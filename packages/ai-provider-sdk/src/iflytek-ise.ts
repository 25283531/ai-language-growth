import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 讯飞语音评测（流式版）协议实现。
 *
 * 旧的 `https://api.xfyun.cn/v1/service/v1/ise` 普通版已经下线，继续调用会返回
 * 10105（illegal X-CheckSum）。这里只使用官方仍在服务的 WebSocket 接口：
 * `wss://ise-api.xfyun.cn/v2/open-ise`。
 *
 * 音频要求：16 kHz、16 bit、单声道 PCM。手机端上传的是 m4a，因此调用前用 ffmpeg
 * 解码为裸 PCM；WAV 且已经是目标格式时直接去掉头部，避免不必要的转码。
 */

export interface IflytekIseAudio {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
}

export interface IflytekIseOptions {
  appId: string;
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  targetText: string;
  language?: string;
  granularity?: 'word' | 'syllable' | 'phoneme';
  timeoutMs?: number;
}

export interface IflytekIseUnit {
  text: string;
  kind: 'word' | 'syllable' | 'phoneme';
  score: number;
  correct: boolean;
  detail: string | null;
}

export interface IflytekIseAssessment {
  score: number;
  units: IflytekIseUnit[];
  rejected: boolean;
  xml: string;
  latencyMs: number;
}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ISE_HOST = 'ise-api.xfyun.cn';
const ISE_PATH = '/v2/open-ise';
const FRAME_BYTES = 1280; // 40ms of 16k/16-bit/mono PCM, as recommended by the protocol.

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const tagPattern = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(xml)) !== null) {
    const closing = match[1] === '/';
    const name = match[2]!;
    const attrText = match[3] ?? '';
    const selfClosing = match[4] === '/';

    if (closing) {
      for (let index = stack.length - 1; index >= 1; index -= 1) {
        if (stack[index]!.name === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const attrs: Record<string, string> = {};
    const attrPattern = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrPattern.exec(attrText)) !== null) {
      attrs[attr[1]!] = decodeXmlEntities(attr[2]!);
    }

    const node: XmlNode = { name, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function findFirst(node: XmlNode, names: readonly string[]): XmlNode | null {
  if (names.includes(node.name)) return node;
  for (const child of node.children) {
    const found = findFirst(child, names);
    if (found) return found;
  }
  return null;
}

function collect(node: XmlNode, name: string, output: XmlNode[] = []): XmlNode[] {
  if (node.name === name) output.push(node);
  for (const child of node.children) collect(child, name, output);
  return output;
}

function numberAttr(value: string | undefined): number {
  const number = Number(value ?? 0);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? number : 0));
}

function errorDetail(attrs: Record<string, string>): string | null {
  const dp = Number(attrs.dp_message ?? 0);
  if (dp === 16) return '漏读';
  if (dp === 32) return '增读';
  if (dp === 64) return '回读';
  if (dp === 128) return '替换';
  if (dp !== 0) return `发音异常(${dp})`;
  const perr = Number(attrs.perr_msg ?? 0);
  if (perr === 1) return '声韵错';
  if (perr === 2) return '调型错';
  if (perr === 3) return '声韵调型错';
  return null;
}

/**
 * 解析流式 ISE 返回的 XML。只依赖属性，不把供应商格式扩散到业务层。
 */
export function parseIflytekIseXml(xml: string): { score: number; units: IflytekIseUnit[]; rejected: boolean } {
  const root = parseXml(xml);
  const detail = findFirst(root, ['read_word', 'read_sentence', 'read_chapter']);
  if (!detail) return { score: 0, units: [], rejected: false };

  const paper = findFirst(detail, ['rec_paper']) ?? detail;
  const scored = findFirst(paper, [detail.name]) ?? paper;
  const words = collect(scored, 'word');
  const score = numberAttr(scored.attrs.total_score ?? detail.attrs.total_score)
    || (words.length
      ? Math.round(words.reduce((sum, word) => sum + numberAttr(word.attrs.total_score), 0) / words.length)
      : 0);

  const units: IflytekIseUnit[] = [];
  for (const word of words) {
    const wordText = word.attrs.content ?? '';
    if (!wordText) continue;
    units.push({
      text: wordText,
      kind: 'word',
      score: numberAttr(word.attrs.total_score) || score,
      correct: Number(word.attrs.dp_message ?? 0) === 0,
      detail: errorDetail(word.attrs),
    });

    for (const syllable of collect(word, 'syll')) {
      const syllableText = syllable.attrs.content ?? '';
      if (!syllableText || ['sil', 'silv', 'fil'].includes(syllableText)) continue;
      const syllableScore = numberAttr(syllable.attrs.total_score) || numberAttr(syllable.attrs.syll_score) || score;
      units.push({
        text: syllableText,
        kind: 'syllable',
        score: syllableScore,
        correct: Number(syllable.attrs.dp_message ?? 0) === 0,
        detail: errorDetail(syllable.attrs),
      });

      for (const phoneme of collect(syllable, 'phone')) {
        const phonemeText = phoneme.attrs.content ?? '';
        if (!phonemeText || ['sil', 'silv', 'fil'].includes(phonemeText)) continue;
        const phonemeScore = numberAttr(phoneme.attrs.phone_score) || syllableScore;
        units.push({
          text: phonemeText,
          kind: 'phoneme',
          score: phonemeScore,
          correct: Number(phoneme.attrs.dp_message ?? 0) === 0,
          detail: errorDetail(phoneme.attrs),
        });
      }
    }
  }

  const rejected = scored.attrs.is_rejected === 'true' || detail.attrs.is_rejected === 'true';
  return { score, units, rejected };
}

/**
 * 构造流式 ISE 的鉴权 URL。签名规则与讯飞其他 WebSocket 服务一致：
 * HMAC-SHA256(APISecret, "host: ...\ndate: ...\nGET ... HTTP/1.1")。
 */
export function buildIflytekIseUrl(options: {
  appId: string;
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
}): string {
  const configured = options.baseUrl?.trim() || `wss://${ISE_HOST}${ISE_PATH}`;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('讯飞 ISE 接入地址不合法');
  }

  const host = parsed.hostname === 'api.xfyun.cn' ? ISE_HOST : parsed.hostname;
  const path = parsed.hostname === 'api.xfyun.cn' ? ISE_PATH : (parsed.pathname || ISE_PATH);
  const date = new Date().toUTCString();
  const requestLine = `GET ${path} HTTP/1.1`;
  const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signature = createHmac('sha256', options.apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = `api_key="${options.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, 'utf8').toString('base64');

  return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(host)}`;
}

function pcmFromWav(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 44
    || Buffer.from(bytes.subarray(0, 4)).toString('ascii') !== 'RIFF'
    || Buffer.from(bytes.subarray(8, 12)).toString('ascii') !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let formatOk = false;
  while (offset + 8 <= bytes.length) {
    const id = Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii');
    const size = Buffer.from(bytes.subarray(offset + 4, offset + 8)).readUInt32LE(0);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      formatOk = Buffer.from(bytes.subarray(start, start + 2)).readUInt16LE(0) === 1
        && Buffer.from(bytes.subarray(start + 2, start + 4)).readUInt16LE(0) === 1
        && Buffer.from(bytes.subarray(start + 4, start + 8)).readUInt32LE(0) === 16000
        && Buffer.from(bytes.subarray(start + 14, start + 16)).readUInt16LE(0) === 16;
    }
    if (id === 'data') {
      if (!formatOk) return null;
      return bytes.subarray(start, Math.min(start + size, bytes.length));
    }
    offset = start + size + (size % 2);
  }
  return null;
}

function extensionFor(audio: IflytekIseAudio): string {
  const name = audio.fileName.toLowerCase();
  const match = /\.([a-z0-9]{2,5})$/.exec(name);
  if (match) return `.${match[1]}`;
  if (audio.mime === 'audio/mp4') return '.m4a';
  if (audio.mime === 'audio/mpeg') return '.mp3';
  if (audio.mime === 'audio/ogg' || audio.mime === 'audio/opus') return '.ogg';
  if (audio.mime === 'audio/aac') return '.aac';
  return '.bin';
}

function runFfmpeg(input: string, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', input,
      '-vn', '-acodec', 'pcm_s16le', '-f', 's16le', '-ac', '1', '-ar', '16000',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('发音评测音频转码超时'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 10 * 1024 * 1024) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT'
        ? '发音评测音频转码组件 ffmpeg 不可用'
        : `发音评测音频转码失败：${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`发音评测音频转码失败：${stderr.trim().slice(0, 300) || `ffmpeg exit ${code}`}`));
        return;
      }
      const output = Buffer.concat(chunks);
      if (!output.length) {
        reject(new Error('发音评测音频转码结果为空'));
        return;
      }
      resolve(new Uint8Array(output));
    });
  });
}

/** 把手机上传的 m4a/mp3/ogg/wav 统一转成 16k/16-bit/mono PCM。 */
export async function transcodeToPcm16k(audio: IflytekIseAudio): Promise<Uint8Array> {
  const mime = audio.mime.toLowerCase();
  const name = audio.fileName.toLowerCase();
  if (mime === 'audio/pcm' || mime === 'audio/raw' || mime === 'audio/l16') {
    return audio.bytes;
  }
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || name.endsWith('.wav')) {
    const pcm = pcmFromWav(audio.bytes);
    if (pcm) return pcm;
  }

  const directory = await mkdtemp(join(tmpdir(), 'alg-ise-'));
  const input = join(directory, `input${extensionFor(audio)}`);
  try {
    await writeFile(input, audio.bytes);
    return await runFfmpeg(input, 15000);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function iseText(targetText: string, category: string): string {
  const text = targetText.trim();
  return `\uFEFF${category === 'read_word' ? `[word]\n${text}` : `[content]\n${text}`}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调用流式 ISE 并等待最终结果。服务端会先返回若干 status=1 的中间帧，
 * 只有 status=2 的那一帧才是最终评测结果。
 */
export async function evaluateWithIflytekIse(
  options: IflytekIseOptions & { audio: IflytekIseAudio },
): Promise<IflytekIseAssessment> {
  if (typeof WebSocket === 'undefined') {
    throw new Error('当前 Node.js 运行时未提供全局 WebSocket；请使用 Node 22+');
  }
  if (!options.appId || !options.apiKey || !options.apiSecret) {
    throw new Error('讯飞 ISE 需要 AppID、APIKey 和 APISecret');
  }

  const started = Date.now();
  const pcm = await transcodeToPcm16k(options.audio);
  const category = options.granularity === 'word' || /^[A-Za-z'-]+$/.test(options.targetText.trim())
    ? 'read_word'
    : 'read_sentence';
  const url = buildIflytekIseUrl(options);
  const timeoutMs = options.timeoutMs ?? 20000;
  const firstFrame = {
    common: { app_id: options.appId },
    business: {
      sub: 'ise',
      ent: 'en_vip',
      category,
      cmd: 'ssb',
      text: iseText(options.targetText, category),
      tte: 'utf-8',
      ttp_skip: true,
      aue: 'raw',
      auf: 'audio/L16;rate=16000',
      rst: 'entirety',
      ise_unite: '1',
      extra_ability: 'multi_dimension',
      plev: '0',
      rstcd: 'utf8',
    },
    data: { status: 0 },
  };

  const xml = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(1000); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value ?? '');
    };

    timer = setTimeout(() => finish(new Error('讯飞 ISE 评测超时')), timeoutMs);

    socket.addEventListener('open', () => {
      void (async () => {
        try {
          socket.send(JSON.stringify(firstFrame));
          for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
            if (settled) return;
            const end = Math.min(offset + FRAME_BYTES, pcm.length);
            const last = end >= pcm.length;
            socket.send(JSON.stringify({
              business: { cmd: 'auw', aus: offset === 0 ? 1 : last ? 4 : 2 },
              data: {
                status: last ? 2 : 1,
                data: Buffer.from(pcm.subarray(offset, end)).toString('base64'),
              },
            }));
            if (!last) await wait(10);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error('讯飞 ISE 音频发送失败'));
        }
      })();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let body: {
        code?: number;
        message?: string;
        data?: { status?: number; data?: string };
      };
      try {
        body = JSON.parse(event.data) as typeof body;
      } catch {
        return;
      }
      if (body.code !== 0) {
        finish(new Error(`讯飞 ISE 错误 ${body.code ?? ''}: ${body.message ?? 'empty result'}`));
        return;
      }
      if (Number(body.data?.status) === 2 && body.data?.data) {
        try {
          finish(undefined, Buffer.from(body.data.data, 'base64').toString('utf8'));
        } catch {
          finish(new Error('讯飞 ISE 返回结果无法解码'));
        }
      }
    });

    socket.addEventListener('error', (event) => {
      const message = 'message' in event && typeof event.message === 'string' ? event.message : '连接失败';
      finish(new Error(`讯飞 ISE WebSocket ${message}`));
    });

    socket.addEventListener('close', (event) => {
      if (!settled) {
        finish(new Error(`讯飞 ISE 连接提前关闭 (${event.code})`));
      }
    });
  });

  const parsed = parseIflytekIseXml(xml);
  return {
    ...parsed,
    xml,
    latencyMs: Date.now() - started,
  };
}

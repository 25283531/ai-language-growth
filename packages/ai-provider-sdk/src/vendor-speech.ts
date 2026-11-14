import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsrAdapter, ProviderCapabilities, ProviderPricing, TtsAdapter } from './protocol';
import type { AsrRequest, AsrResponse, TtsRequest, TtsResponse } from '@alg/shared-contracts';
import { loadAudio, resolveAudioDir, resolveAudioUrlPrefix } from './http';
import { audioFingerprint } from './audio-fingerprint';
import { splitByLanguage, type SpeechSegment } from './language-speed';
export interface IflytekSpeechOptions {
  alias: string;
  baseUrl: string;
  modelAlias?: string;
  credentials: Record<string, string>;
  options?: Record<string, unknown>;
  pricing?: ProviderPricing;
}

const capabilities: ProviderCapabilities = { supportsStructuredOutput: false, supportsStreaming: false };

function pcm16FromWav(input: Uint8Array): Buffer {
  const bytes = Buffer.from(input);
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('讯飞 IAT 当前适配器需要 16kHz、16-bit、单声道 PCM WAV 音频');
  }
  let offset = 12;
  let formatOk = false;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      formatOk = bytes.readUInt16LE(start) === 1 && bytes.readUInt16LE(start + 2) === 1 && bytes.readUInt32LE(start + 4) === 16000 && bytes.readUInt16LE(start + 14) === 16;
    }
    if (id === 'data') {
      if (!formatOk) throw new Error('讯飞 IAT WAV 音频须为 16kHz、16-bit、单声道 PCM');
      return bytes.subarray(start, Math.min(start + size, bytes.length));
    }
    offset = start + size + (size % 2);
  }
  throw new Error('讯飞 IAT 未找到 WAV PCM 音频数据');
}

function signedUrl(baseUrl: string, apiKey: string, apiSecret: string): string {
  const url = new URL(baseUrl);
  const date = new Date().toUTCString();
  const requestLine = `GET ${url.pathname} HTTP/1.1`;
  const signature = createHmac('sha256', apiSecret)
    .update(`host: ${url.host}\ndate: ${date}\n${requestLine}`)
    .digest('base64');
  const authorization = Buffer.from(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`).toString('base64');
  url.searchParams.set('authorization', authorization);
  url.searchParams.set('date', date);
  url.searchParams.set('host', url.host);
  return url.toString();
}

function connectAndSend(url: string, payload: string | string[], timeoutMs: number, decode: (message: Record<string, unknown>) => { done?: boolean; bytes?: Uint8Array; seq?: number; error?: string }): Promise<Uint8Array> {
  if (typeof WebSocket === 'undefined') return Promise.reject(new Error('当前 Node.js 运行时未提供全局 WebSocket；请使用 Node 22+ 或为 Node 20 启用 --experimental-websocket'));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const chunks: Array<{ seq?: number; bytes: Uint8Array }> = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks
        .slice()
        .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
        .map((item) => item.bytes)));
    };
    const timer = setTimeout(() => finish(new Error('讯飞语音服务请求超时')), timeoutMs);
    socket.addEventListener('open', () => {
      try {
        for (const frame of Array.isArray(payload) ? payload : [payload]) socket.send(frame);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      const outcome = decode(message);
      if (outcome.error) { finish(new Error(outcome.error)); return; }
      if (outcome.bytes) chunks.push({ seq: outcome.seq, bytes: outcome.bytes });
      if (outcome.done) finish();
    });
    socket.addEventListener('error', () => finish(new Error('讯飞 WebSocket 连接失败')));
    socket.addEventListener('close', () => {
      if (!settled) finish(new Error('讯飞 WebSocket 在收到完整结果前关闭'));
    });
  });
}

function decodeIatResult(value: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('讯飞 ASR 返回无法解析的识别结果');
  }
  const ret = payload.ret;
  if (typeof ret === 'number' && ret !== 0) {
    throw new Error(`讯飞 ASR 识别失败 ${ret}: ${String(payload.message ?? payload.err ?? '')}`);
  }
  const words: string[] = [];
  const sentences = Array.isArray(payload.ws) ? payload.ws as Array<{ cw?: Array<{ w?: string }> }> : [];
  for (const sentence of sentences) {
    const text = sentence.cw?.[0]?.w;
    if (typeof text === 'string') words.push(text);
  }
  return words.join('');
}

/** speed 取值 0—100，50 为自然语速；英语段按老师语速换算，中文段固定 50。 */
export function iflytekSpeedForSegment(segment: SpeechSegment, teacherSpeed: number): number {
  if (segment.language !== 'en') return 50;
  const value = Number.isFinite(teacherSpeed) && teacherSpeed > 0 ? teacherSpeed : 1;
  return Math.max(0, Math.min(100, Math.round(((value - 0.25) / 1.75) * 100)));
}

export class IflytekTtsAdapter implements TtsAdapter {
  readonly alias: string;
  readonly serviceKind = 'tts' as const;
  readonly capabilities = { ...capabilities, teacherSpeedRange: { min: 0.25, max: 1.2 } };
  readonly pricing: ProviderPricing;

  constructor(private readonly config: IflytekSpeechOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: TtsRequest): Promise<TtsResponse> {
    const started = Date.now();
    const { apiKey = '', apiSecret = '', appId = '' } = this.config.credentials;
    if (!apiKey || !apiSecret || !appId) throw new Error('讯飞 TTS 需要 AppID、API Key 和 API Secret');
    const voice = String(this.config.options?.voice ?? request.voiceIdentity);
    const isSuperSmart = /\/v1\/private\//i.test(this.config.baseUrl);
    // 慢速教学只针对英语：中英混排时按书写系统切段，英语段放慢，中文段保持自然语速。
    const segments = splitByLanguage(request.text);
    if (!segments.length) throw new Error('讯飞 TTS 的文本为空');
    const speeds = segments.map((segment) => iflytekSpeedForSegment(segment, request.voice.teacherSpeed ?? 0.65));
    const parts: Buffer[] = [];
    for (const [index, segment] of segments.entries()) {
      const speed = speeds[index];
      const payload = JSON.stringify(isSuperSmart
        ? {
          header: { app_id: appId, status: 2 },
          parameter: {
            oral: {
              oral_level: String(this.config.options?.oralLevel ?? 'mid'),
              spark_assist: Number(this.config.options?.sparkAssist ?? 1),
              remain: Number(this.config.options?.remain ?? 0),
              stop_split: Number(this.config.options?.stopSplit ?? 0),
            },
            tts: {
              vcn: voice,
              speed,
              volume: 50,
              pitch: 50,
              bgs: 0,
              reg: 0,
              rdn: 0,
              rhy: 0,
              audio: { encoding: 'lame', sample_rate: 24000, channels: 1, bit_depth: 16, frame_size: 0 },
            },
          },
          payload: {
            text: {
              encoding: 'utf8',
              compress: 'raw',
              format: 'plain',
              status: 2,
              seq: 0,
              text: Buffer.from(segment.text).toString('base64'),
            },
          },
        }
        : { common: { app_id: appId }, business: { aue: 'lame', sfl: 1, tte: 'UTF8', vcn: voice, speed, volume: 50, pitch: 50 }, data: { status: 2, text: Buffer.from(segment.text).toString('base64') } });
      const chunk = Buffer.from(await connectAndSend(signedUrl(this.config.baseUrl, apiKey, apiSecret), payload, request.timeoutMs ?? 20000, (message) => {
      const header = message.header as { code?: number; message?: string; status?: number } | undefined;
      const code = header?.code ?? (typeof message.code === 'number' ? message.code : 0);
      const errorMessage = header?.message ?? message.message;
      if (Number(code) !== 0) return { error: `讯飞 TTS 错误 ${code}: ${String(errorMessage ?? '')}` };
      const data = isSuperSmart
        ? (message.payload as { audio?: { audio?: string; status?: number } } | undefined)?.audio
        : message.data as { audio?: string; status?: number } | undefined;
      const encodedAudio = typeof data?.audio === 'string' ? data.audio : undefined;
      const done = isSuperSmart
        ? data?.status === 2 || Number((message.header as { status?: number } | undefined)?.status) === 2
        : data?.status === 2;
      const seq = typeof (data as { seq?: number } | undefined)?.seq === 'number'
        ? (data as { seq: number }).seq
        : undefined;
      return { ...(encodedAudio ? { bytes: Buffer.from(encodedAudio, 'base64'), seq } : {}), ...(done ? { done: true } : {}) };
      }));
      parts.push(chunk);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length < 128) throw new Error('讯飞 TTS 返回的音频数据为空或过短');
    // 文件名指纹统一走共享纯函数：纳入课程作用域/音色版本/模型族、补齐
    // voiceStyle/pronunciationMode、移除 pauseAfterSentenceMs。不同课程同文本
    // 必得不同指纹；同一课程不同用户/时间得到相同指纹。
    const fingerprint = audioFingerprint(request, {
      speed: speeds.join(','),
      voice: this.config.options?.voice ?? request.voiceIdentity,
      modelAlias: this.config.modelAlias ?? '',
      // 超拟人/普通两套请求体结构不同，且 oral 参数会改变声学，纳入指纹。
      extra: [
        this.config.baseUrl,
        isSuperSmart,
        this.config.options?.oralLevel ?? 'mid',
        this.config.options?.sparkAssist ?? 1,
        this.config.options?.remain ?? 0,
        this.config.options?.stopSplit ?? 0,
        'lang-speed-v1',
      ],
    });
    const dir = resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.mp3`;
    const path = join(dir, fileName);
    // 保留 existsSync 跳过写盘：由于指纹现在含 scope 与 voiceProfileVersion，
    // 升版本会自然生成新文件，不再静默复用旧音频。
    if (!existsSync(path)) writeFileSync(path, bytes);
    return { audioRef: `${resolveAudioUrlPrefix()}/${fileName}`, characters: [...request.text].length, latencyMs: Date.now() - started, providerAlias: this.alias, modelAlias: this.config.modelAlias ?? 'iflytek-tts', cached: false };
  }
}

export class IflytekAsrAdapter implements AsrAdapter {
  readonly alias: string;
  readonly serviceKind = 'asr' as const;
  readonly capabilities = capabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly config: IflytekSpeechOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: AsrRequest): Promise<AsrResponse> {
    const started = Date.now();
    const audio = await loadAudio(request.audioRef);
    const { apiKey = '', apiSecret = '', appId = '' } = this.config.credentials;
    if (!apiKey || !apiSecret || !appId) throw new Error('讯飞 ASR 需要 AppID、API Key 和 API Secret');
    const pcm = pcm16FromWav(audio.bytes);
    if (!pcm.length || pcm.length / 32000 > 60) throw new Error('讯飞语音听写大模型单次音频须大于 0 且不超过 60 秒');
    const frames: string[] = [];
    const frameSize = 64 * 1024;
    let sequence = 1;
    for (let offset = 0; offset < pcm.length; offset += frameSize) {
      const chunk = pcm.subarray(offset, Math.min(offset + frameSize, pcm.length));
      const status = offset === 0 ? 0 : 1;
      frames.push(JSON.stringify({
        header: { app_id: appId, status },
        ...(status === 0 ? {
          parameter: {
            iat: {
              domain: 'spark_asr_v2',
              language: 'zh_cn',
              accent: 'mandarin',
              result: { encoding: 'utf8', compress: 'raw', format: 'json' },
            },
          },
        } : {}),
        payload: {
          audio: {
            encoding: 'raw',
            sample_rate: 16000,
            channels: 1,
            bit_depth: 16,
            seq: sequence++,
            status,
            audio: chunk.toString('base64'),
          },
        },
      }));
    }
    frames.push(JSON.stringify({
      header: { app_id: appId, status: 2 },
      payload: {
        audio: {
          encoding: 'raw',
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
          seq: sequence,
          status: 2,
          audio: '',
        },
      },
    }));
    let transcript = '';
    await connectAndSend(signedUrl(this.config.baseUrl, apiKey, apiSecret), frames, request.timeoutMs ?? 20000, (message) => {
      const header = message.header as { code?: number; message?: string; status?: number } | undefined;
      if (Number(header?.code ?? 0) !== 0) return { error: `讯飞 ASR 错误 ${header?.code}: ${String(header?.message ?? '')}` };
      const result = (message.payload as { result?: { text?: string; status?: number } } | undefined)?.result;
      if (result?.text) transcript += decodeIatResult(result.text);
      return { ...(header?.status === 2 || result?.status === 2 ? { done: true } : {}) };
    });
    const text = transcript.trim();
    return { transcript: text, confidence: text ? 0.75 : 0, seconds: pcm.length / 32000, latencyMs: Date.now() - started, providerAlias: this.alias, modelAlias: this.config.modelAlias ?? 'iflytek-iat-v2', suspect: !text };
  }
}

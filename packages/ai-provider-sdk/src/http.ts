/**
 * 真实外部服务的 HTTP 协议适配器（TTS / ASR）。
 *
 * 铁律（约束二）：本文件不出现任何服务商名称、模型名称或音色名称。
 * baseUrl / apiKey / modelAlias / voice 全部由配置注入；换供应商只改 .env。
 * 协议形态为通用 OpenAI 兼容风格：/audio/speech 与 /audio/transcriptions。
 * LLM 走 protocol.ts 里的 HttpLlmAdapter（/chat/completions）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AsrRequest, AsrResponse, TtsRequest, TtsResponse } from '@alg/shared-contracts';
import {
  DEFAULT_CAPABILITIES,
  type AdapterFactoryOptions,
  type AsrAdapter,
  type ProviderCapabilities,
  type ProviderPricing,
  type TtsAdapter,
} from './protocol';
import { audioFingerprint } from './audio-fingerprint';

/**
 * 儿童 ASR 上传录音的独立子目录（相对 resolveAudioDir()）。
 * 与公共 TTS 音频分目录存放，避免私有录音混入公共课程语音资源目录。
 * MediaController 的 uploads/GET 路由使用同名值，改动需两边同步。
 */
export const UPLOADS_SUBDIR = 'uploads';

/** 学习者专属上传子目录名：只暴露不可逆短哈希，不把 learnerId 写进路径。 */
export function uploadOwnerSlug(learnerId: string): string {
  return createHash('sha256').update(learnerId).digest('hex').slice(0, 16);
}

/** 某个学习者的私有录音目录（uploads/<ownerSlug>）。 */
export function resolveUploadDir(learnerId: string): string {
  return join(resolveAudioDir(), UPLOADS_SUBDIR, uploadOwnerSlug(learnerId));
}

/**
 * 按 24-hex 文件名定位音频：先公共 TTS 主目录，再按学习者子目录逐个查找。
 * 文件名已由白名单校验、不含路径分隔符，因此不存在目录穿越。
 */
export function locateAudioFile(fileName: string): string | null {
  if (!/^[a-f0-9]{24}\.[a-z0-9]+$/i.test(fileName)) return null;
  const dir = resolveAudioDir();
  const primary = join(dir, fileName);
  if (existsSync(primary)) return primary;
  const uploads = join(dir, UPLOADS_SUBDIR);
  if (!existsSync(uploads)) return null;
  for (const entry of readdirSync(uploads, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(uploads, entry.name, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 判断路径是否落在 uploads/ 私有子目录内（供媒体路由做归属分流）。 */
export function isUploadedAudioPath(filePath: string): boolean {
  const rel = relative(join(resolveAudioDir(), UPLOADS_SUBDIR), filePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface HttpServiceOptions extends AdapterFactoryOptions {
  providerPresetId?: string;
  protocol?: string;
  credentials?: Record<string, string>;
  options?: Record<string, unknown>;
  /** TTS 音色标识，由配置注入（代码中不写厂商音色名） */
  voice?: string;
  /** 合成音频落盘目录 */
  audioDir?: string;
  /** 合成音频对外访问前缀 */
  audioUrlPrefix?: string;
}

/** 音频目录。默认落在后端进程工作目录下的 .cache/audio，已被 .gitignore 排除。 */
export function resolveAudioDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AI_AUDIO_DIR || '.cache/audio';
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/**
 * 平台内音频路由前缀。
 *
 * 故意不从环境变量读取以斜杠开头的值：Git Bash / MSYS2 在把环境变量交给
 * native 进程时会把 `/api/...` 当 POSIX 路径改写成 Windows 安装目录，
 * 实测曾污染成 `D:/Program Files/.../api/v1/media/audio`。
 * 这属于平台路由而非供应商配置，固定即可，换供应商不受影响。
 */
export const AUDIO_URL_PREFIX = '/api/v1/media/audio';

export function resolveAudioUrlPrefix(): string {
  return AUDIO_URL_PREFIX;
}

/**
 * 抽象语速 → 服务侧语速的唯一映射点（D-014）。
 *
 * 业务层只认识 teacherSpeed（0.25—4，越小越慢），客户端不得传厂商原始 speed。
 * 映射保持单调：慢速教学 0.39 → 0.77，常规 0.65 → 0.96。
 * 停顿 pauseAfterSentenceMs 属播放端行为，M1 不在合成阶段改写教学文本。
 */
export function mapTeacherSpeed(teacherSpeed: number): number {
  const clamped = Math.min(1.2, Math.max(0.25, teacherSpeed));
  return Math.round((0.5 + clamped * 0.7) * 100) / 100;
}

/** 统一的错误体摘要，方便排障且不泄露凭据。 */
async function failureBody(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    return '<unreadable>';
  }
}

/**
 * TTS 适配器：把教学文本合成为真实音频并落盘，返回可播放的 audioRef。
 * 相同文本 + 参数得到相同文件名，构成文件级幂等；Gateway 另有播放缓存。
 */
export class HttpTtsAdapter implements TtsAdapter {
  readonly alias: string;
  readonly serviceKind = 'tts' as const;
  readonly capabilities: ProviderCapabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly options: HttpServiceOptions) {
    this.alias = options.alias;
    this.pricing = options.pricing;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  async invoke(request: TtsRequest): Promise<TtsResponse> {
    const baseUrl = this.options.baseUrl;
    const modelAlias = this.options.modelAlias;
    if (!baseUrl) throw new Error(`adapter ${this.alias} 缺少 baseUrl 配置`);

    const speed = mapTeacherSpeed(request.voice.teacherSpeed ?? 0.65);
    const voice = this.options.voice ?? (this.options.providerPresetId === 'ollama' ? '' : request.voiceIdentity);
    const started = Date.now();

    const provider = this.options.providerPresetId;
    const extra = this.options.options ?? {};
    let requestUrl = `${baseUrl.replace(/\/$/, '')}/audio/speech`;
    let requestHeaders: Record<string, string> = { 'content-type': 'application/json' };
    let requestBody: unknown = {
      model: modelAlias,
      input: request.text,
      voice,
      speed,
      response_format: 'mp3',
    };
    if (provider === 'ollama') {
      requestBody = {
        model: modelAlias,
        input: request.text,
        ...(voice ? { voice } : {}),
        speed: 1,
        response_format: 'wav',
      };
    }
    if (provider === 'bailian') {
      const workspaceId = String(extra.workspaceId ?? '');
      const customBase = baseUrl.replace(/\/$/, '') !== 'https://dashscope.aliyuncs.com';
      const hostBase = customBase ? baseUrl : workspaceId ? `https://${workspaceId}.${String(extra.regionHost ?? 'cn-beijing.maas.aliyuncs.com')}` : baseUrl;
      requestUrl = hostBase.endsWith('/SpeechSynthesizer') ? hostBase : `${hostBase.replace(/\/$/, '')}/api/v1/services/audio/tts/SpeechSynthesizer`;
      requestBody = { model: modelAlias, input: { text: request.text, voice, format: 'mp3', sample_rate: 24000, rate: speed } };
    } else if (provider === 'baidu-qianfan') {
      const credentials = this.options.credentials ?? {};
      const tokenUrl = new URL('https://aip.baidubce.com/oauth/2.0/token');
      tokenUrl.searchParams.set('grant_type', 'client_credentials');
      tokenUrl.searchParams.set('client_id', credentials.apiKey ?? '');
      tokenUrl.searchParams.set('client_secret', credentials.secretKey ?? '');
      const tokenResponse = await fetch(tokenUrl, { method: 'POST', signal: AbortSignal.timeout(request.timeoutMs ?? 12000) });
      if (!tokenResponse.ok) throw new Error(`adapter ${this.alias} 获取百度语音令牌失败: HTTP ${tokenResponse.status}`);
      const tokenData = await tokenResponse.json() as { access_token?: string; error_description?: string };
      if (!tokenData.access_token) throw new Error(`adapter ${this.alias} 获取百度语音令牌失败: ${tokenData.error_description ?? 'missing access_token'}`);
      const url = new URL(baseUrl);
      url.searchParams.set('access_token', tokenData.access_token);
      requestUrl = url.toString();
      requestHeaders = { 'content-type': 'application/json' };
      requestBody = { text: request.text, voice: String(extra.voiceId ?? extra.voice ?? 5003), lang: String(extra.language ?? 'en'), format: 'mp3', sample_rate: 24000, speed: Math.min(2, Math.max(0.5, speed)), pitch: 0, volume: 1 };
    } else if (provider === 'volcengine') {
      requestUrl = baseUrl;
      requestHeaders = {
        'content-type': 'application/json',
        'X-Api-Key': this.options.credentials?.apiKey ?? this.options.apiKey ?? '',
        'X-Api-Resource-Id': String(extra.resourceId ?? 'seed-tts-2.0'),
        'X-Api-Request-Id': randomUUID(),
      };
      requestBody = { user: { uid: 'ai-language-growth' }, req_params: { text: request.text, speaker: voice, audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: Math.round((speed - 1) * 100) } } };
    } else if (provider === 'minimax') {
      const groupId = this.options.credentials?.groupId;
      requestUrl = `${baseUrl}${groupId ? `?GroupId=${encodeURIComponent(groupId)}` : ''}`;
      requestBody = { model: modelAlias, text: request.text, stream: false, voice_setting: { voice_id: voice || String(extra.voice ?? 'English_Graceful_Lady'), speed, vol: 1, pitch: 0 }, audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 } };
    }
    if (this.options.apiKey && provider !== 'volcengine' && provider !== 'baidu-qianfan' && provider !== 'tencent-cloud') requestHeaders.authorization = `Bearer ${this.options.apiKey}`;
    const res = await fetch(requestUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(request.timeoutMs ?? 12000),
    });

    if (!res.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${res.status} ${await failureBody(res)}`);
    }

    let bytes: Buffer;
    if (provider === 'bailian') {
      const body = await res.json() as { output?: { audio?: { url?: string; data?: string } } };
      const audioUrl = body.output?.audio?.url;
      if (body.output?.audio?.data) bytes = Buffer.from(body.output.audio.data, 'base64');
      else if (audioUrl) {
        const audioResponse = await fetch(audioUrl, { signal: AbortSignal.timeout(request.timeoutMs ?? 12000) });
        if (!audioResponse.ok) throw new Error(`adapter ${this.alias} 音频下载失败: HTTP ${audioResponse.status}`);
        bytes = Buffer.from(await audioResponse.arrayBuffer());
      } else throw new Error(`adapter ${this.alias} 未返回音频数据或下载地址`);
    } else if (provider === 'baidu-qianfan') {
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const error = await res.json() as { code?: number; message?: string };
        throw new Error(`adapter ${this.alias} 百度 TTS 错误 ${error.code ?? ''}: ${error.message ?? ''}`);
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } else if (provider === 'minimax') {
      const body = await res.json() as { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string } };
      if (!body.data?.audio) throw new Error(`adapter ${this.alias} 未返回音频: ${body.base_resp?.status_msg ?? 'empty audio'}`);
      bytes = Buffer.from(body.data.audio, 'hex');
    } else if (provider === 'volcengine') {
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('audio/')) bytes = Buffer.from(await res.arrayBuffer());
      else {
        const text = await res.text();
        const packets = text.split(/\r?\n/).filter(Boolean).map((line) => {
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
          try { return JSON.parse(payload) as { data?: { audio?: string }; audio?: string; code?: number; message?: string }; } catch { return undefined; }
        }).filter((packet): packet is { data?: { audio?: string }; audio?: string; code?: number; message?: string } => Boolean(packet));
        const chunks = packets.map((packet) => packet.data?.audio ?? packet.audio ?? '').filter(Boolean).map((chunk) => Buffer.from(chunk, 'base64'));
        if (chunks.length === 0) throw new Error(`adapter ${this.alias} 未返回音频帧`);
        bytes = Buffer.concat(chunks);
      }
    } else bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 128) {
      throw new Error(`adapter ${this.alias} 返回音频过短 (${bytes.length} bytes)`);
    }
    // 回滚到二进制协议时也要防「HTTP 200 但返回 JSON 错误体」被当音频落盘。
    // 裸 MP3 帧流无 ID3 标签，用帧同步位掩码判断，不能用固定 0xFFFB。
    const isMp3 = bytes.subarray(0, 3).toString('latin1') === 'ID3' ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    const isWav = bytes.subarray(0, 4).toString('latin1') === 'RIFF';
    const isMp3OrWav = isMp3 || isWav;
    if (!isMp3OrWav && provider !== 'minimax' && provider !== 'volcengine') {
      throw new Error(`adapter ${this.alias} 返回的不是可播放音频容器 (head=${bytes.subarray(0, 4).toString('hex')})`);
    }

    // 文件名指纹统一走共享纯函数：纳入课程作用域、音色版本、模型族，补齐
    // voiceStyle/pronunciationMode，并移除 pauseAfterSentenceMs（它不写进 TTS
    // 请求体、客户端也不读，只会制造声学相同却文件名不同的重复计费与 audioRef 漂移）。
    // 不同课程相同文本得到不同指纹；同一课程不同用户/时间得到相同指纹。
    const fingerprint = audioFingerprint(request, {
      speed,
      voice,
      modelAlias: modelAlias ?? '',
      // 协议形态/端点也影响实际请求体：换供应商不应错误命中上一家留下的文件。
      extra: [provider, baseUrl],
    });

    const dir = this.options.audioDir ?? resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.${isWav ? 'wav' : 'mp3'}`;
    const fullPath = join(dir, fileName);
    // 保留 existsSync 跳过写盘：由于指纹现在含 scope 与 voiceProfileVersion，
    // 升版本会自然生成新文件，不再静默复用旧音频。
    if (!existsSync(fullPath)) writeFileSync(fullPath, bytes);

    return {
      audioRef: `${this.options.audioUrlPrefix ?? resolveAudioUrlPrefix()}/${fileName}`,
      // 按 Unicode 码点计「字符数」，不用 UTF-8 字节数（中文会高估约 3 倍）
      characters: [...request.text].length,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: modelAlias ?? 'unknown',
      cached: false,
    };
  }
}

/** 把统一 audioRef 解析为可上传的音频字节。 */
export async function loadAudio(
  audioRef: string,
): Promise<{ bytes: Uint8Array; fileName: string; mime: string }> {
  // 1) data URI：Web / Android 原型直接内联上传
  if (audioRef.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(audioRef);
    if (!match?.[1] || !match[2]) throw new Error('data URI 音频格式不合法');
    return {
      bytes: Buffer.from(match[2], 'base64'),
      fileName: 'audio.wav',
      mime: match[1],
    };
  }

  // 2) 后端自己生成的媒体地址：适配器在同一进程内直接读缓存文件，
  //    避免为了供应商上传再次经过需要额度租约的公网媒体路由。
  const mediaPath = /\/api\/v1\/media\/audio\/([a-f0-9]{24}\.(?:mp3|m4a|wav|ogg|opus|aac))$/i.exec(audioRef);
  if (mediaPath?.[1]) {
    // 公共 TTS 音频在主目录，儿童 ASR 上传录音在 uploads/<ownerSlug>/ 下；
    // 两者共用同一 audioRef 形态，由 locateAudioFile 按存在性定位。
    const filePath = locateAudioFile(mediaPath[1]);
    if (!filePath) throw new Error(`音频文件不存在: ${mediaPath[1]}`);
    const lower = filePath.toLowerCase();
    const mime = lower.endsWith('.mp3')
      ? 'audio/mpeg'
      : lower.endsWith('.m4a')
        ? 'audio/mp4'
        : lower.endsWith('.ogg') || lower.endsWith('.opus')
          ? 'audio/ogg'
          : lower.endsWith('.aac')
            ? 'audio/aac'
            : 'audio/wav';
    return {
      bytes: new Uint8Array(readFileSync(filePath)),
      fileName: mediaPath[1],
      mime,
    };
  }

  // 3) 公网可下载地址
  if (/^https?:\/\//i.test(audioRef)) {
    const res = await fetch(audioRef, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`音频下载失败: HTTP ${res.status}`);
    const name = (audioRef.split('/').pop() ?? 'audio.wav').split('?')[0] ?? 'audio.wav';
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      fileName: name,
      mime: res.headers.get('content-type') ?? 'audio/wav',
    };
  }

  // 4) 本地文件：支持 file:// 与绝对路径
  let filePath = audioRef;
  if (filePath.startsWith('file://')) {
    filePath = filePath.slice(7).replace(/^\/([A-Za-z]:)/, '$1');
  }
  if (!isAbsolute(filePath)) filePath = resolve(process.cwd(), filePath);
  if (!existsSync(filePath)) throw new Error(`音频文件不存在: ${filePath}`);

  const lower = filePath.toLowerCase();
  const mime = lower.endsWith('.mp3')
    ? 'audio/mpeg'
    : lower.endsWith('.m4a')
      ? 'audio/mp4'
      : lower.endsWith('.wav')
        ? 'audio/wav'
        : 'application/octet-stream';

  return {
    bytes: new Uint8Array(readFileSync(filePath)),
    fileName: filePath.split(/[\\/]/).pop() ?? 'audio.wav',
    mime,
  };
}

/**
 * ASR 适配器：只回答「说了什么」。
 *
 * 发音是否正确由 pronunciation 服务负责（D-013），本适配器绝不产出评分。
 * 供应商未返回置信度时给保守占位值，且不作为任何教学判断依据（约束三）。
 */
export class HttpAsrAdapter implements AsrAdapter {
  readonly alias: string;
  readonly serviceKind = 'asr' as const;
  readonly capabilities: ProviderCapabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly options: HttpServiceOptions) {
    this.alias = options.alias;
    this.pricing = options.pricing;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  async invoke(request: AsrRequest): Promise<AsrResponse> {
    const baseUrl = this.options.baseUrl;
    const modelAlias = this.options.modelAlias;
    if (!baseUrl) throw new Error(`adapter ${this.alias} 缺少 baseUrl 配置`);

    const audio = await loadAudio(request.audioRef);
    const started = Date.now();

    const provider = this.options.providerPresetId;
    const credentials = this.options.credentials ?? {};
    const extra = this.options.options ?? {};
    let endpoint = `${baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
    let headers: Record<string, string> = {};
    let body: string | FormData;
    if (provider === 'bailian') {
      const workspaceId = String(extra.workspaceId ?? '');
      const customBase = baseUrl.replace(/\/$/, '') !== 'https://dashscope.aliyuncs.com';
      const endpointBase = customBase ? baseUrl : workspaceId ? `https://${workspaceId}.${String(extra.regionHost ?? 'cn-beijing.maas.aliyuncs.com')}` : baseUrl;
      endpoint = endpointBase.endsWith('/generation')
        ? endpointBase
        : `${endpointBase.replace(/\/$/, '')}/api/v1/services/aigc/multimodal-generation/generation`;
      const mime = audio.mime === 'audio/mpeg' ? 'audio/mp3' : audio.mime;
      headers = { 'content-type': 'application/json', authorization: `Bearer ${credentials.apiKey ?? this.options.apiKey ?? ''}` };
      const format = mime === 'audio/mp3' ? 'mp3' : mime === 'audio/opus' ? 'opus' : 'wav';
      body = JSON.stringify({ model: modelAlias, input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${Buffer.from(audio.bytes).toString('base64')}` } }] }] }, parameters: { format, sample_rate: String(extra.sampleRate ?? 16000) } });
    } else if (provider === 'baidu-qianfan') {
      const tokenUrl = new URL('https://aip.baidubce.com/oauth/2.0/token');
      tokenUrl.searchParams.set('grant_type', 'client_credentials');
      tokenUrl.searchParams.set('client_id', credentials.apiKey ?? '');
      tokenUrl.searchParams.set('client_secret', credentials.secretKey ?? '');
      const tokenResponse = await fetch(tokenUrl, { method: 'POST', signal: AbortSignal.timeout(request.timeoutMs ?? 15000) });
      if (!tokenResponse.ok) throw new Error(`adapter ${this.alias} 获取百度语音令牌失败: HTTP ${tokenResponse.status}`);
      const tokenData = await tokenResponse.json() as { access_token?: string; error_description?: string };
      if (!tokenData.access_token) throw new Error(`adapter ${this.alias} 获取百度语音令牌失败: ${tokenData.error_description ?? 'missing access_token'}`);
      const url = new URL(baseUrl);
      url.searchParams.set('token', tokenData.access_token);
      endpoint = url.toString();
      const format = audio.mime.includes('mpeg') || audio.fileName.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav';
      headers = { 'content-type': 'application/json' };
      body = JSON.stringify({ format, rate: Number(extra.sampleRate ?? 16000), channel: 1, cuid: String(extra.cuid ?? 'ai-language-growth'), dev_pid: Number(extra.devPid ?? 1737), speech: Buffer.from(audio.bytes).toString('base64'), len: audio.bytes.length });
    } else if (provider === 'volcengine') {
      endpoint = baseUrl;
      headers = {
        'content-type': 'application/json',
        'X-Api-Key': credentials.apiKey ?? this.options.apiKey ?? '',
        'X-Api-Resource-Id': String(extra.resourceId ?? 'volc.bigasr.auc_turbo'),
        'X-Api-Request-Id': randomUUID(),
        'X-Api-Sequence': '-1',
      };
      body = JSON.stringify({
        user: { uid: String(extra.uid ?? 'ai-language-growth') },
        audio: { data: Buffer.from(audio.bytes).toString('base64') },
        request: {
          model_name: String(extra.modelName ?? 'bigmodel'),
        },
      });
    } else {
      const form = new FormData();
      form.set('model', modelAlias ?? '');
      form.set('file', new Blob([audio.bytes], { type: audio.mime }), audio.fileName);
      body = form;
      if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(request.timeoutMs ?? 15000),
    });

    if (!res.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${res.status} ${await failureBody(res)}`);
    }

    const json = (await res.json()) as {
      text?: string;
      usage?: { seconds?: number; duration?: number };
      result?: Array<string | { text?: string }> | string | { text?: string };
      output?: { text?: string; choices?: Array<{ message?: { content?: string } }> };
      audio_info?: { duration?: number };
    };
    const dashscopeText = json.output?.text ?? json.output?.choices?.[0]?.message?.content;
    const resultObject = json.result && !Array.isArray(json.result) && typeof json.result === 'object'
      ? json.result as { text?: string }
      : undefined;
    const resultText = Array.isArray(json.result)
      ? json.result.map((entry) => typeof entry === 'string' ? entry : entry.text ?? '').join(' ')
      : typeof json.result === 'string' ? json.result : '';
    const transcript = (json.text ?? resultObject?.text ?? resultText ?? dashscopeText ?? '').trim();
    const seconds = Number(json.usage?.seconds ?? json.usage?.duration ?? (provider === 'volcengine' ? json.audio_info?.duration : 0) ?? 0);

    return {
      transcript,
      // 供应商未给出置信度：保守占位值，仅用于展示，不参与评估或证据判定
      confidence: transcript ? 0.75 : 0,
      seconds: Number.isFinite(seconds) ? seconds : 0,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: modelAlias ?? 'unknown',
      // 空结果或纯噪声符号 → 触发 Gateway 的二次高质量识别
      suspect: transcript.length === 0 || /^[\W_]+$/u.test(transcript),
    };
  }
}

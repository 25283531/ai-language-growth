/**
 * 真实外部服务的 HTTP 协议适配器（TTS / ASR）。
 *
 * 铁律（约束二）：本文件不出现任何服务商名称、模型名称或音色名称。
 * baseUrl / apiKey / modelAlias / voice 全部由配置注入；换供应商只改 .env。
 * 协议形态为通用 OpenAI 兼容风格：/audio/speech 与 /audio/transcriptions。
 * LLM 走 protocol.ts 里的 HttpLlmAdapter（/chat/completions）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { AsrRequest, AsrResponse, TtsRequest, TtsResponse } from '@alg/shared-contracts';
import {
  DEFAULT_CAPABILITIES,
  type AdapterFactoryOptions,
  type AsrAdapter,
  type ProviderCapabilities,
  type ProviderPricing,
  type TtsAdapter,
} from './protocol';

export interface HttpServiceOptions extends AdapterFactoryOptions {
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
    const voice = this.options.voice ?? request.voiceIdentity;
    const started = Date.now();

    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelAlias,
        input: request.text,
        voice,
        speed,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 12000),
    });

    if (!res.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${res.status} ${await failureBody(res)}`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 128) {
      throw new Error(`adapter ${this.alias} 返回音频过短 (${bytes.length} bytes)`);
    }
    // 回滚到二进制协议时也要防「HTTP 200 但返回 JSON 错误体」被当音频落盘。
    // 裸 MP3 帧流无 ID3 标签，用帧同步位掩码判断，不能用固定 0xFFFB。
    const isMp3 = bytes.subarray(0, 3).toString('latin1') === 'ID3' ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    const isWav = bytes.subarray(0, 4).toString('latin1') === 'RIFF';
    if (!isMp3 && !isWav) {
      throw new Error(`adapter ${this.alias} 返回的不是可播放音频容器 (head=${bytes.subarray(0, 4).toString('hex')})`);
    }

    const fingerprint = createHash('sha256')
      .update(
        [
          request.text,
          speed,
          voice,
          modelAlias ?? '',
          request.voice.voiceStyle,
          request.voice.pronunciationMode,
          request.voice.pauseAfterSentenceMs,
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 24);

    const dir = this.options.audioDir ?? resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.mp3`;
    const fullPath = join(dir, fileName);
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
async function loadAudio(
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

  // 2) 公网可下载地址
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

  // 3) 本地文件：支持 file:// 与绝对路径
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

    const form = new FormData();
    form.set('model', modelAlias ?? '');
    form.set('file', new Blob([audio.bytes], { type: audio.mime }), audio.fileName);

    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: form,
      signal: AbortSignal.timeout(request.timeoutMs ?? 15000),
    });

    if (!res.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${res.status} ${await failureBody(res)}`);
    }

    const json = (await res.json()) as {
      text?: string;
      usage?: { seconds?: number; duration?: number };
    };
    const transcript = (json.text ?? '').trim();
    const seconds = Number(json.usage?.seconds ?? json.usage?.duration ?? 0);

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

/**
 * 签名型 JSON 音频协议适配器（TTS）。
 *
 * 与 http.ts 的 OpenAI 兼容二进制音频协议并列的第二种协议形态：
 *   POST 到配置的 host，请求体为 JSON，响应体为 JSON，音频以 Base64 字段返回，
 *   请求头带 HMAC 签名（云 API 3.0 通行的 TC3-HMAC-SHA256，公开签名规范）。
 *
 * 铁律（约束二）：本文件不出现任何服务商名称、模型名称或音色名称。
 * host / 动作 / 版本 / 区域 / 音色 / 编码 / 凭据 / 额外请求字段全部由配置注入。
 * 换供应商或换音色档位只改 .env，业务代码零改动。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TtsRequest, TtsResponse } from '@alg/shared-contracts';
import {
  DEFAULT_CAPABILITIES,
  type ProviderCapabilities,
  type ProviderPricing,
  type TtsAdapter,
} from './protocol';
import {
  AUDIO_URL_PREFIX,
  resolveAudioDir,
  type HttpServiceOptions,
} from './http';

/** 签名型协议特有的配置项，全部由 .env 注入。 */
export interface SignedTtsOptions extends HttpServiceOptions {
  /** 签名凭据（两个字段，非 Bearer token） */
  secretId?: string;
  secretKey?: string;
  /** 签名 scope 中的服务名、动作名、版本号、区域 */
  service?: string;
  action?: string;
  version?: string;
  region?: string;
  /** 音频编码：决定落盘扩展名与对外 Content-Type（裸 PCM 无容器头，不开放） */
  codec?: 'mp3' | 'wav';
  /** 采样率 / 主语言 / 音量 / 模型类型等原样透传的数值参数 */
  sampleRate?: number;
  primaryLanguage?: number;
  volume?: number;
  modelType?: number;
  /** 额外请求字段（如不同模型需要的推理强度），由配置注入的 JSON 对象 */
  extraBody?: Record<string, unknown>;
  /** 响应体中承载 Base64 音频的字段名 */
  audioField?: string;
}

/** 允许出现在 audioRef 中的扩展名白名单，MediaController 使用同一份常量。 */
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a'] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

export function audioMimeType(ext: string): string {
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'm4a') return 'audio/mp4';
  return 'audio/mpeg';
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** 从 baseUrl 中取出 host，避免把协议/路径拼进签名。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

/**
 * 抽象教学语速 → 签名型协议的相对语速偏移。
 *
 * 业务层只认识 teacherSpeed（0.25—4，越小越慢），它是序数而非倍率。
 * 该协议的 Speed 是离散档位（0=1.0 倍、-1=0.8 倍、1=1.2 倍），不是倍率本身，
 * 因此这里做分段线性插值，而不是把倍率值原样透传（那样会量纲错配）。
 *
 * 教学场景约束在 0.8—1.2 倍（Speed ∈ [-1, 1]），避免儿童听不清或失真。
 * 语义损失如实记录：teacherSpeed < 0.5 极慢请求无法达到 0.6 倍，M1 不宣称支持。
 */
export function mapTeacherSpeedToOffset(teacherSpeed: number): number {
  const clamped = Math.min(4, Math.max(0.25, teacherSpeed));
  const offset = clamped < 1 ? (clamped - 1) * 1.33 : (clamped - 1) * 0.5;
  return Math.round(Math.min(1, Math.max(-1, offset)) * 10) / 10;
}

async function failureBody(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').slice(0, 220);
  } catch {
    return '<unreadable>';
  }
}

/**
 * 生成 TC3-HMAC-SHA256 请求头。
 * 只签 content-type 与 host 两个头（该签名规范的最小签名集合），
 * 其余业务头不需要参与签名，也不得包含凭据。
 */
export function buildSignedHeaders(options: {
  host: string;
  service: string;
  secretId: string;
  secretKey: string;
  action: string;
  version: string;
  region?: string;
  body: string;
  timestamp: number;
}): Record<string, string> {
  const { host, service, secretId, secretKey, action, version, region, body, timestamp } = options;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(Buffer.from(body, 'utf8')),
  ].join('\n');
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    scope,
    sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
  ].join('\n');
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'content-type': contentType,
    host,
    'x-tc-action': action,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': version,
    ...(region ? { 'x-tc-region': region } : {}),
  };
}

/**
 * 签名型 TTS 适配器。
 *
 * 关键点：该协议在业务失败时仍返回 HTTP 200，错误藏在响应体的 Error 字段里，
 * 因此必须显式检查，否则会把「资源包耗尽」误判为合成成功并落盘空音频。
 */
export class SignedJsonTtsAdapter implements TtsAdapter {
  readonly alias: string;
  readonly serviceKind = 'tts' as const;
  readonly capabilities: ProviderCapabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly options: SignedTtsOptions) {
    this.alias = options.alias;
    this.pricing = options.pricing;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  async invoke(request: TtsRequest): Promise<TtsResponse> {
    const baseUrl = this.options.baseUrl;
    const secretId = this.options.secretId;
    const secretKey = this.options.secretKey;
    if (!baseUrl) throw new Error(`adapter ${this.alias} 缺少 baseUrl 配置`);
    if (!secretId || !secretKey) throw new Error(`adapter ${this.alias} 缺少签名凭据配置`);

    // 该协议单次合成有字数上限：150 个汉字（全角标点计汉字）或 500 个字母
    // （半角标点计字母）。超出时必须显式失败，绝不静默截断教学文本。
    const cjkCount = (request.text.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
    if (cjkCount > 150 || request.text.length > 500) {
      throw new Error(
        `adapter ${this.alias} 文本超出单次合成上限 (汉字=${cjkCount}, 总字符=${request.text.length})`,
      );
    }

    // 换供应商必须能改的值一律由配置注入，不在代码里给厂商默认动作/版本。
    if (!this.options.action || !this.options.version || !this.options.service) {
      throw new Error(`adapter ${this.alias} 缺少动作/版本/服务名配置`);
    }

    const host = hostOf(baseUrl);
    const codec = this.options.codec === 'wav' ? 'wav' : 'mp3';
    const speed = mapTeacherSpeedToOffset(request.voice.teacherSpeed ?? 0.65);
    const voice = this.options.voice ?? request.voiceIdentity;
    const voiceType = Number(voice);
    if (!Number.isInteger(voiceType) || voiceType <= 0) {
      throw new Error(`adapter ${this.alias} 音色标识必须为有效编号，收到 ${voice}`);
    }
    // 音色档位由编号决定，模型类型只允许默认值；拿模型类型去切档会落到
    // 未购买的资源包服务名上（实测会返回资源包不可用）。
    const modelType = this.options.modelType ?? 1;
    if (modelType !== 1) {
      throw new Error(`adapter ${this.alias} 不支持的模型类型 ${modelType}`);
    }
    const audioField = this.options.audioField ?? 'Audio';
    const started = Date.now();

    const payload = {
      // 配置注入的额外字段放在最前：一段 .env 不能覆盖教学文本、音色或编码，
      // 否则会绕过 Router 的档位选择（约束一/二）。
      ...this.options.extraBody,
      Text: request.text,
      // 每次调用（包括重试）都生成新的幂等会话标识，且签名基于新的时间戳重算。
      SessionId: randomUUID(),
      VoiceType: voiceType,
      Codec: codec,
      SampleRate: this.options.sampleRate ?? 16000,
      Speed: speed,
      Volume: this.options.volume ?? 0,
      PrimaryLanguage: this.options.primaryLanguage ?? 2,
      ProjectId: 0,
      ModelType: modelType,
    };

    const body = JSON.stringify(payload);
    const headers = buildSignedHeaders({
      host,
      service: this.options.service,
      secretId,
      secretKey,
      action: this.options.action,
      version: this.options.version,
      region: this.options.region,
      body,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const res = await fetch(baseUrl.replace(/\/$/, ''), {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(request.timeoutMs ?? 12000),
    });
    if (!res.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${res.status} ${await failureBody(res)}`);
    }

    const json = (await res.json()) as {
      Response?: {
        Audio?: string;
        Error?: { Code?: string; Message?: string };
        RequestId?: string;
        [key: string]: unknown;
      };
    };
    const envelope = json.Response;
    if (!envelope) {
      throw new Error(`adapter ${this.alias} 响应缺少业务信封`);
    }
    if (envelope.Error) {
      throw new Error(
        `adapter ${this.alias} 调用失败: ${envelope.Error.Code ?? 'unknown'} ` +
          `${envelope.Error.Message ?? ''} (requestId=${envelope.RequestId ?? '-'})`,
      );
    }

    const encoded = envelope[audioField];
    if (typeof encoded !== 'string' || !encoded) {
      throw new Error(`adapter ${this.alias} 响应缺少 Base64 音频字段 ${audioField}`);
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 128) {
      throw new Error(`adapter ${this.alias} 返回音频过短 (${bytes.length} bytes)`);
    }
    // 有些服务返回无 ID3 标签的裸 MP3 帧流，两种形态都是合法可播放音频。
    const isMp3 = bytes.subarray(0, 3).toString('latin1') === 'ID3' ||
      (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    const isWav = bytes.subarray(0, 4).toString('latin1') === 'RIFF';
    if (codec === 'wav' ? !isWav : !isMp3) {
      throw new Error(`adapter ${this.alias} 返回的音频容器与配置的编码不一致 (${codec})`);
    }

    const fingerprint = createHash('sha256')
      .update(
        [
          request.text,
          speed,
          voice,
          codec,
          this.options.modelAlias ?? '',
          // 协议/动作/服务/区域纳入指纹：换供应商或换音色档位后，
          // 相同文本不会错误命中上一家留下的缓存文件。
          this.options.action ?? '',
          this.options.service ?? '',
          this.options.version ?? '',
          this.options.region ?? '',
          baseUrl,
          this.options.sampleRate ?? 16000,
          this.options.primaryLanguage ?? 2,
          this.options.volume ?? 0,
          this.options.modelType ?? 1,
          JSON.stringify(this.options.extraBody ?? {}),
          request.voice.voiceStyle,
          request.voice.pronunciationMode,
          request.voice.pauseAfterSentenceMs,
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 24);

    const dir = this.options.audioDir ?? resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.${codec}`;
    const fullPath = join(dir, fileName);
    if (!existsSync(fullPath)) writeFileSync(fullPath, bytes);

    return {
      audioRef: `${this.options.audioUrlPrefix ?? AUDIO_URL_PREFIX}/${fileName}`,
      // 供应商按「字符」计费，不是按 UTF-8 字节；中文话术用字节数会高估约 3 倍。
      // 按 Unicode 码点计数，与计费口径一致（1 汉字 / 1 字母 / 1 标点 = 1）。
      characters: [...request.text].length,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: this.options.modelAlias ?? 'signed-json-audio',
      cached: false,
    };
  }
}

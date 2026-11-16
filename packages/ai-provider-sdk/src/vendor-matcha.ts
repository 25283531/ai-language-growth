/**
 * HTTP + 口令的 JSON 转二进制音频适配器（Matcha 引擎，sherpa-onnx 自建服务）。
 *
 * 协议形态（见 docs/tts-matcha-api.md）：
 *   POST {baseUrl}/tts
 *   Header: Content-Type: application/json + 口令头（默认 X-API-Key）
 *   Body:   { text, speed, format }            speed 为倍率 0.5–2.0
 *   Resp:   200 + 音频二进制（wav 16kHz 单声道 / mp3 64kbps）
 *
 * 与签名型（Base64 信封）和 OpenAI 兼容型（/audio/speech）并列的第三种形态：
 * 请求是 JSON、响应是裸音频、鉴权是口令头，业务错误只用 HTTP 状态码表达。
 *
 * 这条链路的关键差异：它的 speed 是真正的倍率（0.5=半速、2.0=两倍），
 * 所以 teacherSpeed 直接透传并钳制，不需要像离散档位那样做插值换算。
 */
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
import { audioFingerprint } from './audio-fingerprint';
import { resolveEffectiveTeacherSpeed } from './language-speed';

/** 服务端文档声明：speed 允许 0.5–2.0，超出自动钳制；文本规范化后上限 800 字符。 */
export const MATCHA_SPEED_RANGE = { min: 0.5, max: 2 } as const;
export const MATCHA_MAX_CHARACTERS = 800;

export interface MatchaTtsOptions extends HttpServiceOptions {
  /** 输出编码，默认 mp3（64kbps，体积小、客户端原生支持） */
  codec?: 'mp3' | 'wav';
  /** 口令头名称，默认 X-API-Key；服务端同时接受 Authorization: Bearer 与 ?token= */
  apiKeyHeader?: string;
}

/**
 * teacherSpeed（业务语义：0.65 慢速 / 0.8 较慢 / 1.0 正常）→ 该服务的倍率参数。
 *
 * 这是全链路里唯一语义一一对应的换算：业务侧的 teacherSpeed 本来就是「相对倍率」，
 * 服务侧 speed 也是倍率，因此只做区间钳制与两位小数取整，不做档位插值
 * （讯飞 0–100 与腾讯 -2..6 才是序数档位，那两处必须插值）。
 */
export function matchaSpeedForTeacherSpeed(teacherSpeed: number): number {
  const raw = Number.isFinite(teacherSpeed) ? teacherSpeed : 1;
  const clamped = Math.min(MATCHA_SPEED_RANGE.max, Math.max(MATCHA_SPEED_RANGE.min, raw));
  return Math.round(clamped * 100) / 100;
}

function looksLikeWav(bytes: Buffer): boolean {
  return bytes.subarray(0, 4).toString('latin1') === 'RIFF';
}

function looksLikeMp3(bytes: Buffer): boolean {
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return bytes.length > 1 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

async function failureBody(res: Response): Promise<string> {
  try {
    return (await res.text()).replace(/\s+/g, ' ').slice(0, 220);
  } catch {
    return '<unreadable>';
  }
}

export class MatchaTtsAdapter implements TtsAdapter {
  readonly alias: string;
  readonly serviceKind = 'tts' as const;
  readonly capabilities: ProviderCapabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly options: MatchaTtsOptions) {
    this.alias = options.alias;
    this.pricing = options.pricing;
    // 该服务是单音色中英双语模型，音色不可选，因此不宣称多音色能力。
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  async invoke(request: TtsRequest): Promise<TtsResponse> {
    const baseUrl = this.options.baseUrl;
    if (!baseUrl) throw new Error(`adapter ${this.alias} 缺少 baseUrl 配置`);
    const apiKey = this.options.credentials?.apiKey ?? '';
    if (!apiKey) throw new Error(`adapter ${this.alias} 缺少口令配置`);

    const text = request.text.trim();
    if (!text) throw new Error(`adapter ${this.alias} 的文本为空`);
    if ([...text].length > MATCHA_MAX_CHARACTERS) {
      throw new Error(
        `adapter ${this.alias} 文本超出单次合成上限 (${[...text].length} > ${MATCHA_MAX_CHARACTERS})`,
      );
    }

    const codec = this.options.codec === 'wav' ? 'wav' : 'mp3';
    // 语速口径：纯英文按档位，混排固定 0.8，纯中文自然语速；此处再转成倍率参数。
    const effective = resolveEffectiveTeacherSpeed(text, request.voice.teacherSpeed ?? 1);
    const speed = matchaSpeedForTeacherSpeed(effective.speed);
    const headerName = this.options.apiKeyHeader ?? 'x-api-key';
    const started = Date.now();

    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [headerName]: apiKey },
      body: JSON.stringify({ text, speed, format: codec }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 120000),
    });
    if (!res.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${res.status} ${await failureBody(res)}`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 128) {
      throw new Error(`adapter ${this.alias} 返回音频过短 (${bytes.length} bytes)`);
    }
    if (codec === 'wav' ? !looksLikeWav(bytes) : !looksLikeMp3(bytes)) {
      throw new Error(`adapter ${this.alias} 返回的音频容器与请求的编码不一致 (${codec})`);
    }

    const fingerprint = audioFingerprint(request, {
      // 与其它适配器不同：这里参与指纹的是最终倍率，编码与协议族也一并带上，
      // 换服务或改编码都不会误命中上一份音频。
      speed,
      voice: this.options.voice ?? request.voiceIdentity,
      modelAlias: this.options.modelAlias ?? '',
      extra: [baseUrl, codec, 'matcha-json-audio-v1', headerName],
    });

    const dir = this.options.audioDir ?? resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.${codec}`;
    const fullPath = join(dir, fileName);
    if (!existsSync(fullPath)) writeFileSync(fullPath, bytes);

    return {
      audioRef: `${this.options.audioUrlPrefix ?? AUDIO_URL_PREFIX}/${fileName}`,
      characters: [...text].length,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: this.options.modelAlias ?? 'matcha-zh-en',
      cached: false,
    };
  }
}

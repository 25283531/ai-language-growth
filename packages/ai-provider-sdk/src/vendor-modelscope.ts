/**
 * 魔搭创空间 Voice Studio 适配器。
 *
 * 同一服务同时提供两件事：
 *   POST {baseUrl}/tts     → 音频二进制（Matcha 中英双语，16kHz 单声道 mp3/wav）
 *   POST {baseUrl}/assess  → 发音评测 JSON（OpenPronounce，音素级）
 *
 * 鉴权是双层：平台网关要 `Authorization: Bearer <token>`，服务自身要 `X-API-Key`。
 * 两个值都只从服务端加密配置读取，不进前端、不进日志。
 *
 * 语速：/tts 的 speed 是真正的倍率（0.5–2.0），且服务端已修过慢速波形拉伸，
 * 0.65 档按 0.65 直接送，不需要像讯飞那样做离散档位反解。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PronunciationRequest,
  PronunciationResponse,
  TtsRequest,
  TtsResponse,
} from '@alg/shared-contracts';
import {
  DEFAULT_CAPABILITIES,
  type PronunciationAdapter,
  type ProviderCapabilities,
  type ProviderPricing,
  type TtsAdapter,
} from './protocol';
import { AUDIO_URL_PREFIX, loadAudio, resolveAudioDir } from './http';
import { audioFingerprint } from './audio-fingerprint';
import { renderSpeedForTier, resolveEffectiveTeacherSpeed } from './language-speed';

export const MODELSCOPE_MAX_CHARACTERS = 800;
export const MODELSCOPE_SPEED_RANGE = { min: 0.5, max: 2 } as const;

export interface ModelScopeOptions {
  alias: string;
  providerPresetId?: string;
  baseUrl: string;
  modelAlias?: string;
  credentials: Record<string, string>;
  options?: Record<string, unknown>;
  pricing?: ProviderPricing;
}

function endpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/$/, '');
  if (!base) throw new Error('魔搭语音服务缺少 baseUrl 配置');
  return `${base}/${path}`;
}

function authHeaders(config: ModelScopeOptions): Record<string, string> {
  const token = (config.credentials.token ?? config.credentials.apiToken ?? '').trim();
  const apiKey = (config.credentials.apiKey ?? '').trim();
  if (!token) throw new Error('魔搭语音服务缺少平台访问令牌 token');
  if (!apiKey) throw new Error('魔搭语音服务缺少服务口令 apiKey');
  return { Authorization: `Bearer ${token}`, 'X-API-Key': apiKey };
}

function failureBody(response: Response): Promise<string> {
  return response.text().then((text) => text.slice(0, 300)).catch(() => '');
}

function looksLikeMp3(bytes: Buffer): boolean {
  // 魔搭返回的是无 ID3 头的裸 MPEG 帧（首字节 0xFF，次字节高三位全 1）；
  // 只认 ID3 会把正常音频误判成非 MP3，导致整条链路降级。
  if (bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** 魔搭 TTS：JSON 请求 + 裸音频响应，speed 直接是倍率。 */
export class ModelScopeTtsAdapter implements TtsAdapter {
  readonly alias: string;
  readonly serviceKind = 'tts' as const;
  readonly capabilities: ProviderCapabilities = {
    ...DEFAULT_CAPABILITIES,
    teacherSpeedRange: MODELSCOPE_SPEED_RANGE,
  };
  readonly pricing: ProviderPricing;

  constructor(private readonly config: ModelScopeOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: TtsRequest): Promise<TtsResponse> {
    const text = request.text.trim();
    if (!text) throw new Error(`adapter ${this.alias} 的文本为空`);
    if ([...text].length > MODELSCOPE_MAX_CHARACTERS) {
      throw new Error(`adapter ${this.alias} 文本超出上限 (${[...text].length} > ${MODELSCOPE_MAX_CHARACTERS})`);
    }
    const effective = resolveEffectiveTeacherSpeed(text, request.voice.teacherSpeed ?? 1);
    const speed = Math.min(
      MODELSCOPE_SPEED_RANGE.max,
      Math.max(MODELSCOPE_SPEED_RANGE.min, Number(renderSpeedForTier(effective.speed).toFixed(2))),
    );
    const codec = this.config.options?.codec === 'wav' ? 'wav' : 'mp3';
    const started = Date.now();

    const response = await fetch(endpoint(this.config.baseUrl, 'tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.config) },
      body: JSON.stringify({ text, speed, format: codec }),
      signal: AbortSignal.timeout(Math.max(60000, request.timeoutMs ?? 0)),
    });
    if (!response.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${response.status} ${await failureBody(response)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 256) throw new Error(`adapter ${this.alias} 返回音频过短 (${bytes.length} bytes)`);
    if (codec === 'mp3' && !looksLikeMp3(bytes)) {
      throw new Error(`adapter ${this.alias} 返回的不是 mp3 音频`);
    }

    const fingerprint = audioFingerprint(request, {
      speed,
      voice: this.config.options?.voice ?? request.voiceIdentity,
      modelAlias: this.config.modelAlias ?? '',
      extra: [this.config.baseUrl, codec, 'modelscope-voice-studio-v1'],
    });
    const dir = resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.${codec}`;
    const fullPath = join(dir, fileName);
    if (!existsSync(fullPath)) writeFileSync(fullPath, bytes);

    return {
      audioRef: `${AUDIO_URL_PREFIX}/${fileName}`,
      characters: [...text].length,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: this.config.modelAlias ?? 'matcha-icefall-zh-en',
      cached: false,
    };
  }
}

/**
 * 单词评测得分：openpronounce 的词错率对单个单词只有 0/1 两种结果，
 * 直接用会把「差一个音」判成 0 分。这里按音素距离给部分分：
 * 0→100、1→80、2→60、3→40，距离再大就 0 分。
 */
export function scoreSingleWordAudio(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 100;
  return clampScore(100 - 20 * distance);
}

/**
 * 把 openpronounce 的原始教学分标定成孩子看到的 0-100 分。
 *
 * 实测（中文母语者）：读得很好约 40 分，读得一般约 30 分。标定目标：
 *  - 40 分（母语者水平）→ 95；
 *  - 40 分以上平缓上升，只有原始满分才给 100（避免随便读到 100）；
 *  - 40 分以下用 1.8 次方压降，读得一般约 57、读得含糊约 27。
 * 标定表：0→0、10→8、20→27、30→57、40→95、50→96、100→100。
 */
export function calibrateModelscopeScore(rawScore: number): number {
  if (!Number.isFinite(rawScore)) return 0;
  const raw = Math.max(0, Math.min(100, rawScore));
  if (raw <= 40) return clampScore(95 * Math.pow(raw / 40, 1.8));
  return clampScore(95 + (5 * (raw - 40)) / 60);
}

/**
 * 魔搭 /assess 发音评测。
 *
 * 该服务按美式母语者声学距离打分，对儿童系统性偏低（合成语音自测约 20 分），
 * 所以**不能直接把原始分给孩子看**。这里用它的错误统计换算成教学分：
 *   教学分 = 100 × (1 - word_error_rate)
 * 读对的词不报错，因此这个词错率比原始分稳定；原始分与转写只用于诊断日志。
 */
export class ModelScopeAssessAdapter implements PronunciationAdapter {
  readonly alias: string;
  readonly serviceKind = 'pronunciation' as const;
  readonly capabilities: ProviderCapabilities = {
    ...DEFAULT_CAPABILITIES,
    supportsPhonemeAssessment: true,
    supportsSyllableAssessment: false,
  };
  readonly pricing: ProviderPricing;

  constructor(private readonly config: ModelScopeOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: PronunciationRequest): Promise<PronunciationResponse> {
    const started = Date.now();
    const audio = await loadAudio(request.audioRef);
    const form = new FormData();
    const fileName = audio.mime === 'audio/wav' ? 'recording.wav' : 'recording.mp3';
    form.append('file', new Blob([audio.bytes], { type: audio.mime || 'audio/mpeg' }), fileName);
    form.append('text', request.targetText);

    const response = await fetch(endpoint(this.config.baseUrl, 'assess'), {
      method: 'POST',
      headers: authHeaders(this.config),
      body: form,
      // 实例刚唤醒时评测模型可能仍在加载，平台网关约 120s 超时；这里留足余量。
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      throw new Error(`adapter ${this.alias} 调用失败: HTTP ${response.status} ${await failureBody(response)}`);
    }
    const raw = await response.json() as {
      score?: number;
      transcribe?: string;
      differences?: {
        errors?: Array<{
          position?: number;
          word?: string;
          expected?: string;
          actual?: string;
          phone_distance?: number;
          phones?: Array<{ expected?: string; heard?: string; confidence?: number }>;
        }>;
        word_error_rate?: number;
        phoneme_error_rate?: number;
      };
    };
    const errors = raw.differences?.errors ?? [];
    const targetWords = request.targetText.trim().split(/\s+/).filter(Boolean).length || 1;
    const wordErrorRate = typeof raw.differences?.word_error_rate === 'number'
      ? raw.differences.word_error_rate
      : errors.length / targetWords;
    // 句子按词错率标定；单个单词没有中间态，改按音素距离给分，避免差一个音就 0 分。
    const baseScore = 100 * (1 - Math.min(1, Math.max(0, wordErrorRate)));
    const teaching = targetWords === 1
      ? scoreSingleWordAudio(errors.length === 0 ? 0 : Math.max(1, errors[0]?.phone_distance ?? 1))
      : calibrateModelscopeScore(baseScore);

    const units: PronunciationResponse['units'] = [];
    for (const error of errors) {
      const word = (error.word ?? '').trim();
      if (!word) continue;
      units.push({
        text: word,
        kind: 'word',
        score: clampScore(100 - 18 * (error.phone_distance ?? 1)),
        correct: false,
        detail: `应为 ${error.expected ?? '—'}，听到 ${error.actual ?? '—'}`,
      });
      for (const phone of error.phones ?? []) {
        const expected = (phone.expected ?? '').trim();
        const heard = (phone.heard ?? '').trim();
        if (!expected || !heard || expected === heard) continue;
        if ((phone.confidence ?? 0) < 0.6) continue;
        units.push({
          text: expected,
          kind: 'phoneme',
          score: clampScore(100 * (1 - (phone.confidence ?? 0))),
          correct: false,
          detail: `应读 ${expected}，实际接近 ${heard}`,
        });
      }
    }

    return {
      score: teaching,
      passed: teaching >= 80,
      units,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: this.config.modelAlias ?? 'openpronounce',
    };
  }
}

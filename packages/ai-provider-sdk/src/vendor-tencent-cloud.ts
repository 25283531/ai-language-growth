import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsrRequest, AsrResponse, TtsRequest, TtsResponse } from '@alg/shared-contracts';
import type { AsrAdapter, ProviderCapabilities, ProviderPricing, TtsAdapter } from './protocol';
import { loadAudio, resolveAudioDir, resolveAudioUrlPrefix } from './http';
import { audioFingerprint } from './audio-fingerprint';

export interface TencentCloudSpeechOptions {
  alias: string;
  baseUrl: string;
  modelAlias?: string;
  credentials: Record<string, string>;
  options?: Record<string, unknown>;
  pricing?: ProviderPricing;
}

const capabilities: ProviderCapabilities = { supportsStructuredOutput: false, supportsStreaming: false };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signedHeaders(config: TencentCloudSpeechOptions, action: string, version: string, body: Record<string, unknown>): Record<string, string> {
  const secretId = config.credentials.secretId ?? '';
  const secretKey = config.credentials.secretKey ?? '';
  if (!secretId || !secretKey) throw new Error('腾讯云语音服务需要 Secret ID 和 Secret Key');
  const endpoint = new URL(config.baseUrl);
  const host = endpoint.host;
  const service = endpoint.hostname.split('.')[0] || 'tts';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const payload = JSON.stringify(body);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeadersList = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeadersList}\n${sha256(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const dateKey = createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const serviceKey = createHmac('sha256', dateKey).update(service).digest();
  const signingKey = createHmac('sha256', serviceKey).update('tc3_request').digest();
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    'content-type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Region': String(config.options?.region ?? ''),
    'X-TC-Timestamp': String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`,
  };
}

async function callTencent(config: TencentCloudSpeechOptions, action: string, version: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(config.baseUrl, {
    method: 'POST',
    headers: signedHeaders(config, action, version, body),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({})) as { Response?: Record<string, unknown> };
  if (!response.ok) throw new Error(`腾讯云语音服务调用失败: HTTP ${response.status}`);
  const result = json.Response ?? {};
  if (result.Error) {
    const error = result.Error as { Code?: string; Message?: string };
    throw new Error(`腾讯云语音服务错误 ${error.Code ?? ''}: ${error.Message ?? ''}`);
  }
  return result;
}

export class TencentCloudTtsAdapter implements TtsAdapter {
  readonly alias: string;
  readonly serviceKind = 'tts' as const;
  readonly capabilities = { ...capabilities, teacherSpeedRange: { min: 0.25, max: 1.2 } };
  readonly pricing: ProviderPricing;

  constructor(private readonly config: TencentCloudSpeechOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: TtsRequest): Promise<TtsResponse> {
    const started = Date.now();
    const codec = String(this.config.options?.codec ?? 'mp3');
    const voiceType = Number(this.config.options?.voiceType ?? 101001);
    const speed = Math.max(-2, Math.min(2, Math.round(((request.voice.teacherSpeed ?? 0.65) - 0.65) * 2)));
    const sampleRate = Number(this.config.options?.sampleRate ?? 16000);
    const primaryLanguage = Number(this.config.options?.primaryLanguage ?? 1);
    const volume = Number(this.config.options?.volume ?? 0);
    const result = await callTencent(this.config, 'TextToVoice', '2019-08-23', {
      Text: request.text,
      SessionId: `alg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      VoiceType: voiceType,
      Codec: codec,
      SampleRate: sampleRate,
      PrimaryLanguage: primaryLanguage,
      Speed: speed,
      Volume: volume,
    }, request.timeoutMs ?? 15000);
    const audio = String(result.Audio ?? '');
    if (!audio) throw new Error('腾讯云 TTS 未返回音频');
    const bytes = Buffer.from(audio, 'base64');
    if (bytes.length < 128) throw new Error('腾讯云 TTS 返回音频过短');
    // 文件名指纹统一走共享纯函数：纳入课程作用域/音色版本/模型族、补齐
    // voiceStyle/pronunciationMode、移除 pauseAfterSentenceMs。不同课程同文本
    // 必得不同指纹；同一课程不同用户/时间得到相同指纹。
    const fingerprint = audioFingerprint(request, {
      speed,
      voice: voiceType,
      modelAlias: this.config.modelAlias ?? '',
      extra: [codec, sampleRate, primaryLanguage, volume, request.voiceIdentity, this.config.baseUrl],
    });
    const dir = resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.${codec}`;
    const path = join(dir, fileName);
    // 保留 existsSync 跳过写盘：由于指纹现在含 scope 与 voiceProfileVersion，
    // 升版本会自然生成新文件，不再静默复用旧音频。
    if (!existsSync(path)) writeFileSync(path, bytes);
    return {
      audioRef: `${resolveAudioUrlPrefix()}/${fileName}`,
      characters: [...request.text].length,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: this.config.modelAlias ?? 'tencent-tts',
      cached: false,
    };
  }
}

export class TencentCloudAsrAdapter implements AsrAdapter {
  readonly alias: string;
  readonly serviceKind = 'asr' as const;
  readonly capabilities = capabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly config: TencentCloudSpeechOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: AsrRequest): Promise<AsrResponse> {
    const started = Date.now();
    const audio = await loadAudio(request.audioRef);
    const result = await callTencent(this.config, 'SentenceRecognition', '2019-06-14', {
      ProjectId: Number(this.config.options?.projectId ?? 0),
      SubServiceType: Number(this.config.options?.subServiceType ?? 2),
      EngSerViceType: String(this.config.options?.engineType ?? '16k_en'),
      SourceType: 1,
      VoiceFormat: audio.fileName.toLowerCase().endsWith('.mp3') ? 8 : 1,
      UsrAudioKey: `alg-${Date.now()}`,
      Data: Buffer.from(audio.bytes).toString('base64'),
      DataLen: audio.bytes.length,
    }, request.timeoutMs ?? 15000);
    const transcript = String(result.Result ?? result.Text ?? '').trim();
    return {
      transcript,
      confidence: transcript ? 0.75 : 0,
      seconds: Number(result.AudioDuration ?? 0) / 1000,
      latencyMs: Date.now() - started,
      providerAlias: this.alias,
      modelAlias: this.config.modelAlias ?? 'tencent-asr',
      suspect: !transcript || /^[\W_]+$/u.test(transcript),
    };
  }
}

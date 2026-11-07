import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsrAdapter, ProviderCapabilities, ProviderPricing, TtsAdapter } from './protocol';
import type { AsrRequest, AsrResponse, TtsRequest, TtsResponse } from '@alg/shared-contracts';
import { loadAudio, resolveAudioDir, resolveAudioUrlPrefix } from './http';

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

function connectAndSend(url: string, payload: string, timeoutMs: number, decode: (message: Record<string, unknown>) => { done?: boolean; bytes?: Uint8Array; error?: string }): Promise<Uint8Array> {
  if (typeof WebSocket === 'undefined') return Promise.reject(new Error('当前 Node.js 运行时未提供 WebSocket；请使用 Node 20.10+ 或更新版本'));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const chunks: Uint8Array[] = [];
    const timer = setTimeout(() => { socket.close(); reject(new Error('讯飞语音服务请求超时')); }, timeoutMs);
    socket.addEventListener('open', () => socket.send(payload));
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
      const outcome = decode(message);
      if (outcome.error) { clearTimeout(timer); socket.close(); reject(new Error(outcome.error)); return; }
      if (outcome.bytes) chunks.push(outcome.bytes);
      if (outcome.done) { clearTimeout(timer); socket.close(); resolve(Buffer.concat(chunks)); }
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('讯飞 WebSocket 连接失败')); });
  });
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
    const speed = Math.max(0, Math.min(100, Math.round(((request.voice.teacherSpeed ?? 0.65) - 0.25) / 1.75 * 100)));
    const payload = JSON.stringify({ common: { app_id: appId }, business: { aue: 'lame', sfl: 1, tte: 'UTF8', vcn: String(this.config.options?.voice ?? request.voiceIdentity), speed, volume: 50, pitch: 50 }, data: { status: 2, text: Buffer.from(request.text).toString('base64') } });
    const bytes = Buffer.from(await connectAndSend(signedUrl(this.config.baseUrl, apiKey, apiSecret), payload, request.timeoutMs ?? 20000, (message) => {
      if (Number(message.code ?? 0) !== 0) return { error: `讯飞 TTS 错误 ${message.code}: ${String(message.message ?? '')}` };
      const data = message.data as { audio?: string; status?: number } | undefined;
      return { ...(data?.audio ? { bytes: Buffer.from(data.audio, 'base64') } : {}), ...(data?.status === 2 ? { done: true } : {}) };
    }));
    if (bytes.length < 128) throw new Error('讯飞 TTS 返回的音频数据为空或过短');
    const fingerprint = createHash('sha256').update([request.text, speed, this.config.modelAlias ?? '', this.config.options?.voice ?? request.voiceIdentity].join('|')).digest('hex').slice(0, 24);
    const dir = resolveAudioDir();
    mkdirSync(dir, { recursive: true });
    const fileName = `${fingerprint}.mp3`;
    const path = join(dir, fileName);
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
    const payload = JSON.stringify({ common: { app_id: appId }, business: { language: String(this.config.options?.language ?? 'en_us'), domain: 'iat', accent: 'mandarin', vad_eos: 2000 }, data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: pcm.toString('base64') } });
    let transcript = '';
    await connectAndSend(signedUrl(this.config.baseUrl, apiKey, apiSecret), payload, request.timeoutMs ?? 20000, (message) => {
      if (Number(message.code ?? 0) !== 0) return { error: `讯飞 ASR 错误 ${message.code}: ${String(message.message ?? '')}` };
      const data = message.data as { result?: { ws?: Array<{ cw?: Array<{ w?: string }> }> }; status?: number } | undefined;
      for (const word of data?.result?.ws ?? []) transcript += word.cw?.[0]?.w ?? '';
      return { ...(data?.status === 2 ? { done: true } : {}) };
    });
    return { transcript: transcript.trim(), confidence: transcript.trim() ? 0.75 : 0, seconds: 0, latencyMs: Date.now() - started, providerAlias: this.alias, modelAlias: this.config.modelAlias ?? 'iflytek-iat', suspect: !transcript.trim() };
  }
}

import { createHmac, createHash, randomUUID } from 'node:crypto';
import type { PronunciationRequest, PronunciationResponse } from '@alg/shared-contracts';
import type { PronunciationAdapter, ProviderCapabilities, ProviderPricing } from './protocol';
import { loadAudio } from './http';

export interface PronunciationProviderOptions {
  alias: string;
  providerPresetId: string;
  baseUrl: string;
  modelAlias?: string;
  credentials: Record<string, string>;
  options?: Record<string, unknown>;
  pricing?: ProviderPricing;
}

const capabilities: ProviderCapabilities = {
  supportsStructuredOutput: true,
  supportsStreaming: false,
  supportsPhonemeAssessment: true,
  supportsSyllableAssessment: true,
};

function score(value: unknown): number {
  const number = Number(value ?? 0);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? number : 0));
}

export class AzurePronunciationAdapter implements PronunciationAdapter {
  readonly alias: string;
  readonly serviceKind = 'pronunciation' as const;
  readonly capabilities = capabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly config: PronunciationProviderOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: PronunciationRequest): Promise<PronunciationResponse> {
    const started = Date.now();
    const audio = await loadAudio(request.audioRef);
    if (!['audio/wav', 'audio/ogg'].includes(audio.mime)) {
      throw new Error('Azure 发音评估支持 WAV PCM 或 OGG Opus 音频，请先转换格式');
    }
    const region = String(this.config.options?.region ?? '');
    const endpoint = this.config.baseUrl || (region ? `https://${region}.stt.speech.microsoft.com` : '');
    if (!endpoint) throw new Error('Azure 发音评估需要配置区域或自定义接入地址');
    const params = new URLSearchParams({ language: request.language || 'en-US', format: 'detailed' });
    const assessment = Buffer.from(JSON.stringify({
      ReferenceText: request.targetText,
      GradingSystem: 'HundredMark',
      Granularity: request.granularity === 'word' ? 'Word' : request.granularity === 'syllable' ? 'Syllable' : 'Phoneme',
      EnableMiscue: true,
      Dimension: 'Comprehensive',
    })).toString('base64');
    const endpointUrl = new URL(endpoint);
    if (!endpointUrl.pathname.replace(/\/$/, '').endsWith('/speech/recognition/conversation/cognitiveservices/v1')) {
      endpointUrl.pathname = `${endpointUrl.pathname.replace(/\/$/, '')}/speech/recognition/conversation/cognitiveservices/v1`;
    }
    params.forEach((value, key) => endpointUrl.searchParams.set(key, value));
    const response = await fetch(endpointUrl.toString(), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.config.credentials.subscriptionKey ?? this.config.credentials.apiKey ?? '',
        'Pronunciation-Assessment': assessment,
        'Content-Type': audio.mime === 'audio/wav' ? 'audio/wav; codecs=audio/pcm; samplerate=16000' : 'audio/ogg; codecs=opus',
        Accept: 'application/json;text/xml',
      },
      body: audio.bytes,
      signal: AbortSignal.timeout(request.timeoutMs ?? 20000),
    });
    if (!response.ok) throw new Error(`Azure pronunciation assessment failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const body = await response.json() as {
      NBest?: Array<{ PronunciationAssessment?: { PronScore?: number; AccuracyScore?: number }; Words?: Array<{ Word?: string; PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string }; Phonemes?: Array<{ Phoneme?: string; PronunciationAssessment?: { AccuracyScore?: number } }>; Syllables?: Array<{ Syllable?: string; PronunciationAssessment?: { AccuracyScore?: number }; Phonemes?: Array<{ Phoneme?: string; PronunciationAssessment?: { AccuracyScore?: number } }> }> }> }>;
      DisplayText?: string;
    };
    const result = body.NBest?.[0];
    if (!result) throw new Error('Azure pronunciation assessment returned no scored hypothesis');
    const units: PronunciationResponse['units'] = [];
    for (const word of result.Words ?? []) {
      if (request.granularity === 'word') {
        const value = score(word.PronunciationAssessment?.AccuracyScore);
        units.push({ text: word.Word ?? '', kind: 'word', score: value, correct: value >= 60, detail: word.PronunciationAssessment?.ErrorType ?? null });
        continue;
      }
      if (request.granularity === 'phoneme' && word.Phonemes?.length) {
        for (const phoneme of word.Phonemes) {
          const value = score(phoneme.PronunciationAssessment?.AccuracyScore);
          units.push({ text: phoneme.Phoneme ?? '', kind: 'phoneme', score: value, correct: value >= 60, detail: null });
        }
        continue;
      }
      for (const syllable of word.Syllables ?? []) {
        if (request.granularity === 'syllable') {
          const value = score(syllable.PronunciationAssessment?.AccuracyScore);
          units.push({ text: syllable.Syllable ?? '', kind: 'syllable', score: value, correct: value >= 60, detail: null });
        } else {
          for (const phoneme of syllable.Phonemes ?? []) {
            const value = score(phoneme.PronunciationAssessment?.AccuracyScore);
            units.push({ text: phoneme.Phoneme ?? '', kind: 'phoneme', score: value, correct: value >= 60, detail: null });
          }
        }
      }
    }
    const total = score(result.PronunciationAssessment?.PronScore ?? result.PronunciationAssessment?.AccuracyScore);
    return { score: total, passed: total >= 60, units, latencyMs: Date.now() - started, providerAlias: this.alias, modelAlias: this.config.modelAlias ?? 'azure-speech' };
  }
}

export class TencentSoeAdapter implements PronunciationAdapter {
  readonly alias: string;
  readonly serviceKind = 'pronunciation' as const;
  readonly capabilities = capabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly config: PronunciationProviderOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: PronunciationRequest): Promise<PronunciationResponse> {
    const started = Date.now();
    const audio = await loadAudio(request.audioRef);
    const appId = this.config.credentials.appId ?? '';
    const secretId = this.config.credentials.secretId ?? '';
    const secretKey = this.config.credentials.secretKey ?? '';
    if (!appId || !secretId || !secretKey) throw new Error('腾讯 SOE 需要 AppID、SecretID 和 SecretKey');
    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      eval_mode: request.granularity === 'word' ? '0' : '1',
      expired: String(now + 3600),
      nonce: String(Math.floor(Math.random() * 1_000_000_000)),
      ref_text: request.targetText,
      rec_mode: '1',
      score_coeff: '1.0',
      secretid: secretId,
      sentence_info_enabled: '1',
      server_engine_type: (request.language ?? 'en-US').toLowerCase().startsWith('zh') ? '16k_zh' : '16k_en',
      timestamp: String(now),
      voice_format: audio.fileName.toLowerCase().endsWith('.mp3') ? '2' : audio.fileName.toLowerCase().endsWith('.wav') ? '1' : '0',
      voice_id: randomUUID(),
      text_mode: '0',
    };
    const endpoint = new URL(this.config.baseUrl || 'wss://soe.cloud.tencent.com/soe/api/');
    const path = `${endpoint.host}${endpoint.pathname.replace(/\/$/, '')}/${appId}`;
    const canonical = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
    const signature = createHmac('sha1', secretKey).update(`${path}?${canonical}`).digest('base64');
    const query = new URLSearchParams();
    for (const key of Object.keys(params).sort()) query.set(key, params[key]!);
    query.set('signature', signature);
    const url = `${endpoint.protocol}//${path}?${query.toString()}`;
    const result = await tencentSocketCall(url, audio.bytes, request.timeoutMs ?? 20000);
    const resultText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? {});
    const scoreMatch = /(?:SuggestedScore|PronAccuracy)["']?\s*:\s*["']?(-?\d+(?:\.\d+)?)/.exec(resultText);
    const total = score(scoreMatch?.[1] ?? 0);
    const phonemes: Array<{ text: string; score: number; detail: string | null }> = [];
    const phonePattern = /(?:PhoneInfo|Phones?)["']?\s*:\s*\[([\s\S]*?)\]/gi;
    for (const match of resultText.matchAll(phonePattern)) {
      const entries = match[1]!.match(/\{[^{}]*\}/g) ?? [];
      for (const entry of entries) {
        const phone = /(?:Phone|ReferencePhone|phone)["']?\s*:\s*["']?([^,}\s"']+)/i.exec(entry)?.[1];
        const phoneScore = /(?:PronAccuracy|Score)["']?\s*:\s*["']?(-?\d+(?:\.\d+)?)/i.exec(entry)?.[1];
        const tag = /(?:Tag|MatchTag|ErrorType)["']?\s*:\s*["']?([^,}\s"']+)/i.exec(entry)?.[1];
        if (phone) phonemes.push({ text: phone.replace(/^['"]|['"]$/g, ''), score: score(phoneScore ?? (tag && tag !== '0' ? 0 : total)), detail: tag && tag !== '0' ? tag : null });
      }
    }
    const units: PronunciationResponse['units'] = phonemes.map((phone) => ({ text: phone.text, kind: 'phoneme', score: phone.score, correct: phone.score >= 60, detail: phone.detail }));
    return { score: total, passed: total >= 60, units, latencyMs: Date.now() - started, providerAlias: this.alias, modelAlias: this.config.modelAlias ?? 'soe' };
  }
}

export class IflytekIseAdapter implements PronunciationAdapter {
  readonly alias: string;
  readonly serviceKind = 'pronunciation' as const;
  readonly capabilities = capabilities;
  readonly pricing: ProviderPricing;

  constructor(private readonly config: PronunciationProviderOptions) {
    this.alias = config.alias;
    this.pricing = config.pricing ?? { checkedAt: new Date().toISOString().slice(0, 10) };
  }

  async invoke(request: PronunciationRequest): Promise<PronunciationResponse> {
    const started = Date.now();
    const audio = await loadAudio(request.audioRef);
    const apiKey = this.config.credentials.apiKey ?? '';
    const appId = this.config.credentials.appId ?? '';
    if (!apiKey || !appId) throw new Error('讯飞 ISE 需要 AppID 和语音评测 API Key');
    const category = request.granularity === 'word' || /^[A-Za-z'-]+$/.test(request.targetText.trim()) ? 'read_word' : 'read_sentence';
    const text = category === 'read_word' ? `[word]\n${request.targetText.trim()}` : `[content]\n${request.targetText.trim()}`;
    const params = Buffer.from(JSON.stringify({
      aue: 'raw', result_level: 'entirety', language: (request.language ?? 'en-US').toLowerCase().startsWith('zh') ? 'zh_cn' : 'en_us', category,
      ...(request.granularity === 'phoneme' ? { extra_ability: 'multi_dimension' } : {}),
    })).toString('base64');
    const curTime = String(Math.floor(Date.now() / 1000));
    const checksum = createHash('md5').update(`${apiKey}${curTime}${params}`).digest('hex');
    const form = new URLSearchParams();
    form.set('audio', Buffer.from(audio.bytes).toString('base64'));
    form.set('text', text);
    const response = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'X-Appid': appId, 'X-CurTime': curTime, 'X-Param': params, 'X-CheckSum': checksum },
      body: form,
      signal: AbortSignal.timeout(request.timeoutMs ?? 20000),
    });
    if (!response.ok) throw new Error(`讯飞 ISE 调用失败: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const body = await response.json() as { code?: string; desc?: string; data?: Record<string, unknown> };
    if (body.code !== '0' || !body.data) throw new Error(`讯飞 ISE 错误 ${body.code ?? ''}: ${body.desc ?? 'empty result'}`);
    const root = (body.data[category] ?? body.data) as Record<string, unknown>;
    const paper = root.rec_paper as Record<string, unknown> | undefined;
    const detail = (paper?.[category] ?? root) as Record<string, unknown>;
    const total = score(detail.total_score);
    const units: PronunciationResponse['units'] = [];
    const walk = (node: unknown, kind: 'word' | 'syllable' | 'phoneme' = 'word', inheritedScore = total): void => {
      if (Array.isArray(node)) { for (const child of node) walk(child, kind, inheritedScore); return; }
      if (!node || typeof node !== 'object') return;
      const item = node as Record<string, unknown>;
      const wordScore = score(item.total_score ?? inheritedScore);
      const syllableScore = score(item.syll_score ?? item.total_score ?? inheritedScore);
      if (typeof item.content === 'string' && !['sil', 'silv', 'fil'].includes(item.content)) {
        const itemKind = Array.isArray(item.phone) ? 'syllable' : Array.isArray(item.syll) ? 'word' : kind;
        if (request.granularity === 'word' && itemKind === 'word') units.push({ text: item.content, kind: 'word', score: wordScore, correct: wordScore >= 60, detail: null });
        if (request.granularity === 'syllable' && itemKind === 'syllable') units.push({ text: item.content, kind: 'syllable', score: syllableScore, correct: syllableScore >= 60, detail: null });
        if (request.granularity === 'phoneme' && kind === 'phoneme') {
          const error = typeof item.dp_message === 'string' && item.dp_message !== '0' && item.dp_message !== '';
          const value = typeof item.phone_score === 'number' ? score(item.phone_score) : error ? 0 : syllableScore;
          units.push({ text: item.content, kind: 'phoneme', score: value, correct: value >= 60, detail: error ? String(item.dp_message) : null });
        }
      }
      if (Array.isArray(item.sentence)) walk(item.sentence, 'word', wordScore);
      if (Array.isArray(item.word)) walk(item.word, 'syllable', wordScore);
      if (Array.isArray(item.syll)) walk(item.syll, 'phoneme', syllableScore);
      if (Array.isArray(item.phone)) walk(item.phone, 'phoneme', syllableScore);
    };
    walk(detail);
    return { score: total, passed: total >= 60, units, latencyMs: Date.now() - started, providerAlias: this.alias, modelAlias: this.config.modelAlias ?? 'ise' };
  }
}

async function tencentSocketCall(url: string, audio: Uint8Array, timeoutMs: number): Promise<{ result?: unknown }> {
  if (typeof WebSocket === 'undefined') throw new Error('当前 Node.js 运行时未提供 WebSocket；请使用 Node 20.10+ 或更新版本');
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('腾讯 SOE 评测超时')); }, timeoutMs);
    let handshake = false;
    let last: { result?: unknown } = {};
    socket.addEventListener('open', () => undefined);
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: { code?: number; message?: string; result?: unknown; final?: number };
      try { message = JSON.parse(event.data) as typeof message; } catch { return; }
      if (message.code && message.code !== 0) { clearTimeout(timer); socket.close(); reject(new Error(`腾讯 SOE 错误 ${message.code}: ${message.message ?? ''}`)); return; }
      if (!handshake) { handshake = true; socket.send(audio); socket.send(JSON.stringify({ type: 'end' })); }
      if (message.result !== undefined) last = { result: message.result };
      if (message.final === 1) { clearTimeout(timer); socket.close(); resolve(last); }
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('腾讯 SOE WebSocket 连接失败')); });
  });
}

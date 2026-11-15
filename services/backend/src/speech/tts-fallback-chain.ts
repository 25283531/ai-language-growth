/**
 * 在线 TTS 回落链：Edge → 讯飞 → 腾讯 → 本地 Piper。
 *
 * 设计约束（与产品口径一致）：
 * 1. **不重试**。同一厂商只调一次，超时即判定无响应并切下一个。
 * 2. 超时时间按句子长度预估：短句 2–3s、中句 5s、长句先拆句再逐句调；预估时间加余量后作为本次调用超时。
 * 3. 每次回落写一条结构化日志：时间、原文、句长、预估、实际等待、厂商、结果、回落原因。
 * 4. 全部在线厂商失败才走设备本地 Piper 兜底。
 */

export type TtsSpeed = 1.0 | 0.8 | 0.65;

export interface TtsRequest {
  text: string;
  speed: TtsSpeed;
  /** 句序号（长句拆句后逐句调用时使用）。 */
  index?: number;
}

export interface TtsResult {
  audio: Buffer;
  sampleRate: number;
  provider: string;
  waitedMs: number;
}

export interface TtsProvider {
  readonly name: string;
  /** 实现内部不得重试；超时由本链路控制。 */
  synthesize(request: TtsRequest, timeoutMs: number): Promise<TtsResult>;
}

export interface FallbackLogEntry {
  at: string;
  text: string;
  chars: number;
  estimatedMs: number;
  waitedMs: number;
  provider: string;
  outcome: 'ok' | 'timeout' | 'error' | 'skipped';
  reason: string;
  attempt: number;
}

export interface FallbackOutcome {
  result: TtsResult;
  logs: FallbackLogEntry[];
  /** 是否走到最后一级（本地兜底）。 */
  usedLocalFallback: boolean;
}

/** 句子长度分档：短句 2–3s，中句 5s，长句按 5s/12 字线性放大。 */
export const TIMEOUT_TABLE = {
  short: { maxChars: 12, baseMs: 2000, perCharMs: 80, maxMs: 3000 },
  medium: { maxChars: 40, baseMs: 3000, perCharMs: 50, maxMs: 5000 },
  long: { baseMs: 5000, perCharMs: 60, maxMs: 20000 },
} as const;

/** 余量系数：预估 × 1.2 + 300ms 固定开销。 */
export const TIMEOUT_MARGIN_RATIO = 1.2;
export const TIMEOUT_MARGIN_FLAT_MS = 300;

/** 按句长估算本次调用应有的超时时间（毫秒）。 */
export function estimateTimeoutMs(text: string): number {
  const chars = [...text.trim()].length;
  if (chars === 0) return TIMEOUT_TABLE.short.baseMs;
  let raw: number;
  if (chars <= TIMEOUT_TABLE.short.maxChars) {
    const t = TIMEOUT_TABLE.short;
    raw = Math.min(t.maxMs, t.baseMs + chars * t.perCharMs);
  } else if (chars <= TIMEOUT_TABLE.medium.maxChars) {
    const t = TIMEOUT_TABLE.medium;
    raw = Math.min(t.maxMs, t.baseMs + (chars - TIMEOUT_TABLE.short.maxChars) * t.perCharMs);
  } else {
    const t = TIMEOUT_TABLE.long;
    raw = Math.min(t.maxMs, t.baseMs + (chars - TIMEOUT_TABLE.medium.maxChars) * t.perCharMs);
  }
  return Math.round(raw * TIMEOUT_MARGIN_RATIO + TIMEOUT_MARGIN_FLAT_MS);
}

/** 长句拆分：按中英文标点切分，超过 maxChars 的片段再按逗号/空格切。 */
export function splitSentences(text: string, maxChars = TIMEOUT_TABLE.medium.maxChars): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if ([...trimmed].length <= maxChars) return [trimmed];
  const rough = trimmed.split(/(?<=[。！？!?；;])|(?<=\.\s)/u).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const piece of rough) {
    if ([...piece].length <= maxChars) {
      out.push(piece);
      continue;
    }
    let buffer = '';
    for (const part of piece.split(/(?<=[，,、])/u)) {
      if ([...`${buffer}${part}`].length > maxChars && buffer) {
        out.push(buffer.trim());
        buffer = part;
      } else {
        buffer += part;
      }
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out.filter(Boolean);
}

export class TtsFallbackChain {
  constructor(
    private readonly providers: TtsProvider[],
    private readonly now: () => number = () => Date.now(),
  ) {
    if (providers.length === 0) throw new Error('TtsFallbackChain 至少需要一个 provider');
  }

  /**
   * 对一段文本执行回落。长句会先拆句，逐句走同一条链，最后按顺序拼接音频。
   */
  async synthesize(request: TtsRequest): Promise<FallbackOutcome> {
    const pieces = splitSentences(request.text);
    if (pieces.length === 0) throw new Error('没有可合成的文本');
    const logs: FallbackLogEntry[] = [];
    const buffers: Buffer[] = [];
    let sampleRate = 24000;
    let usedLocalFallback = false;

    for (let index = 0; index < pieces.length; index += 1) {
      const text = pieces[index]!;
      const outcome = await this.synthesizeOne({ ...request, text, index });
      logs.push(...outcome.logs);
      buffers.push(outcome.result.audio);
      sampleRate = outcome.result.sampleRate;
      usedLocalFallback = usedLocalFallback || outcome.usedLocalFallback;
    }

    return {
      result: { audio: Buffer.concat(buffers), sampleRate, provider: logs.at(-1)?.provider ?? 'unknown', waitedMs: logs.reduce((a, b) => a + b.waitedMs, 0) },
      logs,
      usedLocalFallback,
    };
  }

  /** 单句：按顺序尝试，绝不重试同一厂商。 */
  async synthesizeOne(request: TtsRequest): Promise<FallbackOutcome> {
    const text = request.text;
    const chars = [...text].length;
    const estimatedMs = estimateTimeoutMs(text);
    const logs: FallbackLogEntry[] = [];
    let lastError = '';

    for (let attempt = 0; attempt < this.providers.length; attempt += 1) {
      const provider = this.providers[attempt]!;
      const started = this.now();
      try {
        const result = await provider.synthesize(request, estimatedMs);
        const waitedMs = this.now() - started;
        logs.push({
          at: new Date(this.now()).toISOString(),
          text,
          chars,
          estimatedMs,
          waitedMs,
          provider: provider.name,
          outcome: 'ok',
          reason: attempt === 0 ? '首选命中' : `上一级回落：${lastError}`,
          attempt,
        });
        return {
          result: { ...result, provider: provider.name, waitedMs },
          logs,
          usedLocalFallback: provider.name === 'local-piper',
        };
      } catch (error) {
        const waitedMs = this.now() - started;
        const isTimeout = error instanceof TimeoutError || (error as Error)?.name === 'TimeoutError';
        lastError = isTimeout ? `${provider.name} 超时（预估 ${estimatedMs}ms）` : `${provider.name} 失败：${String((error as Error)?.message ?? error)}`;
        logs.push({
          at: new Date(this.now()).toISOString(),
          text,
          chars,
          estimatedMs,
          waitedMs,
          provider: provider.name,
          outcome: isTimeout ? 'timeout' : 'error',
          reason: lastError,
          attempt,
        });
      }
    }

    throw new FallbackExhaustedError(`全部厂商无响应：${lastError}`, logs);
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class FallbackExhaustedError extends Error {
  constructor(message: string, readonly logs: FallbackLogEntry[]) {
    super(message);
    this.name = 'FallbackExhaustedError';
  }
}

/** 把 provider 包一层硬超时（不做任何重试）。 */
export function withHardTimeout(provider: TtsProvider): TtsProvider {
  return {
    name: provider.name,
    async synthesize(request, timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${provider.name} 超时 ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        return await Promise.race([provider.synthesize(request, timeoutMs), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

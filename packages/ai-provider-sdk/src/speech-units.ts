/**
 * 教学语句的合成单元规划（与供应商无关）。
 *
 * 为什么需要它：长句一次性合成时，供应商要读完整个文本才开始回流音频，孩子等待感强。
 * 按教学句边界（。！？；）切成几句并行合成，再按原顺序拼接，能显著压低首字等待；
 * 生成结果仍然是一个完整音频、一个缓存指纹，播放端无感知。
 *
 * 约束（与 D-014 一致）：
 *  - 只在**句边界**切，不按字数硬切，避免句子被拦腰截断；
 *  - 短文本（< minCharsToSplit）不切，保持单次合成的自然韵律；
 *  - 单元数有上限，超长文本合并尾部，避免一次请求打爆供应商并发。
 */
import { splitByLanguage, type SpeechLanguage, type SpeechSegment } from './language-speed';

export interface SpeechUnit {
  text: string;
  language: SpeechLanguage;
}

const SENTENCE_END = /[。！？；!?;]+[”’"』】）)]*/gu;

export interface PlanOptions {
  /** 达到这个字数才值得切（默认 45）。低于它单次合成更快也更自然。 */
  minCharsToSplit?: number;
  /** 单个单元的目标上限，超出的相邻短句会被合并（默认 45）。 */
  maxUnitChars?: number;
  /** 最多切成几个单元（默认 8）。 */
  maxUnits?: number;
}

/** 去掉空白后的字符数，用于判断长度门槛。 */
function charLength(text: string): number {
  return [...text.replace(/\s+/gu, '')].length;
}

/** 按句末标点切句，标点跟随本句，不丢字符。 */
function splitSentences(text: string): string[] {
  const parts = text.split(SENTENCE_END);
  const matches = text.match(SENTENCE_END) ?? [];
  const sentences: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const body = parts[index] ?? '';
    const tail = matches[index] ?? '';
    const sentence = `${body}${tail}`;
    if (sentence) sentences.push(sentence);
  }
  return sentences;
}

/** 把相邻的短句合并到不超过 maxUnitChars 的单元，保持原顺序。 */
function groupSentences(sentences: string[], maxUnitChars: number): string[] {
  const units: string[] = [];
  for (const sentence of sentences) {
    const previous = units[units.length - 1];
    if (previous && charLength(previous) + charLength(sentence) <= maxUnitChars) {
      units[units.length - 1] = `${previous}${sentence}`;
    } else {
      units.push(sentence);
    }
  }
  return units;
}

/** 单元过多时把尾部合并进最后一个单元，避免并发过高。 */
function capUnits(units: string[], maxUnits: number): string[] {
  if (units.length <= maxUnits) return units;
  const head = units.slice(0, maxUnits - 1);
  const tail = units.slice(maxUnits - 1).join('');
  return [...head, tail];
}

/**
 * 规划一次合成要发几个单元。
 *
 * 纯中文或纯英文长文本按句切；中英混排先按语言切，再对超长语言段按句切。
 * 返回顺序即播放顺序，所有单元文本按序拼接必须还原原文（测试锁定）。
 */
export function planSpeechUnits(text: string, options: PlanOptions = {}): SpeechUnit[] {
  const body = (text ?? '').trim();
  if (!body) return [];
  const minCharsToSplit = options.minCharsToSplit ?? 45;
  const maxUnitChars = options.maxUnitChars ?? 45;
  const maxUnits = options.maxUnits ?? 8;

  const segments: SpeechSegment[] = splitByLanguage(body);
  const units: SpeechUnit[] = [];
  for (const segment of segments) {
    if (charLength(segment.text) < minCharsToSplit) {
      units.push({ text: segment.text, language: segment.language });
      continue;
    }
    const sentences = splitSentences(segment.text);
    const grouped = capUnits(groupSentences(sentences, maxUnitChars), maxUnits);
    for (const unit of grouped) units.push({ text: unit, language: segment.language });
  }
  return units.filter((unit) => unit.text.trim().length > 0);
}

/** 有并发上限的顺序映射：结果顺序与输入一致。 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

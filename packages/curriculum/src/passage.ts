/**
 * 课文切句器。
 *
 * 规则来自任务书 v1.1 第 6.2 节：
 * - 按 . ! ? 与中文标点切分，保留引号、省略号和组合标点；
 * - 不把 Mr. / e.g. / U.S. 等缩写、3.14、10:30 误切；
 * - 单句超过上限时在从句/空白边界二次切分，并标记 splitFrom；
 * - id 使用 <unitCode>-sNN，按出现顺序稳定生成。
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'e.g', 'i.e', 'u.s', 'u.k', 'no',
]);

const CLOSING_MARKS = new Set([
  '"', "'", '”', '’', '）', ')', ']', '】', '》', '」', '』', '›', '»',
]);

const CLAUSE_PUNCTUATION = new Set([',', ';', ':', '，', '；', '：', '、', '—', '–']);

const CLAUSE_CONJUNCTIONS = new Set([
  'and', 'but', 'because', 'which', 'that', 'when', 'if', 'so', 'or',
  'although', 'while', 'after', 'before', 'since', 'unless', 'whereas',
]);

export interface PassageSentenceSplit {
  /** 稳定句子 id：<unitCode>-sNN。 */
  id: string;
  en: string;
  /** 超长句二次切分时，派生句指向保留原 id 的首句。 */
  splitFrom?: string;
}

export interface SplitPassageOptions {
  /** 单句最大字符数，默认 500。 */
  maxLength?: number;
  /** 起始序号，默认 1；已有句子时自动取已有最大序号 + 1。 */
  startIndex?: number;
  /** 已有句子；用于编辑时复用未改动的 id，新增句取最大序号 + 1。 */
  existing?: Pick<PassageSentenceSplit, 'id' | 'en'>[];
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 500;
  return Math.max(1, Math.floor(value));
}

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && /[0-9]/.test(char);
}

function isAbbreviation(before: string): string | null {
  const match = before.match(/([A-Za-z.]+)$/);
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  if (ABBREVIATIONS.has(token)) return token;
  // U.S / e.g / i.e 这类由多个单字母段组成的缩写。
  if (/^(?:[a-z]\.)+[a-z]?$/.test(token)) return token;
  return null;
}

function nextWordAfter(chars: string[], index: number): string | null {
  let cursor = index;
  while (cursor < chars.length && /\s/.test(chars[cursor]!)) cursor += 1;
  let word = '';
  while (cursor < chars.length && /[A-Za-z]/.test(chars[cursor]!)) {
    word += chars[cursor]!;
    cursor += 1;
  }
  return word || null;
}

function keepsAbbreviationTogether(token: string, chars: string[], index: number): boolean {
  const nextWord = nextWordAfter(chars, index + 1);
  // 这些缩写通常只能出现在句首/句中；后接大写词时按句末处理。
  if (token === 'etc' || token === 'e.g' || token === 'i.e' || token === 'u.s' || token === 'u.k') {
    return nextWord !== null && /^[a-z]/.test(nextWord);
  }
  // Mr. / Dr. 等称谓后接姓名，始终不切。
  return true;
}

function isSentenceTerminator(char: string): boolean {
  return char === '.' || char === '!' || char === '?' || char === '。'
    || char === '！' || char === '？' || char === '…';
}

function isBoundaryAt(chars: string[], index: number): boolean {
  const char = chars[index];
  if (!char) return false;

  if (char === '!' || char === '?' || char === '。' || char === '！' || char === '？' || char === '…') {
    return true;
  }

  if (char !== '.') return false;

  const next = chars[index + 1];
  const previous = chars[index - 1];

  // 省略号、连续感叹号/问号由结束标记消费器统一处理。
  if (next === '.') return false;

  // 小数、域名、编号中的点（3.14 / U.S 的第一点）不切。
  if (isAsciiWordChar(next)) return false;
  if (isDigit(previous) && isDigit(next)) return false;

  const abbreviation = isAbbreviation(chars.slice(0, index).join(''));
  return !abbreviation || !keepsAbbreviationTogether(abbreviation, chars, index);
}

/** 只按句子边界切分原始段落，不处理超长句。 */
function splitRawSentences(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const chars = Array.from(text);
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < chars.length; index += 1) {
    if (!isBoundaryAt(chars, index)) continue;

    let end = index + 1;
    while (end < chars.length) {
      const next = chars[end]!;
      if (isSentenceTerminator(next) || CLOSING_MARKS.has(next)) {
        end += 1;
        continue;
      }
      break;
    }

    const sentence = chars.slice(start, end).join('').trim();
    if (sentence) sentences.push(sentence);

    start = end;
    while (start < chars.length && /\s/.test(chars[start]!)) start += 1;
    index = end - 1;
  }

  const tail = chars.slice(start).join('').trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function clauseStartAt(chars: string[], index: number): boolean {
  let word = '';
  let cursor = index;
  while (cursor < chars.length && /\s/.test(chars[cursor]!)) cursor += 1;
  while (cursor < chars.length && /[A-Za-z']/.test(chars[cursor]!)) {
    word += chars[cursor]!;
    cursor += 1;
  }
  return CLAUSE_CONJUNCTIONS.has(word.toLowerCase());
}

/** 在 maxLength 以内寻找最后一个从句/空白边界。 */
function findClauseCut(chars: string[], maxLength: number): number {
  let cut = 0;
  const limit = Math.min(maxLength - 1, chars.length - 1);
  for (let index = 1; index <= limit; index += 1) {
    const char = chars[index]!;
    if (CLAUSE_PUNCTUATION.has(char)) {
      // 10:30 中的冒号不是从句边界。
      if (char === ':' && isDigit(chars[index - 1]) && isDigit(chars[index + 1])) continue;
      cut = index + 1;
      continue;
    }
    if (char === ' ' && clauseStartAt(chars, index + 1)) cut = index;
  }
  return cut;
}

function findWhitespaceCut(chars: string[], maxLength: number): number {
  for (let index = Math.min(maxLength, chars.length - 1); index > 0; index -= 1) {
    if (/\s/.test(chars[index]!)) return index;
  }
  return 0;
}

/** 超长句二次切分；不丢字符，不把单句留到上限以上。 */
export function splitLongSentence(sentence: string, maxLength = 500): string[] {
  const limit = normalizeLimit(maxLength);
  let rest = sentence.trim();
  const chunks: string[] = [];

  while (Array.from(rest).length > limit) {
    const chars = Array.from(rest);
    let cut = findClauseCut(chars, limit);
    if (cut <= 0) cut = findWhitespaceCut(chars, limit);
    if (cut <= 0) cut = limit;

    const chunk = chars.slice(0, cut).join('').trim();
    if (!chunk) {
      // 极端输入（例如连续标点）仍要前进，避免死循环；保留字符，不静默丢弃。
      cut = Math.min(limit, chars.length);
      const fallback = chars.slice(0, cut).join('').trim();
      if (fallback) chunks.push(fallback);
    } else {
      chunks.push(chunk);
    }
    rest = chars.slice(cut).join('').trimStart();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

/** 按段落切句；返回按段落分组的纯文本句子。 */
export function splitSentences(paragraph: string, maxLength = 500): string[] {
  return splitRawSentences(paragraph)
    .flatMap((sentence) => splitLongSentence(sentence, maxLength));
}

function normalizeUnitCode(unitCode: string): string {
  const code = unitCode.trim().replace(/\s+/g, '-');
  if (!code) throw new Error('unitCode 不能为空');
  return code;
}

function sentenceId(unitCode: string, index: number): string {
  return `${unitCode}-s${String(index).padStart(2, '0')}`;
}

function sentenceNumber(id: string): number {
  const match = id.match(/-s(\d+)$/);
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

function normalizeSentenceText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 将整篇课文切成段落/句子，并生成稳定 id。
 * 空行视为段落分隔；单句超长时派生句带 splitFrom。
 * 传入 existing 时，未改动句子复用原 id，新增句取已有最大序号 + 1。
 */
export function splitPassage(
  text: string,
  unitCode: string,
  options: SplitPassageOptions = {},
): PassageSentenceSplit[][] {
  const code = normalizeUnitCode(unitCode);
  const limit = normalizeLimit(options.maxLength);
  const existing = options.existing ?? [];
  const knownIds = new Set(existing.map((sentence) => sentence.id));
  const claimedIds = new Set<string>();
  const existingByText = new Map<string, string[]>();

  for (const sentence of existing) {
    const key = normalizeSentenceText(sentence.en);
    const ids = existingByText.get(key) ?? [];
    if (ids.includes(sentence.id)) continue;
    ids.push(sentence.id);
    existingByText.set(key, ids);
  }

  let nextIndex = Math.max(
    1,
    Math.floor(options.startIndex ?? 1),
    ...existing.map((sentence) => sentenceNumber(sentence.id) + 1),
  );

  const allocateId = (): string => {
    let id = sentenceId(code, nextIndex);
    while (knownIds.has(id) || claimedIds.has(id)) {
      nextIndex += 1;
      id = sentenceId(code, nextIndex);
    }
    claimedIds.add(id);
    nextIndex += 1;
    return id;
  };

  const takeExistingId = (text: string): string | undefined => {
    const ids = existingByText.get(normalizeSentenceText(text));
    const id = ids?.find((candidate) => !claimedIds.has(candidate));
    if (!id) return undefined;
    claimedIds.add(id);
    return id;
  };

  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

  return paragraphs.map((paragraph) => {
    const sentences: PassageSentenceSplit[] = [];

    for (const rawSentence of splitRawSentences(paragraph)) {
      const chunks = splitLongSentence(rawSentence, limit);
      let baseId: string | undefined;

      chunks.forEach((chunk, chunkIndex) => {
        const id = takeExistingId(chunk) ?? allocateId();
        if (chunkIndex === 0) baseId = id;
        sentences.push({
          id,
          en: chunk,
          ...(chunkIndex > 0 ? { splitFrom: baseId } : {}),
        });
      });
    }

    return sentences;
  }).filter((paragraph) => paragraph.length > 0);
}

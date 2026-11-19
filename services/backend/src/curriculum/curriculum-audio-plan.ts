import type {
  AudioSpeedTier,
  CurriculumPassage,
  FocusWordAudio,
  FocusWordClipKind,
  PassageSentence,
  TextbookUnitContent,
} from '@alg/shared-contracts';

/**
 * 双速/拆读音频的确定性规划。
 *
 * 这一层只决定「要合成什么」，不访问数据库、不调用 TTS，便于单测锁定：
 *  - 每句恰好两条：normal(1.0) / slow(0.65)；
 *  - 每单元最多 4 个重点词；
 *  - 重点词顺序固定为整词慢速 → 音节 → 困难音素 → 音节合成 → 自然语速；
 *  - 同一课程版本、同一片段、同一档位只有一个稳定键。
 */

export type AudioClipKind = 'sentence' | FocusWordClipKind;

export interface AudioClipSpec {
  /** 实体稳定标识：`sentence:<sentenceId>` 或 `word:<word>`。 */
  clipKey: string;
  kind: AudioClipKind;
  /** 同一 kind 内的序号；句子固定 0。 */
  partIndex: number;
  /** 播放顺序，从 0 开始。 */
  position: number;
  speedTier: AudioSpeedTier;
  speed: number;
  text: string;
  voiceStyle: 'gentle' | 'warm' | 'encouraging';
  pronunciationMode: 'natural' | 'slow_clear' | 'syllable_by_syllable';
}

export interface FocusWordPlan extends Omit<FocusWordAudio, 'clips'> {
  clips: AudioClipSpec[];
}

export interface CurriculumAudioPlan {
  sentenceClips: AudioClipSpec[];
  focusWords: FocusWordPlan[];
  wordClips: AudioClipSpec[];
  /** 被跳过的音素（phoneme_items 未收录）或无法安全拆分的词。 */
  skipped: Array<{ clipKey: string; text: string; reason: string }>;
}

export interface FocusWordSelection {
  word: string;
  phonetic: string;
  meaningZh: string;
  syllables: string[];
  difficultPhonemes: string[];
  reason: string;
}

const MAX_FOCUS_WORDS = 4;
const MIN_FOCUS_WORDS = 2;
const WORD_RE = /^[A-Za-z][A-Za-z'-]*$/;

export function buildCurriculumAudioPlan(
  content: Pick<TextbookUnitContent, 'passage' | 'vocabulary' | 'activities'>,
  options: { knownPhonemes?: ReadonlySet<string> } = {},
): CurriculumAudioPlan {
  const sentences = content.passage.paragraphs.flatMap((paragraph) => paragraph.sentences);
  const sentenceClips = sentences.flatMap((sentence) => sentenceClipSpecs(sentence));
  const selected = selectFocusWords(content);
  const focusWords: FocusWordPlan[] = [];
  const wordClips: AudioClipSpec[] = [];
  const skipped: CurriculumAudioPlan['skipped'] = [];

  for (const focus of selected) {
    const specs = wordClipSpecs(focus, options.knownPhonemes, skipped);
    if (!specs.length) continue;
    focusWords.push({ ...focus, pos: '', examples: [], clips: specs });
    wordClips.push(...specs);
  }

  return { sentenceClips, focusWords, wordClips, skipped };
}

/** 逐句双速：normal 1.0 自然语速，slow 0.65 清晰慢速。 */
export function sentenceClipSpecs(sentence: PassageSentence): AudioClipSpec[] {
  const text = sentence.en.trim();
  if (!text) return [];
  return [
    {
      clipKey: `sentence:${sentence.id}`,
      kind: 'sentence',
      partIndex: 0,
      position: 0,
      speedTier: 'normal',
      speed: 1,
      text,
      voiceStyle: 'gentle',
      pronunciationMode: 'natural',
    },
    {
      clipKey: `sentence:${sentence.id}`,
      kind: 'sentence',
      partIndex: 0,
      position: 1,
      speedTier: 'slow',
      speed: 0.65,
      text,
      voiceStyle: 'gentle',
      pronunciationMode: 'slow_clear',
    },
  ];
}

/**
 * 选 2–4 个重点词。
 *
 * 评分只看课文与已发布词条，不调用模型：复现次数、多音节、困难音素、是否被句子标为
 * keyWord。没有足够词条时用句子 keyWords 补位，但绝不凭空造音标或释义。
 */
export function selectFocusWords(
  content: Pick<TextbookUnitContent, 'passage' | 'vocabulary' | 'activities'>,
): FocusWordSelection[] {
  const sentences = content.passage.paragraphs.flatMap((paragraph) => paragraph.sentences);
  const fullText = sentences.map((sentence) => sentence.en).join(' ');
  const keyWordSet = new Set(sentences.flatMap((sentence) => sentence.keyWords).map(lower));
  const vocabulary = new Map(
    content.vocabulary
      .filter((entry) => WORD_RE.test(entry.word.trim()))
      .map((entry) => [lower(entry.word), entry]),
  );
  const candidates = new Map<string, FocusWordSelection & { score: number }>();

  const addCandidate = (wordRaw: string, entry?: TextbookUnitContent['vocabulary'][number], index = 99) => {
    const word = wordRaw.trim();
    const key = lower(word);
    if (!WORD_RE.test(word) || word.length > 32) return;
    const existing = candidates.get(key);
    const syllables = entry?.syllables?.length
      ? normalizeSyllables(word, entry.syllables)
      : splitSyllables(word);
    const difficult = uniquePhonemes(entry?.difficultPhonemes ?? []);
    const occurrences = countWord(fullText, word);
    const score = occurrences * 2
      + (syllables.length > 1 ? 2 : 0)
      + difficult.length * 4
      + (keyWordSet.has(key) ? 3 : 0)
      + Math.max(0, 10 - index) / 10;
    const reasonParts = [
      occurrences > 1 ? `课文出现 ${occurrences} 次` : '课文重点词',
      syllables.length > 1 ? `${syllables.length} 个音节` : '',
      difficult.length ? `困难音素 ${difficult.join(' ')}` : '',
    ].filter(Boolean);
    const next: FocusWordSelection & { score: number } = {
      word: entry?.word?.trim() || word,
      phonetic: entry?.phonetic?.trim().slice(0, 100) ?? '',
      meaningZh: entry?.meaningZh?.trim().slice(0, 200) ?? '',
      syllables,
      difficultPhonemes: difficult,
      reason: reasonParts.join('；').slice(0, 200),
      score,
    };
    if (!existing || existing.score < score) candidates.set(key, next);
  };

  content.vocabulary.forEach((entry, index) => addCandidate(entry.word, entry, index));
  sentences.forEach((sentence) => sentence.keyWords.forEach((word) => addCandidate(word)));
  content.activities.forEach((activity) => {
    activity.targetWords.forEach((word) => addCandidate(word, vocabulary.get(lower(word))));
  });

  const ranked = [...candidates.values()].sort((left, right) =>
    right.score - left.score || left.word.localeCompare(right.word));

  const chosen: Array<FocusWordSelection & { score: number }> = [];
  for (const item of ranked) {
    // 优先保证至少两个词有真实词条信息；没有词条的词只在数量不足时补位。
    const rich = Boolean(item.phonetic || item.meaningZh || item.syllables.length > 1);
    if (!rich && chosen.length < MIN_FOCUS_WORDS && ranked.some((other) => other !== item
      && Boolean(other.phonetic || other.meaningZh || other.syllables.length > 1))) {
      continue;
    }
    chosen.push(item);
    if (chosen.length >= MAX_FOCUS_WORDS) break;
  }
  return chosen.map(({ score: _score, ...selection }) => selection);
}

export function wordClipSpecs(
  focus: FocusWordSelection,
  knownPhonemes: ReadonlySet<string> | undefined,
  skipped: CurriculumAudioPlan['skipped'],
): AudioClipSpec[] {
  const word = focus.word.trim();
  if (!WORD_RE.test(word)) return [];
  const specs: AudioClipSpec[] = [];
  let position = 0;
  const push = (
    kind: FocusWordClipKind,
    text: string,
    speedTier: AudioSpeedTier,
    speed: number,
    pronunciationMode: AudioClipSpec['pronunciationMode'],
    partIndex = 0,
  ) => {
    specs.push({
      clipKey: `word:${word.toLowerCase()}`,
      kind,
      partIndex,
      position: position++,
      speedTier,
      speed,
      text,
      voiceStyle: 'gentle',
      pronunciationMode,
    });
  };

  // 1. 整词慢速
  push('word', word, 'slow', 0.65, 'slow_clear');

  // 2. 音节逐个；单音节词不重复造一份和整词相同的音频。
  if (focus.syllables.length > 1) {
    focus.syllables.forEach((syllable, index) => {
      push('syllable', syllable, 'slow', 0.65, 'syllable_by_syllable', index);
    });
  }

  // 3. 困难音素单独；只使用已声明且（如有音素表）已收录的符号。
  let phonemeIndex = 0;
  for (const phoneme of focus.difficultPhonemes) {
    const normalized = normalizePhoneme(phoneme);
    if (!normalized) continue;
    if (knownPhonemes && knownPhonemes.size > 0 && !knownPhonemes.has(normalized)) {
      skipped.push({ clipKey: `word:${word.toLowerCase()}`, text: normalized, reason: 'phoneme_not_in_inventory' });
      continue;
    }
    push('phoneme', normalized, 'extra_slow', 0.55, 'syllable_by_syllable', phonemeIndex++);
  }

  // 4. 音节合成：用逗号制造停顿，再由客户端按片段顺序播放。
  if (focus.syllables.length > 1) {
    push('blend', focus.syllables.join(', '), 'slow', 0.65, 'syllable_by_syllable');
  }

  // 5. 恢复自然语速
  push('natural', word, 'normal', 1, 'natural');
  return specs;
}

/** 把多个来源的音节候选收敛成可拼接的安全结果；拼接不一致时回退算法切分。 */
export function normalizeSyllables(word: string, syllables: string[]): string[] {
  const clean = syllables
    .map((part) => part.trim().toLowerCase().replace(/[^a-z']/g, ''))
    .filter(Boolean);
  if (clean.length > 1 && clean.join('') === word.toLowerCase().replace(/[^a-z']/g, '')) {
    return clean;
  }
  return splitSyllables(word);
}

/** 与教材生成器一致的轻量音节切分；无法可靠切分时返回整词。 */
export function splitSyllables(word: string): string[] {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length <= 3) return [clean];
  const parts = clean.match(/[^aeiou]*[aeiou]+(?:[^aeiou](?=[^aeiou]*[aeiou])|$)/g) ?? [];
  return parts.length > 1 && parts.join('') === clean ? parts : [clean];
}

export function normalizePhoneme(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '').slice(0, 16);
}

function uniquePhonemes(values: string[]): string[] {
  return [...new Set(values.map(normalizePhoneme).filter(Boolean))].slice(0, 6);
}

function countWord(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`\\b${escaped}\\b`, 'gi')) ?? []).length;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * P1：整句音标。逐词查表拼接，任一词缺音标就返回空——
 * 宁可客户端不显示，也不展示半截音标误导孩子。
 */
function sentencePhonetic(
  sentence: string,
  table?: ReadonlyMap<string, string>,
): string {
  if (!table || table.size === 0) return '';
  const words = sentence.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  if (!words.length) return '';
  const parts: string[] = [];
  for (const word of words) {
    const phonetic = table.get(word)?.trim();
    if (!phonetic) return '';
    parts.push(phonetic.replace(/^\/|\/$/g, '').trim());
  }
  return `/${parts.join(' ')}/`;
}

/**
 * 把数据库中的片段套回课文与重点词。
 * 未准备好的片段保留 key、audioRef=null，客户端据此显示“正在准备”。
 */
export function assembleCurriculumPassage(input: {
  unitId: string;
  topicId: string;
  contentVersion: string;
  content: Pick<TextbookUnitContent, 'passage' | 'vocabulary' | 'activities'>;
  clips: Array<{
    clipKey: string;
    kind: string;
    partIndex: number;
    position: number;
    speedTier: string;
    speed: number;
    text: string;
    audioRef: string | null;
    durationMs: number | null;
    status: string;
  }>;
  knownPhonemes?: ReadonlySet<string>;
  /** P1：词形（小写）→ 音标，用于拼整句音标；查不全就留空。 */
  wordPhonetic?: ReadonlyMap<string, string>;
  /** P2：词形（小写）→ 词性；词库无词性时留空。 */
  wordPos?: ReadonlyMap<string, string>;
}): CurriculumPassage {
  const plan = buildCurriculumAudioPlan(input.content, { knownPhonemes: input.knownPhonemes });
  const byIdentity = new Map(
    input.clips.map((clip) => [identity(clip.clipKey, clip.kind, clip.partIndex, clip.speedTier), clip]),
  );
  let audioReady = false;

  const paragraphs = input.content.passage.paragraphs.map((paragraph) => ({
    sentences: paragraph.sentences.map((sentence) => {
      const normal = byIdentity.get(identity(`sentence:${sentence.id}`, 'sentence', 0, 'normal'));
      const slow = byIdentity.get(identity(`sentence:${sentence.id}`, 'sentence', 0, 'slow'));
      if (normal?.audioRef) audioReady = true;
      return {
        ...sentence,
        // 词表/AI 优先；存量 sentence.phonetic 只当兜底（生成期可能给出 helped→/help/ 这类错音）。
        phonetic: sentencePhonetic(sentence.en, input.wordPhonetic) || sentence.phonetic || '',
        audio: {
          normalKey: `sentence:${sentence.id}:normal`,
          slowKey: `sentence:${sentence.id}:slow`,
          ...(normal?.audioRef ? { normalRef: normal.audioRef } : {}),
          ...(slow?.audioRef ? { slowRef: slow.audioRef } : {}),
          normalSpeed: 1,
          slowSpeed: 0.65,
          ...(normal?.durationMs ? { normalDurationMs: normal.durationMs } : {}),
          ...(slow?.durationMs ? { slowDurationMs: slow.durationMs, durationMs: slow.durationMs } : {}),
        },
      };
    }),
  }));

  const focusWords = plan.focusWords.map((focus) => {
    const vocabulary = input.content.vocabulary.find(
      (item) => item.word.trim().toLowerCase() === focus.word.trim().toLowerCase(),
    );
    const examples = (vocabulary?.exampleSentences ?? [])
      .map((example) => ({ en: example.en.trim(), zh: (example.zh ?? '').trim() }))
      .filter((example) => example.en.length > 0)
      .slice(0, 3);
    return {
      ...focus,
      // 词表/AI 有权威读音时覆盖单元词条（dishes 应为 /ˈdɪʃɪz/，不是 /diʃ/）。
      phonetic: input.wordPhonetic?.get(focus.word.trim().toLowerCase()) || focus.phonetic,
      pos: input.wordPos?.get(focus.word.trim().toLowerCase()) ?? '',
      examples,
      clips: focus.clips.map((spec) => {
      const stored = byIdentity.get(identity(spec.clipKey, spec.kind, spec.partIndex, spec.speedTier));
      return {
        key: clipKey(spec),
        kind: spec.kind as FocusWordClipKind,
        partIndex: spec.partIndex,
        position: stored?.position ?? spec.position,
        speedTier: spec.speedTier,
        speed: stored?.speed ?? spec.speed,
        text: stored?.text ?? spec.text,
        audioRef: stored?.audioRef ?? null,
        durationMs: stored?.durationMs ?? null,
        status: normalizeClipStatus(stored?.status),
      };
      }),
    };
  });

  return {
    unitId: input.unitId,
    topicId: input.topicId,
    contentVersion: input.contentVersion,
    audioReady,
    title: input.content.passage.title,
    paragraphs,
    focusWords,
  };
}

function clipKey(spec: AudioClipSpec): string {
  return spec.kind === 'sentence'
    ? `${spec.clipKey}:${spec.speedTier}`
    : `${spec.clipKey}:${spec.kind}:${spec.partIndex}:${spec.speedTier}`;
}

function identity(clipKeyValue: string, kind: string, partIndex: number, speedTier: string): string {
  return `${clipKeyValue}|${kind}|${partIndex}|${speedTier}`;
}

function normalizeClipStatus(status: string | undefined): 'ready' | 'failed' | 'stale' {
  return status === 'ready' || status === 'failed' ? status : 'stale';
}

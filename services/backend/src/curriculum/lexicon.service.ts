import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  LexiconDomain,
  LexiconLookupEntry,
  LexiconMatchSource,
} from '@alg/shared-contracts';
import { PrismaService } from '../prisma/prisma.service';

type LexiconRow = {
  word: string;
  lemma: string;
  familyKey: string;
  familyRank: number | null;
  phonetic: string;
  pos: string;
  meaningZh: string;
  frequencyRank: number | null;
  bncRank: number | null;
  tags: string[];
  domains: string[];
  variants: string[];
  collocations: Prisma.JsonValue;
  examples: Prisma.JsonValue;
  source: string;
  license: string;
  childSafe: boolean;
  isCore: boolean;
  isFunctionWord: boolean;
  textbookUnitIds: string[];
};

type TextbookMetadataEntry = {
  word: string;
  phonetic?: string;
  meaningZh?: string;
  pos?: string;
};

export type LexiconLookupOptions = {
  /** 指定教材单元时，metadata 中的词优先于全局词库。 */
  textbookUnitId?: string;
  /** 词表入口本身来自教材；即使还没写入 textbook_units.metadata，也按教材词优先。 */
  textbookWords?: string[];
};

type CoverageRow = {
  word: string;
  variants: string[];
  phonetic: string;
  meaningZh: string;
  isCore: boolean;
};

export type LexiconCoverageWord = {
  /** 教材词表里的原始词形（已做小写和去序号）。 */
  word: string;
  /** lexicon_entries 里实际命中的词族代表词。 */
  matchedWord: string;
  phonetic: string;
  meaningZh: string;
  /** 同教材更早单元出现过该词族时，记录来源单元编码。 */
  priorUnitCodes: string[];
};

export type LexiconUnitCoverage = {
  unit: {
    id: string;
    textbookId: string;
    unitCode: string;
    title: string;
    order: number;
  };
  counts: {
    total: number;
    covered: number;
    newWords: number;
    reusedWords: number;
    gaps: number;
  };
  /** covered / total；总词表为空时为 0。 */
  hitRate: number;
  newWords: LexiconCoverageWord[];
  reusedWords: LexiconCoverageWord[];
  gaps: string[];
  fieldCoverage: {
    phonetic: number;
    meaningZh: number;
    phoneticRate: number;
    meaningZhRate: number;
  };
  coreWords: number;
  /** 核心词 / 单元总词数。 */
  coreRate: number;
  method: {
    priorScope: 'same_textbook_earlier_units';
    priorUnitCount: number;
  };
};

/**
 * 词库查询服务。优先级固定为：
 *   教材单元 metadata / 教材词表 > lexicon_entries（含 textbookUnitIds 标记）> 未命中。
 *
 * 教材数据只补齐字段，不把 ECDICT 的通用释义反向覆盖教材释义。
 */
@Injectable()
export class LexiconService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(word: string, options: LexiconLookupOptions = {}): Promise<LexiconLookupEntry | null> {
    const normalized = normalizeWord(word);
    if (!normalized) return null;
    const entries = await this.lookupMany([normalized], options);
    return entries.get(normalized) ?? null;
  }

  async lookupMany(words: string[], options: LexiconLookupOptions = {}): Promise<Map<string, LexiconLookupEntry>> {
    const normalized = [...new Set(words.map(normalizeWord).filter(Boolean))];
    if (!normalized.length) return new Map();

    const metadataPromise = options.textbookUnitId
      ? this.prisma.textbook_units.findUnique({
          where: { id: options.textbookUnitId },
          select: { metadata: true },
        })
      : Promise.resolve(null);
    // PostgreSQL IN 列表不设硬上限，但大词表分段查询可以避免单条 SQL 过长。
    const rowChunks = await Promise.all(chunk(normalized, 500).map((batch) =>
      this.prisma.lexicon_entries.findMany({
        where: {
          OR: [
            { word: { in: batch } },
            { variants: { hasSome: batch } },
          ],
        },
      }),
    ));
    const textbookMetadata = await metadataPromise;
    const textbookUnitId = options.textbookUnitId;
    const rows = rowChunks.flat();

    const textbookEntries = extractTextbookMetadata(textbookMetadata?.metadata);
    const textbookWords = new Set((options.textbookWords ?? []).map(normalizeWord).filter(Boolean));
    const byForm = new Map<string, LexiconRow>();
    for (const row of rows as LexiconRow[]) {
      byForm.set(row.word, row);
      for (const variant of row.variants) {
        if (!byForm.has(variant)) byForm.set(variant, row);
      }
    }

    const output = new Map<string, LexiconLookupEntry>();
    for (const input of normalized) {
      const global = byForm.get(input);
      const textbook = textbookEntries.get(input);
      const fromTextbook = Boolean(textbook || textbookWords.has(input) || (global?.textbookUnitIds.length ?? 0) > 0);
      if (!global && !textbook && !textbookWords.has(input)) continue;
      output.set(input, toLookupEntry({
        input,
        row: global,
        textbook,
        textbookUnitId,
        matchSource: fromTextbook ? 'textbook' : 'ecdict',
      }));
    }
    return output;
  }

  /**
   * 教材单元词表覆盖率。
   *
   * 口径：
   *  - 命中：词表词条按 word 或 variants 在 lexicon_entries 中找到；
   *  - 新词：已命中，且同一教材更早单元未出现该词族；
   *  - 复用：已命中，且同一教材更早单元已出现该词族；
   *  - 缺口：未命中 lexicon_entries（教材 metadata 自带的释义不算词库命中）。
   */
  async textbookUnitCoverage(unitId: string): Promise<LexiconUnitCoverage | null> {
    const unit = await this.prisma.textbook_units.findUnique({
      where: { id: unitId },
      select: {
        id: true,
        textbookId: true,
        unitCode: true,
        title: true,
        order: true,
        metadata: true,
      },
    });
    if (!unit) return null;

    const words = extractUnitWordList(unit.metadata);
    const priorUnits = await this.prisma.textbook_units.findMany({
      where: {
        textbookId: unit.textbookId,
        order: { lt: unit.order },
        id: { not: unit.id },
      },
      select: { unitCode: true, order: true, metadata: true },
      orderBy: [{ order: 'asc' }, { unitCode: 'asc' }],
    });

    const priorCodesByWord = new Map<string, Set<string>>();
    for (const prior of priorUnits) {
      for (const word of extractUnitWordList(prior.metadata)) {
        const codes = priorCodesByWord.get(word) ?? new Set<string>();
        codes.add(prior.unitCode);
        priorCodesByWord.set(word, codes);
      }
    }

    const rowChunks = words.length
      ? await Promise.all(chunk(words, 500).map((batch) => this.prisma.lexicon_entries.findMany({
        where: {
          OR: [
            { word: { in: batch } },
            { variants: { hasSome: batch } },
          ],
        },
        select: { word: true, variants: true, phonetic: true, meaningZh: true, isCore: true },
      })))
      : [];
    const byForm = new Map<string, CoverageRow>();
    for (const row of rowChunks.flat() as CoverageRow[]) {
      const canonical = normalizeWord(row.word);
      if (canonical) byForm.set(canonical, row);
      for (const variant of row.variants) {
        const normalized = normalizeWord(variant);
        if (normalized && !byForm.has(normalized)) byForm.set(normalized, row);
      }
    }

    const newWords: LexiconCoverageWord[] = [];
    const reusedWords: LexiconCoverageWord[] = [];
    const gaps: string[] = [];
    let phonetic = 0;
    let meaningZh = 0;
    let coreWords = 0;

    for (const word of words) {
      const row = byForm.get(word);
      if (!row) {
        gaps.push(word);
        continue;
      }
      if (row.phonetic.trim()) phonetic += 1;
      if (row.meaningZh.trim()) meaningZh += 1;
      if (row.isCore) coreWords += 1;

      const priorCodes = new Set<string>();
      for (const form of [word, row.word, ...row.variants]) {
        const normalized = normalizeWord(form);
        const codes = normalized ? priorCodesByWord.get(normalized) : undefined;
        if (!codes) continue;
        for (const code of codes) priorCodes.add(code);
      }
      const item: LexiconCoverageWord = {
        word,
        matchedWord: row.word,
        phonetic: row.phonetic,
        meaningZh: row.meaningZh,
        priorUnitCodes: [...priorCodes].sort((left, right) => left.localeCompare(right)),
      };
      if (priorCodes.size) reusedWords.push(item);
      else newWords.push(item);
    }

    const covered = newWords.length + reusedWords.length;
    return {
      unit: {
        id: unit.id,
        textbookId: unit.textbookId,
        unitCode: unit.unitCode,
        title: unit.title,
        order: unit.order,
      },
      counts: {
        total: words.length,
        covered,
        newWords: newWords.length,
        reusedWords: reusedWords.length,
        gaps: gaps.length,
      },
      hitRate: words.length ? covered / words.length : 0,
      newWords,
      reusedWords,
      gaps,
      fieldCoverage: {
        phonetic,
        meaningZh,
        phoneticRate: covered ? phonetic / covered : 0,
        meaningZhRate: covered ? meaningZh / covered : 0,
      },
      coreWords,
      coreRate: words.length ? coreWords / words.length : 0,
      method: {
        priorScope: 'same_textbook_earlier_units',
        priorUnitCount: priorUnits.length,
      },
    };
  }

  /** 管理端词库概览：核心/扩展、教材词、音标与中文覆盖。 */
  async stats() {
    const [total, core, textbook, phoneticCore, meaningCore] = await Promise.all([
      this.prisma.lexicon_entries.count(),
      this.prisma.lexicon_entries.count({ where: { isCore: true } }),
      this.prisma.lexicon_entries.count({ where: { textbookUnitIds: { isEmpty: false } } }),
      this.prisma.lexicon_entries.count({ where: { isCore: true, phonetic: { not: '' } } }),
      this.prisma.lexicon_entries.count({ where: { isCore: true, meaningZh: { not: '' } } }),
    ]);
    return {
      total,
      core,
      extension: Math.max(0, total - core),
      textbook,
      corePhoneticCoverage: core ? phoneticCore / core : 0,
      coreMeaningCoverage: core ? meaningCore / core : 0,
    };
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

export function normalizeWord(value: unknown): string {  if (typeof value !== 'string') return '';
  const word = value.trim().toLowerCase();
  if (!word || word.length > 100) return '';
  return word;
}

/** 教材单元词表来源：metadata.words / wordList / vocabulary / keyWords，以及已生成内容里的 vocabulary。 */
export function extractUnitWordList(metadata: unknown): string[] {
  const record = asRecord(metadata);
  const output: string[] = [];
  const seen = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const word = normalizeWord(value.trim().replace(/^\d+[.)]\s*/, ''));
    if (!word || seen.has(word)) return;
    seen.add(word);
    output.push(word);
  };
  const addCollection = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') add(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const entry = item as Record<string, unknown>;
          add(entry.word ?? entry.text);
        }
      }
      return;
    }
    if (typeof value === 'string') {
      for (const item of value.split(/\r?\n|[,，;；]/)) add(item);
    }
  };

  for (const key of ['words', 'wordList', 'vocabulary', 'keyWords']) addCollection(record[key]);
  const content = asRecord(record.content);
  addCollection(content.vocabulary);
  addCollection(content.keyWords);
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function extractTextbookMetadata(metadata: unknown): Map<string, TextbookMetadataEntry> {
  const output = new Map<string, TextbookMetadataEntry>();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return output;
  const record = metadata as Record<string, unknown>;
  for (const key of ['words', 'wordList', 'vocabulary', 'keyWords']) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const entry = toTextbookEntry(item);
      if (!entry) continue;
      const existing = output.get(entry.word);
      output.set(entry.word, existing ? { ...existing, ...entry } : entry);
    }
  }
  return output;
}

function toTextbookEntry(value: unknown): TextbookMetadataEntry | null {
  if (typeof value === 'string') {
    const word = normalizeWord(value);
    return word ? { word } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const word = normalizeWord(record.word ?? record.text);
  if (!word) return null;
  return {
    word,
    ...(typeof record.phonetic === 'string' && record.phonetic.trim() ? { phonetic: record.phonetic.trim() } : {}),
    ...(typeof record.ipa === 'string' && record.ipa.trim() ? { phonetic: record.ipa.trim() } : {}),
    ...(typeof record.meaningZh === 'string' && record.meaningZh.trim() ? { meaningZh: record.meaningZh.trim() } : {}),
    ...(typeof record.meaning === 'string' && record.meaning.trim() ? { meaningZh: record.meaning.trim() } : {}),
    ...(typeof record.translation === 'string' && record.translation.trim() ? { meaningZh: record.translation.trim() } : {}),
    ...(typeof record.pos === 'string' && record.pos.trim() ? { pos: record.pos.trim() } : {}),
  };
}

function toLookupEntry(input: {
  input: string;
  row?: LexiconRow;
  textbook?: TextbookMetadataEntry;
  textbookUnitId?: string;
  matchSource: LexiconMatchSource;
}): LexiconLookupEntry {
  const { row, textbook } = input;
  const textbookUnitIds = [...new Set([
    ...(row?.textbookUnitIds ?? []),
    ...(textbook && input.textbookUnitId ? [input.textbookUnitId] : []),
  ])];
  return {
    word: row?.word ?? textbook?.word ?? input.input,
    lemma: row?.lemma || textbook?.word || input.input,
    familyKey: row?.familyKey || row?.lemma || textbook?.word || input.input,
    ...(row?.familyRank ? { familyRank: row.familyRank } : {}),
    phonetic: textbook?.phonetic || row?.phonetic || '',
    pos: textbook?.pos || row?.pos || '',
    meaningZh: textbook?.meaningZh || row?.meaningZh || '',
    ...(row?.frequencyRank ? { frequencyRank: row.frequencyRank } : {}),
    ...(row?.bncRank ? { bncRank: row.bncRank } : {}),
    tags: row?.tags ?? [],
    domains: (row?.domains ?? []) as LexiconDomain[],
    variants: row?.variants ?? [input.input],
    collocations: toStringArray(row?.collocations),
    examples: toExamples(row?.examples),
    source: row?.source ?? 'textbook',
    license: row?.license ?? 'textbook',
    childSafe: row?.childSafe ?? true,
    isCore: row?.isCore ?? false,
    isFunctionWord: row?.isFunctionWord ?? false,
    textbookUnitIds,
    matchSource: input.matchSource,
    matchedForm: input.input,
  };
}

function toStringArray(value: Prisma.JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toExamples(value: Prisma.JsonValue | undefined): Array<{ en: string; zh: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.en === 'string' && record.en.trim()
      ? [{ en: record.en.trim(), zh: typeof record.zh === 'string' ? record.zh : '' }]
      : [];
  });
}

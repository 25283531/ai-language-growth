export type CoverageWord = {
  word: string;
  matchedWord: string;
  phonetic: string;
  meaningZh: string;
  priorUnitCodes: string[];
};

export type LexiconCoverage = {
  unit: { id: string; textbookId: string; unitCode: string; title: string; order: number };
  counts: { total: number; covered: number; newWords: number; reusedWords: number; gaps: number };
  hitRate: number;
  newWords: CoverageWord[];
  reusedWords: CoverageWord[];
  gaps: string[];
  fieldCoverage: { phonetic: number; meaningZh: number; phoneticRate: number; meaningZhRate: number };
  coreWords: number;
  coreRate: number;
  method: { priorScope: 'same_textbook_earlier_units'; priorUnitCount: number };
};

export type CoverageUnit = {
  id: string;
  textbookId: string;
  unitCode: string;
  title: string;
  order: number;
};

export type TextbookCoverageGap = {
  word: string;
  unitCodes: string[];
};

export type TextbookCoverageSummary = {
  textbookId: string;
  unitCount: number;
  totalWords: number;
  coveredWords: number;
  hitRate: number;
  gaps: TextbookCoverageGap[];
  gapUnitCount: number;
};

/**
 * 整册汇总只复用单元 lexicon-coverage 的结果：
 * 同一词在多个单元出现只计一次；任一单元命中即算已覆盖，缺口只保留所有单元都未命中的词。
 */
export function summarizeTextbookCoverage(
  entries: Array<{ unit: CoverageUnit; coverage: LexiconCoverage }>,
  textbookId: string,
): TextbookCoverageSummary {
  const words = new Map<string, { word: string; covered: boolean; unitCodes: Set<string> }>();

  function add(word: string, covered: boolean, unitCode: string) {
    const existing = words.get(word);
    if (!existing) {
      words.set(word, { word, covered, unitCodes: new Set([unitCode]) });
      return;
    }
    existing.covered = existing.covered || covered;
    existing.unitCodes.add(unitCode);
  }

  for (const { unit, coverage } of entries) {
    for (const word of [...coverage.newWords, ...coverage.reusedWords]) add(word.word, true, unit.unitCode);
    for (const word of coverage.gaps) add(word, false, unit.unitCode);
  }

  const records = [...words.values()];
  const gaps = records
    .filter((item) => !item.covered)
    .map((item) => ({ word: item.word, unitCodes: [...item.unitCodes].sort((left, right) => left.localeCompare(right)) }))
    .sort((left, right) => left.word.localeCompare(right.word));
  const coveredWords = records.filter((item) => item.covered).length;
  const gapUnits = new Set(gaps.flatMap((item) => item.unitCodes));

  return {
    textbookId,
    unitCount: entries.length,
    totalWords: records.length,
    coveredWords,
    hitRate: records.length ? coveredWords / records.length : 0,
    gaps,
    gapUnitCount: gapUnits.size,
  };
}

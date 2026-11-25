import type { LexiconRecord } from './types';

export type CoverageEntry = Pick<LexiconRecord, 'word' | 'variants' | 'isCore'>;

export type CoverageTarget = {
  id: string;
  label: string;
  words: string[];
  /** 目标词表来源说明，写进报告，避免把课标代理词误写成某本教材原文。 */
  note?: string;
};

export type CoverageSlice = {
  total: number;
  covered: number;
  rate: number;
  gaps: string[];
};

export type TargetCoverage = {
  id: string;
  label: string;
  note?: string;
  before: CoverageSlice;
  after: CoverageSlice;
  /** after.covered - before.covered，只统计本次由扩展层新增覆盖的目标词。 */
  added: number;
  /** after.rate - before.rate，单位为比例，不是百分数。 */
  improvement: number;
};

export type LexiconCoverageReport = {
  baselineFamilies: number;
  expandedFamilies: number;
  targets: TargetCoverage[];
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 计算 3,000 核心层与 5,000 全量层对目标词表的覆盖。
 *
 * 命中规则与 LexiconService.textbookUnitCoverage 保持一致：
 * 目标词命中 `word` 或任一词族 `variants` 都算已覆盖；同一目标词重复出现只计一次。
 * 这里刻意不把“教材 metadata 自带的释义”算作命中，因为本报告衡量的是
 * 全局词库能否直接提供词条，而不是教材是否自带释义。
 */
export function buildLexiconCoverageReport(
  entries: CoverageEntry[],
  targets: CoverageTarget[],
): LexiconCoverageReport {
  const beforeForms = new Map<string, CoverageEntry>();
  const afterForms = new Map<string, CoverageEntry>();
  for (const entry of entries) {
    const forms = new Set([entry.word, ...entry.variants].map(normalize).filter(Boolean));
    for (const form of forms) {
      if (!afterForms.has(form)) afterForms.set(form, entry);
      if (entry.isCore && !beforeForms.has(form)) beforeForms.set(form, entry);
    }
  }

  const results = targets.map((target): TargetCoverage => {
    const unique = [...new Set(target.words.map(normalize).filter(Boolean))];
    let beforeCovered = 0;
    let afterCovered = 0;
    const gaps: string[] = [];
    for (const word of unique) {
      const after = afterForms.get(word);
      if (beforeForms.has(word)) beforeCovered += 1;
      if (after) afterCovered += 1;
      else gaps.push(word);
    }
    const total = unique.length;
    return {
      id: target.id,
      label: target.label,
      ...(target.note ? { note: target.note } : {}),
      before: {
        total,
        covered: beforeCovered,
        rate: total ? beforeCovered / total : 0,
        gaps: total ? unique.filter((word) => !beforeForms.has(word)) : [],
      },
      after: {
        total,
        covered: afterCovered,
        rate: total ? afterCovered / total : 0,
        gaps,
      },
      added: afterCovered - beforeCovered,
      improvement: total ? (afterCovered - beforeCovered) / total : 0,
    };
  });

  const coreCount = entries.filter((entry) => entry.isCore).length;
  return {
    baselineFamilies: coreCount,
    expandedFamilies: entries.length,
    targets: results,
  };
}

export function formatCoverageRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatCoverageDelta(delta: number): string {
  const value = delta * 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}pp`;
}

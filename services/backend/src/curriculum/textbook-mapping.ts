import type { TextbookModule } from '@alg/shared-contracts';
import { M1_SKILL_NODES } from '@alg/skill-graph';
import { mapTextbookUnitToSkillNodeIds } from './textbook-skill-mapping';

/**
 * 教材单元映射的读取与推断。
 *
 * 存储映射是管理员的显式配置；没有存储映射时，按单元标题/编码/课文关键词
 * 做确定性推断，并标记 `inferred`。推断结果只决定“生成哪些学校轨活动”，
 * 不参与掌握判定，也不作为学习者门槛。
 */

export const TEXTBOOK_MAPPING_SOURCES = ['editorial', 'ai', 'inferred'] as const;
export type TextbookMappingSource = (typeof TEXTBOOK_MAPPING_SOURCES)[number];

const SCHOOL_MODULES: readonly TextbookModule[] = ['A', 'B', 'C', 'D', 'E'];
const KNOWN_SKILL_NODE_IDS = new Set(M1_SKILL_NODES.map((node) => node.id));

const MODULE_BY_SKILL_NODE: Readonly<Record<string, TextbookModule>> = Object.freeze({
  'SE.SCHOOL.letters': 'A',
  'SE.SCHOOL.phonics': 'B',
  'SE.SCHOOL.word_reading': 'C',
  'SE.SCHOOL.reading': 'C',
  'SE.SCHOOL.spelling': 'D',
  'SE.SCHOOL.writing': 'D',
});

export interface StoredTextbookUnitMapping {
  skillNodeIds: unknown;
  domains: unknown;
  schoolModules: unknown;
  stageHint: number | null;
  source: string;
  version: number;
}

export interface TextbookMappingSubject {
  unitCode: string;
  title: string;
  textbookTitle?: string | null;
  grade?: string | null;
  grammarFocus?: string[];
  metadataModules?: string[];
}

export interface EffectiveTextbookUnitMapping {
  skillNodeIds: string[];
  domains: string[];
  schoolModules: TextbookModule[];
  stageHint: number | null;
  source: TextbookMappingSource;
  origin: 'stored' | 'inferred';
  version: number;
}

function uniqueStrings(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

export function normalizeSkillNodeIds(value: unknown): string[] {
  return uniqueStrings(value, 30).filter((id) => KNOWN_SKILL_NODE_IDS.has(id));
}

export function normalizeDomains(value: unknown): string[] {
  return uniqueStrings(value, 20).map((domain) => domain.slice(0, 80));
}

export function normalizeSchoolModules(value: unknown): TextbookModule[] {
  return uniqueStrings(value, 5)
    .map((module) => module.toUpperCase())
    .filter((module): module is TextbookModule => (SCHOOL_MODULES as readonly string[]).includes(module))
    .sort((left, right) => SCHOOL_MODULES.indexOf(left) - SCHOOL_MODULES.indexOf(right));
}

function normalizeStageHint(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6 ? value : null;
}

function normalizeSource(value: unknown): TextbookMappingSource {
  return typeof value === 'string' && (TEXTBOOK_MAPPING_SOURCES as readonly string[]).includes(value)
    ? value as TextbookMappingSource
    : 'editorial';
}

/**
 * 从单元标题和已推断出的能力节点推导学校 A-E 模块。
 *
 * 不为了“覆盖全部模块”而硬塞：没有学校轨线索时返回空数组。
 */
export function inferSchoolModules(subject: TextbookMappingSubject, skillNodeIds: string[]): TextbookModule[] {
  const modules = new Set<TextbookModule>();
  for (const module of normalizeSchoolModules(subject.metadataModules)) modules.add(module);
  for (const skillNodeId of skillNodeIds) {
    const module = MODULE_BY_SKILL_NODE[skillNodeId];
    if (module) modules.add(module);
  }

  const text = [subject.unitCode, subject.title, ...(subject.grammarFocus ?? [])]
    .join(' ')
    .toLowerCase();
  const add = (module: TextbookModule, patterns: RegExp[]) => {
    if (patterns.some((pattern) => pattern.test(text))) modules.add(module);
  };
  add('A', [/\bletters?\b/, /\balphabet\b/, /字母/]);
  add('B', [/\bphonics?\b/, /\bletter sounds?\b/, /拼读/, /音素/]);
  add('C', [/\bread(?:ing)?\b/, /\bstory\b/, /\bpassage\b/, /阅读/, /故事/, /课文/]);
  add('D', [/\bspell(?:ing)?\b/, /\bwriting\b/, /\bhandwriting\b/, /拼写/, /书写/, /默写/]);
  add('E', [/\bgrammar\b/, /\bsentence patterns?\b/, /语法/, /句型/]);
  if ((subject.grammarFocus ?? []).length) modules.add('E');

  return [...modules].sort((left, right) => SCHOOL_MODULES.indexOf(left) - SCHOOL_MODULES.indexOf(right));
}

/** 没有存储映射时的确定性推断结果。 */
export function inferTextbookUnitMapping(subject: TextbookMappingSubject): EffectiveTextbookUnitMapping {
  const skillNodeIds = mapTextbookUnitToSkillNodeIds({
    unitCode: subject.unitCode,
    unitTitle: subject.title,
    textbookTitle: subject.textbookTitle,
    grade: subject.grade,
  });
  return {
    skillNodeIds,
    domains: [],
    schoolModules: inferSchoolModules(subject, skillNodeIds),
    stageHint: null,
    source: 'inferred',
    origin: 'inferred',
    version: 0,
  };
}

/** 存储映射优先；字段缺失时用推断值补齐，且保留来源。 */
export function resolveTextbookUnitMapping(
  stored: StoredTextbookUnitMapping | null | undefined,
  subject: TextbookMappingSubject,
): EffectiveTextbookUnitMapping {
  const inferred = inferTextbookUnitMapping(subject);
  if (!stored) return inferred;

  const skillNodeIds = normalizeSkillNodeIds(stored.skillNodeIds);
  const effectiveSkillNodeIds = skillNodeIds.length ? skillNodeIds : inferred.skillNodeIds;
  const schoolModules = normalizeSchoolModules(stored.schoolModules);
  return {
    skillNodeIds: effectiveSkillNodeIds,
    domains: normalizeDomains(stored.domains),
    schoolModules: schoolModules.length
      ? schoolModules
      : inferSchoolModules(subject, effectiveSkillNodeIds),
    stageHint: normalizeStageHint(stored.stageHint),
    source: normalizeSource(stored.source),
    origin: 'stored',
    version: Number.isInteger(stored.version) && stored.version > 0 ? stored.version : 1,
  };
}

/** 给控制器的校验与 UI 选项使用。 */
export function isKnownSkillNodeId(value: string): boolean {
  return KNOWN_SKILL_NODE_IDS.has(value);
}

/** 学校轨能力节点对应的 A-E 模块；非学校节点返回 undefined。 */
export function schoolModuleForSkillNode(value: string): TextbookModule | undefined {
  return MODULE_BY_SKILL_NODE[value];
}

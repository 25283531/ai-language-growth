/**
 * 学习者能力画像相关契约
 *
 * 依据：DECISIONS.md D-005「掌握状态：五种状态，必须有证据」
 *      V1.1 任务书第 4 章「能力分类」与「掌握判定的硬规则」
 *
 * 机读编码一经确定即视为稳定契约，M2 不得随意更名。
 */

/** 七个成长阶段：能力路径，不是必须依次通关的关卡（D-004）。 */
export const GROWTH_STAGES = [
  { stage: 0, code: 'orientation', name: '语言启蒙与适应' },
  { stage: 1, code: 'listening_reaction', name: '听力理解与语言反应' },
  { stage: 2, code: 'sound_formation', name: '声音辨别与发音形成' },
  { stage: 3, code: 'vocabulary_expression', name: '词汇理解与主动表达' },
  { stage: 4, code: 'phrase_sentence', name: '短语与完整句子' },
  { stage: 5, code: 'dialogue_organization', name: '对话与语言组织' },
  { stage: 6, code: 'autonomous_communication', name: '自主日常交流' },
] as const;

export type GrowthStage = (typeof GROWTH_STAGES)[number]['stage'];
export type GrowthStageCode = (typeof GROWTH_STAGES)[number]['code'];

/** 六大类语言能力 + 学校英语能力（D-006 / 任务书第 4 章）。 */
export const ABILITY_CATEGORIES = [
  'listening',
  'pronunciation',
  'vocabulary',
  'grammar',
  'speaking',
  'communication',
  'school_english',
] as const;

export type AbilityCategory = (typeof ABILITY_CATEGORIES)[number];

/**
 * 五大能力分类在能力节点编码中的域代码（domain）。
 * 与 ABILITY_CATEGORIES 一一对应，编码稳定后不得更名。
 */
export const ABILITY_DOMAIN_CODES = {
  listening: 'LISTEN',
  pronunciation: 'PRON',
  vocabulary: 'VOCAB',
  grammar: 'GRAM',
  speaking: 'SPEAK',
  communication: 'COMM',
  school_english: 'SCHOOL',
} as const;

export type AbilityDomainCode = (typeof ABILITY_DOMAIN_CODES)[keyof typeof ABILITY_DOMAIN_CODES];

/** 双轨代码。LA = 语言习得轨，SE = 学校英语轨（D-002）。 */
export const TRACK_CODES = {
  language_acquisition: 'LA',
  school_english: 'SE',
} as const;

export type TrackCode = (typeof TRACK_CODES)[keyof typeof TRACK_CODES];

/**
 * 五种掌握状态。
 *
 * ⚠️ 任务书 §4 的 profile JSON 示例使用了 "stable" / "developing" / "emerging"，
 * 与五态无一一对应关系，不可持久化。落地统一使用下列机读编码。
 */
export const MASTERY_STATES = [
  'not_exposed',
  'encountered',
  'forming',
  'mastered',
  'transferred',
] as const;

export type MasteryState = (typeof MASTERY_STATES)[number];

/**
 * 掌握状态在数据库中的机读编码（smallint，0–4）。
 * 任务书 §4：「编码在 M0 的数据库设计中定死」——此即定死版本，M2 不得改。
 */
export const MASTERY_STATE_CODES: Record<MasteryState, 0 | 1 | 2 | 3 | 4> = {
  not_exposed: 0,
  encountered: 1,
  forming: 2,
  mastered: 3,
  transferred: 4,
};

/** 机读编码 → 状态名。 */
export const MASTERY_STATE_BY_CODE: Record<0 | 1 | 2 | 3 | 4, MasteryState> = {
  0: 'not_exposed',
  1: 'encountered',
  2: 'forming',
  3: 'mastered',
  4: 'transferred',
};

export const MASTERY_STATE_LABELS: Record<MasteryState, string> = {
  not_exposed: '未接触',
  encountered: '初步接触',
  forming: '正在形成',
  mastered: '基本掌握',
  transferred: '稳定迁移',
};

/** 掌握状态晋级顺序索引，用于状态迁移合法性校验。 */
export const MASTERY_RANK: Record<MasteryState, number> = {
  not_exposed: 0,
  encountered: 1,
  forming: 2,
  mastered: 3,
  transferred: 4,
};

/**
 * 词汇掌握必须分五层独立评估（任务书第 4 章）。
 * 理解能力与表达能力永远独立评估、独立记录。
 */
export const VOCABULARY_DIMENSIONS = [
  'heard_identify', // 听到能识别图片
  'seen_speak', // 看到能说出
  'heard_pronounce', // 听到能正确发音
  'use_in_sentence', // 能在句子中使用
  'use_in_new_context', // 能在新情境中主动使用
] as const;

export type VocabularyDimension = (typeof VOCABULARY_DIMENSIONS)[number];

/** 双轨：语言习得轨与学校英语轨并行（D-002）。 */
export const LEARNING_TRACKS = ['language_acquisition', 'school_english'] as const;
export type LearningTrack = (typeof LEARNING_TRACKS)[number];

/** 能力节点之间的关系类型：前置、相关、可并行、后续（任务书第 4 章）。 */
export const DEPENDENCY_TYPES = ['prerequisite', 'related', 'parallel', 'subsequent'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

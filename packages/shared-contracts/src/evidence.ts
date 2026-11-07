/**
 * 学习证据事件契约 —— 约束三「教学数据必须有可靠证据」的核心。
 *
 * 依据：DECISIONS.md D-005、D-024 约束三；V1.1 任务书第 4 章
 * 「数据设计：当前状态 + 能力证据事件」。
 *
 * 硬规则：
 *  1. 任何掌握状态变更都必须能追溯到一条或多条 learning_evidence 记录。
 *  2. 不得仅凭 LLM 自我声称修改掌握状态：llm_judgement 来源的证据
 *     contributesToPromotion 恒为 false，且 credibility 上限 0.4。
 *  3. stable_transfer 需要两个不同场景独立使用 + 隔天无提示回忆，
 *     该规则由 skill-graph 判定，证据层只负责忠实记录。
 *  4. learning_evidence 只允许 INSERT，不允许 UPDATE / DELETE。
 */
import { z } from 'zod';
import {
  ABILITY_CATEGORIES,
  MASTERY_STATES,
  VOCABULARY_DIMENSIONS,
  type MasteryState,
} from './learner';

/**
 * 评估来源。程序管确定性、LLM 管理解推理、语音服务管音频事实，
 * 三者来源必须可区分（D-008）。
 */
export const EVIDENCE_SOURCES = [
  'pronunciation_api', // 专业发音评估：音素级事实
  'asr', // 语音识别转写结果
  'task_result', // 任务作答结果（点选、填空等确定性判定）
  'llm_judgement', // LLM 判断，仅作辅助证据
  'rule_engine', // 本地规则引擎判定
  'teacher_observation', // 教师人工观察/标注
] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * 证据来源的可信度上限。LLM 自我声称上限 0.4，不得单独支撑状态晋级。
 */
export const EVIDENCE_SOURCE_CREDIBILITY_CAP: Record<EvidenceSource, number> = {
  pronunciation_api: 1.0,
  asr: 0.7,
  task_result: 1.0,
  llm_judgement: 0.4,
  rule_engine: 0.9,
  teacher_observation: 0.8,
};

/** 任务类型：对应课程知识层可派生的任务（任务书第 10 章）。 */
export const TASK_TYPES = [
  'image_identification', // 图片识别
  'listening_comprehension', // 听力理解
  'word_mimicry', // 单词模仿
  'pronunciation_drill', // 发音训练（音节/音素）
  'phrase_assembly', // 短语组合
  'sentence_pattern', // 句型表达
  'situational_dialogue', // 情景对话
  'reading_story', // 阅读小故事
  'free_response', // 自由表达
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/**
 * 场景标识。stable_transfer 要求「两个以上不同场景」，
 * 因此场景必须是可枚举、可比较的稳定标识。
 *
 * 场景由 scenarios 表维护（scenarios 表是「两个不同场景」硬规则的唯一载体），
 * 此处枚举仅覆盖 M1 内置场景。
 */
export const EVIDENCE_SCENARIOS = [
  'greeting_scene', // 问候情景
  'self_intro_scene', // 自我介绍情景
  'object_pic_scene', // 图片识别情景
  'object_shop_scene', // 购物/新情境情景
  'free_chat_scene', // 自由交流情景
  'story_scene', // 故事语境情景
  'review_scene', // 复习场次
  'assessment_scene', // 评估场次
] as const;

export type EvidenceScenario = (typeof EVIDENCE_SCENARIOS)[number];

/**
 * 教学交互的意图分类。
 * 编排器必须先判断这是学习回答还是普通交流（D-007 / D-009）。
 */
export const INTENT_TYPES = [
  'learning_answer', // 学习回答
  'small_talk', // 普通闲聊
  'slow_request', // 要求慢一点
  'repeat_request', // 要求重放
  'question', // 突然提出新问题
  'no_answer', // 未作答
] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

/** 结果可信度（0–1 数值，便于加权计算）。 */
export const CREDIBILITY_LEVELS = ['high', 'medium', 'low'] as const;
export type CredibilityLevel = (typeof CREDIBILITY_LEVELS)[number];

/**
 * 阈值校准状态。
 *
 * ⚠️ M1 全部阈值为原型示意值，未经真实儿童样本校准（D-010 / 任务书 §9）。
 *    任何对外表述不得把 M1 的掌握状态说成「已验证的能力」。
 */
export const CALIBRATION_STATUSES = [
  'uncalibrated', // 未校准（M1 全部状态）
  'partially_calibrated', // 部分校准
  'calibrated', // 已用真实儿童样本校准
] as const;

export type CalibrationStatus = (typeof CALIBRATION_STATUSES)[number];

/** 单条学习证据事件。落库表：learning_evidence（只 INSERT）。 */
export const learningEvidenceSchema = z.object({
  id: z.string(),
  learnerId: z.string(),
  lessonSessionId: z.string().nullable(),

  // —— 证据指向的能力与维度 ——
  skillNodeId: z.string(),
  /** 逐词事实（M1 两级粒度：能力级状态表 + 逐词证据） */
  learningItemId: z.string().nullable().default(null),
  abilityCategory: z.enum(ABILITY_CATEGORIES),
  vocabularyDimension: z.enum(VOCABULARY_DIMENSIONS).nullable().default(null),

  // —— 证据属性 ——
  source: z.enum(EVIDENCE_SOURCES),
  taskType: z.enum(TASK_TYPES),
  /** 是否有提示 */
  prompted: z.boolean(),
  /**
   * 是否为「独立完成」（无提示且正确）。
   * 与 prompted 严格区分：prompted=false 但答错时 independent 也为 false。
   */
  independent: z.boolean(),
  /** 场景标识，对应 scenarios 表 */
  scenario: z.enum(EVIDENCE_SCENARIOS),
  occurredAt: z.string().datetime(),
  /** 数值可信度 0–1 */
  credibility: z.number().min(0).max(1),
  /** 是否允许用于推高掌握状态 */
  contributesToPromotion: z.boolean(),

  // —— 观察结果 ——
  /** 任务是否完成 */
  succeeded: z.boolean(),
  /** 发音评估得分（0-100），无发音评估时为 null */
  score: z.number().min(0).max(100).nullable().default(null),
  /** 出错的具体音节/音素定位 */
  errorUnits: z
    .array(
      z.object({
        unit: z.string(),
        kind: z.enum(['syllable', 'phoneme', 'word', 'pitch', 'rhythm']),
        detail: z.string().nullable().default(null),
      }),
    )
    .default([]),
  /** 原始观察备注（不含可识别身份的隐私信息） */
  note: z.string().nullable().default(null),

  /** 判定所用阈值版本 */
  thresholdVersion: z.string().nullable().default(null),
  /** 判定所用规则版本 */
  ruleVersion: z.string().nullable().default(null),
});

export type LearningEvidence = z.infer<typeof learningEvidenceSchema>;

/** 学习者能力状态。落库表：learner_skill_states。 */
export const learnerSkillStateSchema = z.object({
  id: z.string(),
  learnerId: z.string(),
  skillNodeId: z.string(),
  /** 机读编码 0–4 */
  masteryCode: z.number().int().min(0).max(4),
  /** 状态名（与 masteryCode 一一对应） */
  masteryState: z.enum(MASTERY_STATES),
  /**
   * 达到当前状态的证据 id 列表。任何状态变更都必须可追溯。
   */
  evidenceIds: z.array(z.string()).default([]),
  /**
   * 独立使用过的场景集合。stable_transfer 要求 >= 2 个不同场景。
   */
  independentScenarios: z.array(z.string()).default([]),
  /** 最近一次无提示成功回忆的时间。stable_transfer 要求与首次独立使用相隔 >= 1 天。 */
  lastUnpromptedRecallAt: z.string().datetime().nullable().default(null),
  /** 最近一次独立使用（无提示）的时间 */
  lastIndependentUseAt: z.string().datetime().nullable().default(null),
  /** 阈值校准状态。M1 恒为 uncalibrated。 */
  calibrationStatus: z.enum(CALIBRATION_STATUSES).default('uncalibrated'),
  updatedAt: z.string().datetime(),
});

export type LearnerSkillState = z.infer<typeof learnerSkillStateSchema>;

/** 状态迁移请求：由判定规则产出，必须携带依据证据。 */
export const masteryTransitionSchema = z.object({
  learnerId: z.string(),
  skillNodeId: z.string(),
  from: z.enum(MASTERY_STATES),
  to: z.enum(MASTERY_STATES),
  evidenceIds: z.array(z.string()).min(1, '状态迁移必须至少引用一条证据'),
  reason: z.string(),
  decidedAt: z.string().datetime(),
});

export type MasteryTransition = z.infer<typeof masteryTransitionSchema>;

/**
 * 评估结果。落库表：assessment_records。
 *
 * ⚠️ passed 是「任务级」通过与否，与掌握状态无关。
 *    任务级通过阈值（如 85 分）只影响本条记录，
 *    绝不直接修改 learner_skill_states.mastery_code。
 */
export const assessmentRecordSchema = z.object({
  id: z.string(),
  learnerId: z.string(),
  lessonSessionId: z.string(),
  skillNodeId: z.string(),
  learningItemId: z.string().nullable().default(null),
  taskType: z.enum(TASK_TYPES),
  scenario: z.enum(EVIDENCE_SCENARIOS),
  prompted: z.boolean(),
  independent: z.boolean(),
  score: z.number().min(0).max(100).nullable().default(null),
  /** 任务级是否通过（按 assessment_thresholds 表判定） */
  passed: z.boolean(),
  /** 评估来源。与 ASR 严格分离（D-013）。 */
  assessmentSource: z.enum(EVIDENCE_SOURCES),
  /** 是否已产出证据事件 */
  evidenceId: z.string().nullable().default(null),
  /** 阈值版本 */
  thresholdVersion: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
});

export type AssessmentRecord = z.infer<typeof assessmentRecordSchema>;

/**
 * 评估阈值。落库表：assessment_thresholds。
 *
 * ⚠️ 阈值绝不硬编码在代码里（D-010：正式阈值必须由真实儿童样本标定，
 *    不沿用原型数值）。代码只读表。
 */
export const assessmentThresholdSchema = z.object({
  id: z.string(),
  /** 适用任务类型 */
  taskType: z.enum(TASK_TYPES),
  /** 适用场景，空表示通用 */
  scenario: z.enum(EVIDENCE_SCENARIOS).nullable(),
  /** 跟读 / 发音类得分阈值 */
  passScore: z.number().min(0).max(100),
  /** 达到 forming 所需最少成功条数 */
  minSamplesForming: z.number().int().min(1),
  /** 达到 mastered 所需最少独立完成条数 */
  minSamplesMastered: z.number().int().min(1),
  /** 稳定迁移所需不同场景数 */
  minScenariosTransferred: z.number().int().min(1),
  /** 稳定迁移所需跨天间隔（毫秒） */
  minIntervalTransferredMs: z.number().int().min(0),
  /** 阈值来源 */
  source: z.enum(['hard_rule', 'm1_provisional', 'child_sample_calibrated']),
  /** 校准状态 */
  calibrationStatus: z.enum(CALIBRATION_STATUSES),
  /** 版本号 */
  version: z.string(),
  createdAt: z.string().datetime(),
});

export type AssessmentThreshold = z.infer<typeof assessmentThresholdSchema>;

/** 场景定义。落库表：scenarios。 */
export const scenarioSchema = z.object({
  id: z.string(),
  code: z.enum(EVIDENCE_SCENARIOS),
  name: z.string(),
  description: z.string(),
  /** 场景是否可用于稳定迁移判定 */
  countsForTransfer: z.boolean().default(true),
});

export type Scenario = z.infer<typeof scenarioSchema>;

/** 学习者档案。落库表：learner_profiles + learner_preferences。 */
export const learnerProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  ageGroup: z.enum(['6-9']),
  entryLevel: z.enum(['pre_a1']),
  target: z.enum(['daily_communication']),
  guardianId: z.string(),
  currentTopic: z.string().nullable().default(null),
  teachingPreferences: z.object({
    speechSpeed: z.number().min(0.25).max(4).default(0.65),
    repeatMode: z.enum(['patient']).default('patient'),
    feedbackStyle: z.enum(['encouraging']).default('encouraging'),
  }),
  createdAt: z.string().datetime(),
});

export type LearnerProfile = z.infer<typeof learnerProfileSchema>;

/** 能力状态快照（供 Web 端展示与 API 返回）。 */
export const learnerAbilitySnapshotSchema = z.object({
  learnerId: z.string(),
  states: z.array(
    z.object({
      skillNodeId: z.string(),
      skillName: z.string().default(''),
      abilityCategory: z.enum(ABILITY_CATEGORIES),
      masteryState: z.enum(MASTERY_STATES),
      masteryCode: z.number().int().min(0).max(4),
      /** 阈值校准状态。UI 必须据此避免「已掌握」类表述。 */
      calibrationStatus: z.enum(CALIBRATION_STATUSES),
      updatedAt: z.string().datetime(),
    }),
  ),
});

export type LearnerAbilitySnapshot = z.infer<typeof learnerAbilitySnapshotSchema>;

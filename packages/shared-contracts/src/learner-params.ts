/**
 * 学习者个性化学习节奏参数。
 *
 * 依据：DECISIONS.md D-006 追加条款、D-031；
 * 研究依据：Raviv et al., Science 2026, DOI 10.1126/science.aeh9311
 * —— 每晚重听量、学习速度、新词引入时机这三个参数决定个体学习节奏，
 *    同一年龄的不同孩子发展速度差异很大，属正常现象。
 *
 * ⚠️ 所有数值字段的默认值都是「占位」，不是标定结论。
 *    真实取值必须以儿童实测数据标定（见 DECISIONS.md「尚未决定事项」）。
 */
import { z } from 'zod';

/** 参数来源：默认、由证据自动估计、家长/教师手动设定。 */
export const LEARNING_PARAM_SOURCES = ['default_uncalibrated', 'estimated_from_evidence', 'guardian_set'] as const;
export type LearningParamSource = (typeof LEARNING_PARAM_SOURCES)[number];

export const learnerLearningParamsSchema = z.object({
  learnerId: z.string(),

  /**
   * 每晚重听量：一次课后重听覆盖的条目数上限。
   * 论文中「每晚重听量」是决定学习速度的三个参数之一。
   */
  replayLoadPerNight: z.object({
    value: z.number().int().min(0).max(60),
    source: z.enum(LEARNING_PARAM_SOURCES).default('default_uncalibrated'),
  }),

  /**
   * 学习速度：单位课时内允许引入的新词/新结构数量上限。
   * 用于「少量多次」的内容节流，避免按统一课表硬推。
   */
  learningRate: z.object({
    /** 每课时新词上限 */
    newItemsPerLesson: z.number().int().min(1).max(12),
    source: z.enum(LEARNING_PARAM_SOURCES).default('default_uncalibrated'),
  }),

  /**
   * 新词引入时机：一个新词从「首次接触」到「允许写入新词队列」的最小间隔（小时），
   * 以及允许被引入前必须已完成的回忆次数。
   */
  newItemIntroduction: z.object({
    /** 首次接触后至少间隔多少小时才进入新词队列 */
    minHoursAfterFirstExposure: z.number().int().min(0).max(168),
    /** 进入新词队列前至少完成的无关提示回忆次数 */
    minRecallsBeforeIntroduction: z.number().int().min(0).max(5),
    source: z.enum(LEARNING_PARAM_SOURCES).default('default_uncalibrated'),
  }),

  /** 参数版本，便于回算历史教学决策 */
  version: z.string(),
  updatedAt: z.string().datetime(),
});

export type LearnerLearningParams = z.infer<typeof learnerLearningParamsSchema>;

/**
 * 占位默认值。刻意写得保守（小重听量、低新词量），
 * 只用于让骨架可运行，不代表教学建议。
 */
export const PLACEHOLDER_LEARNING_PARAMS = {
  replayLoadPerNight: { value: 3, source: 'default_uncalibrated' },
  learningRate: { newItemsPerLesson: 3, source: 'default_uncalibrated' },
  newItemIntroduction: {
    minHoursAfterFirstExposure: 12,
    minRecallsBeforeIntroduction: 1,
    source: 'default_uncalibrated',
  },
} as const satisfies Pick<LearnerLearningParams, 'replayLoadPerNight' | 'learningRate' | 'newItemIntroduction'>;

/** 每个孩子的学习曲线点位：按周记录，用于家长报告与教学规划。 */
export const learningCurvePointSchema = z.object({
  learnerId: z.string(),
  /** ISO 周（例如 2026-W46） */
  week: z.string(),
  /** 本周新增「掌握/基本掌握」词数 */
  newMasteredItems: z.number().int().min(0),
  /** 本周重听次数与其中成功的比率 */
  replayCount: z.number().int().min(0),
  replayRecallRate: z.number().min(0).max(1).nullable().default(null),
  /** 本周发音平均分（如有评测） */
  averagePronunciationScore: z.number().min(0).max(100).nullable().default(null),
  /** 本周教学课时数 */
  lessonCount: z.number().int().min(0),
});

export type LearningCurvePoint = z.infer<typeof learningCurvePointSchema>;

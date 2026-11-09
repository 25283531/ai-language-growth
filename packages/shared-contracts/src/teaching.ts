/**
 * 教学回合契约 —— 全局核心接口 `POST /lessons/{id}/turn` 的输入输出。
 *
 * 依据：V1.1 任务书第 7 章「核心教学 API」；D-007「教学闭环：七步闭环」；
 *      D-008「混合决策」；D-010「慢速耐心教学」；D-015「降级链」。
 *
 * 编排器每次收到孩子回应后必须依次完成：
 *   判断性质 → 查当前目标 → 按需评估 → 按需调用模型 → 生成语音
 *   → 更新档案 → 决定下一步
 * 每一步是否发生，由程序按确定性规则判定；只有需要理解与推理的部分才交给 LLM。
 */
import { z } from 'zod';
import {
  EVIDENCE_SCENARIOS,
  INTENT_TYPES,
  TASK_TYPES,
  type EvidenceScenario,
  type IntentType,
  type TaskType,
} from './evidence';
import { MASTERY_STATES } from './learner';

/**
 * TTS 语速与音色的平台统一抽象参数。
 * 客户端不得传厂商原始 speed（D-014 / 约束二）。
 */
export const teacherVoiceParamsSchema = z.object({
  /** 抽象语速，慢速教学约 0.55—0.65 */
  teacherSpeed: z.number().min(0.25).max(4).default(0.65),
  voiceStyle: z.enum(['gentle', 'warm', 'encouraging']).default('gentle'),
  pauseAfterSentenceMs: z.number().int().min(0).max(5000).default(1000),
  pronunciationMode: z.enum(['natural', 'slow_clear', 'syllable_by_syllable']).default('slow_clear'),
});

export type TeacherVoiceParams = z.infer<typeof teacherVoiceParamsSchema>;

/**
 * 教学方法阶梯（L0 确定性规则驱动，不交给 LLM 决定）。
 *
 * D-010 要求「孩子连续读错时，老师要换方法」。换方法必须是程序规则，
 * 不能依赖模型自由裁量，否则无法验证「老师真的会换方法」（验收红线第三项）。
 *
 * 阶梯逐级加码，同一方法不重复超过 maxAttempts 次。
 */
export const METHOD_LADDER = [
  'method_slow_clear', // 放慢语速、整词示范
  'method_syllable_split', // 拆到音节，逐个示范
  'method_phoneme_focus', // 定位到出错音素，单独练
  'method_easy_exemplar', // 换一个更好模仿的例词
  'method_lip_mouth_cue', // 给口型/口型提示
  'method_model_and_wait', // 老师示范后留等待时间，不催促
] as const;

export type MethodVariant = (typeof METHOD_LADDER)[number];

/** 教学指令：后端决定的下一步教法。 */
export const teachingDirectiveSchema = z.object({
  /** 当前教学目标（能力节点编码） */
  targetSkillNodeId: z.string(),
  /** 本轮任务类型 */
  taskType: z.enum(TASK_TYPES),
  /** 是否为无提示的间隔复习 */
  isReview: z.boolean().default(false),
  /** 本轮场景 */
  scenario: z.enum(EVIDENCE_SCENARIOS),
  /** 老师要说的话（中文可含英文教学句） */
  teacherUtterance: z.string(),
  /** 英文示范文本 */
  demonstrationText: z.string().nullable().default(null),
  /** 逐音节/音素拆解，用于屏幕同步高亮当前发音单位 */
  pronunciationUnits: z
    .array(
      z.object({
        text: z.string(),
        kind: z.enum(['word', 'syllable', 'phoneme']),
        /** 该单元是否为已知易错点 */
        isFocus: z.boolean().default(false),
      }),
    )
    .default([]),
  /** 要孩子做什么 */
  expectedResponse: z.enum([
    'repeat', // 跟读
    'tap_image', // 点选图片
    'answer', // 作答
    'listen', // 仅听
    'speak', // 自由表达
  ]),
  /** 目标词（跟读任务用） */
  targetWords: z.array(z.string()).default([]),
  /** 语音参数 */
  voice: teacherVoiceParamsSchema,
  /** 是否允许重放 */
  allowRepeat: z.boolean().default(true),
  /** 本轮采用的教学方法（由 L0 规则阶梯决定） */
  methodVariant: z.enum(METHOD_LADDER).default('method_slow_clear'),
  /** 连续失败轮次（用于耐心陪练计数，上限 5） */
  consecutiveFailures: z.number().int().min(0).default(0),
  /** 老师人格与固定原则（供 Web 端展示语气一致性，非教学决策） */
  personaHint: z.string().nullable().default(null),
});

export type TeachingDirective = z.infer<typeof teachingDirectiveSchema>;

/** 孩子的一次回应。 */
export const learnerResponseSchema = z.object({
  /** 文本回应（点选、作答、自由表达） */
  text: z.string().nullable().default(null),
  /** 语音回应（base64 / 上传后的对象引用） */
  audioRef: z.string().nullable().default(null),
  audioDurationMs: z.number().int().min(0).max(120000).nullable().default(null),
  /** 孩子选择的图片 id（点选任务） */
  selectedImageId: z.string().nullable().default(null),
  /** 孩子是否请求慢一点 */
  requestedSlower: z.boolean().default(false),
  /** 孩子是否请求重放 */
  requestedRepeat: z.boolean().default(false),
  /** 孩子的自由发言（触发意图识别） */
  freeUtterance: z.string().nullable().default(null),
});

export type LearnerResponse = z.infer<typeof learnerResponseSchema>;

/** 本轮评估结论。 */
export const turnAssessmentSchema = z.object({
  /** 是否需要语音评估（自由对话不必调发音评估） */
  performedPronunciationAssessment: z.boolean(),
  performedAsr: z.boolean(),
  /** 是否有足够的回答观察和答案配置完成了任务级评估。 */
  evaluated: z.boolean().default(false),
  /** 评估得分 */
  score: z.number().min(0).max(100).nullable().default(null),
  /** 任务级通过与否（不等于掌握状态） */
  passed: z.boolean(),
  /** 出错的发音单元 */
  errorUnits: z
    .array(
      z.object({
        unit: z.string(),
        kind: z.enum(['syllable', 'phoneme', 'word', 'pitch', 'rhythm']),
        detail: z.string().nullable().default(null),
      }),
    )
    .default([]),
  /** 是否在提示下完成 */
  prompted: z.boolean(),
  /** 是否为独立完成（无提示且正确） */
  independent: z.boolean(),
  /** 使用的阈值版本 */
  thresholdVersion: z.string().nullable().default(null),
});

export type TurnAssessment = z.infer<typeof turnAssessmentSchema>;

/** 本轮产生的证据事件 id（供追溯）。 */
export const turnEvidenceSchema = z.object({
  evidenceId: z.string(),
  skillNodeId: z.string(),
  learningItemId: z.string().nullable().default(null),
  source: z.string(),
  taskType: z.enum(TASK_TYPES),
  prompted: z.boolean(),
  independent: z.boolean(),
  scenario: z.enum(EVIDENCE_SCENARIOS),
  credibility: z.number().min(0).max(1),
  contributesToPromotion: z.boolean(),
  succeeded: z.boolean(),
  score: z.number().min(0).max(100).nullable().default(null),
});

export type TurnEvidence = z.infer<typeof turnEvidenceSchema>;

/** 掌握状态变更（若本轮触发）。 */
export const turnStateChangeSchema = z.object({
  skillNodeId: z.string(),
  from: z.enum(MASTERY_STATES),
  to: z.enum(MASTERY_STATES),
  evidenceIds: z.array(z.string()),
  reason: z.string(),
  /** 阈值校准状态。M1 恒为 uncalibrated。 */
  calibrationStatus: z.enum(['uncalibrated', 'partially_calibrated', 'calibrated']),
});

export type TurnStateChange = z.infer<typeof turnStateChangeSchema>;

/**
 * 路由决策记录：便于成本账本与升级策略可解释。
 * 业务代码只面向 Router 接口，不依赖任何具体模型（D-011 / 约束二）。
 */
export const turnRoutingSchema = z.object({
  /** 任务类型标识（llm.simple_dialogue 等） */
  taskRoute: z.string(),
  /** 使用的服务等级 */
  level: z.enum(['L0', 'L1', 'L2', 'L3']),
  /** 命中的路由策略名 */
  strategy: z.string(),
  /** 是否走了 fallback */
  fellBack: z.boolean(),
  /** 供应商标识（配置别名，非厂商名硬编码） */
  providerAlias: z.string(),
  /** 升级触发信号（多信号，非模型自报置信度） */
  escalationSignals: z.array(z.string()).default([]),
  latencyMs: z.number().int().min(0),
  cost: z.object({
    llmInputTokens: z.number().int().min(0).default(0),
    llmOutputTokens: z.number().int().min(0).default(0),
    ttsCharacters: z.number().int().min(0).default(0),
    asrSeconds: z.number().min(0).default(0),
    pronunciationCalls: z.number().int().min(0).default(0),
    /** 估算成本（元） */
    estimatedCostCny: z.number().min(0).default(0),
  }),
});

export type TurnRouting = z.infer<typeof turnRoutingSchema>;

/**
 * 降级标记。任一环节触发降级都必须如实返回，
 * 不得静默掩盖（验收要求：所有降级路径可观测、可解释）。
 */
export const degradationSchema = z.object({
  /** 是否发生降级 */
  degraded: z.boolean(),
  /** 降级原因 */
  reasons: z.array(z.string()).default([]),
  /** 是否处于离线兜底模式（外部服务全不可用，保留固定课程与缓存音频） */
  offlineFallback: z.boolean().default(false),
  /** 本轮实际使用的服务等级 */
  effectiveLevel: z.enum(['L0', 'L1', 'L2', 'L3']),
});

export type Degradation = z.infer<typeof degradationSchema>;

/** `/lessons/{id}/turn` 请求体。 */
export const turnRequestSchema = z.object({
  learnerId: z.string(),
  response: learnerResponseSchema,
  /**
   * 幂等键。同一 key 重复提交返回同一结果，不重复写证据、不重复计费。
   */
  idempotencyKey: z.string().min(8),
  /** 客户端本地时间戳（仅作记录，判定以服务端时间为准） */
  clientTimestamp: z.string().datetime().optional(),
});

export type TurnRequest = z.infer<typeof turnRequestSchema>;

/** `/lessons/{id}/turn` 响应体。 */
export const turnResponseSchema = z.object({
  lessonSessionId: z.string(),
  turnIndex: z.number().int().min(0),
  /** 教 —— 后端决定的下一步 */
  directive: teachingDirectiveSchema,
  /** 听 —— 需要生成的语音（缓存命中时不重复计费） */
  speech: z.object({
    audioRef: z.string().nullable().default(null),
    /** 是否命中缓存（重复播放不重新消耗 TTS） */
    cached: z.boolean().default(false),
    teacherSpeed: z.number(),
    voiceStyle: z.string(),
    pauseAfterSentenceMs: z.number().int(),
    pronunciationMode: z.string(),
  }),
  /** 评估 */
  assessment: turnAssessmentSchema,
  /** 记录 —— 本轮证据 */
  evidence: z.array(turnEvidenceSchema).default([]),
  /** 记录 —— 状态变更 */
  stateChanges: z.array(turnStateChangeSchema).default([]),
  /** 调整 —— 路由与成本 */
  routing: turnRoutingSchema,
  /** 降级状态 */
  degradation: degradationSchema,
  /** 本轮意图分类结果 */
  intent: z.enum(INTENT_TYPES),
  /** 是否结束本堂课 */
  lessonFinished: z.boolean().default(false),
  /** 结束时的总结 */
  summary: z.string().nullable().default(null),
});

export type TurnResponse = z.infer<typeof turnResponseSchema>;

/** 开课请求与响应。 */
export const lessonStartRequestSchema = z.object({
  learnerId: z.string(),
  topicId: z.string().optional(),
});

export type LessonStartRequest = z.infer<typeof lessonStartRequestSchema>;

export const lessonStartResponseSchema = z.object({
  lessonSessionId: z.string(),
  topicId: z.string(),
  topicName: z.string(),
  directive: teachingDirectiveSchema,
  speech: turnResponseSchema.shape.speech,
  degradation: degradationSchema,
  learnerState: z.object({
    masteryStates: z.record(z.enum(MASTERY_STATES)),
  }),
});

export type LessonStartResponse = z.infer<typeof lessonStartResponseSchema>;

/** 结课请求与响应。 */
export const lessonFinishRequestSchema = z.object({
  learnerId: z.string(),
});

export type LessonFinishRequest = z.infer<typeof lessonFinishRequestSchema>;

export const lessonFinishResponseSchema = z.object({
  lessonSessionId: z.string(),
  turns: z.number().int().min(0),
  completedGoals: z.array(z.string()),
  /** 有效教学成本 = 总成本 / 有效学习目标数 */
  effectiveTeachingCostCny: z.number().min(0),
  totalCostCny: z.number().min(0),
  stateChanges: z.array(turnStateChangeSchema).default([]),
  summary: z.string(),
  growthReport: z.object({
    strengths: z.array(z.string()),
    practiceFocus: z.array(z.string()),
    caregiverGuidance: z.array(z.string()),
  }),
  /** 待复习项（间隔重复调度） */
  reviewScheduled: z.array(
    z.object({
      skillNodeId: z.string(),
      dueAt: z.string().datetime(),
    }),
  ),
  /** 阈值校准提示：M1 全部为未校准 */
  calibrationStatus: z.enum(['uncalibrated', 'partially_calibrated', 'calibrated']),
});

export type LessonFinishResponse = z.infer<typeof lessonFinishResponseSchema>;

export type { EvidenceScenario, TaskType, IntentType };

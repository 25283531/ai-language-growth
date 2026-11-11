/**
 * Model Router 与 AI Gateway 的统一协议。
 *
 * 依据：D-011 多模型分级调度；D-012 Router 与 Gateway 分离；
 *      D-013 语音三路独立路由；D-014 TTS 音色与语速抽象；
 *      D-015 升级机制与成本指标；约束二「所有模型都可以替换」。
 *
 * 核心约定：
 *  - 业务代码只依赖本文件定义的接口，不出现任何服务商或模型名称。
 *  - LLM / TTS / ASR / 发音评估四类服务各自独立路由，不共用一条表。
 *  - 升级依据为多信号，绝不使用模型自报置信度。
 */
import { z } from 'zod';
import { teacherVoiceParamsSchema } from './teaching';

/** 四级调度。L0 为本地规则与缓存，零 API 调用。 */
export const MODEL_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type ModelLevel = (typeof MODEL_LEVELS)[number];

/** 在线教学调用的四类服务独立路由表（D-013）。 */
export const SERVICE_KINDS = ['llm', 'tts', 'asr', 'pronunciation'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** 服务端配置目录还包含暂不参与教学 Model Router 的离线向量能力。 */
export const PROVIDER_SERVICE_KINDS = [...SERVICE_KINDS, 'embedding'] as const;
export type ProviderServiceKind = (typeof PROVIDER_SERVICE_KINDS)[number];

/** 路由任务类型标识。与任务书第 7 章的路由配置示例对齐。 */
export const TASK_ROUTES = [
  'llm.simple_dialogue', // 简单问候与问答
  'llm.teaching_explanation', // 教学解释
  'llm.learning_plan', // 长期学习规划
  'llm.method_adaptation', // 教学方法调整
  'llm.growth_report', // 阶段成长汇总与家长解释
  'llm.memory_extraction', // 结课批量交互记忆候选提取
  'llm.personality_adjustment', // 受控人格调整候选建议
  'tts.fixed_course', // 固定课程音频（走预生成缓存）
  'tts.dynamic_teaching', // 动态教学语句
  'tts.narrative', // 故事与情感表达
  'asr.free_speech', // 自由对话识别
  'asr.follow_read', // 跟读初筛
  'pronunciation.word', // 单词发音评估
  'pronunciation.phoneme', // 音素发音评估
] as const;

export type TaskRoute = (typeof TASK_ROUTES)[number];

/**
 * 升级信号。升级由多信号共同触发，不采用模型自报置信度（D-015）。
 */
export const ESCALATION_SIGNALS = [
  'schema_invalid', // 输出不符合规定的结构化格式
  'task_incomplete', // 当前任务未完成
  'asr_failed', // ASR 识别失败
  'pronunciation_difficulty', // 发音评估显示明显困难
  'child_did_not_understand', // 孩子多次表达不懂
  'method_already_changed', // 老师已经换过教学方法
  'conflicts_with_profile', // 结果与学习档案矛盾
] as const;

export type EscalationSignal = (typeof ESCALATION_SIGNALS)[number];

/** 模型路由决策结果。 */
export const routingDecisionSchema = z.object({
  level: z.enum(MODEL_LEVELS),
  /** 供应商标识（配置别名，非真实厂商名硬编码） */
  providerAlias: z.string(),
  /** 供应商标识下的模型标识（配置别名） */
  modelAlias: z.string(),
  strategy: z.string(),
  fellBack: z.boolean(),
  escalationSignals: z.array(z.string()).default([]),
  /** 预算决策快照；仅在该任务路由启用每日预算时返回。 */
  budget: z.object({
    limitCny: z.number().min(0),
    spentCny: z.number().min(0),
    reservedCny: z.number().min(0),
    unpricedCalls: z.number().int().min(0),
    exhausted: z.boolean(),
  }).optional(),
});

export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

/** LLM 统一调用协议。 */
export const llmRequestSchema = z.object({
  /** 角色提示词标识，对应 prompts/ 下的版本化提示词 */
  promptKey: z.string(),
  promptVersion: z.string(),
  system: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    }),
  ),
  /** 期望的结构化输出 schema（用于 schema 合规性校验） */
  responseSchema: z.unknown().optional(),
  temperature: z.number().min(0).max(2).default(0.6),
  maxTokens: z.number().int().min(1).default(800),
  timeoutMs: z.number().int().min(100).default(15000),
});

export type LlmRequest = z.input<typeof llmRequestSchema>;

export const llmResponseSchema = z.object({
  content: z.string(),
  /** 是否符合结构化 schema 要求 */
  schemaValid: z.boolean(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
  providerAlias: z.string(),
  modelAlias: z.string(),
  /** 结束原因（如 stop / length）。length 表示输出被 token 上限截断，话术可能不完整。 */
  finishReason: z.string().optional(),
});

export type LlmResponse = z.infer<typeof llmResponseSchema>;

/**
 * TTS 缓存作用域 —— 课程级语音资源的复用边界（D-014 / D-026）。
 *
 * 服务端按 (keyVersion, scope, topicId, contentId, contentVersion,
 * voiceParamsHash, voiceProfileVersion, modelFamily) 构造结构化缓存键：
 *  - PUBLIC_CURRICULUM：发布期固化 + 人工审核 + 无 PII，键中不含 learnerId /
 *    lessonSessionId，允许「同一课程、不同用户、不同时间」复用同一份已审核音频；
 *  - PRIVATE_DYNAMIC：默认 fail-closed，键中必带 learnerId / lessonSessionId，
 *    绝不把孩子姓名、原话、错误或学习历史写进可跨用户复用的音频；
 *  - PRONUNCIATION：单词 / 音素 citation-form 示范，独立命名空间。
 *
 * 该对象带 default，使 `z.input` 中 cacheScope 保持可选、现有调用点无需改动；
 * 缺省时网关一律按 PRIVATE_DYNAMIC 处理（fail-closed）。
 */
export const ttsCacheScopeSchema = z.object({
  scope: z.enum(['PUBLIC_CURRICULUM', 'PRIVATE_DYNAMIC', 'PRONUNCIATION']).default('PRIVATE_DYNAMIC'),
  topicId: z.string().default(''),
  contentId: z.string().default(''),
  contentVersion: z.string().default(''),
  learnerId: z.string().optional(),
  lessonSessionId: z.string().optional(),
  providerModelFamily: z.string().optional(),
});

export type TtsCacheScope = z.input<typeof ttsCacheScopeSchema>;

/** TTS 统一调用协议。只接受抽象语速，不接受厂商原始 speed（D-014）。 */
export const ttsRequestSchema = z.object({
  // 单次合成有字数上限；在契约层就拦下超长文本，避免静默截断教学话术
  text: z.string().min(1).max(500),
  voice: teacherVoiceParamsSchema,
  /** 统一音色标识，切换供应商时保持一致 */
  voiceIdentity: z.string().default('teacher_default'),
  timeoutMs: z.number().int().min(100).default(12000),
  /** 课程级缓存作用域；缺省时由网关 fail-closed 到 PRIVATE_DYNAMIC。 */
  cacheScope: ttsCacheScopeSchema.default({
    scope: 'PRIVATE_DYNAMIC',
    topicId: '',
    contentId: '',
    contentVersion: '',
  }),
});

export type TtsRequest = z.input<typeof ttsRequestSchema>;

export const ttsResponseSchema = z.object({
  audioRef: z.string(),
  /**
   * 平台内部的音频计量单位（Unicode 码点数：1 汉字 / 1 字母 / 1 标点 = 1）。
   * 供成本账本与供应商按字符计费的账单对账使用；它不是字节数，也不等于
   * 供应商最终账单字符数（不同供应商对 SSML、标点、多字节字符的口径可能不同）。
   */
  characters: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
  providerAlias: z.string(),
  modelAlias: z.string(),
  /** 是否命中缓存（重复播放不重新消耗 TTS） */
  cached: z.boolean().default(false),
  /** 客户端请求的抽象语速及服务端采用的调速方式。 */
  requestedTeacherSpeed: z.number().min(0.25).max(4).optional(),
  speedMode: z.enum(['native', 'playback']).optional(),
  playbackRate: z.number().min(0.25).max(4).optional(),
});

export type TtsResponse = z.infer<typeof ttsResponseSchema>;

/** ASR 统一调用协议。ASR 只负责「说了什么」，不负责「说得对不对」。 */
export const asrRequestSchema = z.object({
  audioRef: z.string(),
  timeoutMs: z.number().int().min(100).default(15000),
  /** 双层策略：先免费初筛，必要时再付费高质量 */
  highQuality: z.boolean().default(false),
});

export type AsrRequest = z.input<typeof asrRequestSchema>;

export const asrResponseSchema = z.object({
  transcript: z.string(),
  confidence: z.number().min(0).max(1),
  seconds: z.number().min(0),
  latencyMs: z.number().int().min(0),
  providerAlias: z.string(),
  modelAlias: z.string(),
  /** 结果是否异常（空结果、明显异常、无法确认）→ 触发二次高质量识别 */
  suspect: z.boolean().default(false),
});

export type AsrResponse = z.infer<typeof asrResponseSchema>;

/** 发音评估统一调用协议。与 ASR 严格分离。 */
export const pronunciationRequestSchema = z.object({
  audioRef: z.string(),
  /** 目标文本 */
  targetText: z.string(),
  /** 目标语言 */
  language: z.string().default('en-US'),
  /** 评估粒度 */
  granularity: z.enum(['word', 'syllable', 'phoneme']).default('phoneme'),
  timeoutMs: z.number().int().min(100).default(15000),
});

export type PronunciationRequest = z.input<typeof pronunciationRequestSchema>;

export const pronunciationResponseSchema = z.object({
  /** 整体得分 0-100 */
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  /** 逐单元评估 */
  units: z.array(
    z.object({
      text: z.string(),
      kind: z.enum(['word', 'syllable', 'phoneme', 'pitch', 'rhythm']),
      score: z.number().min(0).max(100),
      correct: z.boolean(),
      detail: z.string().nullable().default(null),
    }),
  ),
  latencyMs: z.number().int().min(0),
  providerAlias: z.string(),
  modelAlias: z.string(),
});

export type PronunciationResponse = z.infer<typeof pronunciationResponseSchema>;

/** 成本计量记录。落库表：ai_usage_logs。 */
export const usageRecordSchema = z.object({
  id: z.string(),
  learnerId: z.string().nullable(),
  lessonSessionId: z.string().nullable(),
  serviceKind: z.enum(SERVICE_KINDS),
  taskRoute: z.string(),
  level: z.enum(MODEL_LEVELS),
  providerAlias: z.string(),
  modelAlias: z.string(),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  ttsCharacters: z.number().int().min(0).default(0),
  asrSeconds: z.number().min(0).default(0),
  pronunciationCalls: z.number().int().min(0).default(0),
  estimatedCostCny: z.number().min(0).default(0),
  latencyMs: z.number().int().min(0).default(0),
  createdAt: z.string().datetime(),
});

export type UsageRecord = z.infer<typeof usageRecordSchema>;

/** 路由规则配置。全部可在管理后台调整，换模型不发版（D-012）。 */
export const routeRuleSchema = z.object({
  taskRoute: z.string(),
  primary: z.object({
    providerAlias: z.string(),
    modelAlias: z.string(),
    level: z.enum(MODEL_LEVELS),
  }),
  fallback: z
    .array(
      z.object({
        providerAlias: z.string(),
        modelAlias: z.string(),
        level: z.enum(MODEL_LEVELS),
      }),
    )
    .default([]),
  /** 熔断阈值 */
  maxConcurrency: z.number().int().min(1).default(8),
  /** 预算上限（元/天），超出触发降级 */
  dailyBudgetCny: z.number().min(0).default(0),
  enabled: z.boolean().default(true),
});

export type RouteRule = z.infer<typeof routeRuleSchema>;

/** Model Router 接口。业务代码只面向它。 */
export interface ModelRouter {
  /** 选择模型并执行升级判定。 */
  route(input: {
    serviceKind: ServiceKind;
    taskRoute: TaskRoute | string;
    escalationSignals?: EscalationSignal[];
  }): Promise<RoutingDecision>;
  /** 记录一条用量。 */
  recordUsage(record: UsageRecord): Promise<void>;
  /** 查询当日用量汇总（成本与配额管理）。 */
  usageSummary(input: {
    learnerId?: string;
    lessonSessionId?: string;
  }): Promise<{
    totalCostCny: number;
    byService: Record<string, { calls: number; costCny: number }>;
    byLevel: Record<string, { calls: number; costCny: number }>;
  }>;
}

/** AI Gateway 接口。只负责调用，不负责选模型（D-012）。 */
export interface AiGateway {
  llm(request: LlmRequest, decision: RoutingDecision): Promise<LlmResponse>;
  tts(request: TtsRequest, decision: RoutingDecision): Promise<TtsResponse>;
  asr(request: AsrRequest, decision: RoutingDecision): Promise<AsrResponse>;
  pronunciation(
    request: PronunciationRequest,
    decision: RoutingDecision,
  ): Promise<PronunciationResponse>;
}

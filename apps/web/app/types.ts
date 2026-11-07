/**
 * Web 端按「后端真实响应形状」定义的类型。
 *
 * 说明：本文件刻意不 import @alg/shared-contracts，让 apps/web 可以独立
 * tsc --noEmit / next build，不依赖其它 workspace 的 dist 产物。
 * 字段已对齐后端契约（见 team-lead 回归结论）：
 *  - startLesson 已绑定 LessonStartResponse 契约：嵌套 speech 对象 +
 *    learnerState.masteryStates，不再有多余的 characters 字段；
 *  - scenario / taskType 等一律按字符串宽容渲染，不依赖枚举校验。
 */

export interface TeacherVoiceParams {
  teacherSpeed: number;
  voiceStyle: string;
  pauseAfterSentenceMs: number;
  pronunciationMode: string;
}

export interface PronunciationUnit {
  text: string;
  kind: string;
  isFocus: boolean;
}

export interface ErrorUnit {
  unit: string;
  kind: string;
  detail: string | null;
}

/** 教学指令：完全由后端决定，Web 只渲染。 */
export interface TeachingDirective {
  targetSkillNodeId: string;
  taskType: string;
  scenario: string;
  teacherUtterance: string;
  demonstrationText: string | null;
  pronunciationUnits: PronunciationUnit[];
  expectedResponse: string;
  targetWords: string[];
  voice: TeacherVoiceParams;
  allowRepeat: boolean;
  methodVariant: string;
  consecutiveFailures: number;
  personaHint: string | null;
}

export interface SpeechPayload {
  audioRef: string | null;
  cached: boolean;
  teacherSpeed: number;
  voiceStyle: string;
  pauseAfterSentenceMs: number;
  pronunciationMode: string;
}

export interface TurnAssessment {
  performedPronunciationAssessment: boolean;
  performedAsr: boolean;
  score: number | null;
  passed: boolean;
  errorUnits: ErrorUnit[];
  prompted: boolean;
  independent: boolean;
  thresholdVersion: string | null;
}

export interface TurnEvidence {
  evidenceId: string;
  skillNodeId: string;
  learningItemId: string | null;
  source: string;
  taskType: string;
  prompted: boolean;
  independent: boolean;
  scenario: string;
  credibility: number;
  contributesToPromotion: boolean;
  succeeded: boolean;
  score: number | null;
}

export interface TurnStateChange {
  skillNodeId: string;
  from: string;
  to: string;
  evidenceIds: string[];
  reason: string;
  calibrationStatus: string;
}

export interface TurnRoutingCost {
  llmInputTokens: number;
  llmOutputTokens: number;
  ttsCharacters: number;
  asrSeconds: number;
  pronunciationCalls: number;
  estimatedCostCny: number;
}

export interface TurnRouting {
  taskRoute: string;
  level: string;
  strategy: string;
  fellBack: boolean;
  providerAlias: string;
  escalationSignals: string[];
  latencyMs: number;
  cost: TurnRoutingCost;
}

export interface Degradation {
  degraded: boolean;
  reasons: string[];
  offlineFallback: boolean;
  effectiveLevel: string;
}

/** POST /lessons/{id}/turn 正常响应。 */
export interface TurnResponse {
  lessonSessionId: string;
  turnIndex: number;
  directive: TeachingDirective;
  speech: SpeechPayload;
  assessment: TurnAssessment;
  evidence: TurnEvidence[];
  stateChanges: TurnStateChange[];
  routing: TurnRouting;
  degradation: Degradation;
  intent: string;
  lessonFinished: boolean;
  summary: string | null;
}

/**
 * 后端 turn 失败时返回 HTTP 200 的可解释降级错误体（不是 5xx）。
 * Web 必须识别它，不能当成正常 directive 渲染。
 */
export interface DegradedTurnBody {
  message?: string;
  reason?: string;
  degraded?: boolean;
  offlineFallback?: boolean;
  statusCode?: number;
}

export interface LessonStartResponse {
  lessonSessionId: string;
  topicId: string;
  topicName: string;
  directive: TeachingDirective;
  speech: SpeechPayload;
  degradation: Degradation;
  /** 已对齐 LessonStartResponse 契约：开课时的能力状态快照（均为未校准原型值）。 */
  learnerState?: { masteryStates: Record<string, string> };
}

export interface LessonFinishResponse {
  lessonSessionId: string;
  turns: number;
  completedGoals: string[];
  effectiveTeachingCostCny: number;
  totalCostCny: number;
  stateChanges: TurnStateChange[];
  summary: string;
  reviewScheduled: Array<{ skillNodeId: string; dueAt: string }>;
  calibrationStatus: string;
}

export interface AbilityState {
  skillNodeId: string;
  skillName: string;
  abilityCategory: string;
  masteryState: string;
  masteryCode: number;
  calibrationStatus: string;
  updatedAt: string;
}

export interface AbilitiesResponse {
  learnerId: string;
  states: AbilityState[];
  calibrationNotice: string;
}

/** GET /learners/{id}/evidence 返回 learning_evidence 行数组。 */
export interface EvidenceRow {
  id: string;
  learnerId: string;
  lessonSessionId: string | null;
  skillNodeId: string;
  learningItemId: string | null;
  abilityCategory: string;
  vocabularyDimension: string | null;
  source: string;
  taskType: string;
  prompted: boolean;
  independent: boolean;
  scenario: string;
  occurredAt: string;
  credibility: number;
  contributesToPromotion: boolean;
  succeeded: boolean;
  score: number | null;
  errorUnits: ErrorUnit[];
  note: string | null;
  thresholdVersion: string | null;
  ruleVersion: string | null;
}

export interface UsageBucket {
  calls: number;
  costCny: number;
}

export interface UsageSummary {
  totalCostCny: number;
  byService: Record<string, UsageBucket>;
  byLevel: Record<string, UsageBucket>;
  note?: string;
}

export interface HealthResponse {
  status: string;
  gatewayMode: string;
  calibrationStatus: string;
  timestamp: string;
}

export interface SynthesizeResponse {
  audioRef?: string;
  cached?: boolean;
  characters?: number;
  latencyMs?: number;
  [key: string]: unknown;
}

/** 学生作答输入表单（Web 只采集，不判定）。 */
export interface ResponseForm {
  text: string;
  audioRef: string;
  selectedImageId: string;
  freeUtterance: string;
  requestedRepeat: boolean;
  requestedSlower: boolean;
}

/** POST /lessons/{id}/turn 请求体。 */
export interface TurnRequestBody {
  learnerId: string;
  idempotencyKey: string;
  clientTimestamp: string;
  response: {
    text: string | null;
    audioRef: string | null;
    audioDurationMs: number | null;
    selectedImageId: string | null;
    requestedSlower: boolean;
    requestedRepeat: boolean;
    freeUtterance: string | null;
  };
}

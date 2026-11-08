/**
 * Teacher Orchestrator —— 教师编排器。
 *
 * 依据：D-009「四种角色由同一 LLM 的不同模式承担，职责在系统内部独立」；
 *      D-007「每次互动先判断：这是学习回答还是普通交流、当前目标是什么、
 *      是否需要语音评估、是否需要调用大模型、是否更新档案、下一步怎样教」。
 *
 * 核心接口：POST /lessons/{id}/turn
 * 一次调用完成七步闭环的编排：
 *   判断性质 → 查当前目标 → 按需评估 → 按需调用模型 → 生成语音
 *   → 更新档案 → 决定下一步
 *
 * 硬约束：
 *  - 教学决策全部在后端完成，客户端只渲染（约束一）。
 *  - 掌握状态由规则引擎根据证据计算，不由模型声称（约束三）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  advanceMethodLadder,
  initialMethodLadderState,
  ModelRouterImpl,
  resolveDemonstration,
  resolveTeacherSpeed,
  type MethodLadderState,
} from '@alg/model-router';
import type {
  AssessmentRecord,
  EscalationSignal,
  IntentType,
  LearnerResponse,
  LessonStartResponse,
  LlmResponse,
  RoutingDecision,
  TeachingDirective,
  TurnResponse,
} from '@alg/shared-contracts';
import { resolveEvidenceTargets } from '@alg/skill-graph';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { LearnerModelService } from '../learner-model/learner-model.service';
import { PlannerService } from '../planner/planner.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 离线兜底的固定课程内容（D-015 降级链最后一步）。
 *
 * 完全内置、不查库、不调用任何外部服务 —— 数据库与网络都不可用时
 * 仍能给孩子一段可播放、可跟读的教学内容，保证课程不中断。
 */
const OFFLINE_DIRECTIVE: TeachingDirective = {
  targetSkillNodeId: 'LA.LISTEN.greeting_core',
  taskType: 'listening_comprehension',
  scenario: 'greeting_scene',
  teacherUtterance: '我们先听一听，跟着老师慢慢说：hello。',
  demonstrationText: 'hello',
  pronunciationUnits: [
    { text: 'he', kind: 'syllable', isFocus: false },
    { text: 'llo', kind: 'syllable', isFocus: false },
  ],
  expectedResponse: 'listen',
  targetWords: ['hello'],
  voice: {
    teacherSpeed: 0.5,
    voiceStyle: 'gentle',
    pauseAfterSentenceMs: 1000,
    pronunciationMode: 'slow_clear',
  },
  allowRepeat: true,
  methodVariant: 'method_model_and_wait',
  consecutiveFailures: 0,
  personaHint: '耐心、温柔、积极鼓励；不嘲笑、不催促；诚实说明自己是 AI 老师。',
};

/** 会话中保存的教学状态。 */
interface SessionRuntimeState {
  methodLadder: MethodLadderState;
  currentActivityId: string | null;
  turnCount: number;
  /** 本堂课已完成的活动 */
  completedActivities: string[];
  /** 连续成功次数，用于复习间隔调整 */
  consecutiveSuccesses: Record<string, number>;
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  /** 会话运行时状态。M1 用内存 + 数据库持久化的 methodState 并存。 */
  private readonly runtime = new Map<string, SessionRuntimeState>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LearnerModelService) private readonly learnerModel: LearnerModelService,
    @Inject(PlannerService) private readonly planner: PlannerService,
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
  ) {}

  /** 开课。 */
  /** 返回类型直接绑定契约，避免实现与 lessonStartResponseSchema 漂移。 */
  async startLesson(input: { learnerId: string; topicId?: string }): Promise<LessonStartResponse> {
    const topicId = input.topicId ?? 'topic-greetings';
    const session = await this.prisma.lesson_sessions.create({
      data: {
        learnerId: input.learnerId,
        topicId,
        status: 'active',
        methodState: initialMethodLadderState() as unknown as object,
      },
    });

    this.runtime.set(session.id, {
      methodLadder: initialMethodLadderState(),
      currentActivityId: null,
      turnCount: 0,
      completedActivities: [],
      consecutiveSuccesses: {},
    });

    const step = await this.planner.planNext({
      topicId,
      learnerId: input.learnerId,
      excludeActivityIds: [],
    });

    if (!step) {
      throw new Error(`主题 ${topicId} 没有可用活动`);
    }

    const directive = await this.buildDirective({
      activityId: step.activity.id,
      learnerId: input.learnerId,
      sessionId: session.id,
      methodState: this.getRuntime(session.id).methodLadder,
      errorUnits: [],
    });

    const speech = await this.synthesize(directive);
    // 开课时把学习者已有能力状态一并交给客户端展示（契约 learnerState 字段）。
    const masteryStates = await this.learnerModel.getMasteryStates(input.learnerId);

    return {
      lessonSessionId: session.id,
      topicId,
      topicName: topicNameOf(topicId),
      directive,
      speech: speech.speech,
      degradation: {
        degraded: speech.meta.degraded,
        reasons: speech.meta.reasons,
        offlineFallback: false,
        effectiveLevel: speech.meta.effectiveLevel,
      },
      learnerState: { masteryStates },
    };
  }

  /**
   * 教学回合 —— 全局核心接口。
   */
  async handleTurn(input: {
    lessonSessionId: string;
    learnerId: string;
    response: LearnerResponse;
    idempotencyKey: string;
  }): Promise<TurnResponse> {
    const started = Date.now();

    // —— 幂等：同一 key 重复提交返回同一结果，不重复写证据、不重复计费 ——
    const existing = await this.prisma.interaction_events.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      this.logger.log(`幂等命中，返回既有结果 ${input.idempotencyKey}`);
      return existing.output as unknown as TurnResponse;
    }

    const session = await this.prisma.lesson_sessions.findUnique({
      where: { id: input.lessonSessionId },
    });
    if (!session) {
      throw new Error(`课堂 ${input.lessonSessionId} 不存在`);
    }

    const state = this.getRuntime(input.lessonSessionId);
    const activityId = session.currentActivityId;
    const activity = activityId
      ? (await this.prisma.learning_items.findUnique({ where: { id: activityId } }))
      : null;

    const activityContent = activity?.content as unknown as {
      id: string;
      taskType: string;
      scenario: string;
      skillNodeIds: string[];
      targetWords: string[];
      demonstrationText: string | null;
      teacherUtteranceZh: string;
      requiresPronunciationAssessment: boolean;
      requiresAsr: boolean;
    } | null;

    // —— 第一步：判断性质（意图识别，L0 规则优先）——
    const intent = this.classifyIntent(input.response);
    const escalationSignals: EscalationSignal[] = [];

    // —— 第二步：查当前目标 ——
    let currentActivity = activityContent;
    if (!currentActivity) {
      const step = await this.planner.planNext({
        topicId: session.topicId,
        learnerId: input.learnerId,
        excludeActivityIds: state.completedActivities,
      });
      if (!step) {
        throw new Error('没有可用的教学活动');
      }
      currentActivity = step.activity as unknown as typeof currentActivity;
      await this.prisma.lesson_sessions.update({
        where: { id: input.lessonSessionId },
        data: { currentActivityId: step.activity.id },
      });
      state.currentActivityId = step.activity.id;
    }

    // —— 第三步：按需评估 ——
    const assessment = await this.assess({
      response: input.response,
      activity: currentActivity,
      learnerId: input.learnerId,
      lessonSessionId: input.lessonSessionId,
    });

    // —— 第四步：更新档案（写证据 + 重算状态）——
    const evidence = await this.recordEvidence({
      assessment,
      activity: currentActivity,
      learnerId: input.learnerId,
      lessonSessionId: input.lessonSessionId,
    });

    const stateChanges = await this.recomputeStates({
      learnerId: input.learnerId,
      activity: currentActivity,
    });

    // —— 第五步：调整下一次教学（方法阶梯，L0 规则）——
    const ladder = advanceMethodLadder({
      passed: assessment.passed,
      state: state.methodLadder,
    });
    state.methodLadder = ladder.state;

    if (ladder.needsEscalation) {
      escalationSignals.push('method_already_changed');
    }
    if (!assessment.passed && state.methodLadder.consecutiveFailures >= 2) {
      escalationSignals.push('task_incomplete');
    }

    // —— 第六步：生成语音 ——
    const directive = await this.buildDirective({
      activityId: currentActivity!.id,
      learnerId: input.learnerId,
      sessionId: input.lessonSessionId,
      methodState: state.methodLadder,
      errorUnits: assessment.errorUnits,
    });

    // —— 第五步半：孩子突然提问时，LLM 只补一句回应话术 ——
    // 教学决策（评估、证据、状态、下一活动、方法阶梯）已全部在上方由规则完成，
    // LLM 不参与其中任何一步，输出只追加到老师说的话里，随后一并合成语音。
    let llmInputTokens = 0;
    let llmOutputTokens = 0;
    const llmDegradationReasons: string[] = [];
    if (intent === 'question') {
      const answer = await this.answerChildQuestion({
        question: input.response.text ?? input.response.audioRef ?? '孩子提了一个问题',
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
      });
      llmInputTokens = answer.inputTokens;
      llmOutputTokens = answer.outputTokens;
      if (answer.degraded) llmDegradationReasons.push('llm_fell_back_to_mock');
      directive.teacherUtterance = `${directive.teacherUtterance} ${answer.text}`.trim();
    }

    const routingDecision = await this.router.route({
      serviceKind: 'tts',
      taskRoute: 'tts.dynamic_teaching',
      escalationSignals: escalationSignals.filter(
        (s): s is EscalationSignal => s === 'method_already_changed' || s === 'task_incomplete',
      ),
    });

    const speech = await this.synthesize(directive, routingDecision);

    // —— 记录用量 ——
    await this.router.recordUsage(
      usageRecord({
        id: `usage-${input.lessonSessionId}-${state.turnCount}`,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        serviceKind: 'tts',
        taskRoute: 'tts.dynamic_teaching',
        level: routingDecision.level,
        providerAlias: routingDecision.providerAlias,
        modelAlias: routingDecision.modelAlias,
        ttsCharacters: speech.characters,
        latencyMs: Date.now() - started,
      }),
    );

    // —— 第七步：决定是否结束本堂课 ——
    state.turnCount += 1;
    if (!assessment.passed) {
      // 未达标不推进到下一个活动，继续陪练
    } else {
      state.completedActivities.push(currentActivity!.id);
      state.consecutiveSuccesses[currentActivity!.skillNodeIds[0] ?? ''] =
        (state.consecutiveSuccesses[currentActivity!.skillNodeIds[0] ?? ''] ?? 0) + 1;
    }

    const lessonFinished = state.completedActivities.length >= 4;
    await this.prisma.lesson_sessions.update({
      where: { id: input.lessonSessionId },
      data: {
        turnCount: state.turnCount,
        methodState: state.methodLadder as unknown as object,
        currentActivityId: lessonFinished ? null : state.currentActivityId,
      },
    });

    const result: TurnResponse = {
      lessonSessionId: input.lessonSessionId,
      turnIndex: state.turnCount - 1,
      directive,
      speech: speech.speech,
      assessment: {
        performedPronunciationAssessment: assessment.performedPronunciationAssessment,
        performedAsr: assessment.performedAsr,
        score: assessment.score,
        passed: assessment.passed,
        errorUnits: assessment.errorUnits,
        prompted: assessment.prompted,
        independent: assessment.independent,
        thresholdVersion: assessment.thresholdVersion,
      },
      evidence: evidence.map((e) => ({
        evidenceId: e.id,
        skillNodeId: e.skillNodeId,
        learningItemId: e.learningItemId,
        source: e.source,
        taskType: e.taskType,
        prompted: e.prompted,
        independent: e.independent,
        scenario: e.scenario,
        credibility: e.credibility,
        contributesToPromotion: e.contributesToPromotion,
        succeeded: e.succeeded,
        score: e.score,
      })),
      stateChanges: stateChanges.map((s) => ({
        skillNodeId: s.skillNodeId,
        from: s.from,
        to: s.to,
        evidenceIds: s.evidenceIds,
        reason: s.reason,
        calibrationStatus: 'uncalibrated' as const,
      })),
      routing: {
        taskRoute: 'tts.dynamic_teaching',
        level: routingDecision.level,
        strategy: routingDecision.strategy,
        fellBack: routingDecision.fellBack,
        providerAlias: routingDecision.providerAlias,
        escalationSignals,
        latencyMs: Date.now() - started,
        cost: {
          llmInputTokens,
          llmOutputTokens,
          ttsCharacters: speech.characters,
          asrSeconds: 0,
          pronunciationCalls: assessment.performedPronunciationAssessment ? 1 : 0,
          estimatedCostCny: 0,
        },
      },
      degradation: {
        degraded: speech.meta.degraded || llmDegradationReasons.length > 0,
        reasons: [...speech.meta.reasons, ...llmDegradationReasons],
        offlineFallback: false,
        effectiveLevel: speech.meta.effectiveLevel,
      },
      intent,
      lessonFinished,
      summary: lessonFinished ? '本堂课完成，孩子掌握了本轮练习的目标。' : null,
    };

    // —— 幂等落库 ——
    await this.prisma.interaction_events.create({
      data: {
        id: `ie-${input.idempotencyKey}`,
        lessonSessionId: input.lessonSessionId,
        learnerId: input.learnerId,
        turnIndex: state.turnCount - 1,
        idempotencyKey: input.idempotencyKey,
        intent,
        input: input.response as unknown as object,
        output: result as unknown as object,
        latencyMs: Date.now() - started,
      },
    });

    return result;
  }

  /** 结课。 */
  async finishLesson(lessonSessionId: string, learnerId: string) {
    const session = await this.prisma.lesson_sessions.findUnique({
      where: { id: lessonSessionId },
    });
    if (!session) throw new Error(`课堂 ${lessonSessionId} 不存在`);

    const usage = await this.router.usageSummary({ lessonSessionId });
    const stateChanges = await this.prisma.learner_skill_states.findMany({
      where: { learnerId },
    });

    const completedGoals = Array.from(
      new Set(stateChanges.filter((s) => s.masteryCode >= 2).map((s) => s.skillNodeId)),
    );

    await this.prisma.lesson_sessions.update({
      where: { id: lessonSessionId },
      data: { status: 'finished', finishedAt: new Date() },
    });

    const effectiveTeachingCostCny =
      completedGoals.length > 0 ? usage.totalCostCny / completedGoals.length : usage.totalCostCny;

    return {
      lessonSessionId,
      turns: session.turnCount,
      completedGoals,
      effectiveTeachingCostCny,
      totalCostCny: usage.totalCostCny,
      stateChanges: [],
      summary: `本堂课完成 ${session.turnCount} 轮，形成 ${completedGoals.length} 个能力目标。`,
      reviewScheduled: [],
      calibrationStatus: 'uncalibrated' as const,
    };
  }

  /**
   * 离线兜底：外部服务（含数据库）异常时返回一份完整、可渲染的教学指令，
   * 保证课程不中断（D-015 降级链最后一步 / 验收硬指标）。
   *
   * 铁律：兜底不写证据、不改掌握状态、不计费 ——
   * 没有可靠证据就不能声称学习发生，也不能污染成本账本。
   */
  offlineFallback(input: {
    lessonSessionId: string;
    learnerId: string;
    reason: string;
  }): TurnResponse {
    this.logger.warn(`教学回合进入离线兜底 (${input.learnerId}): ${input.reason}`);
    return {
      lessonSessionId: input.lessonSessionId,
      turnIndex: 0,
      directive: OFFLINE_DIRECTIVE,
      speech: {
        audioRef: 'offline://fixed-course/hello',
        cached: true,
        teacherSpeed: OFFLINE_DIRECTIVE.voice.teacherSpeed,
        voiceStyle: OFFLINE_DIRECTIVE.voice.voiceStyle,
        pauseAfterSentenceMs: OFFLINE_DIRECTIVE.voice.pauseAfterSentenceMs,
        pronunciationMode: OFFLINE_DIRECTIVE.voice.pronunciationMode,
      },
      assessment: {
        performedPronunciationAssessment: false,
        performedAsr: false,
        score: null,
        passed: false,
        errorUnits: [],
        prompted: false,
        independent: false,
        thresholdVersion: null,
      },
      evidence: [],
      stateChanges: [],
      routing: {
        taskRoute: 'tts.fixed_course',
        level: 'L0',
        strategy: 'offline_fixed_course',
        fellBack: true,
        providerAlias: 'course_audio_cache',
        escalationSignals: [],
        latencyMs: 0,
        cost: {
          llmInputTokens: 0,
          llmOutputTokens: 0,
          ttsCharacters: 0,
          asrSeconds: 0,
          pronunciationCalls: 0,
          estimatedCostCny: 0,
        },
      },
      degradation: {
        degraded: true,
        reasons: ['offline_fallback', input.reason],
        offlineFallback: true,
        effectiveLevel: 'L0',
      },
      intent: 'no_answer',
      lessonFinished: false,
      summary: null,
    };
  }

  // ——————————————————— 内部实现 ———————————————————

  /**
   * 意图识别（L0 规则优先，必要时才交给 LLM）。
   *
   * D-008：程序负责确定性事务，LLM 负责需要理解和推理的事务。
   */
  private classifyIntent(response: LearnerResponse): IntentType {
    if (response.requestedSlower) return 'slow_request';
    if (response.requestedRepeat) return 'repeat_request';
    if (!response.text && !response.audioRef && !response.selectedImageId) return 'no_answer';
    if (response.freeUtterance) {
      // 自由发言可能是提问，也可能是闲聊 —— M1 先判为提问
      return 'question';
    }
    return 'learning_answer';
  }

  /**
   * 孩子突然提出新问题时的 LLM 回应（D-008 / 八项硬指标第四项）。
   *
   * 边界极严：LLM 只贡献一句可朗读的儿童友好话术，
   * 不参与评估、不写证据、不改掌握状态、不决定下一个活动（约束一 / 约束三）。
   * 下一步教学仍由 L0 方法阶梯与 Planner 决定，因此模型可随时替换（约束二）。
   *
   * M1 之前编排器里根本没有 LLM 调用点，导致成本账本的 token 字段恒为 0；
   * 接入真实模型后，这条路径才让 LLM 用量可测、可计费、可降级。
   */
  private async answerChildQuestion(input: {
    question: string;
    learnerId: string;
    lessonSessionId: string;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    providerAlias: string;
    degraded: boolean;
  }> {
    const decision = await this.router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.simple_dialogue',
    });

    const fallbackText = '这个问题我们先记下来，等一下一起找答案，好吗？';
    let result: LlmResponse;
    try {
      result = await this.gateway.llm(
        {
          promptKey: 'teacher.child_question',
          promptVersion: 'm1.1',
          system: [
            '你是面向 6—9 岁英语零基础中国儿童的 AI 英语启蒙老师。',
            '用简短、温柔、鼓励式的中文回应孩子的提问，最多两句话，不超过 60 个汉字。',
            '可以自然带出一个简单英文单词，但不要展开讲解。',
            '不评价孩子说得对不对，不判断掌握程度，不布置新任务，不承诺教学结果。',
            '不要解释科学原理、不要给事实性答案；温柔回应一两句后把话题带回当前的英语练习。',
            '如果被问及身份，诚实说明自己是 AI 老师。只用纯文本输出要说的话，',
            '不要 JSON、不要标题、不要表情符号、不要 markdown。',
          ].join(''),
          messages: [{ role: 'user', content: input.question.slice(0, 300) }],
          temperature: 0.4,
          // 业务语义：老师最多说一句短话术。推理型模型需要的最低思考预算
          // 由 LLM_MIN_MAX_TOKENS 在适配层兜底（两者取大值），此处不因换模型而改。
          // 必需配置缺失时由启动期 fail-fast 拒绝启动，不靠调大业务上限掩盖。
          maxTokens: 120,
          timeoutMs: 12000,
        },
        decision,
      );
    } catch (error) {
      this.logger.warn(`LLM 回应失败，使用固定兜底话术: ${(error as Error).message}`);
      return {
        text: fallbackText,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        providerAlias: 'mock_llm',
        degraded: true,
      };
    }

    // finish_reason=length 表示输出被 token 上限截断，话术可能不完整；
    // 如实记录，不把「模型调通了」等同于「老师说了一句完整的话」。
    if (result.finishReason && result.finishReason !== 'stop') {
      this.logger.warn(
        `LLM 输出未正常结束: finish_reason=${result.finishReason} model=${result.modelAlias}`,
      );
    }

    // 输出净化：只保留可朗读的单行短文本，模型不能借话术注入教学结论。
    const cleaned = result.content
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .replace(/[*_`#<>[\]]/g, '')
      .trim()
      .slice(0, 120);
    // Gateway 在真实适配器失败时会回落到 Mock；此处如实标记，不静默掩盖。
    // 另外把「真实模型返回空内容、只能用固定兜底话术」也算降级：
    // 否则推理型模型思考耗尽 token 后，账本会显示 live 成功但老师其实没说话。
    const degraded =
      result.providerAlias !== decision.providerAlias ||
      cleaned.length === 0 ||
      cleaned === fallbackText ||
      // 输出被 token 上限截断时话术不完整，不能算一次成功的真实回应
      (result.finishReason !== undefined && result.finishReason !== 'stop');

    await this.router.recordUsage(
      usageRecord({
        id: `usage-llm-${input.lessonSessionId}-${Date.now()}`,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        serviceKind: 'llm',
        taskRoute: 'llm.simple_dialogue',
        level: decision.level,
        providerAlias: result.providerAlias,
        modelAlias: result.modelAlias,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
      }),
    );

    return {
      text: cleaned || fallbackText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      providerAlias: result.providerAlias,
      degraded,
    };
  }

  /**
   * 评估：按需调用发音评估 / ASR。
   *
   * ASR 不等于发音评估：识别正确不证明发音正确（D-013）。
   * 自由对话用 ASR，针对性跟读用目标词发音评估。
   */
  private async assess(input: {
    response: LearnerResponse;
    activity: {
      taskType: string;
      targetWords: string[];
      requiresPronunciationAssessment: boolean;
      requiresAsr: boolean;
    } | null;
    learnerId: string;
    lessonSessionId: string;
  }): Promise<{
    performedPronunciationAssessment: boolean;
    performedAsr: boolean;
    score: number | null;
    passed: boolean;
    errorUnits: AssessmentRecord extends never ? never : Array<{ unit: string; kind: 'syllable' | 'phoneme' | 'word' | 'pitch' | 'rhythm'; detail: string | null }>;
    prompted: boolean;
    independent: boolean;
    thresholdVersion: string | null;
  }> {
    const emptyUnits: Array<{
      unit: string;
      kind: 'syllable' | 'phoneme' | 'word' | 'pitch' | 'rhythm';
      detail: string | null;
    }> = [];

    if (!input.activity) {
      return {
        performedPronunciationAssessment: false,
        performedAsr: false,
        score: null,
        passed: false,
        errorUnits: emptyUnits,
        prompted: false,
        independent: false,
        thresholdVersion: null,
      };
    }

    const threshold = await this.learnerModel.getThreshold(input.activity.taskType);
    const passScore = threshold?.passScore ?? 80;

    // —— 发音评估：仅在需要跟读评估且有音频时调用 ——
    if (input.activity.requiresPronunciationAssessment && input.response.audioRef) {
      const decision = await this.router.route({
        serviceKind: 'pronunciation',
        taskRoute: 'pronunciation.phoneme',
      });
      const result = await this.gateway.pronunciation(
        {
          audioRef: input.response.audioRef,
          targetText: input.activity.targetWords[0] ?? '',
          language: 'en-US',
          granularity: 'phoneme',
        },
        decision,
      );

      const errorUnits = result.units
        .filter((u) => !u.correct)
        .map((u) => ({
          unit: u.text,
          kind: u.kind as 'syllable' | 'phoneme' | 'word' | 'pitch' | 'rhythm',
          detail: u.detail,
        }));

      await this.router.recordUsage(
        usageRecord({
          id: `usage-pron-${input.lessonSessionId}-${Date.now()}`,
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          serviceKind: 'pronunciation',
          taskRoute: 'pronunciation.phoneme',
          level: decision.level,
          providerAlias: decision.providerAlias,
          modelAlias: decision.modelAlias,
          pronunciationCalls: 1,
          latencyMs: result.latencyMs,
        }),
      );

      const passed = result.score >= passScore;
      return {
        performedPronunciationAssessment: true,
        performedAsr: false,
        score: result.score,
        passed,
        errorUnits,
        prompted: false,
        independent: passed,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    // —— ASR：自由表达或需要识别时调用 ——
    if (input.activity.requiresAsr && input.response.audioRef) {
      const decision = await this.router.route({
        serviceKind: 'asr',
        taskRoute: 'asr.free_speech',
      });
      const result = await this.gateway.asr(
        { audioRef: input.response.audioRef },
        decision,
      );
      await this.router.recordUsage(
        usageRecord({
          id: `usage-asr-${input.lessonSessionId}-${Date.now()}`,
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          serviceKind: 'asr',
          taskRoute: 'asr.free_speech',
          level: decision.level,
          providerAlias: decision.providerAlias,
          modelAlias: decision.modelAlias,
          asrSeconds: result.seconds,
          latencyMs: result.latencyMs,
        }),
      );

      const passed = result.transcript.length > 0 && !result.suspect;
      return {
        performedPronunciationAssessment: false,
        performedAsr: true,
        score: null,
        passed,
        errorUnits: emptyUnits,
        prompted: false,
        independent: passed,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    // —— 点选 / 作答类：本地确定性判定 ——
    if (input.response.selectedImageId) {
      const passed = Boolean(input.response.selectedImageId);
      return {
        performedPronunciationAssessment: false,
        performedAsr: false,
        score: passed ? 100 : 0,
        passed,
        errorUnits: emptyUnits,
        prompted: false,
        independent: passed,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    if (input.response.text) {
      const passed = input.response.text.trim().length > 0;
      return {
        performedPronunciationAssessment: false,
        performedAsr: false,
        score: passed ? 90 : 0,
        passed,
        errorUnits: emptyUnits,
        prompted: false,
        independent: passed,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    return {
      performedPronunciationAssessment: false,
      performedAsr: false,
      score: null,
      passed: false,
      errorUnits: emptyUnits,
      prompted: false,
      independent: false,
      thresholdVersion: threshold?.version ?? null,
    };
  }

  /** 写证据（只 INSERT）。 */
  private async recordEvidence(input: {
    assessment: Awaited<ReturnType<OrchestratorService['assess']>>;
    activity: { skillNodeIds: string[]; taskType: string; scenario: string } | null;
    learnerId: string;
    lessonSessionId: string;
  }) {
    const activity = input.activity;
    if (!activity) return [];

    const source = input.assessment.performedPronunciationAssessment
      ? 'pronunciation_api'
      : input.assessment.performedAsr
        ? 'asr'
        : 'task_result';

    const targets = resolveEvidenceTargets(activity.skillNodeIds);
    const occurredAt = new Date().toISOString();
    return Promise.all(
      targets.map(async ({ skillNodeId, abilityCategory }) => {
        const id = await this.learnerModel.appendEvidence({
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          skillNodeId,
          learningItemId: null,
          abilityCategory,
          vocabularyDimension: null,
          source,
          taskType: activity.taskType as never,
          prompted: input.assessment.prompted,
          independent: input.assessment.independent,
          scenario: activity.scenario as never,
          succeeded: input.assessment.passed,
          score: input.assessment.score,
          errorUnits: input.assessment.errorUnits,
          note: null,
          thresholdVersion: input.assessment.thresholdVersion,
          ruleVersion: 'R1-R7',
          occurredAt: new Date(occurredAt),
        });

        return {
          id,
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          skillNodeId,
          learningItemId: null,
          abilityCategory,
          vocabularyDimension: null,
          source: source as never,
          taskType: activity.taskType as never,
          prompted: input.assessment.prompted,
          independent: input.assessment.independent,
          scenario: activity.scenario as never,
          occurredAt,
          credibility: source === 'pronunciation_api' ? 1 : 0.9,
          contributesToPromotion: true,
          succeeded: input.assessment.passed,
          score: input.assessment.score,
          errorUnits: input.assessment.errorUnits,
          note: null,
          thresholdVersion: input.assessment.thresholdVersion,
          ruleVersion: 'R1-R7',
        };
      }),
    );
  }

  /** 重算能力状态（规则引擎）。 */
  private async recomputeStates(input: {
    learnerId: string;
    activity: { skillNodeIds: string[]; taskType: string } | null;
  }) {
    if (!input.activity) return [];
    const transitions = [];
    for (const skillNodeId of input.activity.skillNodeIds) {
      const threshold = await this.learnerModel.getThreshold(input.activity.taskType);
      if (!threshold) continue;
      const transition = await this.learnerModel.recomputeState({
        learnerId: input.learnerId,
        skillNodeId,
        threshold,
      });
      if (transition) transitions.push(transition);
    }
    return transitions;
  }

  /**
   * 构造教学指令。
   * 方法阶梯决定语速与示范内容（D-010）。
   */
  private async buildDirective(input: {
    activityId: string;
    learnerId: string;
    sessionId: string;
    methodState: MethodLadderState;
    errorUnits: Array<{ unit: string; kind: string; detail: string | null }>;
  }): Promise<TeachingDirective> {
    const item = await this.prisma.learning_items.findUnique({
      where: { id: input.activityId },
    });
    const activity = item?.content as unknown as {
      taskType: string;
      scenario: string;
      skillNodeIds: string[];
      targetWords: string[];
      demonstrationText: string | null;
      teacherUtteranceZh: string;
    };

    const baseSpeed = 0.65;
    const teacherSpeed = resolveTeacherSpeed(baseSpeed, input.methodState.current);
    const targetWord = activity.targetWords[0] ?? '';
    const syllables = splitWord(targetWord);

    const demo = resolveDemonstration({
      method: input.methodState.current,
      targetWord,
      syllables,
      errorUnits: input.errorUnits,
    });

    const pronunciationUnits = demo.focusOnErrorOnly
      ? demo.focusUnits.map((u) => ({ text: u, kind: 'syllable' as const, isFocus: true }))
      : syllables.map((s) => ({ text: s, kind: 'syllable' as const, isFocus: false }));

    return {
      targetSkillNodeId: activity.skillNodeIds[0] ?? 'LA.LISTEN.greeting_core',
      taskType: activity.taskType as TeachingDirective['taskType'],
      scenario: activity.scenario as TeachingDirective['scenario'],
      teacherUtterance: activity.teacherUtteranceZh,
      demonstrationText: demo.demonstrationText,
      pronunciationUnits,
      expectedResponse: expectedResponseOf(activity.taskType),
      targetWords: activity.targetWords,
      voice: {
        teacherSpeed,
        voiceStyle: 'gentle',
        pauseAfterSentenceMs: 1000,
        pronunciationMode:
          input.methodState.current === 'method_syllable_split' ||
          input.methodState.current === 'method_phoneme_focus'
            ? 'syllable_by_syllable'
            : 'slow_clear',
      },
      allowRepeat: true,
      methodVariant: input.methodState.current,
      consecutiveFailures: input.methodState.consecutiveFailures,
      personaHint: '耐心、温柔、积极鼓励；不嘲笑、不催促；诚实说明自己是 AI 老师。',
    };
  }

  /** 生成语音。 */
  private async synthesize(
    directive: TeachingDirective,
    decision?: Awaited<ReturnType<ModelRouterImpl['route']>>,
  ): Promise<{
    speech: TurnResponse['speech'];
    characters: number;
    /** Gateway 真实调用链上的降级信息，用于 degradation 如实上报 */
    meta: {
      degraded: boolean;
      reasons: string[];
      effectiveLevel: RoutingDecision['level'];
      providerAlias: string;
    };
  }> {
    const routingDecision =
      decision ??
      (await this.router.route({ serviceKind: 'tts', taskRoute: 'tts.dynamic_teaching' }));

    const text = [directive.teacherUtterance, directive.demonstrationText]
      .filter(Boolean)
      .join(' ');

    const outcome = await this.gateway.ttsWithResult(
      {
        text,
        voice: directive.voice,
        voiceIdentity: 'teacher_default',
      },
      routingDecision,
    );

    return {
      speech: {
        audioRef: outcome.result.audioRef,
        cached: outcome.result.cached,
        teacherSpeed: directive.voice.teacherSpeed,
        voiceStyle: directive.voice.voiceStyle,
        pauseAfterSentenceMs: directive.voice.pauseAfterSentenceMs,
        pronunciationMode: directive.voice.pronunciationMode,
      },
      characters: outcome.result.characters,
      meta: {
        degraded: outcome.degraded,
        reasons: outcome.reasons,
        effectiveLevel: outcome.effectiveLevel,
        providerAlias: outcome.providerAlias,
      },
    };
  }

  private getRuntime(sessionId: string): SessionRuntimeState {
    let state = this.runtime.get(sessionId);
    if (!state) {
      state = {
        methodLadder: initialMethodLadderState(),
        currentActivityId: null,
        turnCount: 0,
        completedActivities: [],
        consecutiveSuccesses: {},
      };
      this.runtime.set(sessionId, state);
    }
    return state;
  }
}


/**
 * 构造用量记录。
 * 所有字段必须显式给出 —— 成本账本要求每堂课的 LLM Token、TTS 字符量、
 * ASR 时长与发音评估次数都有完整记录（D-015）。
 */
function usageRecord(input: {
  id: string;
  learnerId: string;
  lessonSessionId: string;
  serviceKind: 'llm' | 'tts' | 'asr' | 'pronunciation';
  taskRoute: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
  providerAlias: string;
  modelAlias: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  ttsCharacters?: number;
  asrSeconds?: number;
  pronunciationCalls?: number;
  estimatedCostCny?: number;
}) {
  return {
    id: input.id,
    learnerId: input.learnerId,
    lessonSessionId: input.lessonSessionId,
    serviceKind: input.serviceKind,
    taskRoute: input.taskRoute,
    level: input.level,
    providerAlias: input.providerAlias,
    modelAlias: input.modelAlias,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    ttsCharacters: input.ttsCharacters ?? 0,
    asrSeconds: input.asrSeconds ?? 0,
    pronunciationCalls: input.pronunciationCalls ?? 0,
    estimatedCostCny: input.estimatedCostCny ?? 0,
    latencyMs: input.latencyMs,
    createdAt: new Date().toISOString(),
  };
}

/** 任务类型 → 期望的回应方式。 */
function expectedResponseOf(taskType: string): TeachingDirective['expectedResponse'] {
  switch (taskType) {
    case 'word_mimicry':
    case 'pronunciation_drill':
      return 'repeat';
    case 'image_identification':
      return 'tap_image';
    case 'listening_comprehension':
      return 'listen';
    case 'free_response':
    case 'sentence_pattern':
    case 'situational_dialogue':
      return 'speak';
    default:
      return 'answer';
  }
}

/** 极简音节切分（后端不依赖 provider-sdk 的 mock 表）。 */
function splitWord(word: string): string[] {
  const table: Record<string, string[]> = {
    hello: ['he', 'llo'],
    bye: ['bye'],
    apple: ['ap', 'ple'],
    banana: ['ba', 'na', 'na'],
    'thank you': ['thank', 'you'],
    sorry: ['sor', 'ry'],
    'good morning': ['good', 'mor', 'ning'],
    goodbye: ['good', 'bye'],
    'i am': ['i', 'am'],
    'my name is': ['my', 'name', 'is'],
    ball: ['ball'],
    book: ['book'],
    cup: ['cup'],
    cat: ['cat'],
    dog: ['dog'],
    red: ['red'],
    blue: ['blue'],
    green: ['green'],
    like: ['like'],
    this: ['this'],
    please: ['please'],
    yes: ['yes'],
    no: ['no'],
    hi: ['hi'],
  };
  const key = word.toLowerCase().trim();
  return table[key] ?? [key];
}

function topicNameOf(topicId: string): string {
  const names: Record<string, string> = {
    'topic-greetings': '问候',
    'topic-self-introduction': '自我介绍',
    'topic-objects-around': '身边物品',
  };
  return names[topicId] ?? topicId;
}

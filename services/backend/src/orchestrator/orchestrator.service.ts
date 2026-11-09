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
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
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
import { selectFollowUpSkillNodeIds } from '../planner/growth-followup';
import { PrismaService } from '../prisma/prisma.service';
import { GrowthMentorService } from '../agents/growth-mentor.service';
import { MemoryManagerService } from '../agents/memory-manager.service';
import { PersonalityEngineService } from '../agents/personality-engine.service';

/**
 * 离线兜底的固定课程内容（D-015 降级链最后一步）。
 *
 * 完全内置、不查库、不调用任何外部服务 —— 数据库与网络都不可用时
 * 仍能给孩子一段可播放、可跟读的教学内容，保证课程不中断。
 */
const OFFLINE_DIRECTIVE: TeachingDirective = {
  targetSkillNodeId: 'LA.LISTEN.greeting_core',
  taskType: 'listening_comprehension',
  isReview: false,
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
  currentReviewScheduleId: string | null;
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
    @Inject(GrowthMentorService) private readonly growthMentor: GrowthMentorService,
    @Inject(MemoryManagerService) private readonly memoryManager: MemoryManagerService,
    @Inject(PersonalityEngineService) private readonly personalityEngine: PersonalityEngineService,
  ) {}

  /** 开课。 */
  /** 返回类型直接绑定契约，避免实现与 lessonStartResponseSchema 漂移。 */
  async startLesson(input: { learnerId: string; topicId?: string }): Promise<LessonStartResponse> {
    const previousArchive = await this.prisma.learner_growth_snapshots.findFirst({
      where: { learnerId: input.learnerId },
      orderBy: { createdAt: 'desc' },
      select: { snapshot: true },
    });
    const previousSnapshot = previousArchive?.snapshot as {
      session?: { topicId?: string };
      evidenceBySkill?: Array<{
        skillNodeId: string;
        unsuccessfulAttempts: number;
        independentSuccesses: number;
      }>;
      nextFocusSkillNodeIds?: string[];
    } | undefined;
    const previousFinishedSession = previousSnapshot?.session?.topicId
      ? null
      : await this.prisma.lesson_sessions.findFirst({
          where: { learnerId: input.learnerId, status: 'finished' },
          orderBy: { finishedAt: 'desc' },
          select: { topicId: true },
        });
    const previousTopicId = previousSnapshot?.session?.topicId ?? previousFinishedSession?.topicId;
    // 未指定主题时沿用最近完成课程的主题，让隔天重进真正延续教学上下文；
    // Planner 仍会依据能力、复习和跨场景证据决定具体活动，不把主题顺序当成能力状态。
    const topicId = input.topicId ?? previousTopicId ?? 'topic-greetings';
    const followUpSkillNodeIds = Array.from(new Set([
      ...selectFollowUpSkillNodeIds(previousSnapshot?.evidenceBySkill ?? []),
      ...(previousSnapshot?.nextFocusSkillNodeIds ?? []),
    ])).slice(0, 5);
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
      currentReviewScheduleId: null,
      turnCount: 0,
      completedActivities: [],
      consecutiveSuccesses: {},
    });

    const step = await this.planner.planNext({
      topicId,
      learnerId: input.learnerId,
      lessonSessionId: session.id,
      excludeActivityIds: [],
      followUpSkillNodeIds,
    });

    if (!step) {
      throw new Error(`主题 ${topicId} 没有可用活动`);
    }

    await this.prisma.lesson_sessions.update({
      where: { id: session.id },
      data: {
        currentActivityId: step.activity.id,
        currentReviewScheduleId: step.reviewScheduleId,
      },
    });
    const startState = this.getRuntime(session.id);
    startState.currentActivityId = step.activity.id;
    startState.currentReviewScheduleId = step.reviewScheduleId;

    const directive = await this.buildDirective({
      activityId: step.activity.id,
      learnerId: input.learnerId,
      sessionId: session.id,
      methodState: this.getRuntime(session.id).methodLadder,
      errorUnits: [],
      isReview: step.isReview,
    });
    if (previousTopicId) {
      const previousTopicName = topicNameOf(previousTopicId);
      directive.teacherUtterance = step.isReview
        ? `欢迎回来。上次我们一起练习了「${previousTopicName}」。先试着自己回忆吧。`
        : `欢迎回来。上次我们一起练习了「${previousTopicName}」，今天继续学习。`;
    }

    const speech = await this.synthesize(directive);
    await this.prisma.lesson_sessions.update({
      where: { id: session.id },
      data: {
        currentDirective: directive as unknown as object,
        currentSpeech: speech.speech as unknown as object,
      },
    });
    await this.router.recordUsage(
      usageRecord({
        id: `usage-tts-start-${session.id}`,
        learnerId: input.learnerId,
        lessonSessionId: session.id,
        serviceKind: 'tts',
        taskRoute: 'tts.dynamic_teaching',
        level: speech.meta.effectiveLevel,
        providerAlias: speech.meta.providerAlias,
        modelAlias: speech.meta.modelAlias,
        ttsCharacters: speech.characters,
        latencyMs: speech.meta.latencyMs,
      }),
    );
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
    state.currentActivityId = session.currentActivityId;
    state.currentReviewScheduleId = session.currentReviewScheduleId;
    state.turnCount = session.turnCount;
    if (session.methodState && typeof session.methodState === 'object') {
      const persistedState = session.methodState as unknown as MethodLadderState & {
        completedActivities?: string[];
      };
      const { completedActivities, ...methodLadder } = persistedState;
      state.methodLadder = methodLadder as MethodLadderState;
      state.completedActivities = Array.isArray(persistedState.completedActivities)
        ? persistedState.completedActivities
        : [];
    }
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
      assessment?: {
        acceptedImageIds?: string[];
        acceptedTexts?: string[];
        requiredPhrases?: string[];
        openResponse?: boolean;
      };
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
        lessonSessionId: input.lessonSessionId,
        excludeActivityIds: state.completedActivities,
      });
      if (!step) {
        throw new Error('没有可用的教学活动');
      }
      currentActivity = step.activity as unknown as typeof currentActivity;
      await this.prisma.lesson_sessions.update({
        where: { id: input.lessonSessionId },
        data: {
          currentActivityId: step.activity.id,
          currentReviewScheduleId: step.reviewScheduleId,
        },
      });
      state.currentActivityId = step.activity.id;
      state.currentReviewScheduleId = step.reviewScheduleId;
    }

    const reviewTarget = state.currentReviewScheduleId
      ? await this.planner.getReviewTarget({
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          reviewScheduleId: state.currentReviewScheduleId,
        })
      : null;
    const isReviewRound = Boolean(state.currentReviewScheduleId);

    // 播放控制只影响老师的讲解，不构成学习答案，也不产生能力证据。
    if (intent === 'repeat_request' || intent === 'slow_request') {
      const playback = await this.handlePlaybackRequest({
        session,
        learnerId: input.learnerId,
        idempotencyKey: input.idempotencyKey,
        response: input.response,
        intent,
        state,
      });
      if (playback) return playback;
    }

    // 普通交流不属于当前学习任务：只回应孩子并保留当前活动、复习项和方法阶梯。
    // 这样闲聊/提问不会被误写成学习证据，也不会因为一次闲聊推进课程。
    if (intent === 'question' || intent === 'small_talk') {
      return this.handleConversationalTurn({
        session,
        learnerId: input.learnerId,
        response: input.response,
        idempotencyKey: input.idempotencyKey,
        intent,
        state,
        activityId: currentActivity!.id,
        isReview: isReviewRound,
      });
    }

    // —— 第三步：按需评估 ——
    const assessment = await this.assess({
      response: input.response,
      activity: currentActivity,
      learnerId: input.learnerId,
      lessonSessionId: input.lessonSessionId,
    });
    const passiveActivityCompleted = isPassiveActivity(currentActivity!.taskType) &&
      !input.response.text?.trim() &&
      !input.response.audioRef &&
      !input.response.selectedImageId;

    // —— 第四步：更新档案（写证据 + 重算状态）——
    const evidence = await this.recordEvidence({
      assessment,
      activity: currentActivity,
      reviewTarget,
      learnerId: input.learnerId,
      lessonSessionId: input.lessonSessionId,
    });

    const stateChanges = assessment.evaluated
      ? await this.recomputeStates({
          learnerId: input.learnerId,
          activity: currentActivity,
        })
      : [];

    if (state.currentReviewScheduleId) {
      if (assessment.evaluated) {
        await this.planner.resolveReview({
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          reviewScheduleId: state.currentReviewScheduleId,
          succeeded: assessment.passed,
        });
        state.currentReviewScheduleId = null;
      } else if (passiveActivityCompleted) {
        await this.planner.releaseReviewClaim({
          lessonSessionId: input.lessonSessionId,
          reviewScheduleId: state.currentReviewScheduleId,
        });
        state.currentReviewScheduleId = null;
      }
    }

    if (assessment.passed && assessment.evaluated) {
      for (const skillNodeId of currentActivity!.skillNodeIds) {
        await this.planner.scheduleInitialReview({
          learnerId: input.learnerId,
          skillNodeId,
          learningItemId: reviewTarget?.skillNodeId === skillNodeId && reviewTarget.learningItemId
            ? reviewTarget.learningItemId
            : currentActivity!.id,
        });
      }
    }

    // —— 第五步：调整下一次教学（方法阶梯，L0 规则）——
    const ladder = assessment.evaluated
      ? advanceMethodLadder({
          passed: assessment.passed,
          state: state.methodLadder,
        })
      : { state: state.methodLadder, needsEscalation: false };
    state.methodLadder = ladder.state;

    if (ladder.needsEscalation) {
      escalationSignals.push('method_already_changed');
    }
    if (assessment.evaluated && !assessment.passed && state.methodLadder.consecutiveFailures >= 2) {
      escalationSignals.push('task_incomplete');
    }

    // —— 第七步：决定是否结束本堂课 ——
    state.turnCount += 1;
    const activityCompleted = assessment.evaluated
      ? assessment.passed
      : passiveActivityCompleted;
    if (activityCompleted) {
      if (!state.completedActivities.includes(currentActivity!.id)) {
        state.completedActivities.push(currentActivity!.id);
      }
      if (assessment.evaluated && assessment.passed) {
        state.consecutiveSuccesses[currentActivity!.skillNodeIds[0] ?? ''] =
          (state.consecutiveSuccesses[currentActivity!.skillNodeIds[0] ?? ''] ?? 0) + 1;
      }
      state.currentActivityId = null;
      state.currentReviewScheduleId = null;
    } else {
      // 未达标不推进到下一个活动，继续陪练
    }

    if (activityCompleted) {
      const nextStep = await this.planner.planNext({
        topicId: session.topicId,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        excludeActivityIds: state.completedActivities,
      });
      if (nextStep) {
        state.currentActivityId = nextStep.activity.id;
        state.currentReviewScheduleId = nextStep.reviewScheduleId;
      }
    }
    const lessonFinished = activityCompleted && state.currentActivityId === null;
    const outputActivityId = state.currentActivityId ?? currentActivity!.id;
    const outputIsReview = state.currentActivityId
      ? Boolean(state.currentReviewScheduleId)
      : isReviewRound;
    const outputErrorUnits = state.currentActivityId ? [] : assessment.errorUnits;

    // —— 第六步：生成下一步语音 ——
    const directive = await this.buildDirective({
      activityId: outputActivityId,
      learnerId: input.learnerId,
      sessionId: input.lessonSessionId,
      methodState: state.methodLadder,
      errorUnits: outputErrorUnits,
      isReview: outputIsReview,
    });

    // 普通提问/闲聊已在评估前单独处理；学习回合不额外调用对话模型。
    const llmInputTokens = 0;
    const llmOutputTokens = 0;
    const llmDegradationReasons: string[] = [];

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
        level: speech.meta.effectiveLevel,
        providerAlias: speech.meta.providerAlias,
        modelAlias: speech.meta.modelAlias,
        ttsCharacters: speech.characters,
        latencyMs: Date.now() - started,
      }),
    );

    const persistedMethodState = Object.assign({}, state.methodLadder, {
      completedActivities: state.completedActivities,
    });
    await this.prisma.lesson_sessions.update({
      where: { id: input.lessonSessionId },
      data: {
        turnCount: state.turnCount,
        methodState: persistedMethodState as unknown as object,
        currentActivityId: lessonFinished ? null : state.currentActivityId,
        currentReviewScheduleId: lessonFinished ? null : state.currentReviewScheduleId,
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
        evaluated: assessment.evaluated,
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
      summary: lessonFinished ? '本堂课的可用活动已完成；能力掌握仍以持续的有效评估证据为准。' : null,
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

    await this.prisma.lesson_sessions.update({
      where: { id: input.lessonSessionId },
      data: {
        currentDirective: directive as unknown as object,
        currentSpeech: speech.speech as unknown as object,
      },
    });

    return result;
  }

  private async handlePlaybackRequest(input: {
    session: {
      id: string;
      currentDirective: unknown;
      currentSpeech: unknown;
    };
    learnerId: string;
    idempotencyKey: string;
    response: LearnerResponse;
    intent: 'repeat_request' | 'slow_request';
    state: SessionRuntimeState;
  }): Promise<TurnResponse | null> {
    if (!input.session.currentDirective || !input.session.currentSpeech) return null;

    const started = Date.now();
    const directive = structuredClone(input.session.currentDirective) as TeachingDirective;
    let speech = structuredClone(input.session.currentSpeech) as TurnResponse['speech'];
    let routingDecision = await this.router.route({
      serviceKind: 'tts',
      taskRoute: 'tts.dynamic_teaching',
    });
    let ttsCharacters = 0;

    if (input.intent === 'repeat_request') {
      speech.cached = true;
    } else {
      directive.voice.teacherSpeed = Math.max(0.25, Math.round((directive.voice.teacherSpeed - 0.15) * 100) / 100);
      const synthesized = await this.synthesize(directive, routingDecision);
      speech = synthesized.speech;
      ttsCharacters = synthesized.characters;
      routingDecision = {
        ...routingDecision,
        level: synthesized.meta.effectiveLevel,
        providerAlias: synthesized.meta.providerAlias,
      };
      await this.router.recordUsage(
        usageRecord({
          id: `usage-slow-${input.session.id}-${input.state.turnCount}`,
          learnerId: input.learnerId,
          lessonSessionId: input.session.id,
          serviceKind: 'tts',
          taskRoute: 'tts.dynamic_teaching',
          level: synthesized.meta.effectiveLevel,
          providerAlias: synthesized.meta.providerAlias,
          modelAlias: synthesized.meta.modelAlias,
          ttsCharacters,
          latencyMs: Date.now() - started,
        }),
      );
      await this.prisma.lesson_sessions.update({
        where: { id: input.session.id },
        data: {
          currentDirective: directive as unknown as object,
          currentSpeech: speech as unknown as object,
        },
      });
    }

    const turnIndex = input.state.turnCount;
    input.state.turnCount += 1;
    await this.prisma.lesson_sessions.update({
      where: { id: input.session.id },
      data: { turnCount: input.state.turnCount },
    });

    const result: TurnResponse = {
      lessonSessionId: input.session.id,
      turnIndex,
      directive,
      speech,
      assessment: {
        performedPronunciationAssessment: false,
        performedAsr: false,
        evaluated: false,
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
        taskRoute: 'tts.dynamic_teaching',
        level: routingDecision.level,
        strategy: routingDecision.strategy,
        fellBack: routingDecision.fellBack,
        providerAlias: routingDecision.providerAlias,
        escalationSignals: [],
        latencyMs: Date.now() - started,
        cost: {
          llmInputTokens: 0,
          llmOutputTokens: 0,
          ttsCharacters,
          asrSeconds: 0,
          pronunciationCalls: 0,
          estimatedCostCny: 0,
        },
      },
      degradation: {
        degraded: false,
        reasons: [],
        offlineFallback: false,
        effectiveLevel: routingDecision.level,
      },
      intent: input.intent,
      lessonFinished: false,
      summary: null,
    };

    await this.prisma.interaction_events.create({
      data: {
        id: `ie-${input.idempotencyKey}`,
        lessonSessionId: input.session.id,
        learnerId: input.learnerId,
        turnIndex,
        idempotencyKey: input.idempotencyKey,
        intent: input.intent,
        input: input.response as unknown as object,
        output: result as unknown as object,
        latencyMs: Date.now() - started,
      },
    });
    return result;
  }

  /** 回应提问/闲聊，但不改变当前学习任务的教学证据与方法状态。 */
  private async handleConversationalTurn(input: {
    session: {
      id: string;
      currentDirective: unknown;
      currentSpeech: unknown;
    };
    learnerId: string;
    response: LearnerResponse;
    idempotencyKey: string;
    intent: 'question' | 'small_talk';
    state: SessionRuntimeState;
    activityId: string;
    isReview: boolean;
  }): Promise<TurnResponse> {
    const started = Date.now();
    const directive = await this.buildDirective({
      activityId: input.activityId,
      learnerId: input.learnerId,
      sessionId: input.session.id,
      methodState: input.state.methodLadder,
      errorUnits: [],
      isReview: input.isReview,
    });
    const answer = await this.answerChildQuestion({
      question: input.response.freeUtterance ?? input.response.text ?? '孩子想和老师聊一聊',
      learnerId: input.learnerId,
      lessonSessionId: input.session.id,
      intent: input.intent,
    });
    directive.teacherUtterance = `${answer.text} ${directive.teacherUtterance}`.trim();

    const routingDecision = await this.router.route({
      serviceKind: 'tts',
      taskRoute: 'tts.dynamic_teaching',
    });
    const speech = await this.synthesize(directive, routingDecision);
    await this.router.recordUsage(
      usageRecord({
        id: `usage-conversation-tts-${input.session.id}-${input.state.turnCount}`,
        learnerId: input.learnerId,
        lessonSessionId: input.session.id,
        serviceKind: 'tts',
        taskRoute: 'tts.dynamic_teaching',
        level: speech.meta.effectiveLevel,
        providerAlias: speech.meta.providerAlias,
        modelAlias: speech.meta.modelAlias,
        ttsCharacters: speech.characters,
        latencyMs: Date.now() - started,
      }),
    );

    const turnIndex = input.state.turnCount;
    input.state.turnCount += 1;
    await this.prisma.lesson_sessions.update({
      where: { id: input.session.id },
      data: {
        turnCount: input.state.turnCount,
        currentDirective: directive as unknown as object,
        currentSpeech: speech.speech as unknown as object,
      },
    });

    const result: TurnResponse = {
      lessonSessionId: input.session.id,
      turnIndex,
      directive,
      speech: speech.speech,
      assessment: {
        performedPronunciationAssessment: false,
        performedAsr: false,
        evaluated: false,
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
        taskRoute: 'tts.dynamic_teaching',
        level: speech.meta.effectiveLevel,
        strategy: routingDecision.strategy,
        fellBack: routingDecision.fellBack || speech.meta.degraded,
        providerAlias: speech.meta.providerAlias,
        escalationSignals: [],
        latencyMs: Date.now() - started,
        cost: {
          llmInputTokens: answer.inputTokens,
          llmOutputTokens: answer.outputTokens,
          ttsCharacters: speech.characters,
          asrSeconds: 0,
          pronunciationCalls: 0,
          estimatedCostCny: 0,
        },
      },
      degradation: {
        degraded: speech.meta.degraded || answer.degraded,
        reasons: [...speech.meta.reasons, ...(answer.degraded ? ['llm_fell_back_to_mock'] : [])],
        offlineFallback: false,
        effectiveLevel: speech.meta.effectiveLevel,
      },
      intent: input.intent,
      lessonFinished: false,
      summary: null,
    };

    await this.prisma.interaction_events.create({
      data: {
        id: `ie-${input.idempotencyKey}`,
        lessonSessionId: input.session.id,
        learnerId: input.learnerId,
        turnIndex,
        idempotencyKey: input.idempotencyKey,
        intent: input.intent,
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
    if (session.learnerId !== learnerId) throw new ForbiddenException('课堂不属于该学习者');
    if (session.status === 'finished') {
      const archived = await this.prisma.learner_growth_snapshots.findUnique({
        where: { lessonSessionId },
        select: { snapshot: true },
      });
      const snapshot = archived?.snapshot as {
        growthReport?: { strengths: string[]; practiceFocus: string[]; caregiverGuidance: string[] };
        abilities?: Array<{ skillNodeId: string; masteryCode: number }>;
        upcomingReviews?: Array<{ skillNodeId: string; dueAt: string; intervalDays: number }>;
      } | undefined;
      if (snapshot?.growthReport) {
        const usage = await this.router.usageSummary({ lessonSessionId });
        const completedGoals = (snapshot.abilities ?? [])
          .filter((ability) => ability.masteryCode >= 2)
          .map((ability) => ability.skillNodeId);
        return {
          lessonSessionId,
          turns: session.turnCount,
          completedGoals,
          effectiveTeachingCostCny: completedGoals.length > 0
            ? usage.totalCostCny / completedGoals.length
            : usage.totalCostCny,
          totalCostCny: usage.totalCostCny,
          stateChanges: [],
          summary: session.summary ?? '本堂课已完成。',
          growthReport: snapshot.growthReport,
          reviewScheduled: (snapshot.upcomingReviews ?? []).map((review) => ({
            skillNodeId: review.skillNodeId,
            dueAt: review.dueAt,
            intervalDays: review.intervalDays,
          })),
          calibrationStatus: 'uncalibrated' as const,
        };
      }
    }

    if (session.currentReviewScheduleId) {
      await this.planner.releaseReviewClaim({
        lessonSessionId,
        reviewScheduleId: session.currentReviewScheduleId,
      });
    }

    const stateChanges = await this.prisma.learner_skill_states.findMany({
      where: { learnerId },
    });

    const completedGoals = Array.from(
      new Set(stateChanges.filter((s) => s.masteryCode >= 2).map((s) => s.skillNodeId)),
    );

    await this.prisma.lesson_sessions.update({
      where: { id: lessonSessionId },
      data: {
        status: 'finished',
        finishedAt: new Date(),
        currentActivityId: null,
        currentReviewScheduleId: null,
      },
    });

    const reviewScheduled = await this.prisma.review_schedules.findMany({
      where: { learnerId, completedAt: null },
      orderBy: { dueAt: 'asc' },
      select: { skillNodeId: true, dueAt: true, intervalDays: true },
    });

    const [sessionEvidence, abilityRows] = await Promise.all([
      this.prisma.learning_evidence.findMany({
        where: { learnerId, lessonSessionId },
        include: { skillNode: { select: { name: true, abilityCategory: true } } },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.learner_skill_states.findMany({
        where: { learnerId },
        include: { skillNode: { select: { name: true, abilityCategory: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);
    const bySkill = new Map<string, {
      skillNodeId: string;
      skillName: string;
      abilityCategory: string;
      evidenceCount: number;
      independentSuccesses: number;
      unsuccessfulAttempts: number;
      scenarios: Set<string>;
      errorCounts: Map<string, number>;
    }>();
    for (const row of sessionEvidence) {
      const group = bySkill.get(row.skillNodeId) ?? {
        skillNodeId: row.skillNodeId,
        skillName: row.skillNode.name,
        abilityCategory: row.skillNode.abilityCategory,
        evidenceCount: 0,
        independentSuccesses: 0,
        unsuccessfulAttempts: 0,
        scenarios: new Set<string>(),
        errorCounts: new Map<string, number>(),
      };
      group.evidenceCount += 1;
      if (row.succeeded && row.independent) group.independentSuccesses += 1;
      if (!row.succeeded) group.unsuccessfulAttempts += 1;
      if (row.independent && row.succeeded) group.scenarios.add(row.scenario);
      if (Array.isArray(row.errorUnits)) {
        for (const entry of row.errorUnits) {
          if (!entry || typeof entry !== 'object' || !('unit' in entry)) continue;
          const unit = (entry as { unit: unknown }).unit;
          if (typeof unit === 'string' && unit.trim()) {
            group.errorCounts.set(unit, (group.errorCounts.get(unit) ?? 0) + 1);
          }
        }
      }
      bySkill.set(row.skillNodeId, group);
    }
    const evidenceSummary = Array.from(bySkill.values()).map((group) => ({
      skillNodeId: group.skillNodeId,
      skillName: group.skillName,
      abilityCategory: group.abilityCategory,
      evidenceCount: group.evidenceCount,
      independentSuccesses: group.independentSuccesses,
      unsuccessfulAttempts: group.unsuccessfulAttempts,
      independentScenarios: Array.from(group.scenarios),
      commonErrorUnits: Array.from(group.errorCounts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([unit, count]) => ({ unit, count })),
    }));
    const nextFocusSkillNodeIds = await this.planner.planLongTermFocus({
      learnerId,
      evidenceBySkill: evidenceSummary.map((item) => ({
        skillNodeId: item.skillNodeId,
        unsuccessfulAttempts: item.unsuccessfulAttempts,
        independentSuccesses: item.independentSuccesses,
      })),
    });
    const completedAt = new Date();
    const summary = `本堂课 ${session.turnCount} 轮，记录 ${sessionEvidence.length} 条学习证据，涉及 ${evidenceSummary.length} 项能力。档案为内部学习记录，状态未经儿童样本校准。`;
    const growthReport = await this.growthMentor.createLessonReport({
      learnerId,
      lessonSessionId,
      topicId: session.topicId,
      turns: session.turnCount,
      evidenceBySkill: evidenceSummary.map((item) => ({
        skillNodeId: item.skillNodeId,
        skillName: item.skillName,
        evidenceCount: item.evidenceCount,
        independentSuccesses: item.independentSuccesses,
        unsuccessfulAttempts: item.unsuccessfulAttempts,
        commonErrorUnits: item.commonErrorUnits,
      })),
      upcomingReviews: reviewScheduled.map((item) => ({
        skillNodeId: item.skillNodeId,
        intervalDays: item.intervalDays,
      })),
    });
    const extractedMemories = await this.memoryManager.extractLessonMemories({
      learnerId,
      lessonSessionId,
      topicId: session.topicId,
      evidenceBySkill: evidenceSummary.map((item) => ({
        skillName: item.skillName,
        independentSuccesses: item.independentSuccesses,
        unsuccessfulAttempts: item.unsuccessfulAttempts,
      })),
    });
    await this.memoryManager.saveLessonMemories({ learnerId, lessonSessionId, memories: extractedMemories });
    await this.personalityEngine.adaptAfterLesson({
      learnerId,
      lessonSessionId,
      evidenceBySkill: evidenceSummary.map((item) => ({
        independentSuccesses: item.independentSuccesses,
        unsuccessfulAttempts: item.unsuccessfulAttempts,
      })),
      memories: extractedMemories,
    });
    const usage = await this.router.usageSummary({ lessonSessionId });
    const snapshot = {
      session: {
        lessonSessionId,
        topicId: session.topicId,
        turns: session.turnCount,
        completedAt: completedAt.toISOString(),
        evidenceCount: sessionEvidence.length,
      },
      evidenceBySkill: evidenceSummary,
      abilities: abilityRows.map((row) => ({
        skillNodeId: row.skillNodeId,
        skillName: row.skillNode?.name ?? '',
        abilityCategory: row.skillNode?.abilityCategory ?? '',
        masteryCode: row.masteryCode,
        calibrationStatus: row.calibrationStatus,
        updatedAt: row.updatedAt.toISOString(),
      })),
      upcomingReviews: reviewScheduled.map((review) => ({
        skillNodeId: review.skillNodeId,
        dueAt: review.dueAt.toISOString(),
        intervalDays: review.intervalDays,
      })),
      nextFocusSkillNodeIds,
      growthReport,
      calibrationNotice: '内部原型状态，阈值未经真实儿童样本校准，不代表已掌握。',
    };
    const memoryContent = sessionEvidence.length === 0
      ? `本次课程未产生学习证据。课程主题：${session.topicId}。`
      : `本次课程结构化学习摘要：${evidenceSummary.map((group) =>
          `${group.skillName || group.skillNodeId}：独立成功 ${group.independentSuccesses} 项，待练习 ${group.unsuccessfulAttempts} 项` +
          (group.commonErrorUnits.length > 0
            ? `，常见待练单元 ${group.commonErrorUnits.map((item) => item.unit).join('、')}`
            : ''),
        ).join('；')}。该摘要来自评估证据，不含原始语音或对话文本。`;

    const existingLessonMemory = await this.prisma.interaction_memories.findFirst({
      where: { sourceSessionId: lessonSessionId, memoryType: 'lesson_learning_summary' },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.lesson_sessions.update({
        where: { id: lessonSessionId },
        data: { summary },
      }),
      this.prisma.learner_growth_snapshots.upsert({
        where: { lessonSessionId },
        create: {
          id: `growth-${lessonSessionId}`,
          learnerId,
          lessonSessionId,
          snapshot: snapshot as unknown as object,
        },
        update: { snapshot: snapshot as unknown as object },
      }),
      existingLessonMemory
        ? this.prisma.interaction_memories.update({
            where: { id: existingLessonMemory.id },
            data: {
              content: memoryContent,
              importance: Math.min(1, 0.4 + Math.min(sessionEvidence.length, 20) * 0.03),
            },
          })
        : this.prisma.interaction_memories.create({
            data: {
              id: `memory-${lessonSessionId}`,
              learnerId,
              sourceSessionId: lessonSessionId,
              memoryType: 'lesson_learning_summary',
              content: memoryContent,
              importance: Math.min(1, 0.4 + Math.min(sessionEvidence.length, 20) * 0.03),
              source: 'rule_summary',
            },
          }),
    ]);

    const effectiveTeachingCostCny =
      completedGoals.length > 0 ? usage.totalCostCny / completedGoals.length : usage.totalCostCny;

    return {
      lessonSessionId,
      turns: session.turnCount,
      completedGoals,
      effectiveTeachingCostCny,
      totalCostCny: usage.totalCostCny,
      stateChanges: [],
      summary,
      growthReport,
      reviewScheduled: reviewScheduled.map((review) => ({
        skillNodeId: review.skillNodeId,
        dueAt: review.dueAt.toISOString(),
        intervalDays: review.intervalDays,
      })),
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
        evaluated: false,
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
    if (!response.text && !response.audioRef && !response.selectedImageId && !response.freeUtterance) return 'no_answer';
    if (response.freeUtterance?.trim()) {
      return isLikelyQuestion(response.freeUtterance) ? 'question' : 'small_talk';
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
    intent?: 'question' | 'small_talk';
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

    const intent = input.intent ?? 'question';
    const fallbackText = intent === 'small_talk'
      ? '我听见啦，我们边聊边继续练习，好吗？'
      : '这个问题我们先记下来，等一下一起找答案，好吗？';
    let result: LlmResponse;
    try {
      result = await this.gateway.llm(
        {
          promptKey: intent === 'small_talk' ? 'teacher.small_talk' : 'teacher.child_question',
          promptVersion: 'm1.1',
          system: [
            '你是面向 6—9 岁英语零基础中国儿童的 AI 英语启蒙老师。',
            intent === 'small_talk'
              ? '用简短、温柔、自然的中文回应孩子的闲聊，最多两句话，不超过 60 个汉字。'
              : '用简短、温柔、鼓励式的中文回应孩子的提问，最多两句话，不超过 60 个汉字。',
            '可以自然带出一个简单英文单词，但不要展开讲解。',
            '不评价孩子说得对不对，不判断掌握程度，不布置新任务，不承诺教学结果。',
            intent === 'small_talk'
              ? '不要把闲聊写成学习表现评价；回应一两句后自然带回当前英语练习。'
              : '不要解释科学原理、不要给事实性答案；温柔回应一两句后把话题带回当前的英语练习。',
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
        level: result.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
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
      demonstrationText?: string | null;
      requiresPronunciationAssessment: boolean;
      requiresAsr: boolean;
      assessment?: {
        acceptedImageIds?: string[];
        acceptedTexts?: string[];
        requiredPhrases?: string[];
        openResponse?: boolean;
      };
    } | null;
    learnerId: string;
    lessonSessionId: string;
  }): Promise<{
    performedPronunciationAssessment: boolean;
    performedAsr: boolean;
    evaluated: boolean;
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
        evaluated: false,
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
          level: result.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
          providerAlias: result.providerAlias,
          modelAlias: result.modelAlias,
          pronunciationCalls: 1,
          latencyMs: result.latencyMs,
        }),
      );

      const passed = result.score >= passScore;
      return {
        performedPronunciationAssessment: true,
        performedAsr: false,
        evaluated: true,
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
          level: result.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
          providerAlias: result.providerAlias,
          modelAlias: result.modelAlias,
          asrSeconds: result.seconds,
          latencyMs: result.latencyMs,
        }),
      );

      const passed = matchesSpeechAnswer({
        transcript: result.transcript,
        taskType: input.activity.taskType,
        targetWords: input.activity.targetWords,
        demonstrationText: input.activity.demonstrationText,
        assessment: input.activity.assessment,
        suspect: result.suspect,
      });
      const evaluated = hasTextAnswerConfiguration({
        taskType: input.activity.taskType,
        targetWords: input.activity.targetWords,
        demonstrationText: input.activity.demonstrationText,
        assessment: input.activity.assessment,
      });
      return {
        performedPronunciationAssessment: false,
        performedAsr: true,
        evaluated,
        score: null,
        passed: evaluated && passed,
        errorUnits: emptyUnits,
        prompted: false,
        independent: evaluated && passed,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    // 被动听读可以结束活动，但没有作答证据，不得当作通过或掌握。
    if (isPassiveActivity(input.activity.taskType) &&
      !input.response.text?.trim() &&
      !input.response.audioRef &&
      !input.response.selectedImageId) {
      return {
        performedPronunciationAssessment: false,
        performedAsr: false,
        evaluated: false,
        score: null,
        passed: false,
        errorUnits: emptyUnits,
        prompted: false,
        independent: false,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    // —— 点选 / 作答类：本地确定性判定 ——
    if (input.response.selectedImageId) {
      const acceptedImageIds = input.activity.assessment?.acceptedImageIds ?? [];
      const passed = acceptedImageIds.includes(input.response.selectedImageId);
      return {
        performedPronunciationAssessment: false,
        performedAsr: false,
        evaluated: acceptedImageIds.length > 0,
        score: acceptedImageIds.length > 0 ? (passed ? 100 : 0) : null,
        passed,
        errorUnits: emptyUnits,
        prompted: false,
        independent: passed,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    // 语音任务必须由对应的音频观察完成，不能用键盘文本绕过 ASR/发音评估。
    if (
      (input.activity.requiresPronunciationAssessment || input.activity.requiresAsr) &&
      !input.response.audioRef
    ) {
      return {
        performedPronunciationAssessment: false,
        performedAsr: false,
        evaluated: false,
        score: null,
        passed: false,
        errorUnits: emptyUnits,
        prompted: false,
        independent: false,
        thresholdVersion: threshold?.version ?? null,
      };
    }

    if (input.response.text) {
      const answer = input.response.text.trim();
      const configured = hasTextAnswerConfiguration({
        taskType: input.activity.taskType,
        targetWords: input.activity.targetWords,
        demonstrationText: input.activity.demonstrationText,
        assessment: input.activity.assessment,
      });
      const passed = matchesTextAnswer({
        answer,
        taskType: input.activity.taskType,
        targetWords: input.activity.targetWords,
        demonstrationText: input.activity.demonstrationText,
        assessment: input.activity.assessment,
      });
      return {
        performedPronunciationAssessment: false,
        performedAsr: false,
        evaluated: configured,
        score: configured ? (passed ? 100 : 0) : null,
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
      evaluated: false,
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
    activity: { id: string; skillNodeIds: string[]; taskType: string; scenario: string } | null;
    reviewTarget: { skillNodeId: string; learningItemId: string | null } | null;
    learnerId: string;
    lessonSessionId: string;
  }) {
    const activity = input.activity;
    if (!activity || !input.assessment.evaluated) return [];

    const source = input.assessment.performedPronunciationAssessment
      ? 'pronunciation_api'
      : input.assessment.performedAsr
        ? 'asr'
        : 'task_result';

    const targets = resolveEvidenceTargets(activity.skillNodeIds);
    const occurredAt = new Date().toISOString();
    return Promise.all(
      targets.map(async ({ skillNodeId, abilityCategory }) => {
        const learningItemId = input.reviewTarget?.skillNodeId === skillNodeId && input.reviewTarget.learningItemId
          ? input.reviewTarget.learningItemId
          : activity.id;
        const id = await this.learnerModel.appendEvidence({
          learnerId: input.learnerId,
          lessonSessionId: input.lessonSessionId,
          skillNodeId,
          learningItemId,
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
          learningItemId,
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
    isReview: boolean;
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

    const [teacherProfile, interactionMemories] = await Promise.all([
      this.getLearnerTeacherProfile(input.learnerId),
      this.prisma.interaction_memories.findMany({
        where: {
          learnerId: input.learnerId,
          memoryType: { in: ['learning_preference', 'encouragement_preference'] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
        take: 3,
        select: { content: true },
      }),
    ]);
    const adjustable = teacherProfile?.adjustable && typeof teacherProfile.adjustable === 'object' && !Array.isArray(teacherProfile.adjustable)
      ? teacherProfile.adjustable as Record<string, unknown>
      : {};
    const baseSpeed = typeof adjustable.speakingRate === 'number' ? Math.min(0.85, Math.max(0.45, adjustable.speakingRate)) : 0.65;
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
    const expectedResponse = expectedResponseOf(activity.taskType);

    return {
      targetSkillNodeId: activity.skillNodeIds[0] ?? 'LA.LISTEN.greeting_core',
      taskType: activity.taskType as TeachingDirective['taskType'],
      isReview: input.isReview,
      scenario: activity.scenario as TeachingDirective['scenario'],
      teacherUtterance: input.isReview
        ? expectedResponse === 'tap_image'
          ? '我们来做一次复习。请回想之前学过的内容，选择对应的图片。'
          : '我们来做一次复习。请回想之前学过的内容，试着自己回答。'
        : activity.teacherUtteranceZh,
      demonstrationText: input.isReview ? null : demo.demonstrationText,
      pronunciationUnits: input.isReview ? [] : pronunciationUnits,
      expectedResponse: input.isReview && expectedResponse !== 'tap_image' ? 'speak' : expectedResponse,
      targetWords: input.isReview ? [] : activity.targetWords,
      voice: {
        teacherSpeed,
        voiceStyle: adjustable.tone === 'lively' ? 'encouraging' : adjustable.tone === 'calm' ? 'warm' : 'gentle',
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
      personaHint: [
        teacherProfile?.style === 'conversation_partner'
          ? '自然的英语交流伙伴，减少不必要的教学提示'
          : teacherProfile?.style === 'playful_companion'
            ? '活泼友好的学习伙伴'
            : teacherProfile?.style === 'calm_coach'
              ? '沉稳的耐心教练'
              : '耐心温和的引导老师',
        adjustable.encouragement === 'frequent' ? '多给予具体鼓励' : adjustable.encouragement === 'light' ? '简短自然地鼓励' : '适度给予具体鼓励',
        adjustable.correctionStyle === 'model_first' ? '纠错时先示范正确说法' : adjustable.correctionStyle === 'encourage_retry' ? '纠错时先邀请孩子再试一次' : '纠错时先给提示再示范',
        ...interactionMemories.map((memory) => `教学偏好参考：${memory.content.slice(0, 120)}`),
        '始终保护儿童安全，不嘲笑、不施压，诚实说明自己是 AI 老师。',
      ].join('；'),
    };
  }

  /**
   * 每个学习者使用从统一模板派生的独立教师档案。
   * 运行时只读取白名单风格参数；核心安全原则不从模型或学习者数据中覆盖。
   */
  private async getLearnerTeacherProfile(learnerId: string) {
    const existing = await this.prisma.teacher_profiles.findUnique({ where: { learnerId } });
    if (existing) return existing;
    const template = await this.prisma.teacher_profiles.findFirst({
      where: { learnerId: null },
      orderBy: { createdAt: 'asc' },
    }) ?? await this.prisma.teacher_profiles.create({
      data: {
        id: 'default-teacher',
        name: '英语成长老师',
        coreTraits: { childSafety: true, honestAiIdentity: true, noShaming: true, noPressure: true, ageAppropriate: true },
        adjustable: { tone: 'gentle', encouragement: 'balanced', correctionStyle: 'hint_first', speakingRate: 0.65 },
        style: 'patient_guide',
      },
    });
    try {
      return await this.prisma.teacher_profiles.create({
        data: {
          name: template.name,
          coreTraits: template.coreTraits as object,
          adjustable: template.adjustable as object,
          style: template.style,
          stage: template.stage,
          version: 1,
          learnerId,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      return this.prisma.teacher_profiles.findUniqueOrThrow({ where: { learnerId } });
    }
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
      modelAlias: string;
      latencyMs: number;
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
        speedMode: outcome.result.speedMode,
        playbackRate: outcome.result.playbackRate,
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
        modelAlias: outcome.result.modelAlias,
        latencyMs: outcome.latencyMs,
      },
    };
  }

  private getRuntime(sessionId: string): SessionRuntimeState {
    let state = this.runtime.get(sessionId);
    if (!state) {
      state = {
        methodLadder: initialMethodLadderState(),
        currentActivityId: null,
        currentReviewScheduleId: null,
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

type AssessmentAnswerConfig = {
  acceptedImageIds?: string[];
  acceptedTexts?: string[];
  requiredPhrases?: string[];
  openResponse?: boolean;
};

function normalizeAnswer(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function answerCandidates(input: {
  taskType: string;
  targetWords: string[];
  demonstrationText?: string | null;
  assessment?: AssessmentAnswerConfig;
}): string[] {
  const configured = input.assessment?.acceptedTexts ?? [];
  if (configured.length) return configured.map(normalizeAnswer).filter(Boolean);
  if (
    ['word_mimicry', 'pronunciation_drill', 'phrase_assembly'].includes(input.taskType)
  ) {
    return input.targetWords.map(normalizeAnswer).filter(Boolean);
  }
  if (input.taskType === 'sentence_pattern' && input.demonstrationText?.trim()) {
    return [normalizeAnswer(input.demonstrationText)].filter(Boolean);
  }
  return [];
}

function hasTextAnswerConfiguration(input: {
  taskType: string;
  targetWords: string[];
  demonstrationText?: string | null;
  assessment?: AssessmentAnswerConfig;
}): boolean {
  return Boolean(
    input.assessment?.openResponse ||
    answerCandidates(input).length ||
    input.assessment?.requiredPhrases?.length,
  );
}

function matchesTextAnswer(input: {
  answer: string;
  taskType: string;
  targetWords: string[];
  demonstrationText?: string | null;
  assessment?: AssessmentAnswerConfig;
}): boolean {
  const normalized = normalizeAnswer(input.answer);
  if (!normalized) return false;
  if (input.assessment?.openResponse) return true;
  const required = (input.assessment?.requiredPhrases ?? []).map(normalizeAnswer).filter(Boolean);
  if (required.length && required.every((phrase) => containsWholePhrase(normalized, phrase))) return true;
  const candidates = answerCandidates(input);
  if (!candidates.length) return false;
  return candidates.some((phrase) => normalized === phrase);
}

function containsWholePhrase(answer: string, phrase: string): boolean {
  return ` ${answer} `.includes(` ${phrase} `);
}

function isPassiveActivity(taskType: string): boolean {
  return taskType === 'listening_comprehension' || taskType === 'reading_story';
}

function matchesSpeechAnswer(input: {
  transcript: string;
  taskType: string;
  targetWords: string[];
  demonstrationText?: string | null;
  assessment?: AssessmentAnswerConfig;
  suspect?: boolean;
}): boolean {
  if (input.suspect || !input.transcript.trim()) return false;
  return matchesTextAnswer({
    answer: input.transcript,
    taskType: input.taskType,
    targetWords: input.targetWords,
    demonstrationText: input.demonstrationText,
    assessment: input.assessment,
  });
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

/** 只把明显的疑问句判为提问，其余自由发言按普通交流处理。 */
function isLikelyQuestion(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/[?？]$/.test(text)) return true;
  if (/^(what|why|how|when|where|who|which|can|could|would|will|do|does|did|is|are|am|may|请问|为什么|怎么|什么|哪里|谁|能不能|可以吗|是不是|吗)/i.test(text)) {
    return true;
  }
  return /(吗|呢|么)[。！!，,]?$/.test(text);
}

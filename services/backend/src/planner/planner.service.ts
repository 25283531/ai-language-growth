/**
 * Teaching Planner —— 教学规划器。
 *
 * 依据：D-007「教学闭环：七步闭环，三个时间尺度」；
 *      D-008「混合决策：程序管确定性，LLM 管理解推理」。
 *
 * M1 的规划完全由程序规则驱动（规则 + 能力状态 + 课程活动），
 * 不依赖 LLM —— 这保证规划可复现、可回归测试、可解释。
 * M2 才在此基础上引入 LLM 做长期规划与策略调整。
 *
 * 规划原则：
 *  1. 先复习到期项，再教新内容（间隔重复：短期复现 → 次日无提示回忆 → 按表现调整间隔）。
 *  2. 未达成硬前置的能力不排课，但**不阻塞其他能力**（D-004：阶段不是关卡）。
 *  3. 同一主题内按 order 推进；连续失败时改用更细粒度的活动（定向练习）。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Curriculum } from '@alg/curriculum';
import { SkillGraph } from '@alg/skill-graph';
import type { MasteryState, TeachingActivity } from '@alg/shared-contracts';
import { teachingActivitySchema } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';
import { chooseReviewActivity, nextReviewIntervalDays } from './review-policy';

export interface PlannedStep {
  activity: TeachingActivity;
  /** 为什么选这个活动（可解释性） */
  rationale: string;
  /** 是否为复习 */
  isReview: boolean;
  reviewScheduleId: string | null;
}

const REVIEW_CLAIM_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
  private readonly curriculum = new Curriculum();
  private readonly graph = new SkillGraph();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
  ) {}

  /**
   * 选出本堂课的第一个活动。
   *
   * @param topicId 主题
   * @param learnerId 学习者
   * @param excludeActivityIds 本堂课已做过的活动（避免重复）
   */
  async planNext(input: {
    topicId: string;
    learnerId: string;
    lessonSessionId: string;
    excludeActivityIds: string[];
    followUpSkillNodeIds?: string[];
  }): Promise<PlannedStep | null> {
    // —— 1. 先看有没有到期的复习项 ——
    const now = new Date();
    const dueReviews = await this.prisma.review_schedules.findMany({
      where: {
        learnerId: input.learnerId,
        completedAt: null,
        dueAt: { lte: now },
        OR: [
          { claimedBySessionId: null },
          { claimedBySessionId: input.lessonSessionId },
          { claimExpiresAt: { lte: now } },
        ],
      },
      orderBy: { dueAt: 'asc' },
      take: 10,
    });

    for (const review of dueReviews) {
      const reviewActivities = (await this.activitiesForSkill(review.skillNodeId, input.topicId))
        .filter((activity) => !input.excludeActivityIds.includes(activity.id));
      const originalActivity = review.learningItemId
        ? this.curriculum.getActivity(review.learningItemId)
        : undefined;
      const originalWords = new Set((originalActivity?.targetWords ?? []).map((word) => word.toLowerCase()));
      const sameKnowledgeActivities = originalWords.size === 0
        ? reviewActivities
        : reviewActivities.filter((activity) =>
            activity.targetWords.some((word) => originalWords.has(word.toLowerCase())),
          );
      const recentEvidence = await this.prisma.learning_evidence.findMany({
        where: {
          learnerId: input.learnerId,
          skillNodeId: review.skillNodeId,
          ...(review.learningItemId ? { learningItemId: review.learningItemId } : {}),
          succeeded: true,
          independent: true,
        },
        orderBy: { occurredAt: 'desc' },
        take: 20,
        select: { scenario: true },
      });
      const candidate = chooseReviewActivity(
        sameKnowledgeActivities.length > 0 ? sameKnowledgeActivities : reviewActivities,
        recentEvidence.map((evidence) => evidence.scenario),
      );
      if (candidate) {
        const claimed = await this.prisma.review_schedules.updateMany({
          where: {
            id: review.id,
            completedAt: null,
            dueAt: { lte: now },
            OR: [
              { claimedBySessionId: null },
              { claimedBySessionId: input.lessonSessionId },
              { claimExpiresAt: { lte: now } },
            ],
          },
          data: {
            claimedBySessionId: input.lessonSessionId,
            claimExpiresAt: new Date(now.getTime() + REVIEW_CLAIM_TTL_MS),
          },
        });
        if (claimed.count !== 1) continue;
        return {
          activity: candidate,
          rationale: `复习到期：${review.skillNodeId}；优先使用近期较少练习的场景 ${candidate.scenario}`,
          isReview: true,
          reviewScheduleId: review.id,
        };
      }
    }

    // —— 2. 回到上一堂课中仍需巩固的能力 ——
    for (const skillNodeId of input.followUpSkillNodeIds ?? []) {
      const followUp = (await this.activitiesForSkill(skillNodeId, input.topicId)).find((activity) =>
        activity.topicId === input.topicId &&
        !input.excludeActivityIds.includes(activity.id),
      );
      if (followUp) {
        return {
          activity: followUp,
          rationale: `跨课续学：上一堂课的 ${skillNodeId} 仍有未完成练习，先巩固后推进新内容`,
          isReview: false,
          reviewScheduleId: null,
        };
      }
    }

    // —— 3. 选取主题内下一个可排的活动 ——
    const states = await this.getStates(input.learnerId);
    const activities = (await this.activitiesOf(input.topicId))
      .filter((a) => !input.excludeActivityIds.includes(a.id));

    if (activities.length === 0) {
      return null;
    }

    const eligible: TeachingActivity[] = [];
    for (const activity of activities) {
      const gate = this.canSchedule(activity, states);
      if (gate.met) {
        eligible.push(activity);
      }
    }
    if (eligible.length) {
      const selected = await this.chooseAdaptiveActivity({
        activities: eligible,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        states,
      });
      return {
        activity: selected,
        rationale: `AI 在 ${eligible.length} 个规则可行活动中选择；能力状态与硬前置由服务端校验`,
        isReview: false,
        reviewScheduleId: null,
      };
    }

    // —— 4. 全部被硬前置阻塞：退回到该主题内门槛最低的活动 ——
    //     D-004：不得因某能力未达标就禁止孩子发展其他能力。
    const fallback = activities.reduce((best, a) => {
      if (!best) return a;
      return a.difficulty < best.difficulty ? a : best;
    }, activities[0]!);

    return {
      activity: fallback,
      rationale: '目标能力的硬前置尚未达成，先做门槛较低的活动，不阻塞整体推进（D-004）',
      isReview: false,
      reviewScheduleId: null,
    };
  }

  /**
   * 判定活动是否可排课。
   * 硬前置未达成则阻塞；related / parallel 不阻塞。
   */
  private canSchedule(
    activity: TeachingActivity,
    states: Record<string, MasteryState>,
  ): { met: boolean; blockedBy: string[] } {
    const blockers: string[] = [];
    for (const skillNodeId of activity.skillNodeIds) {
      const gate = this.graph.prerequisitesMet(skillNodeId, states);
      if (!gate.met) {
        blockers.push(...gate.blockedBy);
      }
    }
    return { met: blockers.length === 0, blockedBy: blockers };
  }

  /** 读取学习者的能力状态。 */
  private async getStates(learnerId: string): Promise<Record<string, MasteryState>> {
    const rows = await this.prisma.learner_skill_states.findMany({
      where: { learnerId },
    });
    const map: Record<string, MasteryState> = {};
    for (const row of rows) {
      map[row.skillNodeId] = (['not_exposed', 'encountered', 'forming', 'mastered', 'transferred'] as const)[
        row.masteryCode
      ] ?? 'not_exposed';
    }
    return map;
  }

  /**
   * AI 只能在已经通过发布状态和硬前置筛选的有限候选集中调序。
   * 无效输出、预算熔断或供应商故障都会回落到可复现的规则排序。
   */
  private async chooseAdaptiveActivity(input: {
    activities: TeachingActivity[];
    learnerId: string;
    lessonSessionId: string;
    states: Record<string, MasteryState>;
  }): Promise<TeachingActivity> {
    const fallback = [...input.activities].sort((a, b) => {
      const masteryRank = (activity: TeachingActivity) => Math.min(
        ...activity.skillNodeIds.map((id) => masteryCode(input.states[id] ?? 'not_exposed')),
      );
      return masteryRank(a) - masteryRank(b) || a.difficulty - b.difficulty || a.order - b.order;
    })[0]!;
    if (input.activities.length < 2) return fallback;

    const decision = await this.router.route({ serviceKind: 'llm', taskRoute: 'llm.learning_plan' });
    let result: Awaited<ReturnType<AiGatewayService['llm']>> | null = null;
    try {
      const [learner, textbook] = await Promise.all([
        this.prisma.learner_profiles.findUnique({
          where: { id: input.learnerId },
          select: { ageGroup: true, entryLevel: true, target: true },
        }),
        this.prisma.textbook_mappings.findFirst({
          where: { learnerId: input.learnerId },
          orderBy: { updatedAt: 'desc' },
          select: { publisher: true, grade: true, version: true, currentUnit: true },
        }),
      ]);
      result = await this.gateway.llm({
        promptKey: 'planner.adaptive_candidate',
        promptVersion: 'm2.1',
        system: [
          '你是课程活动排序助手，只能从候选列表选择一个 activityId。',
          '优先考虑学习者薄弱或尚未接触的能力、教材关联和难度适配；已到期复习由系统单独优先处理。',
          '你不能创造活动、修改能力状态或声称已经掌握。只输出 JSON：{"activityId":"候选中的ID"}。',
        ].join(''),
        messages: [{
          role: 'user',
          content: JSON.stringify({
            learner,
            textbook,
            skillStates: input.states,
            candidates: input.activities.map((activity) => ({
              activityId: activity.id,
              targetWords: activity.targetWords,
              skillNodeIds: activity.skillNodeIds,
              difficulty: activity.difficulty,
              taskType: activity.taskType,
              order: activity.order,
            })),
          }),
        }],
        temperature: 0.1,
        maxTokens: 100,
        timeoutMs: 8000,
      }, decision);
    } catch {
      // The deterministic fallback below keeps a lesson available.
    }

    const selectedId = result ? parseActivityId(result.content) : null;
    const selected = input.activities.find((activity) => activity.id === selectedId) ?? fallback;
    await this.router.recordUsage({
      id: `usage-plan-${input.lessonSessionId}-${Date.now()}`,
      learnerId: input.learnerId,
      lessonSessionId: input.lessonSessionId,
      serviceKind: 'llm',
      taskRoute: 'llm.learning_plan',
      level: result?.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
      providerAlias: result?.providerAlias ?? decision.providerAlias,
      modelAlias: result?.modelAlias ?? decision.modelAlias,
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      ttsCharacters: 0,
      asrSeconds: 0,
      pronunciationCalls: 0,
      estimatedCostCny: 0,
      latencyMs: result?.latencyMs ?? 0,
      createdAt: new Date().toISOString(),
    });
    return selected;
  }

  private topicName(topicId: string): string {
    return this.curriculum.getTopic(topicId)?.name ?? topicId;
  }

  /** 已发布课程优先于内置 M1 内容；数据库课程无效时安全回落到内置活动。 */
  private async activitiesOf(topicId: string): Promise<TeachingActivity[]> {
    const rows = await this.prisma.learning_items.findMany({
      where: { topicId, reviewStatus: 'published' },
      orderBy: { createdAt: 'asc' },
    });
    const activities = rows
      .map((row) => teachingActivitySchema.safeParse(row.content))
      .filter((parsed): parsed is { success: true; data: TeachingActivity } => parsed.success)
      .map((parsed) => parsed.data);
    return activities.length ? activities : this.curriculum.activitiesOf(topicId);
  }

  private async activitiesForSkill(skillNodeId: string, topicId: string): Promise<TeachingActivity[]> {
    const activities = await this.activitiesOf(topicId);
    const scoped = activities.filter((activity) => activity.skillNodeIds.includes(skillNodeId));
    return scoped.length ? scoped : this.curriculum.activitiesForSkill(skillNodeId);
  }

  /**
   * 安排复习（间隔重复）。
   *
   * 规则（任务书第 4 章「智能复习机制」）：
   *  - 初次学习后安排短期复现（1 天）
   *  - 次日做一次无提示回忆
   *  - 之后按表现调整间隔：稳定则扩大，出现遗忘则缩短
   */
  async scheduleInitialReview(input: {
    learnerId: string;
    skillNodeId: string;
    learningItemId: string | null;
    now?: Date;
  }): Promise<void> {
    const activeKey = this.activeReviewKey(input.learnerId, input.skillNodeId, input.learningItemId);
    const existing = await this.prisma.review_schedules.findUnique({ where: { activeKey } });
    if (existing) return;

    const intervalDays = 1;
    const now = input.now ?? new Date();
    try {
      await this.prisma.review_schedules.create({
        data: {
          learnerId: input.learnerId,
          skillNodeId: input.skillNodeId,
          learningItemId: input.learningItemId,
          activeKey,
          intervalDays,
          dueAt: new Date(now.getTime() + intervalDays * 86400000),
        },
      });
      this.logger.log(`安排复习 ${input.skillNodeId}，首次间隔 ${intervalDays} 天`);
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      // Concurrent successful attempts may race to create the same pending review.
    }
  }

  /** Complete the claimed review and atomically schedule the next interval. */
  async resolveReview(input: {
    learnerId: string;
    lessonSessionId: string;
    reviewScheduleId: string;
    succeeded: boolean;
    now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    await this.prisma.$transaction(async (tx) => {
      const review = await tx.review_schedules.findFirst({
        where: {
          id: input.reviewScheduleId,
          learnerId: input.learnerId,
          claimedBySessionId: input.lessonSessionId,
          completedAt: null,
        },
      });
      if (!review) return;

      const completed = await tx.review_schedules.updateMany({
        where: { id: review.id, completedAt: null, claimedBySessionId: input.lessonSessionId },
        data: { completedAt: now, activeKey: null, claimedBySessionId: null, claimExpiresAt: null },
      });
      if (completed.count !== 1) return;

      const consecutiveSuccesses = input.succeeded ? review.consecutiveSuccesses + 1 : 0;
      const intervalDays = nextReviewIntervalDays(review.consecutiveSuccesses, input.succeeded);
      await tx.review_schedules.create({
        data: {
          learnerId: review.learnerId,
          skillNodeId: review.skillNodeId,
          learningItemId: review.learningItemId,
          activeKey: this.activeReviewKey(review.learnerId, review.skillNodeId, review.learningItemId),
          consecutiveSuccesses,
          intervalDays,
          dueAt: new Date(now.getTime() + intervalDays * 86400000),
        },
      });
      this.logger.log(
        `复习完成 ${review.skillNodeId}：${input.succeeded ? '成功' : '未通过'}，下次间隔 ${intervalDays} 天`,
      );
    });
  }

  async releaseReviewClaim(input: { lessonSessionId: string; reviewScheduleId: string }): Promise<void> {
    await this.prisma.review_schedules.updateMany({
      where: {
        id: input.reviewScheduleId,
        claimedBySessionId: input.lessonSessionId,
        completedAt: null,
      },
      data: { claimedBySessionId: null, claimExpiresAt: null },
    });
  }

  async getReviewTarget(input: {
    learnerId: string;
    lessonSessionId: string;
    reviewScheduleId: string;
  }): Promise<{ skillNodeId: string; learningItemId: string | null } | null> {
    const review = await this.prisma.review_schedules.findFirst({
      where: {
        id: input.reviewScheduleId,
        learnerId: input.learnerId,
        claimedBySessionId: input.lessonSessionId,
        completedAt: null,
      },
      select: { skillNodeId: true, learningItemId: true },
    });
    return review;
  }

  private activeReviewKey(learnerId: string, skillNodeId: string, learningItemId: string | null): string {
    return `${learnerId}::${skillNodeId}::${learningItemId ?? '*'}`;
  }
}

function masteryCode(state: MasteryState): number {
  return ({ not_exposed: 0, encountered: 1, forming: 2, mastered: 3, transferred: 4 } as Record<MasteryState, number>)[state] ?? 0;
}

function parseActivityId(content: string): string | null {
  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { activityId?: unknown };
    return typeof parsed.activityId === 'string' ? parsed.activityId : null;
  } catch {
    return null;
  }
}

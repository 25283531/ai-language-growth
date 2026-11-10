/**
 * Teaching Planner —— 教学规划器。
 *
 * 依据：D-007「教学闭环：七步闭环，三个时间尺度」；
 *      D-008「混合决策：程序管确定性，LLM 管理解推理」。
 *
 * M1 的规划完全由程序规则驱动（规则 + 能力状态 + 课程活动），
 * 不依赖 LLM —— 这保证规划可复现、可回归测试、可解释。
 * M2 在此基础上加入候选活动的 LLM 调序；长期关注点仍由服务端规则确定，
 * 避免模型直接改写学习状态或绕过能力门槛。
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
import { parseSkillNodeIds } from '../curriculum/textbook-skill-mapping';
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
    const states = await this.getStates(input.learnerId);
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
        .filter((activity) =>
          !input.excludeActivityIds.includes(activity.id) &&
          this.isWithinProgressiveAccess(activity, states),
        );
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
        !input.excludeActivityIds.includes(activity.id) &&
        this.isWithinProgressiveAccess(activity, states),
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
      const progressive = this.applyProgressiveAccess(eligible, states);
      const candidates = progressive.activities.length
        ? progressive.activities
        : [...eligible]
            .filter((activity) => !this.isAutonomousConversation(activity))
            .sort((left, right) => left.difficulty - right.difficulty || left.order - right.order)
            .slice(0, 1);
      if (!candidates.length) return null;
      const selected = await this.chooseAdaptiveActivity({
        activities: candidates,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        states,
      });
      return {
        activity: selected,
        rationale: `服务端按当前能力开放难度 ${progressive.difficultyBand}，在 ${candidates.length} 个候选中选择；能力状态与硬前置由服务端校验${progressive.freeConversationLocked ? '，自主日常交流尚未开放' : ''}${progressive.activities.length ? '' : '；当前课程缺少该难度活动，回退至最低难度的非自由交流活动'}`,
        isReview: false,
        reviewScheduleId: null,
      };
    }

    // —— 4. 全部被硬前置阻塞：退回到该主题内门槛最低的活动 ——
    //     D-004：不得因某能力未达标就禁止孩子发展其他能力。
    const fallbackActivities = activities.filter((activity) =>
      !this.isAutonomousConversation(activity) || this.hasIndependentConversationFoundation(states, masteryCode),
    );
    if (!fallbackActivities.length) return null;
    const fallback = fallbackActivities.reduce((best, a) => {
      if (!best) return a;
      return a.difficulty < best.difficulty ? a : best;
    }, undefined as TeachingActivity | undefined) ?? fallbackActivities[0]!;

    return {
      activity: fallback,
      rationale: '目标能力的硬前置尚未达成，先做门槛较低的活动，不阻塞整体推进（D-004）',
      isReview: false,
      reviewScheduleId: null,
    };
  }

  /**
   * 结课/阶段复盘使用的长期关注点。
   *
   * 该结果是服务端规则产物，供下一堂课的 Planner 使用；它不是能力状态，
   * 也不允许被 LLM 自行改写。失败多、独立成功少且当前掌握等级低的能力优先。
   */
  async planLongTermFocus(input: {
    learnerId: string;
    evidenceBySkill: Array<{
      skillNodeId: string;
      unsuccessfulAttempts: number;
      independentSuccesses: number;
    }>;
    limit?: number;
  }): Promise<string[]> {
    const states = await this.getStates(input.learnerId);
    const rank = masteryCode;
    const evidence = new Map(input.evidenceBySkill.map((item) => [item.skillNodeId, item]));
    // 长期关注只从本课产生过证据的能力中选择，避免每节课把全图未接触
    // 节点随机带入下一堂课，破坏“围绕实际学习表现规划”的可解释性。
    const candidates = Array.from(evidence.keys())
      .map((skillNodeId) => {
        const item = evidence.get(skillNodeId)!;
        const stateRank = rank(states[skillNodeId] ?? 'not_exposed');
        const unresolved = (item?.unsuccessfulAttempts ?? 0) - (item?.independentSuccesses ?? 0);
        return {
          skillNodeId,
          score: unresolved * 4 + (stateRank < 3 ? 2 : 0) + (stateRank === 0 ? 1 : 0),
          stateRank,
          unresolved,
        };
      })
      .filter((item) => item.unresolved > 0 || item.stateRank < 3)
      .sort((left, right) =>
        right.score - left.score ||
        left.stateRank - right.stateRank ||
        left.skillNodeId.localeCompare(right.skillNodeId),
      );
    return candidates.slice(0, Math.max(1, Math.min(5, input.limit ?? 3))).map((item) => item.skillNodeId);
  }

  /**
   * 能力增强后逐步提高活动难度；自由交流要求口语句子和情景对话能力达标。
   * 这是服务端确定性门槛，LLM 只能在门槛内调序。
   */
  private applyProgressiveAccess(
    activities: TeachingActivity[],
    states: Record<string, MasteryState>,
  ): { activities: TeachingActivity[]; difficultyBand: number; freeConversationLocked: boolean } {
    const rank = masteryCode;
    const highest = Math.max(
      0,
      ...activities.map((activity) => this.activityDifficultyBand(activity, states, rank)),
    );
    const difficultyBand = highest >= 3 ? 3 : highest >= 2 ? 2 : 1;
    const freeConversationLocked = !this.hasIndependentConversationFoundation(states, rank);
    const scoped = activities.filter((activity) =>
      activity.difficulty <= this.activityDifficultyBand(activity, states, rank) &&
      (!this.isAutonomousConversation(activity) || !freeConversationLocked),
    );
    return {
      activities: scoped,
      difficultyBand,
      freeConversationLocked,
    };
  }

  private isWithinProgressiveAccess(activity: TeachingActivity, states: Record<string, MasteryState>): boolean {
    const rank = masteryCode;
    if (activity.difficulty > this.activityDifficultyBand(activity, states, rank)) return false;
    return !this.isAutonomousConversation(activity) || this.hasIndependentConversationFoundation(states, rank);
  }

  private isAutonomousConversation(activity: TeachingActivity): boolean {
    return activity.skillNodeIds.includes('LA.COMM.free_talk');
  }

  /**
   * 能力节点所属的轨。编码三段式 `<track>.<DOMAIN>.<slug>`（D-002）。
   * 返回 null 表示该编码不属于已知轨（忽略，不参与难度换算）。
   */
  private static nodeTrack(skillNodeId: string): 'LA' | 'SE' | null {
    if (skillNodeId.startsWith('SE.')) return 'SE';
    if (skillNodeId.startsWith('LA.')) return 'LA';
    return null;
  }

  private static bandOfRank(highest: number): number {
    return highest >= 3 ? 3 : highest >= 2 ? 2 : 1;
  }

  /**
   * 活动的难度上限。
   *
   * 关键约束（D-002：双轨并行、进度独立）：**按活动自己所属的轨算档**，
   * 不能所有活动都只看 `LA.*`。此前只取 `LA.*` 节点，导致只挂
   * `SE.SCHOOL.*` 节点的活动永远算作难度档 1 —— 学校英语轨学到什么程度
   * 都升不上去，等于用一条主线把另一条锁死。
   *
   * 规则：
   *  - 按轨分组，各轨内取该活动自身目标节点的最高掌握等级换算档位；
   *  - 活动挂多条轨时取各轨档位的最大值 —— 只要有一条它所属的轨已达标，
   *    就不该被另一条轨拖住；
   *  - 该轨还没有任何能力数据时，档位为 1（最低档），保证活动仍可排课。
   */
  private activityDifficultyBand(
    activity: TeachingActivity,
    states: Record<string, MasteryState>,
    rank: (state: MasteryState) => number,
  ): number {
    const byTrack = new Map<'LA' | 'SE', number[]>();
    for (const skillNodeId of activity.skillNodeIds) {
      const track = PlannerService.nodeTrack(skillNodeId);
      if (!track) continue;
      const ranks = byTrack.get(track) ?? [];
      ranks.push(rank(states[skillNodeId] ?? 'not_exposed'));
      byTrack.set(track, ranks);
    }
    if (!byTrack.size) return 1; // 没有可识别轨的节点：按最低档处理，不阻塞
    return Math.max(
      ...[...byTrack.values()].map((ranks) => PlannerService.bandOfRank(Math.max(0, ...ranks))),
    );
  }

  private hasIndependentConversationFoundation(
    states: Record<string, MasteryState>,
    rank: (state: MasteryState) => number,
  ): boolean {
    return rank(states['LA.SPEAK.simple_sentences'] ?? 'not_exposed') >= 3 &&
      rank(states['LA.COMM.dialogue'] ?? 'not_exposed') >= 3;
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
    // 零个或一个候选时不需要排序，也不需要读教材映射（省一次查询）。
    // 调用方保证候选集非空；这里保持与改造前一致的行为。
    if (input.activities.length <= 1) return input.activities[0]!;

    // 教材单元 → 能力节点映射（第 3 节「教材同步」的落地出口）。
    // 只读一次：既用于下面的确定性排序，也作为 LLM 调序的上下文。
    // 学习者从未选过教材时为空集合，此时行为与引入映射前完全一致。
    const textbookMapping = await this.prisma.textbook_mappings.findFirst({
      where: { learnerId: input.learnerId },
      orderBy: { updatedAt: 'desc' },
      select: { publisher: true, grade: true, version: true, currentUnit: true, skillNodeIds: true },
    });
    const unitSkillNodeIds = parseSkillNodeIds(textbookMapping?.skillNodeIds);
    const masteryRankOf = (activity: TeachingActivity) => Math.min(
      ...activity.skillNodeIds.map((id) => masteryCode(input.states[id] ?? 'not_exposed')),
    );
    // 教材对齐是「同等薄弱程度下」的次级优先：不覆盖「先补最薄弱能力」的既有规则。
    const unitAlignedOf = (activity: TeachingActivity) =>
      activity.skillNodeIds.some((id) => unitSkillNodeIds.includes(id)) ? 0 : 1;

    const fallback = [...input.activities].sort((a, b) =>
      masteryRankOf(a) - masteryRankOf(b) ||
      unitAlignedOf(a) - unitAlignedOf(b) ||
      a.difficulty - b.difficulty ||
      a.order - b.order,
    )[0]!;

    const decision = await this.router.route({ serviceKind: 'llm', taskRoute: 'llm.learning_plan' });
    let result: Awaited<ReturnType<AiGatewayService['llm']>> | null = null;
    try {
      const learner = await this.prisma.learner_profiles.findUnique({
        where: { id: input.learnerId },
        select: { ageGroup: true, entryLevel: true, target: true },
      });
      const textbook = textbookMapping
        ? { ...textbookMapping, skillNodeIds: unitSkillNodeIds }
        : null;
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

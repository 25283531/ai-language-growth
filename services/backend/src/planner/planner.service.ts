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
import { PrismaService } from '../prisma/prisma.service';

export interface PlannedStep {
  activity: TeachingActivity;
  /** 为什么选这个活动（可解释性） */
  rationale: string;
  /** 是否为复习 */
  isReview: boolean;
}

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
  private readonly curriculum = new Curriculum();
  private readonly graph = new SkillGraph();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
    excludeActivityIds: string[];
  }): Promise<PlannedStep | null> {
    // —— 1. 先看有没有到期的复习项 ——
    const dueReviews = await this.prisma.review_schedules.findMany({
      where: {
        learnerId: input.learnerId,
        completedAt: null,
        dueAt: { lte: new Date() },
      },
      orderBy: { dueAt: 'asc' },
      take: 5,
    });

    for (const review of dueReviews) {
      const reviewActivities = this.curriculum
        .activitiesForSkill(review.skillNodeId)
        .filter((a) => a.m1Scope);
      const candidate = reviewActivities.find((a) => !input.excludeActivityIds.includes(a.id));
      if (candidate) {
        return {
          activity: candidate,
          rationale: `复习到期：${review.skillNodeId} 的间隔重复项`,
          isReview: true,
        };
      }
    }

    // —— 2. 选取主题内下一个可排的活动 ——
    const states = await this.getStates(input.learnerId);
    const activities = this.curriculum
      .activitiesOf(input.topicId)
      .filter((a) => a.m1Scope && !input.excludeActivityIds.includes(a.id));

    if (activities.length === 0) {
      return null;
    }

    for (const activity of activities) {
      const gate = this.canSchedule(activity, states);
      if (gate.met) {
        return {
          activity,
          rationale: `主题「${this.topicName(input.topicId)}」的下一个活动，能力节点 ${activity.skillNodeIds.join(',')} 的硬前置已达成`,
          isReview: false,
        };
      }
    }

    // —— 3. 全部被硬前置阻塞：退回到该主题内门槛最低的活动 ——
    //     D-004：不得因某能力未达标就禁止孩子发展其他能力。
    const fallback = activities.reduce((best, a) => {
      if (!best) return a;
      return a.difficulty < best.difficulty ? a : best;
    }, activities[0]!);

    return {
      activity: fallback,
      rationale: '目标能力的硬前置尚未达成，先做门槛较低的活动，不阻塞整体推进（D-004）',
      isReview: false,
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

  private topicName(topicId: string): string {
    return this.curriculum.getTopic(topicId)?.name ?? topicId;
  }

  /**
   * 安排复习（间隔重复）。
   *
   * 规则（任务书第 4 章「智能复习机制」）：
   *  - 初次学习后安排短期复现（1 天）
   *  - 次日做一次无提示回忆
   *  - 之后按表现调整间隔：稳定则扩大，出现遗忘则缩短
   */
  async scheduleReview(input: {
    learnerId: string;
    skillNodeId: string;
    consecutiveSuccesses: number;
  }): Promise<void> {
    const intervalDays = Math.min(30, 1 * Math.pow(2, Math.max(0, input.consecutiveSuccesses)));
    const dueAt = new Date(Date.now() + intervalDays * 86400000);
    await this.prisma.review_schedules.create({
      data: {
        learnerId: input.learnerId,
        skillNodeId: input.skillNodeId,
        intervalDays,
        dueAt,
      },
    });
    this.logger.log(`安排复习 ${input.skillNodeId}，间隔 ${intervalDays} 天`);
  }
}

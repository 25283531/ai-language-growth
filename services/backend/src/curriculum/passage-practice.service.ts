/**
 * P2-08：课文跟读/重点词跟读的结果落证据与复习。
 *
 * 课文页直接调用 `/speech/evaluate` 取即时分数；这个接口原来只写用量账本，
 * 分数不会进入 `learning_evidence`，所以读得再好也不会形成掌握状态或复习。
 *
 * 这里只在请求显式带上 `learningItemId`（由开课响应的 passage 下发）且
 * 属于当前课堂主题时写入，避免把普通发音试听误记成教材证据。
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LearnerModelService } from '../learner-model/learner-model.service';
import { PlannerService } from '../planner/planner.service';

const RULE_VERSION = 'R1-R7';

export interface PassagePracticeResult {
  recorded: boolean;
  learningItemId: string;
  skillNodeIds: string[];
  passed: boolean;
  score: number | null;
  thresholdVersion: string | null;
  reviewScheduled: boolean;
}

export interface PassagePracticeInput {
  learnerId: string;
  lessonSessionId: string;
  learningItemId: string;
  targetText: string;
  score: number | null;
  errorUnits: Array<{ unit: string; kind: string; detail: string | null }>;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9']/g, '');
}

@Injectable()
export class PassagePracticeService {
  private readonly logger = new Logger(PassagePracticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly learnerModel: LearnerModelService,
    private readonly planner: PlannerService,
  ) {}

  async record(input: PassagePracticeInput): Promise<PassagePracticeResult> {
    const session = await this.prisma.lesson_sessions.findFirst({
      where: { id: input.lessonSessionId, learnerId: input.learnerId },
      select: { topicId: true },
    });
    if (!session) throw new BadRequestException('课堂会话不存在或不属于当前学习者');

    const item = await this.prisma.learning_items.findFirst({
      where: {
        id: input.learningItemId,
        topicId: session.topicId,
        reviewStatus: 'published',
      },
      select: { id: true, skillNodeId: true, content: true },
    });
    if (!item) throw new BadRequestException('教材学习项不存在或不属于当前课堂');

    const activity = (item.content ?? {}) as Record<string, unknown>;
    const taskType = typeof activity.taskType === 'string' ? activity.taskType : 'word_mimicry';
    const demonstration = typeof activity.demonstrationText === 'string'
      ? activity.demonstrationText.trim()
      : '';
    const targets = Array.isArray(activity.targetWords)
      ? activity.targetWords.filter((word): word is string => typeof word === 'string')
      : [];
    const expected = new Set([demonstration, ...targets].filter(Boolean).map(normalizeText));
    if (!expected.size || !expected.has(normalizeText(input.targetText))) {
      throw new BadRequestException('跟读文本与教材学习项不一致');
    }

    const contentSkillNodeIds = Array.isArray(activity.skillNodeIds)
      ? activity.skillNodeIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      : [];
    const candidateSkillNodeIds = [...new Set([item.skillNodeId, ...contentSkillNodeIds])];
    const skillNodes = await this.prisma.skill_nodes.findMany({
      where: { id: { in: candidateSkillNodeIds } },
      select: { id: true, abilityCategory: true },
    });
    // 以数据库里真实存在的能力节点为准，避免内容 JSON 里的旧编码触发外键失败。
    const targetsResolved = candidateSkillNodeIds
      .map((id) => skillNodes.find((node) => node.id === id))
      .filter((node): node is { id: string; abilityCategory: string } => Boolean(node));
    if (!targetsResolved.length) {
      throw new BadRequestException('教材学习项没有可用的能力节点');
    }

    const threshold = await this.learnerModel.getThreshold(taskType);
    const passScore = threshold?.passScore ?? 80;
    const score = input.score;
    const passed = typeof score === 'number' && Number.isFinite(score) && score >= passScore;
    // 课文页是“听示范后自己读”，没有逐句提示词；通过即记为独立产出。
    // 未通过仍写失败证据，但不排复习，避免把尚未形成的技能提前推进。
    const independent = passed;
    const occurredAt = new Date();

    for (const target of targetsResolved) {
      await this.learnerModel.appendEvidence({
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        skillNodeId: target.id,
        learningItemId: item.id,
        abilityCategory: target.abilityCategory,
        vocabularyDimension: null,
        source: 'pronunciation_api',
        taskType: taskType as never,
        prompted: false,
        independent,
        scenario: (typeof activity.scenario === 'string' ? activity.scenario : 'story_scene') as never,
        succeeded: passed,
        score: typeof score === 'number' && Number.isFinite(score) ? score : null,
        errorUnits: input.errorUnits as never,
        note: null,
        thresholdVersion: threshold?.version ?? null,
        ruleVersion: RULE_VERSION,
        occurredAt,
      });
      if (threshold) {
        await this.learnerModel.recomputeState({
          learnerId: input.learnerId,
          skillNodeId: target.id,
          threshold,
        });
      }
    }

    let reviewScheduled = false;
    if (passed) {
      for (const target of targetsResolved) {
        await this.planner.scheduleInitialReview({
          learnerId: input.learnerId,
          skillNodeId: target.id,
          learningItemId: item.id,
          now: occurredAt,
        });
        reviewScheduled = true;
      }
    }

    this.logger.log(
      `课文跟读证据：item=${item.id} task=${taskType} score=${score ?? 'n/a'} passed=${passed}`,
    );
    return {
      recorded: true,
      learningItemId: item.id,
      skillNodeIds: targetsResolved.map((target) => target.id),
      passed,
      score: typeof score === 'number' && Number.isFinite(score) ? score : null,
      thresholdVersion: threshold?.version ?? null,
      reviewScheduled,
    };
  }
}

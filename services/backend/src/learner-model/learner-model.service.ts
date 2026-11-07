/**
 * Learner Model Service —— 学习者长期能力档案与历史证据（学习记忆）。
 *
 * 依据：D-006「学习者智能引擎：核心资产，自主开发」；
 *      D-005「掌握状态：五种状态，必须有证据」；
 *      D-019「学习记忆自主掌控」；
 *      任务书第 4 章「数据设计：当前状态 + 能力证据事件」。
 *
 * 铁律：
 *  1. 掌握状态只能由规则引擎根据证据计算得出，不得由 LLM 直接声称修改（约束三）。
 *  2. 学习证据只写不改（数据库触发器强制），保证可追溯、可重放。
 *  3. 外部记忆组件无权改写本模块的数据。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVIDENCE_SOURCE_CREDIBILITY_CAP,
  MASTERY_STATE_BY_CODE,
  MASTERY_STATE_CODES,
  type AssessmentThreshold,
  type LearningEvidence,
  type MasteryState,
  type MasteryTransition,
} from '@alg/shared-contracts';
import { evaluateMastery, type MasteryStateView } from '@alg/skill-graph';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LearnerModelService {
  private readonly logger = new Logger(LearnerModelService.name);

  // tsx/esbuild 不发射 design:paramtypes 元数据，必须显式 @Inject
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 读取学习者全部能力状态。
   * 返回 skillNodeId -> MasteryState。
   */
  async getMasteryStates(learnerId: string): Promise<Record<string, MasteryState>> {
    const rows = await this.prisma.learner_skill_states.findMany({
      where: { learnerId },
    });
    const map: Record<string, MasteryState> = {};
    for (const row of rows) {
      map[row.skillNodeId] = MASTERY_STATE_BY_CODE[row.masteryCode as 0 | 1 | 2 | 3 | 4] ?? 'not_exposed';
    }
    return map;
  }

  /** 读取单个能力节点的状态。 */
  async getMasteryState(learnerId: string, skillNodeId: string): Promise<MasteryState> {
    const row = await this.prisma.learner_skill_states.findUnique({
      where: { learnerId_skillNodeId: { learnerId, skillNodeId } },
    });
    if (!row) return 'not_exposed';
    return MASTERY_STATE_BY_CODE[row.masteryCode as 0 | 1 | 2 | 3 | 4] ?? 'not_exposed';
  }

  /** 读取某能力节点的阈值配置。 */
  async getThreshold(taskType: string): Promise<AssessmentThreshold | null> {
    const row = await this.prisma.assessment_thresholds.findFirst({
      where: { taskType },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    return {
      id: row.id,
      taskType: row.taskType as AssessmentThreshold['taskType'],
      scenario: row.scenario as AssessmentThreshold['scenario'],
      passScore: row.passScore,
      minSamplesForming: row.minSamplesForming,
      minSamplesMastered: row.minSamplesMastered,
      minScenariosTransferred: row.minScenariosTransferred,
      minIntervalTransferredMs: row.minIntervalTransferredMs,
      source: row.source as AssessmentThreshold['source'],
      calibrationStatus: row.calibrationStatus as AssessmentThreshold['calibrationStatus'],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 读取某能力节点的历史证据（按时间升序）。 */
  async getEvidence(learnerId: string, skillNodeId: string): Promise<LearningEvidence[]> {
    const rows = await this.prisma.learning_evidence.findMany({
      where: { learnerId, skillNodeId },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((r) => this.toEvidence(r));
  }

  /**
   * 写入一条学习证据（只 INSERT）。
   *
   * @returns 证据 id
   */
  async appendEvidence(input: {
    learnerId: string;
    lessonSessionId: string | null;
    skillNodeId: string;
    learningItemId: string | null;
    abilityCategory: string;
    vocabularyDimension: string | null;
    source: LearningEvidence['source'];
    taskType: LearningEvidence['taskType'];
    prompted: boolean;
    independent: boolean;
    scenario: LearningEvidence['scenario'];
    succeeded: boolean;
    score: number | null;
    errorUnits: LearningEvidence['errorUnits'];
    note: string | null;
    thresholdVersion: string | null;
    ruleVersion: string | null;
    occurredAt?: Date;
  }): Promise<string> {
    // 可信度受来源上限约束（D-005 / 约束三）
    const cap = EVIDENCE_SOURCE_CREDIBILITY_CAP[input.source];
    const credibility = Math.min(cap, 0.9);

    // LLM 判断不得贡献晋级（约束三）
    const contributesToPromotion = input.source !== 'llm_judgement';

    const row = await this.prisma.learning_evidence.create({
      data: {
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        skillNodeId: input.skillNodeId,
        learningItemId: input.learningItemId,
        abilityCategory: input.abilityCategory,
        vocabularyDimension: input.vocabularyDimension,
        source: input.source,
        taskType: input.taskType,
        prompted: input.prompted,
        independent: input.independent,
        scenario: input.scenario,
        occurredAt: input.occurredAt ?? new Date(),
        credibility,
        contributesToPromotion,
        succeeded: input.succeeded,
        score: input.score,
        errorUnits: input.errorUnits as unknown as object,
        note: input.note,
        thresholdVersion: input.thresholdVersion,
        ruleVersion: input.ruleVersion,
      },
    });
    return row.id;
  }

  /**
   * 依据证据重算能力状态并落库。
   *
   * 判定完全由规则引擎执行（@alg/skill-graph 的 R1-R7），
   * 不接受任何来自模型的自然语言结论。
   *
   * @returns 状态迁移（有迁移时返回），无迁移返回 null
   */
  async recomputeState(input: {
    learnerId: string;
    skillNodeId: string;
    threshold: AssessmentThreshold;
  }): Promise<MasteryTransition | null> {
    const currentState = await this.getMasteryState(input.learnerId, input.skillNodeId);
    const evidence = await this.getEvidence(input.learnerId, input.skillNodeId);

    const view: MasteryStateView = {
      masteryState: currentState,
      evidenceIds: evidence.map((e) => e.id),
      independentScenarios: [],
      lastUnpromptedRecallAt: null,
      lastIndependentUseAt: null,
      updatedAt: new Date().toISOString(),
    };

    const result = evaluateMastery({
      currentState,
      evidence,
      threshold: input.threshold,
    });

    // 状态没有变化时仍需更新「最近独立使用时间」等派生字段
    const independent = evidence.filter((e) => e.independent && e.succeeded);
    const recalls = independent.filter(
      (e) => e.scenario !== 'review_scene' && e.scenario !== 'assessment_scene',
    );
    const lastIndependent = independent.length > 0 ? independent[independent.length - 1] : undefined;
    const lastRecall = recalls.length > 0 ? recalls[recalls.length - 1] : undefined;
    const lastIndependentUseAt = lastIndependent ? lastIndependent.occurredAt : null;
    const lastUnpromptedRecallAt = lastRecall ? lastRecall.occurredAt : null;

    await this.prisma.learner_skill_states.upsert({
      where: {
        learnerId_skillNodeId: { learnerId: input.learnerId, skillNodeId: input.skillNodeId },
      },
      update: {
        masteryCode: MASTERY_STATE_CODES[result.state],
        evidenceIds: Array.from(new Set(view.evidenceIds)) as unknown as object,
        independentScenarios: Array.from(
          new Set(independent.map((e) => e.scenario)),
        ) as unknown as object,
        lastIndependentUseAt: lastIndependentUseAt ? new Date(lastIndependentUseAt) : null,
        lastUnpromptedRecallAt: lastUnpromptedRecallAt ? new Date(lastUnpromptedRecallAt) : null,
        calibrationStatus: input.threshold.calibrationStatus,
        updatedAt: new Date(),
      },
      create: {
        id: `${input.learnerId}:${input.skillNodeId}`,
        learnerId: input.learnerId,
        skillNodeId: input.skillNodeId,
        masteryCode: MASTERY_STATE_CODES[result.state],
        evidenceIds: Array.from(new Set(view.evidenceIds)) as unknown as object,
        independentScenarios: Array.from(
          new Set(independent.map((e) => e.scenario)),
        ) as unknown as object,
        lastIndependentUseAt: lastIndependentUseAt ? new Date(lastIndependentUseAt) : null,
        lastUnpromptedRecallAt: lastUnpromptedRecallAt ? new Date(lastUnpromptedRecallAt) : null,
        calibrationStatus: input.threshold.calibrationStatus,
        updatedAt: new Date(),
      },
    });

    if (!result.transition) {
      return null;
    }

    // 注：不更新 learning_evidence 本身。
    // 证据表由数据库触发器强制 append-only（只允许 INSERT），
    // 「该证据是否已被状态迁移引用」由 learner_skill_states.evidenceIds 派生，
    // 不需要也不允许修改原始证据行。

    this.logger.log(
      `掌握状态迁移 ${input.learnerId}/${input.skillNodeId}: ${result.transition.from} → ${result.transition.to}`,
    );

    return {
      learnerId: input.learnerId,
      skillNodeId: input.skillNodeId,
      from: result.transition.from,
      to: result.transition.to,
      evidenceIds: result.transition.evidenceIds,
      reason: result.transition.reason,
      decidedAt: new Date().toISOString(),
    };
  }

  /** 能力状态快照（供 API 返回）。 */
  async abilitySnapshot(learnerId: string) {
    const rows = await this.prisma.learner_skill_states.findMany({
      where: { learnerId },
      include: { skillNode: true },
    });
    return rows.map((r) => ({
      skillNodeId: r.skillNodeId,
      skillName: r.skillNode?.name ?? '',
      abilityCategory: (r.skillNode?.abilityCategory ?? 'listening') as never,
      masteryState: MASTERY_STATE_BY_CODE[r.masteryCode as 0 | 1 | 2 | 3 | 4] ?? 'not_exposed',
      masteryCode: r.masteryCode,
      calibrationStatus: r.calibrationStatus as never,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** 数据库行 → 领域对象。 */
  private toEvidence(r: {
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
    occurredAt: Date;
    credibility: number;
    contributesToPromotion: boolean;
    succeeded: boolean;
    score: number | null;
    errorUnits: unknown;
    note: string | null;
    thresholdVersion: string | null;
    ruleVersion: string | null;
  }): LearningEvidence {
    return {
      id: r.id,
      learnerId: r.learnerId,
      lessonSessionId: r.lessonSessionId,
      skillNodeId: r.skillNodeId,
      learningItemId: r.learningItemId,
      abilityCategory: r.abilityCategory as LearningEvidence['abilityCategory'],
      vocabularyDimension: r.vocabularyDimension as LearningEvidence['vocabularyDimension'],
      source: r.source as LearningEvidence['source'],
      taskType: r.taskType as LearningEvidence['taskType'],
      prompted: r.prompted,
      independent: r.independent,
      scenario: r.scenario as LearningEvidence['scenario'],
      occurredAt: r.occurredAt.toISOString(),
      credibility: r.credibility,
      contributesToPromotion: r.contributesToPromotion,
      succeeded: r.succeeded,
      score: r.score,
      errorUnits: (r.errorUnits ?? []) as LearningEvidence['errorUnits'],
      note: r.note,
      thresholdVersion: r.thresholdVersion,
      ruleVersion: r.ruleVersion,
    };
  }
}

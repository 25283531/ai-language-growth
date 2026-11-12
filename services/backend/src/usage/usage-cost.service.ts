import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { meteredQuantities } from './prisma-usage-ledger';

export interface UsageCostRange {
  from: Date;
  to: Date;
  learnerId?: string;
  lessonSessionId?: string;
  topicId?: string;
}

export interface UsageCostRow {
  learnerId: string | null;
  lessonSessionId: string | null;
  modelId: string | null;
  level: string;
  inputTokens: number;
  outputTokens: number;
  ttsCharacters: number;
  asrSeconds: number;
  pronunciationCalls: number;
  estimatedCostCny: number;
  createdAt: Date;
  lessonSession: { topicId: string } | null;
  model: { prices: Array<{ priceType: string }> } | null;
}

export interface UsageCostMetrics {
  calls: number;
  ttsCharacters: number;
  asrSeconds: number;
  pronunciationCalls: number;
  estimatedCostCny: number;
  /** 有实际计量单位、但缺少模型价格或价格类型的调用数。 */
  unpricedCalls: number;
}

export interface UsageCostLearnerBucket extends UsageCostMetrics {
  learnerId: string | null;
}

export interface UsageCostTopicBucket extends UsageCostMetrics {
  topicId: string | null;
}

export interface UsageCostDayBucket extends UsageCostMetrics {
  /** UTC 日期，格式 YYYY-MM-DD。 */
  date: string;
}

export interface UsageCostReport {
  from: string;
  to: string;
  totals: UsageCostMetrics;
  byLearner: UsageCostLearnerBucket[];
  byTopic: UsageCostTopicBucket[];
  byDay: UsageCostDayBucket[];
  note: string;
}

const UNASSIGNED_LEARNER = '__unassigned_learner__';
const UNASSIGNED_TOPIC = '__unassigned_topic__';

/**
 * 管理员只读成本聚合。
 *
 * 只读 ai_usage_logs；topic 通过 lesson_sessions.topicId 关联，不伪造
 * 不存在的 courseId/lessonId。没有会话或学习者的记录进入 unassigned 桶。
 */
@Injectable()
export class UsageCostService {
  constructor(private readonly prisma: PrismaService) {}

  async aggregate(range: UsageCostRange): Promise<UsageCostReport> {
    const rows = await this.prisma.ai_usage_logs.findMany({
      where: {
        createdAt: { gte: range.from, lt: range.to },
        ...(range.learnerId ? { learnerId: range.learnerId } : {}),
        ...(range.lessonSessionId ? { lessonSessionId: range.lessonSessionId } : {}),
        ...(range.topicId ? { lessonSession: { is: { topicId: range.topicId } } } : {}),
      },
      select: {
        learnerId: true,
        lessonSessionId: true,
        modelId: true,
        level: true,
        inputTokens: true,
        outputTokens: true,
        ttsCharacters: true,
        asrSeconds: true,
        pronunciationCalls: true,
        estimatedCostCny: true,
        createdAt: true,
        lessonSession: { select: { topicId: true } },
        model: { select: { prices: { select: { priceType: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return buildUsageCostReport(rows, range);
  }
}

export function buildUsageCostReport(
  rows: UsageCostRow[],
  range: Pick<UsageCostRange, 'from' | 'to'>,
): UsageCostReport {
  const totals = emptyMetrics();
  const learners = new Map<string, UsageCostLearnerBucket>();
  const topics = new Map<string, UsageCostTopicBucket>();
  const days = new Map<string, UsageCostDayBucket>();

  for (const row of rows) {
    const unpriced = isUnpriced(row);
    addRow(totals, row, unpriced);

    const learnerKey = row.learnerId ?? UNASSIGNED_LEARNER;
    const learner = learners.get(learnerKey) ?? {
      learnerId: row.learnerId,
      ...emptyMetrics(),
    };
    addRow(learner, row, unpriced);
    learners.set(learnerKey, learner);

    const topicId = row.lessonSession?.topicId ?? null;
    const topicKey = topicId ?? UNASSIGNED_TOPIC;
    const topic = topics.get(topicKey) ?? {
      topicId,
      ...emptyMetrics(),
    };
    addRow(topic, row, unpriced);
    topics.set(topicKey, topic);

    const date = row.createdAt.toISOString().slice(0, 10);
    const day = days.get(date) ?? {
      date,
      ...emptyMetrics(),
    };
    addRow(day, row, unpriced);
    days.set(date, day);
  }

  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    totals: finishMetrics(totals),
    byLearner: [...learners.values()]
      .map(finishMetrics)
      .sort((left, right) => {
        const cost = right.estimatedCostCny - left.estimatedCostCny;
        return cost || String(left.learnerId ?? '').localeCompare(String(right.learnerId ?? ''));
      }),
    byTopic: [...topics.values()]
      .map(finishMetrics)
      .sort((left, right) => {
        const cost = right.estimatedCostCny - left.estimatedCostCny;
        return cost || String(left.topicId ?? '').localeCompare(String(right.topicId ?? ''));
      }),
    byDay: [...days.values()]
      .map(finishMetrics)
      .sort((left, right) => left.date.localeCompare(right.date)),
    note:
      'estimatedCostCny 仅在 ai_models.prices 已配置时可靠；unpricedCalls > 0 ' +
      '表示这些调用有计量单位但未匹配到价格。topic 来自 lesson_sessions.topicId，' +
      '未关联会话的记录单列 null。',
  };
}

function emptyMetrics(): UsageCostMetrics {
  return {
    calls: 0,
    ttsCharacters: 0,
    asrSeconds: 0,
    pronunciationCalls: 0,
    estimatedCostCny: 0,
    unpricedCalls: 0,
  };
}

function addRow(target: UsageCostMetrics, row: UsageCostRow, unpriced: boolean): void {
  target.calls += 1;
  target.ttsCharacters += row.ttsCharacters;
  target.asrSeconds += row.asrSeconds;
  target.pronunciationCalls += row.pronunciationCalls;
  target.estimatedCostCny += row.estimatedCostCny;
  if (unpriced) target.unpricedCalls += 1;
}

function finishMetrics<T extends UsageCostMetrics>(metrics: T): T {
  return {
    ...metrics,
    estimatedCostCny: Math.round(metrics.estimatedCostCny * 1_000_000) / 1_000_000,
  };
}

/**
 * 与 PrismaUsageLedger.dailyCost 的口径保持一致：
 * L0 视为免费；有计量单位但没有模型或对应价格类型的调用，才是未计价。
 */
function isUnpriced(row: UsageCostRow): boolean {
  if (row.level === 'L0') return false;
  const priceTypes = new Set(row.model?.prices.map((price) => price.priceType) ?? []);
  const usedTypes = Object.entries(meteredQuantities(row, priceTypes))
    .filter(([, quantity]) => quantity > 0)
    .map(([priceType]) => priceType);
  if (!usedTypes.length) return false;
  return !row.modelId || usedTypes.some((priceType) => !priceTypes.has(priceType));
}

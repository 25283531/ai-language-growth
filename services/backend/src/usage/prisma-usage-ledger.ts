import type { UsageLedger } from '@alg/model-router';
import type { UsageRecord } from '@alg/shared-contracts';
import { PrismaService } from '../prisma/prisma.service';

/** Durable UsageLedger implementation backed by ai_usage_logs. */
export class PrismaUsageLedger implements UsageLedger {
  constructor(private readonly prisma: PrismaService) {}

  async add(record: UsageRecord): Promise<void> {
    const model = await this.prisma.ai_models.findFirst({
      where: {
        alias: record.modelAlias,
        provider: { is: { alias: record.providerAlias, kind: record.serviceKind } },
      },
      include: { prices: { select: { priceType: true, unitPrice: true } } },
    });
    const estimatedCostCny = model?.prices.length
      ? estimateCost(record, model.prices)
      : record.estimatedCostCny;
    await this.prisma.ai_usage_logs.create({
      data: {
        id: record.id,
        learnerId: record.learnerId,
        lessonSessionId: record.lessonSessionId,
        modelId: model?.id ?? null,
        providerAlias: record.providerAlias,
        modelAlias: record.modelAlias,
        serviceKind: record.serviceKind,
        taskRoute: record.taskRoute,
        level: record.level,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        ttsCharacters: record.ttsCharacters,
        asrSeconds: record.asrSeconds,
        pronunciationCalls: record.pronunciationCalls,
        estimatedCostCny,
        latencyMs: record.latencyMs,
        createdAt: new Date(record.createdAt),
      },
    });
  }

  async list(filter?: { learnerId?: string; lessonSessionId?: string }): Promise<UsageRecord[]> {
    const rows = await this.prisma.ai_usage_logs.findMany({
      where: {
        ...(filter?.learnerId ? { learnerId: filter.learnerId } : {}),
        ...(filter?.lessonSessionId ? { lessonSessionId: filter.lessonSessionId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      learnerId: row.learnerId,
      lessonSessionId: row.lessonSessionId,
      serviceKind: row.serviceKind as UsageRecord['serviceKind'],
      taskRoute: row.taskRoute,
      level: row.level as UsageRecord['level'],
      providerAlias: row.providerAlias,
      modelAlias: row.modelAlias,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      ttsCharacters: row.ttsCharacters,
      asrSeconds: row.asrSeconds,
      pronunciationCalls: row.pronunciationCalls,
      estimatedCostCny: row.estimatedCostCny,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async dailyCost(input: { taskRoute: string; from: Date; to: Date }): Promise<{
    costCny: number;
    unpricedCalls: number;
  }> {
    const rows = await this.prisma.ai_usage_logs.findMany({
      where: {
        taskRoute: input.taskRoute,
        createdAt: { gte: input.from, lt: input.to },
      },
      select: {
        estimatedCostCny: true,
        level: true,
        modelId: true,
        inputTokens: true,
        outputTokens: true,
        ttsCharacters: true,
        asrSeconds: true,
        pronunciationCalls: true,
        model: { select: { prices: { select: { priceType: true } } } },
      },
    });
    let costCny = 0;
    let unpricedCalls = 0;
    for (const row of rows) {
      costCny += row.estimatedCostCny;
      const availableTypes = new Set(row.model?.prices.map((price) => price.priceType) ?? []);
      const quantities = meteredQuantities(row, availableTypes);
      const usedTypes = Object.entries(quantities)
        .filter(([, quantity]) => quantity > 0)
        .map(([priceType]) => priceType);
      if (
        row.level !== 'L0' &&
        usedTypes.length &&
        (!row.modelId || usedTypes.some((priceType) => !availableTypes.has(priceType)))
      ) {
        unpricedCalls += 1;
      }
    }
    return { costCny, unpricedCalls };
  }

  async summary(filter?: { learnerId?: string; lessonSessionId?: string }) {
    const rows = await this.prisma.ai_usage_logs.findMany({
      where: {
        ...(filter?.learnerId ? { learnerId: filter.learnerId } : {}),
        ...(filter?.lessonSessionId ? { lessonSessionId: filter.lessonSessionId } : {}),
      },
      select: { serviceKind: true, level: true, estimatedCostCny: true },
    });
    const byService: Record<string, { calls: number; costCny: number }> = {};
    const byLevel: Record<string, { calls: number; costCny: number }> = {};
    let totalCostCny = 0;
    for (const row of rows) {
      totalCostCny += row.estimatedCostCny;
      const service = (byService[row.serviceKind] ??= { calls: 0, costCny: 0 });
      service.calls += 1;
      service.costCny += row.estimatedCostCny;
      const level = (byLevel[row.level] ??= { calls: 0, costCny: 0 });
      level.calls += 1;
      level.costCny += row.estimatedCostCny;
    }
    return { totalCostCny, byService, byLevel };
  }
}

export function meteredQuantities(
  input: {
    inputTokens: number;
    outputTokens: number;
    ttsCharacters: number;
    asrSeconds: number;
    pronunciationCalls: number;
  },
  availablePriceTypes?: Set<string>,
): Record<string, number> {
  const quantities: Record<string, number> = {
    input_token: input.inputTokens,
    output_token: input.outputTokens,
    per_second: input.asrSeconds,
    per_call: input.pronunciationCalls,
  };
  if (input.ttsCharacters > 0) {
    // 新价格用“元/千字符”；只有没有新价格时才回退到历史“元/字符”。
    const useThousand = availablePriceTypes
      ? availablePriceTypes.has('per_1000_chars') || !availablePriceTypes.has('per_character')
      : true;
    if (useThousand) quantities.per_1000_chars = input.ttsCharacters / 1000;
    else quantities.per_character = input.ttsCharacters;
  }
  return quantities;
}

function estimateCost(
  record: UsageRecord,
  prices: Array<{ priceType: string; unitPrice: number }>,
): number {
  const priceByType = new Map(prices.map((price) => [price.priceType, price.unitPrice]));
  const quantities = meteredQuantities(record, new Set(priceByType.keys()));
  const used = Object.entries(quantities).filter(([, quantity]) => quantity > 0);
  if (!used.length) return record.estimatedCostCny;
  if (used.some(([priceType]) => !priceByType.has(priceType))) return 0;
  return used.reduce(
    (total, [priceType, quantity]) => total + quantity * priceByType.get(priceType)!,
    0,
  );
}

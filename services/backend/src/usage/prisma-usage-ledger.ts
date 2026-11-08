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
      select: { id: true },
    });
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
        estimatedCostCny: record.estimatedCostCny,
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrismaService } from '../src/prisma/prisma.service';
import { PrismaUsageLedger } from '../src/usage/prisma-usage-ledger';

describe('PrismaUsageLedger', () => {
  it('persists aliases and metering fields even when the model catalog is not linked yet', async () => {
    let inserted: Record<string, unknown> | undefined;
    const prisma = {
      ai_models: { findFirst: async () => null },
      ai_usage_logs: { create: async ({ data }: { data: Record<string, unknown> }) => { inserted = data; } },
    } as unknown as PrismaService;
    const ledger = new PrismaUsageLedger(prisma);

    await ledger.add({
      id: 'usage-1',
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      serviceKind: 'llm',
      taskRoute: 'llm.simple_dialogue',
      level: 'L1',
      providerAlias: 'configured_llm',
      modelAlias: 'model-a',
      inputTokens: 12,
      outputTokens: 5,
      ttsCharacters: 0,
      asrSeconds: 0,
      pronunciationCalls: 0,
      estimatedCostCny: 0,
      latencyMs: 42,
      createdAt: '2026-11-08T00:00:00.000Z',
    });

    assert.equal(inserted?.providerAlias, 'configured_llm');
    assert.equal(inserted?.modelAlias, 'model-a');
    assert.equal(inserted?.inputTokens, 12);
    assert.equal(inserted?.modelId, null);
  });

  it('builds persistent cost totals grouped by service and level', async () => {
    const prisma = {
      ai_usage_logs: {
        findMany: async () => [
          { serviceKind: 'llm', level: 'L1', estimatedCostCny: 0.2 },
          { serviceKind: 'llm', level: 'L2', estimatedCostCny: 0.3 },
          { serviceKind: 'tts', level: 'L1', estimatedCostCny: 0.1 },
        ],
      },
    } as unknown as PrismaService;
    const summary = await new PrismaUsageLedger(prisma).summary();

    assert.equal(summary.totalCostCny, 0.6);
    assert.deepEqual(summary.byService.llm, { calls: 2, costCny: 0.5 });
    assert.deepEqual(summary.byLevel.L1, { calls: 2, costCny: 0.3 });
  });
});

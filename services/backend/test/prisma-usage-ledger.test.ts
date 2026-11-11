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

  it('estimates cost from configured per-unit prices and metered usage', async () => {
    let inserted: Record<string, unknown> | undefined;
    const prisma = {
      ai_models: {
        findFirst: async () => ({
          id: 'model-id',
          prices: [
            { priceType: 'input_token', unitPrice: 0.000001 },
            { priceType: 'output_token', unitPrice: 0.000002 },
          ],
        }),
      },
      ai_usage_logs: {
        create: async ({ data }: { data: Record<string, unknown> }) => { inserted = data; },
      },
    } as unknown as PrismaService;

    await new PrismaUsageLedger(prisma).add({
      id: 'usage-priced',
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      serviceKind: 'llm',
      taskRoute: 'llm.simple_dialogue',
      level: 'L1',
      providerAlias: 'configured_llm',
      modelAlias: 'model-a',
      inputTokens: 1200,
      outputTokens: 300,
      ttsCharacters: 0,
      asrSeconds: 0,
      pronunciationCalls: 0,
      estimatedCostCny: 0,
      latencyMs: 42,
      createdAt: '2026-11-08T00:00:00.000Z',
    });

    assert.equal(inserted?.modelId, 'model-id');
    assert.ok(Math.abs(Number(inserted?.estimatedCostCny) - 0.0018) < 1e-9);
  });

  it('prices TTS by 1000 characters and keeps the legacy per-character unit working', async () => {
    const current = { inserted: undefined as Record<string, unknown> | undefined };
    const legacy = { inserted: undefined as Record<string, unknown> | undefined };
    const makePrisma = (priceType: string, unitPrice: number, sink: typeof current) => ({
      ai_models: {
        findFirst: async () => ({ id: 'tts-model', prices: [{ priceType, unitPrice }] }),
      },
      ai_usage_logs: {
        create: async ({ data }: { data: Record<string, unknown> }) => { sink.inserted = data; },
      },
    }) as unknown as PrismaService;

    const usage = {
      id: 'usage-tts',
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      serviceKind: 'tts' as const,
      taskRoute: 'tts.dynamic_teaching',
      level: 'L1' as const,
      providerAlias: 'configured_tts',
      modelAlias: 'tts-model',
      inputTokens: 0,
      outputTokens: 0,
      ttsCharacters: 1500,
      asrSeconds: 0,
      pronunciationCalls: 0,
      estimatedCostCny: 0,
      latencyMs: 10,
      createdAt: '2026-11-11T00:00:00.000Z',
    };

    await new PrismaUsageLedger(makePrisma('per_1000_chars', 0.05, current)).add(usage);
    assert.ok(Math.abs(Number(current.inserted?.estimatedCostCny) - 0.075) < 1e-9);

    await new PrismaUsageLedger(makePrisma('per_character', 0.00015, legacy)).add(usage);
    assert.ok(Math.abs(Number(legacy.inserted?.estimatedCostCny) - 0.225) < 1e-9);
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
    assert.equal(summary.byLevel.L1.calls, 2);
    assert.ok(Math.abs(summary.byLevel.L1.costCny - 0.3) < 1e-9);
  });
});

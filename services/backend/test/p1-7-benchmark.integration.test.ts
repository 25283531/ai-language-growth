import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { PrismaService } from '../src/prisma/prisma.service.ts';
import { ProviderConfigService } from '../src/providers/provider-config.service.ts';
import { ProviderBenchmarkService } from '../src/providers/provider-benchmark.service.ts';

const enabled = process.env.P1_7_DB_INTEGRATION === '1';

describe('P1-7 Benchmark 持久化与最近结果', { skip: !enabled }, () => {
  it('真实账本样本写入 benchmark、最近结果可读，新的失败会覆盖旧通过', async () => {
    const prisma = new PrismaService();
    await prisma.$connect();
    const configId = randomUUID();
    const providerAlias = `configured_llm_${configId}`;
    try {
      await prisma.ai_provider_configs.create({
        data: {
          id: configId,
          serviceKind: 'llm',
          providerPresetId: 'ollama',
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:11434/v1',
          modelAlias: 'p1-7-test-model',
          enabled: true,
          options: {},
        },
      });
      const provider = await prisma.ai_providers.create({
        data: { alias: providerAlias, kind: 'llm', baseUrl: 'http://127.0.0.1:11434/v1', enabled: true },
      });
      const model = await prisma.ai_models.create({
        data: {
          providerId: provider.id,
          alias: 'p1-7-test-model',
          modelId: 'p1-7-test-model',
          level: 'L1',
          enabled: true,
        },
      });
      await prisma.ai_usage_logs.createMany({
        data: [1000, 1100, 1200, 1300, 1400].map((latencyMs, index) => ({
          id: `p1-7-usage-${configId}-${index}`,
          providerAlias,
          modelAlias: 'p1-7-test-model',
          modelId: model.id,
          serviceKind: 'llm',
          taskRoute: 'llm.simple_dialogue',
          level: 'L1',
          latencyMs,
        })),
      });

      const configs = new ProviderConfigService(prisma as never);
      const benchmarks = new ProviderBenchmarkService(prisma as never, configs);
      const result = await benchmarks.run({ serviceKind: 'llm', configId });

      assert.equal(result.passed, true);
      assert.equal(result.sampleCount, 5);
      assert.equal(result.benchmarkType, 'llm_runtime_readiness');
      assert.equal(await configs.hasPassingBenchmark('llm', 'p1-7-test-model', configId), true);

      const listed = await configs.listBenchmarks('llm', configId);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.latest?.id, result.id);
      assert.equal(listed[0]?.productionReady, true);

      const newerFailure = await prisma.ai_model_benchmarks.create({
        data: {
          modelId: model.id,
          benchmarkType: 'llm_runtime_readiness',
          score: 0,
          sampleCount: 1,
          passed: false,
          notes: '模拟最新一次失败',
        },
      });
      assert.equal(await configs.hasPassingBenchmark('llm', 'p1-7-test-model', configId), false);

      const after = await configs.listBenchmarks('llm', configId);
      assert.equal(after[0]?.latest?.id, newerFailure.id);
      assert.equal(after[0]?.productionReady, false);

      const previous = process.env.AI_GATEWAY_MODE;
      process.env.AI_GATEWAY_MODE = 'live';
      try {
        await assert.rejects(
          () => configs.assertProductionReady('llm', 'p1-7-test-model', configId),
          /最近一次 Benchmark 未通过/,
        );
      } finally {
        if (previous === undefined) delete process.env.AI_GATEWAY_MODE;
        else process.env.AI_GATEWAY_MODE = previous;
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  evaluateRuntimeReadiness,
  type RuntimeBenchmarkConfig,
} from '../src/providers/provider-benchmark.service.ts';
import { ProviderConfigService } from '../src/providers/provider-config.service.ts';
import { RoutingConfigService } from '../src/routing/routing-config.service.ts';

const llmConfig: RuntimeBenchmarkConfig = {
  providerPresetId: 'siliconflow',
  baseUrl: 'https://example.invalid/v1',
  modelAlias: 'test-llm',
  enabled: true,
  credentials: { apiKey: 'test-key' },
};

function configService(latest: { passed: boolean; sampleCount: number } | null, enabled = true) {
  const prisma = {
    ai_providers: { findUnique: async () => ({ id: 'provider-1' }) },
    ai_models: {
      findUnique: async () => ({
        id: 'model-1',
        enabled,
        benchmarks: latest ? [{ ...latest, testedAt: new Date() }] : [],
      }),
    },
  };
  return new ProviderConfigService(prisma as never);
}

describe('P1-7 运行准入 Benchmark', () => {
  it('5 次低延迟 LLM 调用通过，并按样本和延迟计分', () => {
    const result = evaluateRuntimeReadiness({
      serviceKind: 'llm',
      config: llmConfig,
      latenciesMs: [1000, 1100, 1200, 1300, 1400],
    });

    assert.equal(result.sampleCount, 5);
    assert.equal(result.passed, true);
    assert.equal(result.score, 91);
    assert.match(result.notes, /平均 1200ms/);
    assert.match(result.notes, /不替代儿童教学质量评估/);
  });

  it('样本不足时明确未通过，不伪造通过', () => {
    const result = evaluateRuntimeReadiness({
      serviceKind: 'llm',
      config: llmConfig,
      latenciesMs: [800, 900, 1000, 1100],
    });

    assert.equal(result.sampleCount, 4);
    assert.equal(result.passed, false);
    assert.match(result.notes, /至少 5 次/);
  });

  it('平均延迟超门槛时未通过', () => {
    const result = evaluateRuntimeReadiness({
      serviceKind: 'llm',
      config: llmConfig,
      latenciesMs: [9000, 9100, 9200, 9300, 9400],
    });

    assert.equal(result.passed, false);
    assert.equal(result.score, 40);
    assert.match(result.notes, /平均 9200ms/);
  });

  it('P95 被长尾拖高时即使平均延迟合格也未通过', () => {
    const result = evaluateRuntimeReadiness({
      serviceKind: 'llm',
      config: llmConfig,
      latenciesMs: [1000, 1000, 1000, 1000, 20000],
    });

    assert.equal(result.passed, false);
    assert.match(result.notes, /P95 20000ms/);
  });

  it('配置不完整时直接失败并指出缺项', () => {
    const result = evaluateRuntimeReadiness({
      serviceKind: 'llm',
      config: { ...llmConfig, baseUrl: '', credentials: {} },
      latenciesMs: [1000, 1000, 1000, 1000, 1000],
    });

    assert.equal(result.score, 0);
    assert.equal(result.passed, false);
    assert.match(result.notes, /接入地址为空/);
    assert.match(result.notes, /尚未保存平台凭据/);
  });

  it('Embedding 尚未接入调用链时不生成可伪造的通过结果', () => {
    const result = evaluateRuntimeReadiness({
      serviceKind: 'embedding',
      config: llmConfig,
      latenciesMs: [],
    });

    assert.equal(result.score, 0);
    assert.equal(result.passed, false);
    assert.match(result.notes, /尚未接入教学调用链/);
  });

  it('TTS 使用独立的 3 次样本门槛', () => {
    const result = evaluateRuntimeReadiness({
      serviceKind: 'tts',
      config: { ...llmConfig, providerPresetId: 'ollama', credentials: {} },
      latenciesMs: [500, 600, 700],
    });

    assert.equal(result.sampleCount, 3);
    assert.equal(result.passed, true);
  });

  it('生产门禁只认最近一次 Benchmark，旧通过不能覆盖新失败', async () => {
    assert.equal(await configService({ passed: false, sampleCount: 8 }).hasPassingBenchmark('llm', 'test-llm', 'config-1'), false);
    assert.equal(await configService({ passed: true, sampleCount: 8 }).hasPassingBenchmark('llm', 'test-llm', 'config-1'), true);
  });

  it('启用前检查允许配置当前仍停用，但运行时门禁要求模型已启用', async () => {
    const service = configService({ passed: true, sampleCount: 8 }, false);
    assert.equal(await service.hasPassingBenchmark('llm', 'test-llm', 'config-1'), false);
    assert.equal(await service.hasPassingBenchmark('llm', 'test-llm', 'config-1', false), true);
  });

  it('mock 模式不阻断；live 模式最近未通过时拒绝生产准入', async () => {
    const previous = process.env.AI_GATEWAY_MODE;
    try {
      process.env.AI_GATEWAY_MODE = 'mock';
      await configService({ passed: false, sampleCount: 1 }).assertProductionReady('llm', 'test-llm', 'config-1');

      process.env.AI_GATEWAY_MODE = 'live';
      await assert.rejects(
        () => configService({ passed: false, sampleCount: 1 }).assertProductionReady('llm', 'test-llm', 'config-1'),
        (error: unknown) => error instanceof BadRequestException,
      );
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_MODE;
      else process.env.AI_GATEWAY_MODE = previous;
    }
  });

  it('live 模式保存已启用路由时调用生产准入检查，未通过则整次写入被拒绝', async () => {
    const previous = process.env.AI_GATEWAY_MODE;
    process.env.AI_GATEWAY_MODE = 'live';
    try {
      let checked: { serviceKind: string; modelAlias: string; configId: string } | null = null;
      const providerConfigs = {
        assertProductionReady: async (serviceKind: string, modelAlias: string, configId: string) => {
          checked = { serviceKind, modelAlias, configId };
          throw new BadRequestException('未通过 Benchmark');
        },
      };
      const routing = new RoutingConfigService({} as never, {} as never, providerConfigs as never);
      await assert.rejects(
        () => routing.save({
          rules: [{
            taskRoute: 'llm.simple_dialogue',
            primary: {
              providerAlias: 'configured_llm_config-1',
              modelAlias: 'test-llm',
              level: 'L1',
            },
            fallback: [],
            maxConcurrency: 1,
            dailyBudgetCny: 0,
            enabled: true,
          }],
          escalationTargets: {},
          fallbackOrder: ['L1'],
        }),
        /未通过 Benchmark/,
      );
      assert.deepEqual(checked, {
        serviceKind: 'llm',
        modelAlias: 'test-llm',
        configId: 'config-1',
      });
    } finally {
      if (previous === undefined) delete process.env.AI_GATEWAY_MODE;
      else process.env.AI_GATEWAY_MODE = previous;
    }
  });
});

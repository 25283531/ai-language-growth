/**
 * P0-4 回归测试：预算熔断（Router 返回 L0）不得被 Gateway 绕过。
 *
 * 缺陷：`callWithFallback` 用自己注册的 `configured_*` / 主 LLM 候选列表决定调用谁，
 * 完全不看 `decision.level` / `decision.providerAlias`。于是 Router 因预算耗尽返回
 * `level = 'L0'`、`providerAlias = 'local_rules'` 时，Gateway 仍然会调用付费供应商 ——
 * 熔断等于没做（违反 D-012 铁律一：Gateway 只执行 Router 的决策）。
 *
 * 本测试用「付费适配器调用计数」直接验证熔断是否真的生效。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoutingDecision } from '@alg/shared-contracts';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.ts';

type GatewayInternals = AiGatewayService & {
  registry: { register(serviceKind: string, adapter: unknown): void };
  runtimeCandidates: { llm: string[]; tts: string[]; asr: string[] };
  mainLlmCandidates: string[];
  smallLlmCandidates: string[];
};

function makeGateway(): GatewayInternals {
  // 只测调用决策，不需要真实 DB / 配置服务。
  return new AiGatewayService({} as never, {} as never, {} as never) as unknown as GatewayInternals;
}

/** 注册一个「付费」LLM 适配器，并记录被调用次数。 */
function registerPaidLlm(gateway: GatewayInternals): { calls: () => number } {
  let calls = 0;
  gateway.registry.register('llm', {
    alias: 'configured_llm_paid',
    serviceKind: 'llm',
    capabilities: { supportsStructuredOutput: true, supportsStreaming: false },
    pricing: { checkedAt: '2026-11-08' },
    invoke: async () => {
      calls += 1;
      return {
        content: 'paid',
        schemaValid: true,
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 1,
        providerAlias: 'configured_llm_paid',
        modelAlias: 'paid-model',
      };
    },
  });
  gateway.mainLlmCandidates = ['configured_llm_paid'];
  gateway.runtimeCandidates.llm = ['configured_llm_paid'];
  return { calls: () => calls };
}

const REQUEST = {
  promptKey: 'test.prompt',
  promptVersion: 'v1',
  system: 'system',
  messages: [{ role: 'user' as const, content: 'hello' }],
  temperature: 0.1,
  maxTokens: 32,
  timeoutMs: 2000,
};

function decision(level: RoutingDecision['level'], providerAlias: string, strategy: string): RoutingDecision {
  return {
    level,
    providerAlias,
    modelAlias: 'alias-model',
    strategy,
    fellBack: true,
    escalationSignals: [],
  };
}

describe('预算熔断（L0）不得回落付费供应商', () => {
  it('L0 + local_rules：完全不调用付费 LLM，返回本地 Mock 结果', async () => {
    const gateway = makeGateway();
    const paid = registerPaidLlm(gateway);

    const response = await gateway.llm(
      REQUEST,
      decision('L0', 'local_rules', 'budget_circuit_open_local_fallback'),
    );

    assert.equal(paid.calls(), 0, '预算熔断时不得调用付费供应商');
    assert.equal(response.providerAlias, 'mock_llm');
  });

  it('L0 时 ASR 不做「二次高质量识别」升级（升级会绕开熔断）', async () => {
    const gateway = makeGateway();
    let paid = 0;
    gateway.registry.register('asr', {
      alias: 'configured_asr_paid',
      serviceKind: 'asr',
      capabilities: { supportsStructuredOutput: false, supportsStreaming: false },
      pricing: { checkedAt: '2026-11-08' },
      invoke: async () => {
        paid += 1;
        return {
          transcript: 'paid transcript',
          confidence: 0.9,
          seconds: 1,
          latencyMs: 1,
          providerAlias: 'configured_asr_paid',
          modelAlias: 'paid-model',
          suspect: false,
        };
      },
    });
    gateway.runtimeCandidates.asr = ['configured_asr_paid'];

    // 空音频引用：Mock ASR 会返回空转写并标记 suspect，
    // 这正是「二次高质量识别」升级分支的触发条件。
    const result = await gateway.asr(
      { audioRef: '' },
      decision('L0', 'local_rules', 'budget_circuit_open_local_fallback'),
    );

    assert.equal(paid, 0, '预算熔断时不得调用付费 ASR');
    assert.equal(result.providerAlias, 'mock_asr');
    assert.equal(result.transcript, '');
  });

  it('L0 时 TTS 走 Mock 并把降级如实上报（effectiveLevel = L0）', async () => {
    const gateway = makeGateway();
    let paid = 0;
    gateway.registry.register('tts', {
      alias: 'configured_tts_paid',
      serviceKind: 'tts',
      capabilities: { supportsStructuredOutput: false, supportsStreaming: false },
      pricing: { checkedAt: '2026-11-08' },
      invoke: async () => {
        paid += 1;
        return {
          audioRef: '/api/v1/media/audio/paid.mp3',
          characters: 5,
          latencyMs: 1,
          providerAlias: 'configured_tts_paid',
          modelAlias: 'paid-model',
          cached: false,
        };
      },
    });
    gateway.runtimeCandidates.tts = ['configured_tts_paid'];

    const outcome = await gateway.ttsWithResult(
      {
        text: 'Hello',
        voice: { teacherSpeed: 0.65, voiceStyle: 'gentle', pauseAfterSentenceMs: 800, pronunciationMode: 'slow_clear' },
        voiceIdentity: 'teacher_default',
      },
      decision('L0', 'local_rules', 'budget_circuit_open_local_fallback'),
    );

    assert.equal(paid, 0, '预算熔断时不得调用付费 TTS');
    assert.equal(outcome.degraded, true);
    assert.equal(outcome.effectiveLevel, 'L0');
    assert.equal(outcome.providerAlias, 'mock_tts');
    assert.ok(outcome.reasons.some((reason) => reason.startsWith('local_only_')));
  });

  it('非 L0 决策仍按 Router 指定的付费供应商执行（防止过度收紧）', async () => {
    const gateway = makeGateway();
    const paid = registerPaidLlm(gateway);

    const response = await gateway.llm(REQUEST, decision('L1', 'configured_llm_paid', 'primary'));

    assert.equal(paid.calls(), 1);
    assert.equal(response.providerAlias, 'configured_llm_paid');
    assert.equal(response.content, 'paid');
  });
});

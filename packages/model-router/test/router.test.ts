import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advanceMethodLadder,
  DEFAULT_ROUTER_CONFIG,
  initialMethodLadderState,
  ModelRouterImpl,
  resolveDemonstration,
  resolveTeacherSpeed,
} from '../src/index.ts';

describe('Model Router', () => {
  const router = new ModelRouterImpl();

  it('四类服务各自独立路由', async () => {
    const llm = await router.route({ serviceKind: 'llm', taskRoute: 'llm.simple_dialogue' });
    const tts = await router.route({ serviceKind: 'tts', taskRoute: 'tts.dynamic_teaching' });
    const asr = await router.route({ serviceKind: 'asr', taskRoute: 'asr.free_speech' });
    const pron = await router.route({
      serviceKind: 'pronunciation',
      taskRoute: 'pronunciation.phoneme',
    });

    assert.equal(llm.providerAlias, 'free_llm');
    assert.equal(tts.providerAlias, 'lowcost_tts');
    assert.equal(asr.providerAlias, 'free_asr');
    assert.equal(pron.providerAlias, 'pronunciation_svc');
  });

  it('升级信号触发升级到 L2', async () => {
    const decision = await router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.simple_dialogue',
      escalationSignals: ['child_did_not_understand'],
    });
    assert.equal(decision.level, 'L2');
    assert.equal(decision.fellBack, true);
    assert.equal(decision.providerAlias, 'mid_llm');
    assert.equal(decision.modelAlias, 'mid_llm_01');
    assert.equal(decision.strategy, 'escalated_on_child_did_not_understand');
    assert.ok(decision.escalationSignals.includes('child_did_not_understand'));
  });

  it('多个升级信号取最高级别；目标模型缺失时返回真实可用的最高备选级别', async () => {
    const decision = await router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.simple_dialogue',
      escalationSignals: ['child_did_not_understand', 'method_already_changed'],
    });
    assert.equal(decision.level, 'L2');
    assert.equal(decision.providerAlias, 'mid_llm');
    assert.equal(decision.strategy, 'escalation_target_l3_unavailable_using_l2');
  });

  it('运行时供应商别名不覆盖真实模型别名', async () => {
    const configurableRouter = new ModelRouterImpl();
    configurableRouter.setProviderAlias('llm', 'configured_llm', 'child-model-v2');
    const decision = await configurableRouter.route({ serviceKind: 'llm', taskRoute: 'llm.simple_dialogue' });
    assert.equal(decision.providerAlias, 'configured_llm');
    assert.equal(decision.modelAlias, 'child-model-v2');
  });

  it('可以运行时替换任务路由策略并使用真实备选模型升级', async () => {
    const configurableRouter = new ModelRouterImpl();
    configurableRouter.setConfig({
      ...DEFAULT_ROUTER_CONFIG,
      rules: DEFAULT_ROUTER_CONFIG.rules.map((rule) => rule.taskRoute === 'llm.simple_dialogue'
        ? {
            ...rule,
            primary: { providerAlias: 'configured_light', modelAlias: 'child-light', level: 'L1' },
            fallback: [{ providerAlias: 'configured_mid', modelAlias: 'child-mid', level: 'L2' }],
          }
        : rule),
    });
    const decision = await configurableRouter.route({
      serviceKind: 'llm',
      taskRoute: 'llm.simple_dialogue',
      escalationSignals: ['child_did_not_understand'],
    });
    assert.equal(decision.providerAlias, 'configured_mid');
    assert.equal(decision.modelAlias, 'child-mid');
    assert.equal(decision.level, 'L2');
  });

  it('全部供应商标��失败时降级到 L0 本地规则', async () => {
    const decision = await router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.simple_dialogue',
      failedAliases: ['free_llm', 'lowcost_llm', 'mid_llm'],
    });
    assert.equal(decision.level, 'L0');
    assert.equal(decision.providerAlias, 'local_rules');
  });

  it('达到每日预算后选择低等级备选并标记自动降级', async () => {
    const budgetRouter = new ModelRouterImpl({
      ...DEFAULT_ROUTER_CONFIG,
      rules: DEFAULT_ROUTER_CONFIG.rules.map((rule) =>
        rule.taskRoute === 'llm.learning_plan'
          ? { ...rule, dailyBudgetCny: 1, maxConcurrency: 1 }
          : rule,
      ),
    });
    await budgetRouter.recordUsage({
      id: 'budget-used',
      learnerId: null,
      lessonSessionId: null,
      serviceKind: 'llm',
      taskRoute: 'llm.learning_plan',
      level: 'L3',
      providerAlias: 'premium_llm',
      modelAlias: 'premium_llm_01',
      estimatedCostCny: 1,
      createdAt: new Date().toISOString(),
    });
    const decision = await budgetRouter.route({
      serviceKind: 'llm',
      taskRoute: 'llm.learning_plan',
    });
    assert.equal(decision.level, 'L2');
    assert.equal(decision.strategy, 'budget_degraded_fallback');
    assert.equal(decision.budget?.exhausted, true);
  });

  it('并发预算预留会触发熔断，避免多个请求同时越过上限', async () => {
    const budgetRouter = new ModelRouterImpl({
      ...DEFAULT_ROUTER_CONFIG,
      rules: DEFAULT_ROUTER_CONFIG.rules.map((rule) =>
        rule.taskRoute === 'llm.learning_plan'
          ? { ...rule, dailyBudgetCny: 1, maxConcurrency: 1 }
          : rule,
      ),
    });
    const first = await budgetRouter.route({ serviceKind: 'llm', taskRoute: 'llm.learning_plan' });
    const second = await budgetRouter.route({ serviceKind: 'llm', taskRoute: 'llm.learning_plan' });
    assert.equal(first.level, 'L3');
    assert.equal(second.level, 'L2');
    assert.equal(second.strategy, 'budget_degraded_fallback');
    await budgetRouter.recordUsage({
      id: 'budget-settle',
      learnerId: null,
      lessonSessionId: null,
      serviceKind: 'llm',
      taskRoute: 'llm.learning_plan',
      level: first.level,
      providerAlias: first.providerAlias,
      modelAlias: first.modelAlias,
      estimatedCostCny: 0.2,
      createdAt: new Date().toISOString(),
    });
    await budgetRouter.recordUsage({
      id: 'budget-settle-2',
      learnerId: null,
      lessonSessionId: null,
      serviceKind: 'llm',
      taskRoute: 'llm.learning_plan',
      level: second.level,
      providerAlias: second.providerAlias,
      modelAlias: second.modelAlias,
      estimatedCostCny: 0.2,
      createdAt: new Date().toISOString(),
    });
  });

  it('发音评测缺少可用单价时按未知成本熔断到 L0', async () => {
    const budgetRouter = new ModelRouterImpl();
    await budgetRouter.recordUsage({
      id: 'unpriced-pronunciation',
      learnerId: null,
      lessonSessionId: null,
      serviceKind: 'pronunciation',
      taskRoute: 'pronunciation.phoneme',
      level: 'L1',
      providerAlias: 'pronunciation_svc',
      modelAlias: 'pronunciation_01',
      pronunciationCalls: 1,
      estimatedCostCny: 0,
      createdAt: new Date().toISOString(),
    });
    const decision = await budgetRouter.route({
      serviceKind: 'pronunciation',
      taskRoute: 'pronunciation.phoneme',
    });
    assert.equal(decision.level, 'L0');
    assert.equal(decision.strategy, 'budget_circuit_open_local_fallback');
    assert.equal(decision.budget?.unpricedCalls, 1);
  });

  it('路由规则中不含任何厂商或模型名称', () => {
    const forbidden = ['silicon', 'siliconflow', 'openai', 'zhipu', 'aliyun', 'tencent', 'qwen', 'glm', 'doubao'];
    const text = JSON.stringify(DEFAULT_ROUTER_CONFIG).toLowerCase();
    for (const word of forbidden) {
      assert.equal(text.includes(word), false, `路由配置中出现厂商名：${word}`);
    }
  });
});

describe('教学方法阶梯（L0 规则驱动）', () => {
  it('达标后重置方法与连续失败计数', () => {
    const state = { ...initialMethodLadderState(), attempts: 2, consecutiveFailures: 3 };
    const result = advanceMethodLadder({ passed: true, state });
    assert.equal(result.state.current, 'method_slow_clear');
    assert.equal(result.state.consecutiveFailures, 0);
  });

  it('连续失败会更换方法，而不是重复同一句', () => {
    let state = initialMethodLadderState();
    const first = advanceMethodLadder({ passed: false, state });
    assert.equal(first.state.current, 'method_slow_clear'); // 第一次仍用当前方法
    state = first.state;

    const second = advanceMethodLadder({ passed: false, state });
    assert.equal(second.state.current, 'method_syllable_split'); // 第二次换方法
  });

  it('最多陪练 5 轮后停止催促并请求升级', () => {
    let state = initialMethodLadderState();
    let result = advanceMethodLadder({ passed: false, state });
    for (let i = 0; i < 6; i++) {
      state = result.state;
      result = advanceMethodLadder({ passed: false, state });
    }
    assert.equal(result.reachedPatienceLimit, true);
    assert.equal(result.needsEscalation, true);
    assert.equal(result.state.current, 'method_model_and_wait');
  });

  it('定向练习只示范出错的音节', () => {
    const result = resolveDemonstration({
      method: 'method_syllable_split',
      targetWord: 'apple',
      syllables: ['ap', 'ple'],
      errorUnits: [{ unit: 'ple', kind: 'syllable' }],
    });
    assert.equal(result.focusOnErrorOnly, true);
    assert.equal(result.demonstrationText, 'ple');
  });

  it('非定向方法示范完整单词', () => {
    const result = resolveDemonstration({
      method: 'method_slow_clear',
      targetWord: 'apple',
      syllables: ['ap', 'ple'],
      errorUnits: [{ unit: 'ple', kind: 'syllable' }],
    });
    assert.equal(result.focusOnErrorOnly, false);
    assert.equal(result.demonstrationText, 'apple');
  });

  it('不同方法产生不同语速，且在合法范围内', () => {
    const slow = resolveTeacherSpeed(0.65, 'method_slow_clear');
    const phoneme = resolveTeacherSpeed(0.65, 'method_phoneme_focus');
    assert.ok(phoneme < slow);
    assert.ok(phoneme >= 0.25 && phoneme <= 4);
  });
});

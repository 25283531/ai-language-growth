import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import {
  buildUsageBudgetSnapshot,
  evaluateUsageBudget,
  parseUsageBudgetConfig,
  usageBudgetWindow,
  type UsageBudgetObserved,
} from '../src/usage/usage-budget.ts';
import { UsageBudgetAdminController } from '../src/usage/usage-budget-admin.controller.ts';
import { UsageBudgetService } from '../src/usage/usage-budget.service.ts';

const DAY_WINDOW = {
  from: new Date('2026-11-12T00:00:00.000Z'),
  to: new Date('2026-11-13T00:00:00.000Z'),
};

function observed(overrides: Partial<UsageBudgetObserved> = {}): UsageBudgetObserved {
  return {
    calls: 1,
    ttsCharacters: 0,
    asrSeconds: 0,
    pronunciationCalls: 0,
    estimatedCostCny: 0,
    unpricedCalls: 0,
    ...overrides,
  };
}

describe('用量预算契约', () => {
  it('解析 learner/day 与 topic/month 配置，拒绝负数', () => {
    const config = parseUsageBudgetConfig(JSON.stringify({
      learnerDay: { ttsCharacters: 100, asrSeconds: 60, pronunciationCalls: 5 },
      topicMonth: { estimatedCostCny: 20 },
    }));
    assert.deepEqual(config.learnerDay, {
      ttsCharacters: 100,
      asrSeconds: 60,
      pronunciationCalls: 5,
    });
    assert.deepEqual(config.topicMonth, { estimatedCostCny: 20 });
    assert.deepEqual(parseUsageBudgetConfig(undefined), { learnerDay: {}, topicMonth: {} });
    assert.throws(
      () => parseUsageBudgetConfig('{"learnerDay":{"ttsCharacters":-1}}'),
      /必须是正数/,
    );
    assert.throws(
      () => parseUsageBudgetConfig('{broken'),
      /不是合法 JSON/,
    );
  });

  it('按 UTC 自然日 / 自然月计算窗口', () => {
    const now = new Date('2026-11-12T23:30:00.000Z');
    assert.deepEqual(usageBudgetWindow('learner_day', now), DAY_WINDOW);
    assert.deepEqual(usageBudgetWindow('topic_month', now), {
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-12-01T00:00:00.000Z'),
    });
  });

  it('80% 触发软告警，仍为 advisory 不阻断', () => {
    const evaluation = evaluateUsageBudget(
      'learner_day',
      { ttsCharacters: 100, asrSeconds: 100, pronunciationCalls: 10 },
      observed({ ttsCharacters: 80 }),
      DAY_WINDOW,
    );
    const tts = evaluation.metrics.find((metric) => metric.key === 'ttsCharacters');
    assert.equal(tts?.ratio, 0.8);
    assert.equal(tts?.status, 'warning');
    assert.equal(evaluation.status, 'warning');
    assert.equal(evaluation.enforcement, 'advisory');
    assert.equal(evaluation.blocked, false);
    assert.equal(evaluation.displayMode, 'usage');
    assert.equal(evaluation.cost, null);
    assert.ok(evaluation.notices.some((notice) => notice.includes('80%')));
  });

  it('100% 触发 exceeded 告警，但不返回阻断', () => {
    const evaluation = evaluateUsageBudget(
      'learner_day',
      { ttsCharacters: 100 },
      observed({ ttsCharacters: 100 }),
      DAY_WINDOW,
    );
    assert.equal(evaluation.metrics[0]?.ratio, 1);
    assert.equal(evaluation.metrics[0]?.status, 'exceeded');
    assert.equal(evaluation.status, 'exceeded');
    assert.equal(evaluation.blocked, false);
    assert.ok(evaluation.notices.some((notice) => notice.includes('100%')));
  });

  it('79% 不告警，验证 80% 边界', () => {
    const evaluation = evaluateUsageBudget(
      'learner_day',
      { ttsCharacters: 100 },
      observed({ ttsCharacters: 79 }),
      DAY_WINDOW,
    );
    assert.equal(evaluation.status, 'ok');
    assert.equal(evaluation.metrics[0]?.status, 'ok');
  });

  it('未计价时不生成金额预算，只保留字符/秒/次数', () => {
    const evaluation = evaluateUsageBudget(
      'topic_month',
      { ttsCharacters: 100, estimatedCostCny: 10 },
      observed({ ttsCharacters: 80, estimatedCostCny: 8, unpricedCalls: 1 }),
      DAY_WINDOW,
    );
    assert.equal(evaluation.displayMode, 'usage');
    assert.deepEqual(evaluation.metrics.map((metric) => metric.key), ['ttsCharacters']);
    assert.equal(evaluation.cost, null);
    assert.equal(evaluation.status, 'warning');
    assert.ok(evaluation.notices.some((notice) => notice.includes('未计价')));
  });

  it('价格可用且配置金额时，才附带金额预算', () => {
    const evaluation = evaluateUsageBudget(
      'topic_month',
      { estimatedCostCny: 10 },
      observed({ estimatedCostCny: 8, unpricedCalls: 0 }),
      DAY_WINDOW,
    );
    assert.equal(evaluation.displayMode, 'cost_and_usage');
    assert.equal(evaluation.cost?.key, 'estimatedCostCny');
    assert.equal(evaluation.cost?.ratio, 0.8);
    assert.equal(evaluation.cost?.status, 'warning');
    assert.equal(evaluation.status, 'warning');
  });

  it('未配置金额时只走用量预算，不显示 0 元', () => {
    const evaluation = evaluateUsageBudget(
      'learner_day',
      { ttsCharacters: 100 },
      observed({ ttsCharacters: 10 }),
      DAY_WINDOW,
    );
    assert.equal(evaluation.displayMode, 'usage');
    assert.equal(evaluation.cost, null);
    assert.ok(evaluation.notices.some((notice) => notice.includes('未配置金额预算')));
  });

  it('配置快照可读回，来源标为 environment', () => {
    const snapshot = buildUsageBudgetSnapshot({
      learnerDay: { ttsCharacters: 100 },
      topicMonth: { asrSeconds: 60 },
    });
    assert.equal(snapshot.source, 'environment');
    assert.equal(snapshot.enforcement, 'advisory');
    assert.deepEqual(snapshot.scopes.learnerDay, {
      scope: 'learner_day',
      limits: { ttsCharacters: 100 },
    });
    assert.deepEqual(snapshot.scopes.topicMonth, {
      scope: 'topic_month',
      limits: { asrSeconds: 60 },
    });
  });

  it('服务按 scope 查询聚合，并拒绝缺少作用域标识', async () => {
    const ranges: unknown[] = [];
    const service = new UsageBudgetService({
      aggregate: async (range: unknown) => {
        ranges.push(range);
        return { totals: observed({ ttsCharacters: 80 }) };
      },
    } as never);
    const previous = process.env.USAGE_BUDGET_CONFIG_JSON;
    process.env.USAGE_BUDGET_CONFIG_JSON = JSON.stringify({
      learnerDay: { ttsCharacters: 100 },
      topicMonth: { ttsCharacters: 100 },
    });
    try {
      const result = await service.evaluate({
        scope: 'learner_day',
        learnerId: ' learner-1 ',
        now: new Date('2026-11-12T08:00:00.000Z'),
      });
      assert.equal(result.status, 'warning');
      const topicResult = await service.evaluate({
        scope: 'topic_month',
        topicId: ' topic-1 ',
        now: new Date('2026-11-12T08:00:00.000Z'),
      });
      assert.equal(topicResult.status, 'warning');
      assert.deepEqual(ranges, [
        { from: DAY_WINDOW.from, to: DAY_WINDOW.to, learnerId: 'learner-1' },
        {
          from: new Date('2026-11-01T00:00:00.000Z'),
          to: new Date('2026-12-01T00:00:00.000Z'),
          topicId: 'topic-1',
        },
      ]);
      await assert.rejects(
        service.evaluate({ scope: 'learner_day' }),
        /learner_day 需要 learnerId/,
      );
      await assert.rejects(
        service.evaluate({ scope: 'topic_month' }),
        /topic_month 需要 topicId/,
      );
    } finally {
      if (previous === undefined) delete process.env.USAGE_BUDGET_CONFIG_JSON;
      else process.env.USAGE_BUDGET_CONFIG_JSON = previous;
    }
  });

  it('管理员预算快照接口先鉴权再返回配置', () => {
    let authorized = 0;
    const snapshot = buildUsageBudgetSnapshot({ learnerDay: {}, topicMonth: {} });
    const controller = new UsageBudgetAdminController(
      {
        resolveRequest: () => {
          authorized += 1;
          return 'admin';
        },
      } as never,
      { getSnapshot: () => snapshot } as never,
    );
    assert.deepEqual(
      controller.budgetSnapshot({ headers: { cookie: 'alg_admin_session=test' } } as Request),
      snapshot,
    );
    assert.equal(authorized, 1);
  });
});

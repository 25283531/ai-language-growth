import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import { UsageAdminController } from '../src/usage/usage-admin.controller.ts';
import {
  buildUsageCostReport,
  type UsageCostRow,
} from '../src/usage/usage-cost.service.ts';

function row(overrides: Partial<UsageCostRow> = {}): UsageCostRow {
  return {
    learnerId: 'learner-1',
    lessonSessionId: 'session-1',
    modelId: 'model-1',
    level: 'L1',
    inputTokens: 0,
    outputTokens: 0,
    ttsCharacters: 0,
    asrSeconds: 0,
    pronunciationCalls: 0,
    estimatedCostCny: 0,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    lessonSession: { topicId: 'topic-a' },
    model: { prices: [{ priceType: 'per_1000_chars' }, { priceType: 'per_second' }, { priceType: 'per_call' }] },
    ...overrides,
  };
}

describe('管理员成本聚合', () => {
  it('按 learner/topic/day 汇总计量与未计价调用', () => {
    const report = buildUsageCostReport(
      [
        row({
          ttsCharacters: 100,
          estimatedCostCny: 0.05,
        }),
        row({
          learnerId: 'learner-1',
          lessonSessionId: 'session-2',
          ttsCharacters: 0,
          asrSeconds: 2.5,
          estimatedCostCny: 0.01,
          createdAt: new Date('2026-11-02T10:00:00.000Z'),
        }),
        row({
          learnerId: 'learner-2',
          lessonSessionId: 'session-3',
          level: 'L2',
          modelId: null,
          model: null,
          pronunciationCalls: 1,
          estimatedCostCny: 0,
          createdAt: new Date('2026-11-02T11:00:00.000Z'),
          lessonSession: { topicId: 'topic-b' },
        }),
        row({
          learnerId: null,
          lessonSessionId: null,
          level: 'L0',
          modelId: null,
          model: null,
          ttsCharacters: 5,
          createdAt: new Date('2026-11-03T11:00:00.000Z'),
          lessonSession: null,
        }),
      ],
      {
        from: new Date('2026-11-01T00:00:00.000Z'),
        to: new Date('2026-11-04T00:00:00.000Z'),
      },
    );

    assert.deepEqual(report.totals, {
      calls: 4,
      ttsCharacters: 105,
      asrSeconds: 2.5,
      pronunciationCalls: 1,
      estimatedCostCny: 0.06,
      unpricedCalls: 1,
    });

    const learner1 = report.byLearner.find((bucket) => bucket.learnerId === 'learner-1');
    assert.equal(learner1?.calls, 2);
    assert.equal(learner1?.ttsCharacters, 100);
    assert.equal(learner1?.asrSeconds, 2.5);
    assert.equal(learner1?.unpricedCalls, 0);

    const learner2 = report.byLearner.find((bucket) => bucket.learnerId === 'learner-2');
    assert.equal(learner2?.pronunciationCalls, 1);
    assert.equal(learner2?.unpricedCalls, 1);

    const topicA = report.byTopic.find((bucket) => bucket.topicId === 'topic-a');
    assert.equal(topicA?.calls, 2);
    assert.equal(topicA?.asrSeconds, 2.5);

    const topicB = report.byTopic.find((bucket) => bucket.topicId === 'topic-b');
    assert.equal(topicB?.pronunciationCalls, 1);

    const unassigned = report.byTopic.find((bucket) => bucket.topicId === null);
    assert.equal(unassigned?.ttsCharacters, 5);

    assert.deepEqual(
      report.byDay.map((bucket) => bucket.date),
      ['2026-11-01', '2026-11-02', '2026-11-03'],
    );
  });

  it('缺少价格类型的调用计为未计价，L0 不计未计价', () => {
    const report = buildUsageCostReport(
      [
        row({
          ttsCharacters: 100,
          model: { prices: [{ priceType: 'per_1000_chars' }] },
        }),
        row({
          learnerId: 'learner-2',
          asrSeconds: 1,
          model: { prices: [{ priceType: 'input_token' }] },
        }),
        row({
          learnerId: 'learner-3',
          level: 'L0',
          ttsCharacters: 100,
          modelId: null,
          model: null,
        }),
      ],
      {
        from: new Date('2026-11-01T00:00:00.000Z'),
        to: new Date('2026-11-04T00:00:00.000Z'),
      },
    );

    assert.equal(report.totals.unpricedCalls, 1);
    assert.equal(
      report.byLearner.find((bucket) => bucket.learnerId === 'learner-3')?.unpricedCalls,
      0,
    );
  });

  it('管理员控制器先鉴权，并传递过滤与时间范围', async () => {
    const calls: unknown[] = [];
    let authorized = 0;
    const controller = new UsageAdminController(
      {
        resolveRequest: () => {
          authorized += 1;
          return 'admin';
        },
      } as never,
      {
        aggregate: async (range: unknown) => {
          calls.push(range);
          return { totals: {}, byLearner: [], byTopic: [], byDay: [] };
        },
      } as never,
    );

    const result = await controller.cost(
      { headers: { cookie: 'alg_admin_session=test' } } as Request,
      '2026-11-01T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
      'learner-1',
      'session-1',
      'topic-a',
    );

    assert.equal(authorized, 1);
    assert.deepEqual(calls, [
      {
        from: new Date('2026-11-01T00:00:00.000Z'),
        to: new Date('2026-11-03T00:00:00.000Z'),
        learnerId: 'learner-1',
        lessonSessionId: 'session-1',
        topicId: 'topic-a',
      },
    ]);
    assert.deepEqual(result, { totals: {}, byLearner: [], byTopic: [], byDay: [] });
  });

  it('拒绝反向或超过 366 天的范围', async () => {
    const controller = new UsageAdminController(
      { resolveRequest: () => 'admin' } as never,
      { aggregate: async () => ({}) } as never,
    );
    const request = { headers: {} } as Request;

    await assert.rejects(
      controller.cost(request, '2026-11-03T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
      /from 必须早于 to/,
    );
    await assert.rejects(
      controller.cost(request, '2024-01-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'),
      /不能超过 366 天/,
    );
  });
});

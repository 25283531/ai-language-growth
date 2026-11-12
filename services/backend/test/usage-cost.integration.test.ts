import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { UsageCostService } from '../src/usage/usage-cost.service.ts';

const prisma = new PrismaClient();
const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const userId = `ci-usage-user-${runId}`;
const learnerA = `ci-usage-a-${runId}`;
const learnerB = `ci-usage-b-${runId}`;
const topicA = `ci-usage-topic-a-${runId}`;
const topicB = `ci-usage-topic-b-${runId}`;
const sessionA1 = `ci-usage-session-a1-${runId}`;
const sessionA2 = `ci-usage-session-a2-${runId}`;
const sessionB = `ci-usage-session-b-${runId}`;
const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
// 只允许显式授权的可丢弃库，避免误连生产库写入测试账本。
const enabled =
  process.env.USAGE_COST_DB_INTEGRATION === '1' &&
  process.env.NODE_ENV !== 'production' &&
  /(^|[_-])(ci|test|tmp|disposable)([_-]|$)/i.test(databaseName);

before(async () => {
  if (!enabled) return;
  await prisma.users.create({
    data: {
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: 'ci-only',
      displayName: 'Usage Cost CI',
      role: 'guardian',
    },
  });
  await prisma.learner_profiles.createMany({
    data: [
      { id: learnerA, userId, guardianId: userId, displayName: 'Usage A' },
      { id: learnerB, userId, guardianId: userId, displayName: 'Usage B' },
    ],
  });
  await prisma.lesson_sessions.createMany({
    data: [
      { id: sessionA1, learnerId: learnerA, topicId: topicA },
      { id: sessionA2, learnerId: learnerA, topicId: topicA },
      { id: sessionB, learnerId: learnerB, topicId: topicB },
    ],
  });
  await prisma.ai_usage_logs.createMany({
    data: [
      {
        learnerId: learnerA,
        lessonSessionId: sessionA1,
        serviceKind: 'tts',
        taskRoute: 'tts',
        level: 'L1',
        ttsCharacters: 100,
        estimatedCostCny: 0.05,
        createdAt: new Date('2026-11-01T10:00:00.000Z'),
      },
      {
        learnerId: learnerA,
        lessonSessionId: sessionA2,
        serviceKind: 'asr',
        taskRoute: 'asr',
        level: 'L1',
        asrSeconds: 2.5,
        estimatedCostCny: 0.01,
        createdAt: new Date('2026-11-02T10:00:00.000Z'),
      },
      {
        learnerId: learnerB,
        lessonSessionId: sessionB,
        serviceKind: 'pronunciation',
        taskRoute: 'pronunciation',
        level: 'L1',
        pronunciationCalls: 1,
        estimatedCostCny: 0.02,
        createdAt: new Date('2026-11-02T11:00:00.000Z'),
      },
      {
        learnerId: learnerB,
        lessonSessionId: sessionB,
        serviceKind: 'tts',
        taskRoute: 'tts',
        level: 'L1',
        ttsCharacters: 50,
        estimatedCostCny: 0.03,
        createdAt: new Date('2026-11-03T11:00:00.000Z'),
      },
    ],
  });
});

after(async () => {
  try {
    if (enabled) {
      await prisma.ai_usage_logs.deleteMany({
        where: { learnerId: { in: [learnerA, learnerB] } },
      });
      await prisma.lesson_sessions.deleteMany({
        where: { learnerId: { in: [learnerA, learnerB] } },
      });
      await prisma.learner_profiles.deleteMany({
        where: { id: { in: [learnerA, learnerB] } },
      });
      await prisma.users.deleteMany({ where: { id: userId } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test(
  '真实 PostgreSQL 中按 learner/topic/day 聚合且 topic 过滤生效',
  { skip: !enabled },
  async () => {
    const service = new UsageCostService(prisma as never);
    const from = new Date('2026-11-01T00:00:00.000Z');
    const to = new Date('2026-11-04T00:00:00.000Z');

    const report = await service.aggregate({ from, to });
    assert.deepEqual(report.totals, {
      calls: 4,
      ttsCharacters: 150,
      asrSeconds: 2.5,
      pronunciationCalls: 1,
      estimatedCostCny: 0.11,
      unpricedCalls: 4,
    });
    assert.equal(report.byLearner.length, 2);
    assert.equal(report.byLearner.find((bucket) => bucket.learnerId === learnerA)?.calls, 2);
    assert.equal(report.byTopic.find((bucket) => bucket.topicId === topicA)?.asrSeconds, 2.5);
    assert.equal(report.byTopic.find((bucket) => bucket.topicId === topicB)?.calls, 2);
    assert.deepEqual(
      report.byDay.map((bucket) => bucket.date),
      ['2026-11-01', '2026-11-02', '2026-11-03'],
    );

    const byTopic = await service.aggregate({ from, to, topicId: topicA });
    assert.equal(byTopic.totals.calls, 2);
    assert.equal(byTopic.totals.ttsCharacters, 100);
    assert.equal(byTopic.totals.asrSeconds, 2.5);

    const empty = await service.aggregate({
      from: new Date('2020-01-01T00:00:00.000Z'),
      to: new Date('2020-01-02T00:00:00.000Z'),
    });
    assert.equal(empty.totals.calls, 0);
    assert.deepEqual(empty.byLearner, []);
    assert.deepEqual(empty.byTopic, []);
    assert.deepEqual(empty.byDay, []);
  },
);

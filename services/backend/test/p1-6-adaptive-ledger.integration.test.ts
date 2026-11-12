import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { ModelRouterImpl, MOCK_PROVIDER_ALIASES } from '@alg/model-router';
import type { MasteryState, TeachingActivity } from '@alg/shared-contracts';
import { PlannerService } from '../src/planner/planner.service.ts';
import { PrismaUsageLedger } from '../src/usage/prisma-usage-ledger.ts';

/**
 * P1-6 账本对照探针：统计 chooseAdaptiveActivity 对 LLM 的真实调用次数。
 *
 * 不启动 HTTP、不调用真实供应商；Router 使用真实 PrismaUsageLedger，
 * 因此每次 LLM 分支都会在 ai_usage_logs 留下可核对的行。
 *
 * 默认断言改造后的预算（只允许一个边界场景调用）。改造前可用
 * P1_6_EXPECT_LLM_CALLS=4 运行同一探针，得到基线。
 */
const prisma = new PrismaClient();
const runId = process.env.P1_6_RUN_ID ?? process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const userId = `p1-6-user-${runId}`;
const learnerId = `p1-6-learner-${runId}`;
const lessonSessionId = `p1-6-session-${runId}`;
const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const enabled =
  process.env.P1_6_DB_INTEGRATION === '1' &&
  process.env.NODE_ENV !== 'production' &&
  /(^|[_-])(ci|test|tmp|disposable)([_-]|$)/i.test(databaseName);
const expectedCalls = Number(process.env.P1_6_EXPECT_LLM_CALLS ?? '1');

const states: Record<string, MasteryState> = {
  'LA.VOCAB.receptive': 'not_exposed',
  'LA.LISTEN.greeting_core': 'not_exposed',
  'SE.SCHOOL.letters': 'forming',
  'LA.SPEAK.simple_sentences': 'mastered',
  'SE.SCHOOL.word_reading': 'mastered',
};

function activity(input: {
  id: string;
  skillNodeId: string;
  taskType: string;
  order: number;
}): TeachingActivity {
  return {
    id: input.id,
    skillNodeIds: [input.skillNodeId],
    targetWords: [input.id],
    difficulty: 1,
    taskType: input.taskType,
    order: input.order,
  } as unknown as TeachingActivity;
}

type AdaptiveChoice = {
  chooseAdaptiveActivity(input: {
    activities: TeachingActivity[];
    learnerId: string;
    lessonSessionId: string;
    states: Record<string, MasteryState>;
  }): Promise<TeachingActivity>;
};

after(async () => {
  if (enabled) {
    await prisma.ai_usage_logs.deleteMany({
      where: { learnerId, serviceKind: 'llm' },
    }).catch(() => undefined);
    await prisma.lesson_sessions.deleteMany({ where: { id: lessonSessionId } }).catch(() => undefined);
    await prisma.learner_profiles.deleteMany({ where: { id: learnerId } }).catch(() => undefined);
    await prisma.users.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

before(async () => {
  if (!enabled) return;
  await prisma.users.create({
    data: {
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: 'ci-only',
      displayName: 'P1-6 Guardian',
      role: 'guardian',
    },
  });
  await prisma.learner_profiles.create({
    data: {
      id: learnerId,
      userId,
      guardianId: userId,
      displayName: 'P1-6 Learner',
      ageGroup: '6-9',
      entryLevel: 'pre_a1',
      membershipTier: 'free',
    },
  });
  await prisma.lesson_sessions.create({
    data: { id: lessonSessionId, learnerId, topicId: `p1-6-topic-${runId}` },
  });
});

test(
  'chooseAdaptiveActivity 的 LLM 调用受确定性边界约束，并写入账本',
  { skip: !enabled },
  async () => {
    await prisma.ai_usage_logs.deleteMany({
      where: { learnerId, serviceKind: 'llm' },
    });

    const gatewayCalls: unknown[] = [];
    const decisions: Array<{ level: string; providerAlias: string }> = [];
    const gateway = {
      llm: async (request: { messages: Array<{ content: string }> }, decision: { level: string; providerAlias: string; modelAlias: string }) => {
        gatewayCalls.push(request);
        decisions.push({ level: decision.level, providerAlias: decision.providerAlias });
        const payload = JSON.parse(request.messages[0]?.content ?? '{}') as {
          candidates?: Array<{ activityId: string }>;
        };
        const activityId = payload.candidates?.at(-1)?.activityId ?? '';
        return {
          content: JSON.stringify({ activityId }),
          schemaValid: true,
          inputTokens: 12,
          outputTokens: 4,
          latencyMs: 3,
          providerAlias: decision.providerAlias,
          modelAlias: decision.modelAlias,
        };
      },
    };
    const router = new ModelRouterImpl(
      undefined,
      new PrismaUsageLedger(prisma as never),
      MOCK_PROVIDER_ALIASES,
    );
    const planner = new PlannerService(
      {
        textbook_mappings: { findFirst: async () => null },
        learner_profiles: {
          findUnique: async () => ({ ageGroup: '6-9', entryLevel: 'pre_a1', target: 'daily' }),
        },
      } as never,
      gateway as never,
      router as never,
    );
    const choose = (planner as unknown as AdaptiveChoice).chooseAdaptiveActivity.bind(planner);

    const scenarios: Array<{
      name: string;
      activities: TeachingActivity[];
      expected: 'deterministic' | 'llm';
    }> = [
      {
        name: 'clear-mastery-gap',
        activities: [
          activity({ id: 'a-clear-low', skillNodeId: 'LA.VOCAB.receptive', taskType: 'vocabulary', order: 1 }),
          activity({ id: 'a-clear-high', skillNodeId: 'SE.SCHOOL.letters', taskType: 'vocabulary', order: 2 }),
        ],
        expected: 'deterministic',
      },
      {
        name: 'tie-same-task-type',
        activities: [
          activity({ id: 'a-same-1', skillNodeId: 'LA.VOCAB.receptive', taskType: 'vocabulary', order: 1 }),
          activity({ id: 'a-same-2', skillNodeId: 'LA.LISTEN.greeting_core', taskType: 'vocabulary', order: 2 }),
        ],
        expected: 'deterministic',
      },
      {
        name: 'tie-different-task-type',
        activities: [
          activity({ id: 'a-boundary-1', skillNodeId: 'LA.VOCAB.receptive', taskType: 'vocabulary', order: 1 }),
          activity({ id: 'a-boundary-2', skillNodeId: 'LA.LISTEN.greeting_core', taskType: 'listening', order: 2 }),
        ],
        expected: 'llm',
      },
      {
        name: 'all-mastered',
        activities: [
          activity({ id: 'a-mastered-1', skillNodeId: 'LA.SPEAK.simple_sentences', taskType: 'review', order: 1 }),
          activity({ id: 'a-mastered-2', skillNodeId: 'SE.SCHOOL.word_reading', taskType: 'review', order: 2 }),
        ],
        expected: 'deterministic',
      },
    ];

    for (const scenario of scenarios) {
      const callsBefore = gatewayCalls.length;
      const selected = await choose({
        activities: scenario.activities,
        learnerId,
        lessonSessionId,
        states,
      });
      assert.ok(scenario.activities.some((item) => item.id === selected.id));
      if (expectedCalls === 1) {
        assert.equal(
          gatewayCalls.length - callsBefore,
          scenario.expected === 'llm' ? 1 : 0,
          `${scenario.name} 的 LLM 调用数不符合预期`,
        );
      }
    }

    const rows = await prisma.ai_usage_logs.findMany({
      where: { learnerId, serviceKind: 'llm' },
      orderBy: { createdAt: 'asc' },
      select: { taskRoute: true, level: true },
    });
    const llmCalls = rows.length;
    const observed = {
      runId,
      scenarios: scenarios.length,
      llmCalls,
      gatewayCalls: gatewayCalls.length,
      routes: rows.map((row) => row.taskRoute),
      levels: rows.map((row) => row.level),
      decisions,
    };
    console.log(JSON.stringify(observed));

    assert.equal(llmCalls, expectedCalls, `LLM 调用次数应为 ${expectedCalls}，实际 ${llmCalls}`);
    assert.equal(gatewayCalls.length, llmCalls, '网关调用次数必须与账本行数一致');
    if (expectedCalls === 1) {
      assert.deepEqual(observed.routes, ['llm.learning_plan_tiebreak']);
      assert.deepEqual(observed.levels, ['L0'], 'mock 适配器在账本中按 L0 记录');
      assert.equal(observed.decisions[0]?.level, 'L1');
    }
  },
);

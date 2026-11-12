/**
 * P0-1 回归测试：`/api/v1/learners/*` 必须有鉴权与归属校验。
 *
 * 缺陷：`LearnersController` 没有注入 AuthService，5 个路由全部匿名可访问，
 * `GET /learners` 还会把全库学习者档案列出来 —— 儿童档案属敏感个人信息，
 * 这是必须堵住的口子。
 *
 * 本测试不启动 HTTP、不需要数据库：用内存假 Prisma + 真实 AuthService
 * 直接调用控制器方法，验证 401 / 403 / 列表按账号过滤三条断言。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { AuthService } from '../src/auth/auth.service.ts';
import { LearnersController } from '../src/lessons/lessons.controller.ts';

const TOKEN_A = 'token-account-a';
const TOKEN_B = 'token-account-b';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const PROFILES = [
  { id: 'learner-a', userId: 'user-a', guardianId: 'user-a', displayName: 'A 的孩子', createdAt: new Date(1) },
  { id: 'learner-b', userId: 'user-b', guardianId: 'user-b', displayName: 'B 的孩子', createdAt: new Date(2) },
  // 历史脏数据：userId 与 guardianId 不一致的档案不属于任何一方，
  // 列表与单条读取都不得返回。
  { id: 'learner-orphan', userId: 'user-a', guardianId: 'user-b', displayName: '脏档案', createdAt: new Date(3) },
];

const SESSIONS = [
  {
    id: 'session-a',
    tokenHash: sha256(TOKEN_A),
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: { id: 'user-a', disabledAt: null },
  },
  {
    id: 'session-b',
    tokenHash: sha256(TOKEN_B),
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    user: { id: 'user-b', disabledAt: null },
  },
];

function fakePrisma() {
  return {
    auth_sessions: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        SESSIONS.find((session) => session.tokenHash === where.tokenHash) ?? null,
      update: async () => ({}),
    },
    learner_profiles: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        PROFILES.find((profile) => profile.id === where.id) ?? null,
      findMany: async ({ where }: { where: { userId: string; guardianId: string } }) =>
        PROFILES.filter(
          (profile) => profile.userId === where.userId && profile.guardianId === where.guardianId,
        ),
    },
    learning_evidence: { findMany: async () => [] },
    learner_growth_snapshots: { findMany: async () => [] },
    interaction_memories: { findMany: async () => [] },
    review_schedules: { findMany: async () => [] },
  };
}

function controller() {
  const prisma = fakePrisma();
  const auth = new AuthService(prisma as never);
  const learnerModel = { abilitySnapshot: async () => ({}) };
  const reports = {
    weekly: async (learnerId: string, weekStart?: string) => ({ learnerId, weekStart: weekStart ?? null }),
  };
  return new LearnersController(learnerModel as never, prisma as never, auth, reports as never);
}

const statusOf = (error: unknown): number =>
  typeof (error as { getStatus?: () => number }).getStatus === 'function'
    ? (error as { getStatus: () => number }).getStatus()
    : -1;

describe('学习者接口鉴权', () => {
  it('无 cookie / 无 Bearer：列表与所有单条接口都返回 401', async () => {
    const api = controller();
    await assert.rejects(() => api.list(undefined, undefined), (error) => statusOf(error) === 401);
    await assert.rejects(() => api.profile('learner-a', undefined, undefined), (error) => statusOf(error) === 401);
    await assert.rejects(() => api.abilities('learner-a', undefined, undefined), (error) => statusOf(error) === 401);
    await assert.rejects(() => api.evidence('learner-a', undefined, undefined), (error) => statusOf(error) === 401);
    await assert.rejects(() => api.growth('learner-a', undefined, undefined), (error) => statusOf(error) === 401);
    await assert.rejects(
      () => api.weeklyReport('learner-a', undefined, undefined),
      (error) => statusOf(error) === 401,
    );
  });

  it('列表只返回当前账号名下的学习者（不泄露他人档案）', async () => {
    const api = controller();
    const mine = await api.list(`Bearer ${TOKEN_A}`, undefined);
    assert.deepEqual(mine.map((row) => row.id), ['learner-a']);

    const other = await api.list(undefined, `alg_session=${TOKEN_B}`);
    assert.deepEqual(other.map((row) => row.id), ['learner-b']);
  });

  it('跨账号读取他人学习者：403（不区分「不存在」与「无权」，避免枚举）', async () => {
    const api = controller();
    const headers = `Bearer ${TOKEN_A}`;
    await assert.rejects(() => api.profile('learner-b', headers, undefined), (error) => statusOf(error) === 403);
    await assert.rejects(() => api.abilities('learner-b', headers, undefined), (error) => statusOf(error) === 403);
    await assert.rejects(() => api.evidence('learner-b', headers, undefined), (error) => statusOf(error) === 403);
    await assert.rejects(() => api.growth('learner-b', headers, undefined), (error) => statusOf(error) === 403);
    await assert.rejects(
      () => api.weeklyReport('learner-b', headers, undefined),
      (error) => statusOf(error) === 403,
    );
  });

  it('userId 与 guardianId 不一致的脏档案对双方都不可见', async () => {
    const api = controller();
    assert.deepEqual((await api.list(`Bearer ${TOKEN_A}`, undefined)).map((row) => row.id), ['learner-a']);
    assert.deepEqual((await api.list(`Bearer ${TOKEN_B}`, undefined)).map((row) => row.id), ['learner-b']);
    await assert.rejects(
      () => api.profile('learner-orphan', `Bearer ${TOKEN_A}`, undefined),
      (error) => statusOf(error) === 403,
    );
  });

  it('本人档案可以正常读取（防止过度收紧）', async () => {
    const api = controller();
    const profile = await api.profile('learner-a', `Bearer ${TOKEN_A}`, undefined);
    assert.equal(profile.id, 'learner-a');
    const abilities = await api.abilities('learner-a', `Bearer ${TOKEN_A}`, undefined);
    assert.equal(abilities.learnerId, 'learner-a');
    const growth = await api.growth('learner-a', `Bearer ${TOKEN_A}`, undefined);
    assert.equal(growth.learnerId, 'learner-a');
    const weekly = await api.weeklyReport('learner-a', `Bearer ${TOKEN_A}`, undefined, '2026-11-09');
    assert.deepEqual(weekly, { learnerId: 'learner-a', weekStart: '2026-11-09' });
  });
});

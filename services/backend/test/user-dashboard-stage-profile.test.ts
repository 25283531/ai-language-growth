/**
 * P3-03：dashboard 必须随同一次请求返回七领域阶段画像。
 *
 * 旧 `abilities` 是 masteryCode（0—4）聚合，不能拿来当 growthStage（0—6）；
 * 这里锁住两件事：
 *  1. `stageProfile` 来自 StageProfileService，只计算一次；
 *  2. 旧 `abilities` 字段仍然存在，避免破坏头像等级与旧客户端。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StageProfile } from '@alg/shared-contracts';
import { UserController } from '../src/auth/user.controller.ts';

const STAGE_PROFILE: StageProfile = {
  learnerId: 'learner-1',
  stages: {
    listening: 3,
    pronunciation: 0,
    vocabulary: 3,
    grammar: 1,
    speaking: 2,
    communication: 2,
    schoolEnglish: 1,
  },
  stageNodeCounts: {
    listening: 2,
    pronunciation: 0,
    vocabulary: 1,
    grammar: 1,
    speaking: 1,
    communication: 1,
    schoolEnglish: 1,
  },
  evidenceCounts: {
    listening: 8,
    pronunciation: 0,
    vocabulary: 5,
    grammar: 2,
    speaking: 3,
    communication: 2,
    schoolEnglish: 1,
  },
  computedAt: '2026-11-24T00:00:00.000Z',
};

describe('P3-03 dashboard 七领域阶段画像', () => {
  it('同一次 dashboard 返回 stageProfile，且不替换旧 abilities', async () => {
    let stageComputes = 0;
    const auth = {
      resolveSession: async () => ({ id: 'user-1' }),
    };
    const prisma = {
      learner_profiles: {
        findFirst: async () => ({
          id: 'learner-1',
          displayName: '小海',
          entryLevel: 'pre_a1',
          currentTopic: null,
          membershipTier: 'free',
        }),
        findUnique: async () => ({ id: 'learner-1', preferences: null }),
      },
      textbook_mappings: { findFirst: async () => null },
      learner_skill_states: { findMany: async () => [] },
      learning_evidence: { findMany: async () => [] },
      textbook_catalogs: { findMany: async () => [] },
    };
    const warmup = { warmLearnerLevel: () => undefined };
    const stages = {
      compute: async () => {
        stageComputes += 1;
        return STAGE_PROFILE;
      },
    };

    const controller = new UserController(
      auth as never,
      prisma as never,
      warmup as never,
      stages as never,
    );
    const body = await controller.dashboard();

    assert.deepEqual(body.stageProfile, STAGE_PROFILE);
    assert.equal(stageComputes, 1);
    assert.equal(body.abilities.length, 7);
    assert.equal(body.abilities.every((row) => row.stage === 0), true);
    assert.equal(body.learner.id, 'learner-1');
  });

  it('阶段画像失败时降级为 null，不影响 dashboard 的其它字段', async () => {
    const auth = { resolveSession: async () => ({ id: 'user-1' }) };
    const prisma = {
      learner_profiles: {
        findFirst: async () => ({
          id: 'learner-1',
          displayName: '小海',
          entryLevel: 'pre_a1',
          currentTopic: null,
          membershipTier: 'free',
        }),
        findUnique: async () => ({ id: 'learner-1', preferences: null }),
      },
      textbook_mappings: { findFirst: async () => null },
      learner_skill_states: { findMany: async () => [] },
      learning_evidence: { findMany: async () => [] },
      textbook_catalogs: { findMany: async () => [] },
    };
    const warmup = { warmLearnerLevel: () => undefined };
    const stages = {
      compute: async () => {
        throw new Error('stage profile unavailable');
      },
    };

    const controller = new UserController(
      auth as never,
      prisma as never,
      warmup as never,
      stages as never,
    );

    const body = await controller.dashboard();

    assert.equal(body.stageProfile, null);
    assert.equal(body.learner.id, 'learner-1');
    assert.equal(body.abilities.length, 7);
  });
});

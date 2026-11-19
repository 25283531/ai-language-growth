/**
 * P3-01 七领域阶段画像。
 *
 * 重点不是“最高分”，而是七条线互不影响：
 *  - 有 forming 就不看 encountered 的更高阶段；
 *  - 没有 forming 才回退 encountered；
 *  - 学校英语独立成一条线，不混进语言习得；
 *  - 只读聚合，不写 learner_skill_states。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { StageProfileService } from '../src/learner-model/stage-profile.service.ts';
import {
  CurriculumStageAdminController,
  LearnerStageController,
} from '../src/learner-model/stage-profile.controller.ts';

const NODES = [
  { id: 'listen-a', abilityCategory: 'listening', growthStage: 1 },
  { id: 'listen-b', abilityCategory: 'listening', growthStage: 4 },
  { id: 'pron-a', abilityCategory: 'pronunciation', growthStage: 2 },
  { id: 'vocab-a', abilityCategory: 'vocabulary', growthStage: 3 },
  { id: 'gram-a', abilityCategory: 'grammar', growthStage: 4 },
  { id: 'speak-a', abilityCategory: 'speaking', growthStage: 5 },
  { id: 'comm-a', abilityCategory: 'communication', growthStage: 5 },
  { id: 'school-a', abilityCategory: 'school_english', growthStage: 1 },
  { id: 'school-b', abilityCategory: 'school_english', growthStage: 2 },
  { id: 'unknown-a', abilityCategory: 'legacy_unknown', growthStage: 6 },
];

const STATES = [
  { skillNodeId: 'listen-a', masteryCode: 3 },
  // 更高阶段但只接触过：不得盖过已形成的 stage 1。
  { skillNodeId: 'listen-b', masteryCode: 1 },
  { skillNodeId: 'pron-a', masteryCode: 0 },
  { skillNodeId: 'vocab-a', masteryCode: 3 },
  { skillNodeId: 'gram-a', masteryCode: 2 },
  { skillNodeId: 'speak-a', masteryCode: 1 },
  { skillNodeId: 'comm-a', masteryCode: 2 },
  { skillNodeId: 'school-a', masteryCode: 2 },
  { skillNodeId: 'school-b', masteryCode: 2 },
];

const EVIDENCE = [
  { skillNodeId: 'listen-a', _count: { _all: 2 } },
  { skillNodeId: 'vocab-a', _count: { _all: 1 } },
  { skillNodeId: 'school-b', _count: { _all: 4 } },
  { skillNodeId: 'not-in-graph', _count: { _all: 9 } },
];

function fakePrisma() {
  return {
    skill_nodes: { findMany: async () => NODES },
    learner_skill_states: { findMany: async () => STATES },
    learning_evidence: { groupBy: async () => EVIDENCE },
    learner_profiles: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'learner-a' ? { id: 'learner-a' } : null,
    },
  };
}

describe('P3-01 七领域阶段画像', () => {
  it('每个领域独立取 forming 最高阶段，没有 forming 才回退 encountered', async () => {
    const profile = await new StageProfileService(fakePrisma() as never).compute('learner-a');
    assert.deepEqual(profile.stages, {
      listening: 1,
      pronunciation: 0,
      vocabulary: 3,
      grammar: 4,
      speaking: 5,
      communication: 5,
      schoolEnglish: 2,
    });
    assert.match(profile.computedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(profile.learnerId, 'learner-a');
  });

  it('返回当前阶段节点数与证据数，未知分类不进画像', async () => {
    const profile = await new StageProfileService(fakePrisma() as never).compute('learner-a');
    assert.deepEqual(profile.stageNodeCounts, {
      listening: 1,
      pronunciation: 0,
      vocabulary: 1,
      grammar: 1,
      speaking: 1,
      communication: 1,
      schoolEnglish: 1,
    });
    assert.deepEqual(profile.evidenceCounts, {
      listening: 2,
      pronunciation: 0,
      vocabulary: 1,
      grammar: 0,
      speaking: 0,
      communication: 0,
      schoolEnglish: 4,
    });
    assert.equal(Object.hasOwn(profile.stageNodeCounts, 'legacy_unknown'), false);
  });

  it('没有任何状态时七领域都为 0，不伪造阶段', async () => {
    const prisma = fakePrisma();
    prisma.learner_skill_states.findMany = async () => [];
    prisma.learning_evidence.groupBy = async () => [];
    const profile = await new StageProfileService(prisma as never).compute('learner-empty');
    assert.deepEqual(Object.values(profile.stages), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(Object.values(profile.evidenceCounts), [0, 0, 0, 0, 0, 0, 0]);
  });

  it('家长端路由校验归属并返回画像；不存在返回 404', async () => {
    const prisma = fakePrisma();
    const auth = {
      assertLearnerOwnership: async (token: string | undefined, id: string) => {
        if (!token) throw new UnauthorizedException('请先登录');
        if (id !== 'learner-a') throw new ForbiddenException('无权访问');
        return 'user-a';
      },
    };
    const controller = new LearnerStageController(
      prisma as never,
      auth as never,
      new StageProfileService(prisma as never),
    );

    await assert.rejects(
      () => controller.stages('learner-a'),
      (error) => error instanceof UnauthorizedException,
    );
    await assert.rejects(
      () => controller.stages('learner-b', 'Bearer token'),
      (error) => error instanceof ForbiddenException,
    );

    const profile = await controller.stages('learner-a', 'Bearer token');
    assert.equal(profile.stages.communication, 5);
    assert.equal(profile.evidenceCounts.schoolEnglish, 4);
  });

  it('管理端路由先校验管理员会话；没有会话不查库', async () => {
    let queried = false;
    const prisma = {
      ...fakePrisma(),
      learner_profiles: {
        findUnique: async () => {
          queried = true;
          return { id: 'learner-a' };
        },
      },
    };
    const adminAuth = {
      resolveRequest: () => {
        throw new UnauthorizedException('请先登录管理后台');
      },
    };
    const controller = new CurriculumStageAdminController(
      prisma as never,
      adminAuth as never,
      new StageProfileService(prisma as never),
    );
    await assert.rejects(
      () => controller.stages('learner-a'),
      (error) => error instanceof UnauthorizedException,
    );
    assert.equal(queried, false);

    const allowed = new CurriculumStageAdminController(
      prisma as never,
      { resolveRequest: () => 'admin' } as never,
      new StageProfileService(prisma as never),
    );
    assert.equal((await allowed.stages('learner-a')).stages.speaking, 5);
  });

  it('不存在的学习者返回 404', async () => {
    const prisma = fakePrisma();
    const controller = new CurriculumStageAdminController(
      prisma as never,
      { resolveRequest: () => 'admin' } as never,
      new StageProfileService(prisma as never),
    );
    await assert.rejects(
      () => controller.stages('learner-missing'),
      (error) => error instanceof NotFoundException,
    );
  });
});

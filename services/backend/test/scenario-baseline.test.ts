import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVIDENCE_SCENARIOS } from '@alg/shared-contracts';
import {
  findMissingScenarioBaseline,
  type ScenarioBaselinePrisma,
} from '../src/curriculum/scenario-baseline.ts';

function fakePrisma(existingCodes: readonly string[]) {
  const queries: string[][] = [];
  const prisma = {
    scenarios: {
      findMany: async (args: {
        where: { code: { in: string[] } };
        select: { code: true };
      }) => {
        queries.push(args.where.code.in);
        return args.where.code.in
          .filter((code) => existingCodes.includes(code))
          .map((code) => ({ code }));
      },
    },
  } as unknown as ScenarioBaselinePrisma;
  return { prisma, queries };
}

describe('scenarios 基础数据校验', () => {
  it('story_scene 缺失时明确指出，完形证据会因外键失败', async () => {
    const state = fakePrisma(EVIDENCE_SCENARIOS.filter((code) => code !== 'story_scene'));
    const missing = await findMissingScenarioBaseline(state.prisma);
    assert.deepEqual(missing, ['story_scene']);
    assert.deepEqual(state.queries[0], [...EVIDENCE_SCENARIOS]);
  });

  it('共享契约的 8 个场景都存在时通过', async () => {
    const state = fakePrisma(EVIDENCE_SCENARIOS);
    const missing = await findMissingScenarioBaseline(state.prisma);
    assert.deepEqual(missing, []);
  });
});

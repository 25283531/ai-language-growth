/**
 * P3-07：阶段画像与词汇覆盖回归。
 *
 * 阶段部分锁住「七条线独立计算」：发音只有接触、听力已形成时，听力仍按
 * 自身节点取阶段，不能被发音拉低。词汇部分直接验收仓库内 5,000 族数据与
 * 覆盖报告，避免扩容后只更新文档、数据悄悄回退。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { StageProfileService } from '../src/learner-model/stage-profile.service';

type NodeRow = { id: string; abilityCategory: string; growthStage: number };
type StateRow = { skillNodeId: string; masteryCode: number };

async function computeProfile(
  nodes: NodeRow[],
  states: StateRow[],
  evidence: Array<{ skillNodeId: string; count: number }>,
  learnerId = 'learner-1',
) {
  const prisma = {
    skill_nodes: { findMany: async () => nodes },
    learner_skill_states: { findMany: async () => states },
    learning_evidence: {
      groupBy: async () => evidence.map((row) => ({
        skillNodeId: row.skillNodeId,
        _count: { _all: row.count },
      })),
    },
  };
  return new StageProfileService(prisma as never).compute(learnerId);
}

describe('P3-07 阶段画像独立计算', () => {
  it('发音只到接触阶段时，不影响听力/词汇按各自节点取阶段', async () => {
    const profile = await computeProfile(
      [
        { id: 'listen-2', abilityCategory: 'listening', growthStage: 2 },
        { id: 'listen-3', abilityCategory: 'listening', growthStage: 3 },
        { id: 'pron-1', abilityCategory: 'pronunciation', growthStage: 1 },
        { id: 'pron-4', abilityCategory: 'pronunciation', growthStage: 4 },
        { id: 'vocab-3', abilityCategory: 'vocabulary', growthStage: 3 },
        { id: 'gram-2', abilityCategory: 'grammar', growthStage: 2 },
        { id: 'speak-2', abilityCategory: 'speaking', growthStage: 2 },
        { id: 'comm-1', abilityCategory: 'communication', growthStage: 1 },
        { id: 'school-1', abilityCategory: 'school_english', growthStage: 1 },
        { id: 'unknown', abilityCategory: 'not_a_domain', growthStage: 6 },
      ],
      [
        { skillNodeId: 'listen-2', masteryCode: 3 },
        { skillNodeId: 'listen-3', masteryCode: 2 },
        { skillNodeId: 'pron-1', masteryCode: 1 },
        { skillNodeId: 'vocab-3', masteryCode: 2 },
        { skillNodeId: 'gram-2', masteryCode: 4 },
        { skillNodeId: 'speak-2', masteryCode: 0 },
        { skillNodeId: 'comm-1', masteryCode: 2 },
        { skillNodeId: 'school-1', masteryCode: 2 },
      ],
      [
        { skillNodeId: 'listen-2', count: 4 },
        { skillNodeId: 'listen-3', count: 1 },
        { skillNodeId: 'pron-1', count: 2 },
        { skillNodeId: 'vocab-3', count: 3 },
        { skillNodeId: 'gram-2', count: 1 },
        { skillNodeId: 'comm-1', count: 2 },
        { skillNodeId: 'school-1', count: 1 },
        { skillNodeId: 'unknown', count: 99 },
      ],
    );

    assert.deepEqual(profile.stages, {
      listening: 3,
      pronunciation: 1,
      vocabulary: 3,
      grammar: 2,
      speaking: 0,
      communication: 1,
      schoolEnglish: 1,
    });
    assert.equal(profile.stageNodeCounts.listening, 1);
    assert.equal(profile.stageNodeCounts.pronunciation, 1);
    assert.equal(profile.stageNodeCounts.speaking, 0);
    assert.equal(profile.evidenceCounts.listening, 5);
    assert.equal(profile.evidenceCounts.pronunciation, 2);
    assert.equal(profile.evidenceCounts.schoolEnglish, 1);
    assert.equal(profile.learnerId, 'learner-1');
  });

  it('没有学习状态时七领域均为 0，不返回总等级', async () => {
    const profile = await computeProfile(
      [{ id: 'listen-3', abilityCategory: 'listening', growthStage: 3 }],
      [],
      [],
    );
    assert.deepEqual(profile.stages, {
      listening: 0,
      pronunciation: 0,
      vocabulary: 0,
      grammar: 0,
      speaking: 0,
      communication: 0,
      schoolEnglish: 0,
    });
    assert.equal(Object.values(profile.stages).every((stage) => stage === 0), true);
  });
});

describe('P3-07 词汇覆盖数据验收', () => {
  const dataset = JSON.parse(readFileSync(
    resolve(__dirname, '../../../packages/vocabulary/data/lexicon.json'),
    'utf8',
  )) as { entries: Array<{ isCore: boolean; phonetic: string; meaningZh: string; pos: string }> };
  const report = JSON.parse(readFileSync(
    resolve(__dirname, '../../../packages/vocabulary/data/lexicon-coverage.json'),
    'utf8',
  )) as {
    scale: { families: number; core: number; extension: number };
    fields: { core: { phonetic: number; meaning: number; pos: number }; extension: { phonetic: number } };
    coverage: { targets: Array<{ id: string; before: { rate: number }; after: { rate: number } }> };
  };

  it('5,000 族规模与核心层 IPA/释义覆盖达到任务书门槛', () => {
    const core = dataset.entries.filter((entry) => entry.isCore);
    const extension = dataset.entries.filter((entry) => !entry.isCore);
    assert.equal(dataset.entries.length, 5000);
    assert.equal(core.length, 3000);
    assert.equal(extension.length, 2000);
    assert.equal(core.filter((entry) => entry.phonetic).length / core.length >= 0.99, true);
    assert.equal(core.filter((entry) => entry.meaningZh).length, core.length);
    assert.equal(core.filter((entry) => entry.pos).length, core.length);
    assert.equal(extension.filter((entry) => entry.phonetic).length / extension.length >= 0.98, true);
    assert.equal(report.scale.families, 5000);
    assert.equal(report.fields.core.phonetic >= 2990, true);
    assert.equal(report.fields.core.meaning, 3000);
    assert.equal(report.fields.core.pos, 3000);
  });

  it('覆盖报告保留 zk/gk 扩容收益与教材优先词 100% 覆盖', () => {
    const target = (id: string) => report.coverage.targets.find((item) => item.id === id);
    const zk = target('zk');
    const gk = target('gk');
    const textbook = target('textbook-priority');
    assert.ok(zk && gk && textbook);
    assert.equal(zk!.after.rate > zk!.before.rate, true);
    assert.equal(gk!.after.rate > gk!.before.rate, true);
    assert.equal(zk!.after.rate >= 0.97, true);
    assert.equal(gk!.after.rate >= 0.83, true);
    assert.equal(textbook!.after.rate, 1);
  });
});
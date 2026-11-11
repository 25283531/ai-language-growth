import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssessmentThreshold, LearningEvidence } from '@alg/shared-contracts';
import { evaluateMastery, fromCode, resolveEvidenceTargets, SkillGraph, toCode } from '../src/index.ts';

const THRESHOLD: AssessmentThreshold = {
  id: 'th-1',
  taskType: 'word_mimicry',
  scenario: null,
  passScore: 85,
  minSamplesForming: 2,
  minSamplesMastered: 2,
  minScenariosTransferred: 2,
  minIntervalTransferredMs: 86400000,
  source: 'm1_provisional',
  calibrationStatus: 'uncalibrated',
  version: 'm1.1',
  createdAt: '2026-11-07T00:00:00.000Z',
};

const ev = (over: Partial<LearningEvidence>): LearningEvidence => ({
  id: 'e1',
  learnerId: 'child_001',
  lessonSessionId: 'ls1',
  skillNodeId: 'LA.VOCAB.expressive',
  learningItemId: null,
  abilityCategory: 'vocabulary',
  vocabularyDimension: null,
  source: 'task_result',
  taskType: 'image_identification',
  prompted: false,
  independent: true,
  scenario: 'object_pic_scene',
  occurredAt: '2026-11-07T02:00:00.000Z',
  credibility: 0.9,
  contributesToPromotion: true,
  succeeded: true,
  score: 95,
  errorUnits: [],
  note: null,
  thresholdVersion: 'm1.1',
  ruleVersion: 'R1-R7',
  ...over,
});

describe('掌握状态机 R1-R7', () => {
  it('R1：单条证据最多到 encountered，不得跨级', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [ev({ id: 'e1' })],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'encountered');
    assert.notEqual(r.state, 'forming');
  });

  it('R2：有提示的成功计入 forming 但不计独立样本', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [
        ev({ id: 'e1', prompted: true, independent: false }),
        ev({ id: 'e2', prompted: true, independent: false, occurredAt: '2026-11-07T02:01:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'forming');
  });

  it('R3：需要至少 2 条独立成功证据才能 mastered', () => {
    const one = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [ev({ id: 'e1' })],
      threshold: THRESHOLD,
    });
    assert.notEqual(one.state, 'mastered');

    const two = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [
        ev({ id: 'e1' }),
        ev({ id: 'e2', scenario: 'greeting_scene', occurredAt: '2026-11-07T02:01:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(two.state, 'mastered');
  });

  it('R4：同一天同一场景不能到 transferred', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [
        ev({ id: 'e1' }),
        ev({ id: 'e2', occurredAt: '2026-11-07T02:01:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.notEqual(r.state, 'transferred');
  });

  it('R4：两个不同场景 + 跨天无提示回忆才能 transferred', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [
        ev({ id: 'e1', scenario: 'object_pic_scene', occurredAt: '2026-11-05T02:00:00.000Z' }),
        ev({ id: 'e2', scenario: 'greeting_scene', occurredAt: '2026-11-06T02:00:00.000Z' }),
        ev({ id: 'e3', scenario: 'free_chat_scene', occurredAt: '2026-11-07T02:00:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'transferred');
  });

  it('R4：旧证据不能替新场景补足 24 小时间隔', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [
        ev({ id: 'old', scenario: 'object_pic_scene', occurredAt: '2026-09-01T02:00:00.000Z' }),
        ev({ id: 'new-a', scenario: 'greeting_scene', occurredAt: '2026-11-06T02:00:00.000Z' }),
        ev({ id: 'new-b', scenario: 'free_chat_scene', occurredAt: '2026-11-06T12:00:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.notEqual(r.state, 'transferred', '第二个场景成立后不足 24 小时，旧证据不得参与跨天计算');
  });

  it('R4：第 N 个场景成立后跨天回忆才计入 transferred', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [
        ev({ id: 'e1', scenario: 'object_pic_scene', occurredAt: '2026-11-05T02:00:00.000Z' }),
        ev({ id: 'e2', scenario: 'greeting_scene', occurredAt: '2026-11-06T02:00:00.000Z' }),
        ev({ id: 'e3', scenario: 'free_chat_scene', occurredAt: '2026-11-06T20:00:00.000Z' }),
        ev({ id: 'e4', scenario: 'object_pic_scene', occurredAt: '2026-11-07T03:00:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'transferred');
  });

  it('R5：LLM 自我声称不得单独构成晋级依据', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [
        ev({ id: 'e1', source: 'llm_judgement', credibility: 0.4, contributesToPromotion: false }),
        ev({ id: 'e2', source: 'llm_judgement', credibility: 0.4, contributesToPromotion: false, occurredAt: '2026-11-07T02:01:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'not_exposed');
  });

  it('R6：没有回归时，单一场景的历史证据不得把 mastered 降级', () => {
    const r = evaluateMastery({
      currentState: 'mastered',
      evidence: [
        ev({ id: 'e1' }),
        ev({ id: 'e2', occurredAt: '2026-11-07T02:01:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'mastered');
  });

  it('R6：最近一次失败后，同场景成功只能封顶在 forming', () => {
    const r = evaluateMastery({
      currentState: 'mastered',
      evidence: [
        ev({ id: 'e1' }),
        ev({ id: 'e2', occurredAt: '2026-11-07T02:01:00.000Z' }),
        ev({ id: 'fail', occurredAt: '2026-11-07T03:00:00.000Z', succeeded: false, independent: false }),
        ev({ id: 'retry', occurredAt: '2026-11-07T04:00:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'forming');
  });

  it('R6：回归后补齐两个场景 + 跨天无提示回忆才恢复 mastered/transferred', () => {
    const r = evaluateMastery({
      currentState: 'mastered',
      evidence: [
        ev({ id: 'e1', scenario: 'object_pic_scene', occurredAt: '2026-11-05T02:00:00.000Z' }),
        ev({ id: 'e2', scenario: 'greeting_scene', occurredAt: '2026-11-06T02:00:00.000Z' }),
        ev({ id: 'fail', scenario: 'greeting_scene', occurredAt: '2026-11-07T02:00:00.000Z', succeeded: false, independent: false }),
        ev({ id: 'retry-a', scenario: 'object_pic_scene', occurredAt: '2026-11-07T03:00:00.000Z' }),
        ev({ id: 'retry-b', scenario: 'greeting_scene', occurredAt: '2026-11-07T04:00:00.000Z' }),
        ev({ id: 'recall', scenario: 'free_chat_scene', occurredAt: '2026-11-08T05:00:00.000Z' }),
      ],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'transferred');
  });

  it('R7：不做自动遗忘衰减，证据不足时维持原状态', () => {
    const r = evaluateMastery({
      currentState: 'mastered',
      evidence: [],
      threshold: THRESHOLD,
    });
    assert.equal(r.state, 'mastered');
  });

  it('状态编码 0-4 与名称一一对应', () => {
    assert.equal(toCode('not_exposed'), 0);
    assert.equal(toCode('transferred'), 4);
    assert.equal(fromCode(0), 'not_exposed');
    assert.equal(fromCode(4), 'transferred');
  });

  it('状态迁移必须携带证据 id', () => {
    const r = evaluateMastery({
      currentState: 'not_exposed',
      evidence: [ev({ id: 'e1' })],
      threshold: THRESHOLD,
    });
    assert.ok(r.transition);
    assert.ok(r.transition.evidenceIds.length > 0);
  });
});

describe('能力图谱', () => {
  const graph = new SkillGraph();

  it('同一活动的所有能力节点都映射到各自的能力分类', () => {
    assert.deepEqual(
      resolveEvidenceTargets(['LA.SPEAK.imitation', 'LA.PRON.syllable']),
      [
        { skillNodeId: 'LA.SPEAK.imitation', abilityCategory: 'speaking' },
        { skillNodeId: 'LA.PRON.syllable', abilityCategory: 'pronunciation' },
      ],
    );
  });

  it('重复节点只生成一条证据目标，未知节点拒绝写入', () => {
    assert.equal(resolveEvidenceTargets(['LA.SPEAK.imitation', 'LA.SPEAK.imitation']).length, 1);
    assert.throws(() => resolveEvidenceTargets(['LA.UNKNOWN.node']), /Unknown skill node/);
  });

  it('能力节点编码符合 <LA|SE>.<DOMAIN>.<slug> 格式', () => {
    for (const node of graph.allNodes()) {
      assert.match(
        node.code,
        /^(LA|SE)\.(LISTEN|PRON|VOCAB|GRAM|SPEAK|COMM|SCHOOL)\.[a-z0-9_]+$/,
        node.code,
      );
    }
  });

  it('M1 节点全部落在七个成长阶段内', () => {
    for (const node of graph.m1Nodes()) {
      assert.ok(node.growthStage >= 0 && node.growthStage <= 6, node.code);
    }
  });

  it('依赖关系指向存在的节点', () => {
    const ids = new Set(graph.allNodes().map((n) => n.id));
    for (const dep of graph.allDependencies()) {
      assert.ok(ids.has(dep.dependsOnSkillNodeId), dep.dependsOnSkillNodeId);
      assert.ok(ids.has(dep.skillNodeId), dep.skillNodeId);
    }
  });

  it('依赖方向不反向：前置能力的阶段不高于后续能力', () => {
    const stageOf = new Map(graph.allNodes().map((n) => [n.id, n.growthStage]));
    for (const dep of graph.allDependencies()) {
      if (dep.dependencyType !== 'prerequisite') continue;
      const from = stageOf.get(dep.skillNodeId)!;
      const to = stageOf.get(dep.dependsOnSkillNodeId)!;
      assert.ok(
        to <= from,
        `${dep.skillNodeId}(stage ${from}) 依赖了更晚的 ${dep.dependsOnSkillNodeId}(stage ${to})`,
      );
    }
  });

  it('未达成硬前置时判定为阻塞', () => {
    const result = graph.prerequisitesMet('LA.SPEAK.simple_sentences', {});
    assert.equal(result.met, false);
    assert.ok(result.blockedBy.length > 0);
  });

  it('硬前置达成后解锁', () => {
    const states = {
      'LA.SPEAK.single_words': 'mastered',
      'LA.SPEAK.phrases': 'mastered',
    };
    const result = graph.prerequisitesMet('LA.SPEAK.simple_sentences', states);
    assert.equal(result.met, true);
  });

  it('related 与 parallel 永不构成前置门槛（D-002 / D-004）', () => {
    for (const dep of graph.allDependencies()) {
      if (dep.dependencyType === 'related' || dep.dependencyType === 'parallel') {
        assert.equal(dep.required, false, dep.id);
      }
    }
  });
});

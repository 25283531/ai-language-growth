/**
 * P0-3 回归测试：难度档必须按活动自己所属的轨计算。
 *
 * 缺陷：`activityDifficultyBand` 只取 `LA.*` 节点算档，只挂 `SE.SCHOOL.*`
 * 节点的活动恒为难度档 1 —— 学校英语轨学到什么程度都升不上去，
 * 且 difficulty ≥ 2 的 SE 活动会被 applyProgressiveAccess 永久过滤掉，
 * 等于用一条主线锁住另一条（违反 D-002 双轨并行、进度独立）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MasteryState, TeachingActivity } from '@alg/shared-contracts';
import { PlannerService } from '../src/planner/planner.service.ts';

/**
 * 独立重算掌握等级数值，不复用被测代码里的映射表，
 * 避免「测试跟着实现一起错」。
 */
const RANK: Record<MasteryState, number> = {
  not_exposed: 0,
  encountered: 1,
  forming: 2,
  mastered: 3,
  transferred: 4,
};
const rank = (state: MasteryState): number => RANK[state] ?? 0;

type PlannerInternals = {
  activityDifficultyBand(
    activity: TeachingActivity,
    states: Record<string, MasteryState>,
    rank: (state: MasteryState) => number,
  ): number;
  applyProgressiveAccess(
    activities: TeachingActivity[],
    states: Record<string, MasteryState>,
  ): { activities: TeachingActivity[]; difficultyBand: number; freeConversationLocked: boolean };
};

function planner(): PlannerInternals {
  // 只测纯函数式规则，不需要真实 DB / Gateway / Router。
  return new PlannerService({} as never, {} as never, {} as never) as unknown as PlannerInternals;
}

function activity(skillNodeIds: string[], difficulty: number): TeachingActivity {
  return { id: `a-${skillNodeIds.join('_')}-${difficulty}`, skillNodeIds, difficulty } as unknown as TeachingActivity;
}

describe('难度档按活动所属轨计算', () => {
  it('只有 SE 节点的活动，按学校英语轨的掌握等级升档（修复前恒为 1）', () => {
    const seMastered: Record<string, MasteryState> = { 'SE.SCHOOL.letters': 'mastered' };
    assert.equal(
      planner().activityDifficultyBand(activity(['SE.SCHOOL.letters'], 1), seMastered, rank),
      3,
    );
    const seForming: Record<string, MasteryState> = { 'SE.SCHOOL.letters': 'forming' };
    assert.equal(
      planner().activityDifficultyBand(activity(['SE.SCHOOL.letters'], 1), seForming, rank),
      2,
    );
  });

  it('该轨还没有数据时回落到最低档 1，活动仍可排课', () => {
    assert.equal(planner().activityDifficultyBand(activity(['SE.SCHOOL.letters'], 1), {}, rank), 1);
    assert.equal(planner().activityDifficultyBand(activity(['LA.VOCAB.receptive'], 1), {}, rank), 1);
  });

  it('LA 单轨活动的原有语义不变', () => {
    const states: Record<string, MasteryState> = { 'LA.VOCAB.receptive': 'mastered' };
    assert.equal(planner().activityDifficultyBand(activity(['LA.VOCAB.receptive'], 1), states, rank), 3);
    const forming: Record<string, MasteryState> = { 'LA.VOCAB.receptive': 'forming' };
    assert.equal(planner().activityDifficultyBand(activity(['LA.VOCAB.receptive'], 1), forming, rank), 2);
  });

  it('跨轨活动取各轨档位的最大值：一条轨达标就不被另一条拖住', () => {
    const states: Record<string, MasteryState> = {
      'LA.VOCAB.expressive': 'mastered',
      'SE.SCHOOL.word_reading': 'not_exposed',
    };
    assert.equal(
      planner().activityDifficultyBand(
        activity(['LA.VOCAB.expressive', 'SE.SCHOOL.word_reading'], 1),
        states,
        rank,
      ),
      3,
    );
  });

  it('两条轨进度独立：LA 高掌握不会顺带解锁 SE 的难度', () => {
    const states: Record<string, MasteryState> = {
      'LA.LISTEN.greeting_core': 'transferred',
      'LA.SPEAK.simple_sentences': 'mastered',
    };
    assert.equal(planner().activityDifficultyBand(activity(['SE.SCHOOL.letters'], 1), states, rank), 1);
  });

  it('SE 轨达标后，difficulty 2 的 SE 活动不再被 applyProgressiveAccess 过滤', () => {
    const seActivity = activity(['SE.SCHOOL.word_reading'], 2);
    const states: Record<string, MasteryState> = {
      'SE.SCHOOL.letters': 'mastered',
      'SE.SCHOOL.word_reading': 'forming',
    };
    const scoped = planner().applyProgressiveAccess([seActivity], states);
    assert.equal(scoped.activities.length, 1, 'SE 活动不得被单轨逻辑永久过滤');
    assert.equal(scoped.difficultyBand, 2);

    // 同一活动在 SE 轨无数据时按最低档处理：difficulty 2 > 档位 1，暂不开放。
    const locked = planner().applyProgressiveAccess([seActivity], {});
    assert.equal(locked.activities.length, 0);
  });
});

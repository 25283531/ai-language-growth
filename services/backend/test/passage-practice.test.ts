/**
 * P2-08：课文跟读/重点词跟读的证据与复习。
 *
 * 验证两条边界：
 * 1. 只有通过时才排复习，失败仍写证据；
 * 2. 证据必须绑定教材 learning_items 行主键，复习调度也带同一个 id。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PassagePracticeService } from '../src/curriculum/passage-practice.service.ts';

function setup(score: number) {
  const evidence: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const recomputed: string[] = [];
  const prisma = {
    lesson_sessions: {
      findFirst: async () => ({ topicId: 'topic-textbook-u07' }),
    },
    learning_items: {
      findFirst: async () => ({
        id: 'item-s01',
        skillNodeId: 'LA.SPEAK.simple_sentences',
        content: {
          taskType: 'word_mimicry',
          scenario: 'story_scene',
          demonstrationText: 'Last Saturday morning, I helped my mother clean the house.',
          targetWords: ['Last Saturday morning, I helped my mother clean the house.'],
          skillNodeIds: ['LA.SPEAK.simple_sentences'],
        },
      }),
    },
    skill_nodes: {
      findMany: async () => [
        { id: 'LA.SPEAK.simple_sentences', abilityCategory: 'speaking' },
      ],
    },
  };
  const learnerModel = {
    getThreshold: async () => ({ passScore: 80, version: 'pron-v1' }),
    appendEvidence: async (input: Record<string, unknown>) => {
      evidence.push(input);
      return `evidence-${evidence.length}`;
    },
    recomputeState: async (input: { skillNodeId: string }) => {
      recomputed.push(input.skillNodeId);
      return null;
    },
  };
  const planner = {
    scheduleInitialReview: async (input: Record<string, unknown>) => {
      reviews.push(input);
    },
  };
  return {
    service: new PassagePracticeService(prisma as never, learnerModel as never, planner as never),
    evidence,
    reviews,
    recomputed,
    score,
  };
}

describe('课文跟读证据与复习', () => {
  it('通过时写教材证据、重算状态并排指向 learningItemId 的复习', async () => {
    const ctx = setup(92);
    const result = await ctx.service.record({
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      learningItemId: 'item-s01',
      targetText: 'Last Saturday morning, I helped my mother clean the house.',
      score: ctx.score,
      errorUnits: [],
    });

    assert.equal(result.recorded, true);
    assert.equal(result.passed, true);
    assert.equal(result.reviewScheduled, true);
    assert.equal(result.learningItemId, 'item-s01');
    assert.equal(ctx.evidence.length, 1);
    assert.equal(ctx.evidence[0]!.learningItemId, 'item-s01');
    assert.equal(ctx.evidence[0]!.skillNodeId, 'LA.SPEAK.simple_sentences');
    assert.equal(ctx.evidence[0]!.source, 'pronunciation_api');
    assert.equal(ctx.evidence[0]!.succeeded, true);
    assert.equal(ctx.evidence[0]!.independent, true);
    assert.deepEqual(ctx.recomputed, ['LA.SPEAK.simple_sentences']);
    assert.deepEqual(ctx.reviews, [{
      learnerId: 'learner-1',
      skillNodeId: 'LA.SPEAK.simple_sentences',
      learningItemId: 'item-s01',
      now: ctx.reviews[0]!.now,
    }]);
  });

  it('未通过时仍写失败证据，但不排复习', async () => {
    const ctx = setup(55);
    const result = await ctx.service.record({
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      learningItemId: 'item-s01',
      targetText: 'Last Saturday morning, I helped my mother clean the house.',
      score: ctx.score,
      errorUnits: [{ unit: 'mother', kind: 'word', detail: 'th' }],
    });

    assert.equal(result.recorded, true);
    assert.equal(result.passed, false);
    assert.equal(result.reviewScheduled, false);
    assert.equal(ctx.evidence.length, 1);
    assert.equal(ctx.evidence[0]!.succeeded, false);
    assert.equal(ctx.evidence[0]!.independent, false);
    assert.equal(ctx.reviews.length, 0);
  });

  it('跟读文本与教材条目不一致时拒绝写证据', async () => {
    const ctx = setup(90);
    await assert.rejects(
      () => ctx.service.record({
        learnerId: 'learner-1',
        lessonSessionId: 'session-1',
        learningItemId: 'item-s01',
        targetText: 'A different sentence.',
        score: ctx.score,
        errorUnits: [],
      }),
      /跟读文本与教材学习项不一致/,
    );
    assert.equal(ctx.evidence.length, 0);
  });
});

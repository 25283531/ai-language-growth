import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TeachingActivity } from '@alg/shared-contracts';
import { chooseReviewActivity, MAX_REVIEW_INTERVAL_DAYS, nextReviewIntervalDays } from '../src/planner/review-policy.ts';

const activity = (id: string, scenario: string, order: number): TeachingActivity => ({
  id,
  topicId: 'topic-test',
  taskType: 'image_identification',
  scenario: scenario as TeachingActivity['scenario'],
  skillNodeIds: ['LA.LISTEN.word_recognition'],
  targetWords: ['apple'],
  demonstrationText: null,
  teacherUtteranceZh: '点出苹果。',
  requiresPronunciationAssessment: false,
  requiresAsr: false,
  difficulty: 1,
  order,
  m1Scope: true,
});

describe('adaptive review policy', () => {
  it('starts with a one-day schedule and doubles after each successful recall', () => {
    assert.equal(nextReviewIntervalDays(0, false), 1);
    assert.equal(nextReviewIntervalDays(0, true), 2);
    assert.equal(nextReviewIntervalDays(1, true), 4);
  });

  it('resets the interval after a failed recall and caps stable intervals at 30 days', () => {
    assert.equal(nextReviewIntervalDays(8, false), 1);
    assert.equal(nextReviewIntervalDays(10, true), MAX_REVIEW_INTERVAL_DAYS);
  });

  it('prefers a different, least-used scenario for the next review', () => {
    const same = activity('same', 'object_pic_scene', 1);
    const alternate = activity('alternate', 'object_shop_scene', 2);
    const leastUsed = activity('least-used', 'story_scene', 3);
    assert.equal(chooseReviewActivity([same, alternate, leastUsed], [
      'object_pic_scene', 'object_pic_scene', 'object_shop_scene',
    ])?.id, 'least-used');
  });

  it('returns no candidate when a skill has no review activity', () => {
    assert.equal(chooseReviewActivity([], []), undefined);
  });
});

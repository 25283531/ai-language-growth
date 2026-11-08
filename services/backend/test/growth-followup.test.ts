import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectFollowUpSkillNodeIds } from '../src/planner/growth-followup.ts';

describe('cross-lesson follow-up selection', () => {
  it('prioritizes unresolved skills and excludes balanced or successful skills', () => {
    assert.deepEqual(selectFollowUpSkillNodeIds([
      { skillNodeId: 'balanced', unsuccessfulAttempts: 2, independentSuccesses: 2 },
      { skillNodeId: 'needs-work', unsuccessfulAttempts: 3, independentSuccesses: 1 },
      { skillNodeId: 'stronger-gap', unsuccessfulAttempts: 4, independentSuccesses: 0 },
      { skillNodeId: 'successful', unsuccessfulAttempts: 0, independentSuccesses: 2 },
    ]), ['stronger-gap', 'needs-work']);
  });

  it('caps the follow-up list and removes repeated skill ids', () => {
    assert.deepEqual(selectFollowUpSkillNodeIds([
      { skillNodeId: 'first', unsuccessfulAttempts: 4, independentSuccesses: 0 },
      { skillNodeId: 'first', unsuccessfulAttempts: 3, independentSuccesses: 0 },
      { skillNodeId: 'second', unsuccessfulAttempts: 2, independentSuccesses: 0 },
      { skillNodeId: 'third', unsuccessfulAttempts: 1, independentSuccesses: 0 },
    ], 2), ['first', 'second']);
  });
});

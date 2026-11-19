import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evidenceKindForActivity } from '../src/orchestrator/orchestrator.service.ts';

describe('evidenceKindForActivity', () => {
  it('显式声明优先，便于翻译/被动听读标 none', () => {
    assert.equal(evidenceKindForActivity({ taskType: 'word_mimicry', evidenceKind: 'none' }), 'none');
    assert.equal(evidenceKindForActivity({ taskType: 'reading_story', evidenceKind: 'transfer' }), 'transfer');
  });

  it('未声明时按任务保守推断，理解与表达分开', () => {
    assert.equal(evidenceKindForActivity({ taskType: 'listening_comprehension' }), 'listening_comprehension');
    assert.equal(evidenceKindForActivity({ taskType: 'image_identification' }), 'listening_comprehension');
    assert.equal(evidenceKindForActivity({ taskType: 'reading_story' }), 'reading_comprehension');
    assert.equal(evidenceKindForActivity({ taskType: 'word_mimicry' }), 'pronunciation');
    assert.equal(evidenceKindForActivity({ taskType: 'sentence_pattern' }), 'production');
    assert.equal(evidenceKindForActivity({ taskType: 'free_response' }), 'production');
    assert.equal(evidenceKindForActivity({ taskType: 'unknown' }), 'none');
    assert.equal(evidenceKindForActivity({ taskType: null }), 'none');
  });
});

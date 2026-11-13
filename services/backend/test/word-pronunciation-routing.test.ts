import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldAssessWordPronunciationForActivity } from '../src/orchestrator/word-pronunciation.ts';

const imageActivity = {
  taskType: 'image_identification',
  targetWords: ['hello'],
  requiresPronunciationAssessment: false,
};

describe('word pronunciation assessment routing', () => {
  it('assesses a spoken target word on an image activity without an image selection', () => {
    assert.equal(shouldAssessWordPronunciationForActivity({
      activity: imageActivity,
      response: { audioRef: 'data:audio/mp4;base64,AAAA' },
    }), true);
  });

  it('keeps image selection on the deterministic image-answer path', () => {
    assert.equal(shouldAssessWordPronunciationForActivity({
      activity: imageActivity,
      response: { audioRef: 'data:audio/mp4;base64,AAAA', selectedImageId: 'img-hello' },
    }), false);
  });

  it('does not turn sentence or multi-word activities into word pronunciation drills', () => {
    assert.equal(shouldAssessWordPronunciationForActivity({
      activity: { taskType: 'sentence_pattern', targetWords: ['hello'], requiresPronunciationAssessment: false },
      response: { audioRef: 'data:audio/mp4;base64,AAAA' },
    }), false);
    assert.equal(shouldAssessWordPronunciationForActivity({
      activity: { taskType: 'image_identification', targetWords: ['hello', 'hi'], requiresPronunciationAssessment: false },
      response: { audioRef: 'data:audio/mp4;base64,AAAA' },
    }), false);
  });

  it('always assesses explicit pronunciation activities', () => {
    assert.equal(shouldAssessWordPronunciationForActivity({
      activity: { taskType: 'word_mimicry', targetWords: ['hello'], requiresPronunciationAssessment: true },
      response: { audioRef: 'data:audio/mp4;base64,AAAA' },
    }), true);
  });
});

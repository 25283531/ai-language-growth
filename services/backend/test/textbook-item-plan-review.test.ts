import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textbookUnitContentSchema } from '@alg/shared-contracts';
import { derivedTextbookActivities } from '../src/curriculum/textbook-item-plan.ts';

const content = textbookUnitContentSchema.parse({
  resourceType: 'textbook_unit',
  textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
  unit: { code: 'Unit 3', title: 'My Family', order: 3 },
  objectives: ['能朗读课文'],
  passage: {
    title: 'My Family',
    paragraphs: [{
      sentences: [
        { id: 'Unit-3-s01', en: 'This is my family.', zh: '这是我的家庭。', keyWords: ['family'] },
      ],
    }],
  },
  grammarPoints: [],
  vocabulary: [{ word: 'family', phonetic: '/ˈfæməli/', meaningZh: '家庭', syllables: ['fam', 'i', 'ly'] }],
  activities: [{
    id: 'Unit-3-a01',
    title: '读一读',
    taskType: 'word_mimicry',
    scenario: 'story_scene',
    skillNodeIds: ['LA.SPEAK.simple_sentences'],
    targetWords: ['family'],
    teacherUtteranceZh: '跟老师读 family。',
    demonstrationText: 'family',
    requiresPronunciationAssessment: true,
    requiresAsr: false,
    evidenceKind: 'pronunciation',
    assessment: { acceptedImageIds: [], acceptedTexts: ['family'], requiredPhrases: [], openResponse: false },
    difficulty: 1,
    imageRequirements: [],
    media: { speechKey: 'Unit-3-a01', speechText: '跟老师读 family。 family', imageKeys: [] },
  }],
});

describe('教材派生跟读条目', () => {
  it('逐句跟读带 reviewMode=read_aloud，复习轮不会被清空目标文本', () => {
    const derived = derivedTextbookActivities(content, [{ skillNodeIds: ['LA.SPEAK.simple_sentences'] }]);
    const sentence = derived.find((activity) => activity.id === 'Unit-3-s01');
    assert.ok(sentence);
    assert.equal(sentence!.taskType, 'word_mimicry');
    assert.equal(sentence!.reviewMode, 'read_aloud');
    assert.deepEqual(sentence!.targetWords, ['This is my family.']);
    assert.equal(sentence!.demonstrationText, 'This is my family.');
  });

  it('重点词跟读同样带 reviewMode=read_aloud', () => {
    const derived = derivedTextbookActivities(content, [{ skillNodeIds: ['LA.SPEAK.simple_sentences'] }]);
    const word = derived.find((activity) => activity.taskType === 'pronunciation_drill');
    assert.ok(word, '应至少派生一个重点词跟读条目');
    assert.equal(word!.reviewMode, 'read_aloud');
    assert.deepEqual(word!.targetWords, ['family']);
  });
});

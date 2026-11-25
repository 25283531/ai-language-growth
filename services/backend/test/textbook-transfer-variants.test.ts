/**
 * P4-06 回归：教材单元必须为关键项提供至少两个不同场景。
 *
 * 掌握规则 R4（`packages/skill-graph/src/mastery.ts`）要求「两个以上不同场景
 * 独立使用」；如果教材生成的所有跟读都在 story_scene，孩子读得再对也拿不到
 * 迁移证据。这里锁住三件事：
 *  1. 原活动与变体共享 `transferScenarioKey`；
 *  2. 同一键下至少出现两个不同 `scenario`；
 *  3. 变体不引入课文/词表之外的新词。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textbookUnitContentSchema } from '@alg/shared-contracts';
import { derivedTextbookActivities, buildTransferActivities } from '../src/curriculum/textbook-item-plan.ts';

function buildContent() {
  return textbookUnitContentSchema.parse({
    resourceType: 'textbook_unit',
    textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
    unit: { code: 'U03', title: 'My Family', order: 3 },
    objectives: ['能介绍家庭成员', '能听懂并跟读课文'],
    passage: {
      title: 'My Family',
      paragraphs: [{
        sentences: [
          { id: 'u03-s01', en: 'This is my family.', zh: '这是我的家庭。', keyWords: ['family'] },
          { id: 'u03-s02', en: 'I love my mother.', zh: '我爱我的妈妈。', keyWords: ['mother'] },
        ],
      }],
    },
    grammarPoints: [{
      id: 'g1',
      pattern: 'This is my + 名词.',
      titleZh: '介绍自己的家人',
      explanationZh: 'this 指离自己近的人；my 表示“我的”。',
      examples: [{ en: 'This is my father.', zh: '这是我爸爸。' }],
      sentenceIds: ['u03-s01'],
    }],
    vocabulary: [
      {
        word: 'family',
        phonetic: 'ˈfæməli',
        meaningZh: '家庭',
        syllables: ['fam', 'i', 'ly'],
        difficultPhonemes: [],
        phrases: [],
        exampleSentences: [],
      },
      {
        word: 'mother',
        phonetic: 'ˈmʌðə',
        meaningZh: '妈妈',
        syllables: ['moth', 'er'],
        difficultPhonemes: ['ð'],
        phrases: [],
        exampleSentences: [],
      },
    ],
    activities: [{
      id: 'u03-a01',
      title: '朗读课文：My Family',
      taskType: 'reading_story',
      scenario: 'story_scene',
      skillNodeIds: ['LA.LISTEN.word_recognition'],
      targetWords: ['family'],
      teacherUtteranceZh: '先听老师读一遍课文。',
      demonstrationText: 'This is my family.',
      requiresPronunciationAssessment: false,
      requiresAsr: false,
      evidenceKind: 'none',
      passiveReading: true,
      assessment: {
        acceptedImageIds: [],
        acceptedTexts: [],
        requiredPhrases: [],
        openResponse: false,
      },
      difficulty: 1,
      imageRequirements: [],
      media: {
        speechKey: 'u03-a01',
        speechText: '先听老师读一遍课文。 This is my family.',
        imageKeys: [],
      },
    }, {
      id: 'u03-a02',
      title: '句型练习：介绍自己的家人',
      taskType: 'sentence_pattern',
      scenario: 'story_scene',
      skillNodeIds: ['LA.SPEAK.simple_sentences', 'LA.GRAM.basic_pattern'],
      targetWords: ['family'],
      transferScenarioKey: 'tp-g1',
      teacherUtteranceZh: '试着用“This is my + 名词.”说一句自己的话。',
      demonstrationText: 'This is my father.',
      requiresPronunciationAssessment: false,
      requiresAsr: true,
      evidenceKind: 'production',
      assessment: {
        acceptedImageIds: [],
        acceptedTexts: ['This is my father.'],
        requiredPhrases: [],
        openResponse: false,
      },
      difficulty: 2,
      imageRequirements: [],
      media: {
        speechKey: 'u03-a02',
        speechText: '试着用这个句型说一句自己的话。 This is my father.',
        imageKeys: [],
      },
    }],
    stageHint: 1,
  });
}

describe('P4-06 教材跨场景迁移变体', () => {
  it('为句型与重点词生成第二个场景，且不新增词', () => {
    const content = buildContent();
    const transfer = buildTransferActivities(content, content.activities);

    assert.equal(transfer.length, 3, '一个句型变体 + 两个重点词变体');
    const allowedWords = new Set(content.vocabulary.map((entry) => entry.word.toLowerCase()));
    for (const activity of transfer) {
      assert.equal(activity.evidenceKind, 'transfer');
      assert.ok(activity.transferScenarioKey, '迁移活动必须带 transferScenarioKey');
      for (const word of activity.targetWords) {
        assert.ok(allowedWords.has(word.toLowerCase()), `不得引入词表外的词：${word}`);
      }
    }
  });

  it('同一 transferScenarioKey 下出现两个不同场景', () => {
    const content = buildContent();
    // 发布时是「派生条目 + 人工条目」一起落库，这里按同样口径合并。
    const all = [...derivedTextbookActivities(content, content.activities), ...content.activities];

    const byKey = new Map<string, Set<string>>();
    for (const activity of all) {
      if (!activity.transferScenarioKey) continue;
      const scenarios = byKey.get(activity.transferScenarioKey) ?? new Set<string>();
      scenarios.add(activity.scenario);
      byKey.set(activity.transferScenarioKey, scenarios);
    }

    assert.deepEqual([...byKey.keys()].sort(), ['tp-g1', 'tw-family', 'tw-mother']);
    for (const [key, scenarios] of byKey) {
      assert.ok(scenarios.size >= 2, `${key} 只有一个场景：${[...scenarios].join(',')}`);
    }
  });

  it('原句型活动与商店场景变体共享 tp-g1，场景不同', () => {
    const content = buildContent();
    const all = derivedTextbookActivities(content, content.activities);
    const original = content.activities.find((activity) => activity.taskType === 'sentence_pattern');
    const variant = all.find((activity) => activity.id === 'U03-x01');

    assert.ok(original);
    assert.ok(variant);
    assert.equal(original!.transferScenarioKey, 'tp-g1');
    assert.equal(variant!.transferScenarioKey, 'tp-g1');
    assert.equal(original!.scenario, 'story_scene');
    assert.equal(variant!.scenario, 'object_shop_scene');
  });

  it('重点词原活动与图片场景变体共享词级键，且活动 id 唯一', () => {
    const content = buildContent();
    const all = derivedTextbookActivities(content, content.activities);
    const ids = all.map((activity) => activity.id);
    assert.equal(new Set(ids).size, ids.length, '活动 id 必须唯一');

    const familyOriginal = all.find((activity) =>
      activity.taskType === 'pronunciation_drill' && activity.targetWords.includes('family'));
    const familyVariant = all.find((activity) =>
      activity.taskType === 'word_mimicry' && activity.targetWords.includes('family'));
    assert.ok(familyOriginal);
    assert.ok(familyVariant);
    assert.equal(familyOriginal!.transferScenarioKey, 'tw-family');
    assert.equal(familyVariant!.transferScenarioKey, 'tw-family');
    assert.notEqual(familyOriginal!.scenario, familyVariant!.scenario);
    assert.deepEqual(familyVariant!.targetWords, ['family']);
  });

  it('没有语法点时仍生成重点词变体', () => {
    const content = buildContent();
    content.grammarPoints = [];
    const transfer = buildTransferActivities(content, content.activities);

    assert.equal(transfer.length, 2);
    assert.ok(transfer.every((activity) => activity.scenario === 'object_pic_scene'));
  });
});

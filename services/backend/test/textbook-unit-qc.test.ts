import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  textbookUnitContentSchema,
  type TextbookUnitContent,
} from '@alg/shared-contracts';
import { validateTextbookUnitContent } from '../src/curriculum/textbook-unit-qc';

function baseContent(): TextbookUnitContent {
  return textbookUnitContentSchema.parse({
    resourceType: 'textbook_unit',
    textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
    unit: { code: 'Unit 3', title: 'My Family', order: 3 },
    objectives: ['能听懂并朗读课文', '能认读家庭成员词'],
    passage: {
      title: 'My Family',
      paragraphs: [{
        sentences: [
          { id: 'Unit-3-s01', en: 'This is my family.', zh: '这是我的家庭。' },
          { id: 'Unit-3-s02', en: 'This is my mother.', zh: '这是我的妈妈。' },
        ],
      }],
    },
    grammarPoints: [{
      id: 'g01',
      pattern: 'This is my ...',
      titleZh: '介绍家庭成员',
      explanationZh: '用 This is my ... 介绍家人。',
      examples: [{ en: 'This is my family.', zh: '这是我的家庭。' }],
      commonErrorZh: 'my 后面直接跟名词。',
      sentenceIds: ['Unit-3-s01'],
    }],
    vocabulary: [
      { word: 'family', phonetic: '/ˈfæməli/', meaningZh: '家庭', syllables: ['fam', 'i', 'ly'] },
      { word: 'mother', phonetic: '/ˈmʌðə/', meaningZh: '妈妈', syllables: ['moth', 'er'] },
    ],
    activities: [{
      id: 'Unit-3-a01',
      title: '朗读课文',
      taskType: 'reading_story',
      scenario: 'story_scene',
      skillNodeIds: ['LA.LISTEN.word_recognition', 'SE.SCHOOL.reading'],
      targetWords: ['family'],
      teacherUtteranceZh: '先听老师读一遍课文。',
      demonstrationText: 'This is my family.',
      requiresPronunciationAssessment: false,
      requiresAsr: false,
      evidenceKind: 'none',
      passiveReading: true,
      assessment: { acceptedImageIds: [], acceptedTexts: [], requiredPhrases: [], openResponse: false },
      difficulty: 1,
      media: { speechKey: 'Unit-3-a01', speechText: '先听老师读一遍课文。 This is my family.' },
    }],
    qcReport: { needsReview: false, issues: [] },
  });
}

function errorsOf(content: TextbookUnitContent, options: Parameters<typeof validateTextbookUnitContent>[1] = {}) {
  return validateTextbookUnitContent(content, {
    grammarFocus: ['This is my ...'],
    knownSkillCodes: new Set([
      'LA.LISTEN.word_recognition',
      'SE.SCHOOL.reading',
    ]),
    ...options,
  }).errors.map((issue) => issue.code);
}

describe('教材单元自动校验', () => {
  it('完整内容通过，统计句子/词条/活动/语法点', () => {
    const result = validateTextbookUnitContent(baseContent(), {
      grammarFocus: ['This is my ...'],
      knownSkillCodes: new Set(['LA.LISTEN.word_recognition', 'SE.SCHOOL.reading']),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.stats.sentences, 2);
    assert.equal(result.stats.vocabulary, 2);
    assert.equal(result.stats.phonetic, 2);
    assert.equal(result.stats.meaning, 2);
    assert.equal(result.stats.activities, 1);
    assert.equal(result.stats.grammarPoints, 1);
  });

  it('占位译文、空译文、纯英文中文栏都拒绝', () => {
    const placeholder = baseContent();
    placeholder.passage.paragraphs[0]!.sentences[0]!.zh = '（第 1 句译文待补充）';
    assert.ok(errorsOf(placeholder).includes('sentence_zh_placeholder'));

    const english = baseContent();
    english.passage.paragraphs[0]!.sentences[0]!.zh = 'This is my family';
    assert.ok(errorsOf(english).includes('sentence_zh_not_chinese'));
  });

  it('句子 ID 重复拒绝', () => {
    const content = baseContent();
    content.passage.paragraphs[0]!.sentences[1]!.id = 'Unit-3-s01';
    assert.ok(errorsOf(content).includes('sentence_id_duplicate'));
  });

  it('音标覆盖率 <98% 与释义缺失拒绝', () => {
    const content = baseContent();
    content.vocabulary = [
      { ...content.vocabulary[0]!, word: 'family', phonetic: '' },
      { ...content.vocabulary[1]!, word: 'mother', phonetic: '/ˈmʌðə/' },
    ];
    assert.ok(errorsOf(content).includes('phonetic_coverage_low'));

    const meaning = baseContent();
    meaning.vocabulary[0]!.meaningZh = '';
    assert.ok(errorsOf(meaning).includes('vocabulary_meaning_empty'));
  });

  it('教师话语超过 150 汉字或 500 字符拒绝', () => {
    const content = baseContent();
    content.activities[0]!.teacherUtteranceZh = '读'.repeat(151);
    assert.ok(errorsOf(content).includes('activity_speech_too_long'));
  });

  it('活动没有可判定评估规则时拒绝；passiveReading=true 例外', () => {
    const content = baseContent();
    content.activities[0] = {
      ...content.activities[0]!,
      taskType: 'sentence_pattern',
      requiresAsr: true,
      evidenceKind: 'production',
      passiveReading: false,
      assessment: { acceptedImageIds: [], acceptedTexts: [], requiredPhrases: [], openResponse: false },
    };
    assert.ok(errorsOf(content).includes('activity_assessment_unjudgeable'));

    content.activities[0] = {
      ...content.activities[0]!,
      evidenceKind: 'none',
      passiveReading: true,
    };
    assert.ok(!errorsOf(content).includes('activity_assessment_unjudgeable'));
  });

  it('缺少课文活动、缺语法点、未知能力节点、缺 evidenceKind 都拒绝', () => {
    const noPassage = baseContent();
    noPassage.activities[0] = {
      ...noPassage.activities[0]!,
      taskType: 'sentence_pattern',
      demonstrationText: 'Hello.',
      evidenceKind: 'production',
      passiveReading: false,
      requiresAsr: true,
      assessment: { acceptedImageIds: [], acceptedTexts: ['Hello.'], requiredPhrases: [], openResponse: false },
    };
    assert.ok(errorsOf(noPassage).includes('passage_activity_missing'));

    const noGrammar = baseContent();
    noGrammar.grammarPoints = [];
    assert.ok(errorsOf(noGrammar).includes('grammar_point_missing'));

    const unknownSkill = baseContent();
    unknownSkill.activities[0]!.skillNodeIds = ['LA.NOT.real'];
    assert.ok(errorsOf(unknownSkill).includes('activity_skill_node_unknown'));

    const noEvidence = baseContent();
    delete (noEvidence.activities[0] as { evidenceKind?: string }).evidenceKind;
    assert.ok(errorsOf(noEvidence).includes('activity_evidence_kind_missing'));
  });

  it('学校轨声明后每个模块必须有活动、活动必须有模块与能力节点', () => {
    const content = baseContent();
    content.schoolTrack = {
      modules: ['A', 'C'],
      activities: [{
        ...baseContent().activities[0]!,
        id: 'Unit-3-sch01',
        skillNodeIds: ['SE.SCHOOL.reading'],
        evidenceKind: 'reading_comprehension',
        passiveReading: false,
        assessment: { acceptedImageIds: [], acceptedTexts: ['family'], requiredPhrases: [], openResponse: false },
      }],
    };
    const errors = errorsOf(content);
    assert.ok(errors.includes('school_activity_module_missing'));
    assert.ok(errors.includes('school_module_no_activity'));
  });

  it('图片必须 HTTPS + license，敏感内容拒绝', () => {
    const content = baseContent();
    content.vocabulary[0]!.imageAsset = { url: 'http://example.com/family.png', license: '' };
    const errors = errorsOf(content);
    assert.ok(errors.includes('image_url_not_https'));
    assert.ok(errors.includes('image_license_missing'));

    const sensitive = baseContent();
    sensitive.passage.paragraphs[0]!.sentences[0]!.en = 'This is a bomb.';
    assert.ok(errorsOf(sensitive).includes('sensitive_content'));
  });

  it('生成阶段问题进入警告而不是静默丢失', () => {
    const result = validateTextbookUnitContent(baseContent(), {
      grammarFocus: ['This is my ...'],
      knownSkillCodes: new Set(['LA.LISTEN.word_recognition', 'SE.SCHOOL.reading']),
      generationIssues: [{ code: 'activities_fallback', path: 'activities', message: '模型不可用' }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((issue) => issue.code === 'generation_activities_fallback'));
  });
});

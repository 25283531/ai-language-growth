import assert from 'node:assert/strict';
import test from 'node:test';
import {
  curriculumPassageSchema,
  passageSentenceSchema,
  teachingDirectiveSchema,
  textbookUnitContentSchema,
} from '../src';

const lesson = {
  id: 'u03-a01',
  title: '跟读 hello',
  taskType: 'word_mimicry',
  scenario: 'greeting_scene',
  skillNodeIds: ['LA.SPEAK.imitation'],
  targetWords: ['hello'],
  teacherUtteranceZh: '跟老师读 hello。',
  demonstrationText: 'hello',
  requiresPronunciationAssessment: true,
  requiresAsr: false,
  assessment: { acceptedTexts: ['hello'] },
  difficulty: 1,
  media: { speechKey: 'u03-a01', speechText: '跟老师读 hello。hello' },
};

const unit = {
  resourceType: 'textbook_unit',
  textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
  unit: { code: 'u03', title: 'My Family', order: 3 },
  objectives: ['能介绍家庭成员'],
  passage: {
    title: 'My Family',
    paragraphs: [{
      sentences: [
        { id: 'u03-s01', en: 'This is my family.', zh: '这是我的家庭。' },
        {
          id: 'u03-s02',
          en: 'This is my father. This is my mother.',
          zh: '这是我爸爸。这是我妈妈。',
          splitFrom: 'u03-s02',
        },
      ],
    }],
  },
  grammarPoints: [{
    id: 'g1',
    pattern: 'This is my + 名词.',
    titleZh: '介绍家人',
    explanationZh: 'this 指离自己近的人。',
    examples: [{ en: 'This is my father.', zh: '这是我爸爸。' }],
  }],
  vocabulary: [{ word: 'family', phonetic: '/ˈfæməli/', meaningZh: '家庭' }],
  activities: [lesson],
};

test('textbookUnitContentSchema 接受完整教材单元并填充默认值', () => {
  const parsed = textbookUnitContentSchema.parse(unit);
  assert.equal(parsed.passage.paragraphs[0]!.sentences[0]!.keyWords.length, 0);
  assert.deepEqual(parsed.passage.paragraphs[0]!.sentences[0]!.schoolModules, []);
  assert.equal(parsed.passage.paragraphs[0]!.sentences[1]!.splitFrom, 'u03-s02');
  assert.equal(parsed.grammarPoints[0]!.commonErrorZh, '');
  assert.deepEqual(parsed.schoolTrack?.modules ?? [], []);
});

test('textbookUnitContentSchema 拒绝空译文和空活动列表', () => {
  const emptyZh = structuredClone(unit);
  emptyZh.passage.paragraphs[0]!.sentences[0]!.zh = '';
  assert.equal(textbookUnitContentSchema.safeParse(emptyZh).success, false);

  const noActivities = structuredClone(unit);
  noActivities.activities = [];
  assert.equal(textbookUnitContentSchema.safeParse(noActivities).success, false);
});

test('passageSentenceSchema 限制单句长度并接受可选音频字段', () => {
  const parsed = passageSentenceSchema.parse({
    id: 'u03-s01',
    en: 'Hello.',
    zh: '你好。',
    audio: {
      normalKey: 'u03-s01:1.0',
      slowKey: 'u03-s01:0.65',
      normalRef: '/api/v1/media/audio/n.mp3',
      slowRef: '/api/v1/media/audio/s.mp3',
      normalSpeed: 1,
      slowSpeed: 0.65,
      slowDurationMs: 1200,
    },
  });
  assert.equal(parsed.audio?.slowKey, 'u03-s01:0.65');
  assert.equal(parsed.audio?.normalRef, '/api/v1/media/audio/n.mp3');
  assert.equal(parsed.audio?.slowSpeed, 0.65);
  assert.equal(passageSentenceSchema.safeParse({
    id: 'u03-s01',
    en: 'x'.repeat(501),
    zh: '超长',
  }).success, false);
});

test('curriculumPassageSchema 接受逐句双速与重点词拆读，并限制最多 4 个重点词', () => {
  const passage = {
    unitId: 'unit-1',
    topicId: 'topic-1',
    contentVersion: 'v1',
    audioReady: true,
    title: 'My Family',
    paragraphs: [{
      sentences: [{
        id: 'u03-s01',
        en: 'This is my father.',
        zh: '这是我的爸爸。',
        audio: { normalKey: 'sentence:u03-s01:normal', slowKey: 'sentence:u03-s01:slow' },
      }],
    }],
    focusWords: [{
      word: 'father',
      phonetic: '/ˈfɑːðər/',
      meaningZh: '爸爸',
      syllables: ['fa', 'ther'],
      difficultPhonemes: ['ð'],
      clips: [{
        key: 'word:father:word:0:slow',
        kind: 'word',
        partIndex: 0,
        position: 0,
        speedTier: 'slow',
        speed: 0.65,
        text: 'father',
        audioRef: '/api/v1/media/audio/w.mp3',
        status: 'ready',
      }],
    }],
  };
  const parsed = curriculumPassageSchema.parse(passage);
  assert.equal(parsed.focusWords[0]!.clips[0]!.kind, 'word');
  assert.equal(parsed.focusWords[0]!.clips[0]!.status, 'ready');
  const tooMany = structuredClone(passage);
  tooMany.focusWords = Array.from({ length: 5 }, () => passage.focusWords[0]!);
  assert.equal(curriculumPassageSchema.safeParse(tooMany).success, false);
});

test('teachingDirectiveSchema 的 evidenceKind 默认 none，避免无证据活动误记掌握', () => {
  const parsed = teachingDirectiveSchema.parse({
    targetSkillNodeId: 'LA.LISTEN.greeting_core',
    taskType: 'reading_story',
    scenario: 'story_scene',
    teacherUtterance: '听老师读。',
    expectedResponse: 'listen',
    voice: {},
  });
  assert.equal(parsed.evidenceKind, 'none');
  assert.equal(teachingDirectiveSchema.parse({ ...parsed, evidenceKind: 'reading_comprehension' }).evidenceKind, 'reading_comprehension');
});

test('活动契约接受跨场景迁移键，空串被拒绝', () => {
  const parsed = textbookUnitContentSchema.parse({
    ...unit,
    activities: [{
      ...lesson,
      evidenceKind: 'transfer',
      transferScenarioKey: 'tw-family',
    }],
  });
  assert.equal(parsed.activities[0]!.transferScenarioKey, 'tw-family');
  assert.equal(parsed.activities[0]!.evidenceKind, 'transfer');

  const empty = { ...unit, activities: [{ ...lesson, transferScenarioKey: '' }] };
  assert.equal(textbookUnitContentSchema.safeParse(empty).success, false);
});

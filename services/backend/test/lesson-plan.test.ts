/**
 * P4-05：教师用教案导出。
 *
 * 锁住三件事：
 *  1. 教案正文来自单元资源包，含目标、课时、重点句、重点词、语法、活动与易错点；
 *  2. 导出是确定性的，不调用模型、不读学习者数据；
 *  3. 管理端接口在未生成内容时返回 404，`format=md` 返回 Markdown 附件。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  textbookUnitContentSchema,
  type TextbookUnitContent,
} from '@alg/shared-contracts';
import {
  buildLessonPlanExport,
  estimateSessions,
  lessonPlanFilename,
  renderLessonPlanMarkdown,
} from '../src/curriculum/lesson-plan';
import { CurriculumAdminController } from '../src/curriculum/curriculum-admin.controller';

const unitId = '33333333-3333-4333-8333-333333333333';
const curriculumUnitId = '44444444-4444-4444-8444-444444444444';

function fixture(overrides: Partial<TextbookUnitContent> = {}): TextbookUnitContent {
  const base = textbookUnitContentSchema.parse({
    resourceType: 'textbook_unit',
    textbook: { publisher: '人教版', grade: '三年级', volume: '上册', edition: '2024' },
    unit: { code: 'Unit 3', title: 'My Family', order: 3 },
    objectives: ['能听懂并朗读课文', '能认读家庭成员词'],
    passage: {
      title: 'My Family',
      paragraphs: [{
        sentences: [
          { id: 'Unit-3-s01', en: 'This is my family.', zh: '这是我的家庭。', keyWords: ['family'] },
          { id: 'Unit-3-s02', en: 'This is my mother.', zh: '这是我的妈妈。', keyWords: ['mother'] },
        ],
      }],
    },
    grammarPoints: [{
      id: 'g01',
      pattern: 'This is my ...',
      titleZh: '介绍家庭成员',
      explanationZh: '用 This is my ... 介绍家人。',
      examples: [{ en: 'This is my family.', zh: '这是我的家庭。' }],
      commonErrorZh: 'my 后面直接跟名词，不再加 a。',
      sentenceIds: ['Unit-3-s01'],
    }],
    vocabulary: [
      {
        word: 'family',
        phonetic: '/ˈfæməli/',
        meaningZh: '家庭',
        syllables: ['fam', 'i', 'ly'],
        difficultPhonemes: ['/f/'],
        exampleSentences: [{ en: 'This is my family.', zh: '这是我的家庭。' }],
      },
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
      evidenceKind: 'reading_comprehension',
      assessment: { acceptedImageIds: [], acceptedTexts: [], requiredPhrases: [], openResponse: false },
      difficulty: 1,
      media: { speechKey: 'Unit-3-a01', speechText: '先听老师读一遍课文。 This is my family.' },
    }],
    schoolTrack: {
      modules: ['A'],
      activities: [{
        id: 'Unit-3-sa01',
        title: '字母跟读：F',
        taskType: 'word_mimicry',
        scenario: 'review_scene',
        skillNodeIds: ['SE.SCHOOL.letters'],
        targetWords: ['F'],
        teacherUtteranceZh: '先跟老师读字母 F。',
        demonstrationText: 'F',
        requiresPronunciationAssessment: true,
        requiresAsr: false,
        evidenceKind: 'pronunciation',
        schoolModule: 'A',
        assessment: { acceptedImageIds: [], acceptedTexts: ['F'], requiredPhrases: [], openResponse: false },
        difficulty: 1,
        media: { speechKey: 'Unit-3-sa01', speechText: '先跟老师读字母 F。 F' },
      }],
    },
    stageHint: 1,
    qcReport: {
      validation: { ok: true, errors: [], warnings: [{ code: 'sample', message: '示例警告' }] },
      needsReview: false,
    },
  });
  return { ...base, ...overrides };
}

describe('P4-05 教师用教案导出', () => {
  it('生成含目标、课时、重点句、词汇、语法、活动与易错点的 Markdown', () => {
    const exported = buildLessonPlanExport({
      unitId,
      content: fixture(),
      currentVersion: 3,
      contentVersion: 'abc123',
      availability: 'active',
      generatedAt: new Date('2026-11-25T08:00:00.000Z'),
    });

    assert.equal(exported.plan.unitId, unitId);
    assert.equal(exported.plan.suggestedSessions, 1);
    assert.equal(exported.plan.sessionMinutes, 15);
    assert.equal(exported.plan.currentVersion, 3);
    assert.equal(exported.plan.contentVersion, 'abc123');
    assert.equal(exported.plan.qc.ok, true);
    assert.equal(exported.plan.qc.errors, 0);
    assert.equal(exported.plan.qc.warnings, 1);
    assert.equal(exported.plan.keySentences.length, 2);
    assert.equal(exported.plan.focusWords.length, 2);
    assert.equal(exported.plan.activities.filter((activity) => activity.track === 'school').length, 1);
    assert.ok(exported.plan.commonErrors.some((error) => error.kind === 'grammar'));
    assert.ok(exported.plan.commonErrors.some((error) => error.kind === 'pronunciation' && error.target === 'family /f/'));

    const markdown = exported.markdown;
    assert.match(markdown, /^# 教案：Unit 3 · My Family/m);
    assert.match(markdown, /建议课时：1 课时/);
    assert.match(markdown, /contentVersion=abc123/);
    assert.match(markdown, /## 二、重点句/);
    assert.match(markdown, /This is my family\./);
    assert.match(markdown, /## 三、重点词汇/);
    assert.match(markdown, /### family \/ˈfæməli\//);
    assert.match(markdown, /## 四、语法点/);
    assert.match(markdown, /my 后面直接跟名词/);
    assert.match(markdown, /## 五、课堂活动/);
    assert.match(markdown, /## 六、学校英语轨/);
    assert.match(markdown, /## 七、易错点/);
    assert.match(markdown, /发音｜family \/f\//);
    assert.match(markdown, /## 八、课后练习建议/);
    assert.match(markdown, /## 九、自动质检摘要/);
    assert.match(markdown, /- 阻断项：0/);
    assert.match(markdown, /- 警告：1/);
    assert.equal(exported.filename.includes('教案'), true);
    assert.equal(exported.filename.endsWith('.md'), true);
    assert.equal(exported.filename.includes('/'), false);
  });

  it('同样内容重复导出正文一致，只有导出时间可变', () => {
    const first = buildLessonPlanExport({
      unitId,
      content: fixture(),
      generatedAt: new Date('2026-11-25T00:00:00.000Z'),
    });
    const second = buildLessonPlanExport({
      unitId,
      content: fixture(),
      generatedAt: new Date('2026-11-26T00:00:00.000Z'),
    });
    assert.equal(
      first.markdown.replace(/导出时间：.*/, ''),
      second.markdown.replace(/导出时间：.*/, ''),
    );
  });

  it('课时按 8 句/6 个活动估算并封顶 6 课时', () => {
    const short = fixture();
    assert.equal(estimateSessions(short), 1);

    const manySentences = fixture();
    manySentences.passage = {
      title: '长课文',
      paragraphs: [{
        sentences: Array.from({ length: 17 }, (_, index) => ({
          id: `Unit-3-s${String(index + 1).padStart(2, '0')}`,
          en: `Sentence ${index + 1}.`,
          zh: `第 ${index + 1} 句。`,
          keyWords: [],
          grammarIds: [],
          schoolModules: [],
        })),
      }],
    };
    assert.equal(estimateSessions(manySentences), 3);

    const manyActivities = fixture();
    manyActivities.activities = Array.from({ length: 60 }, (_, index) => ({
      ...manyActivities.activities[0]!,
      id: `Unit-3-a${String(index + 1).padStart(2, '0')}`,
    }));
    assert.equal(estimateSessions(manyActivities), 6);
  });

  it('文件名过滤路径字符并保留单元标识', () => {
    const exported = buildLessonPlanExport({ unitId, content: fixture() });
    const filename = lessonPlanFilename(exported.plan);
    assert.ok(filename.includes('Unit-3'));
    assert.doesNotMatch(filename, /[\\/:*?"<>|]/);
    assert.ok(filename.length <= 123);
  });

  it('未生成资源包时接口返回 404；format=md 返回 Markdown 附件', async () => {
    const controller = makeController(null);
    await assert.rejects(
      () => controller.getTextbookUnitLessonPlan('cookie', unitId, undefined, fakeResponse()),
      /尚未生成资源包/,
    );

    const headers: Record<string, string> = {};
    const response = {
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value;
      },
    };
    const withContent = makeController(fixture());
    const result = await withContent.getTextbookUnitLessonPlan('cookie', unitId, 'md', response as never);

    assert.equal(typeof result, 'string');
    assert.match(result as string, /^# 教案：/);
    assert.match(headers['content-type'] ?? '', /text\/markdown/);
    assert.match(headers['content-disposition'] ?? '', /attachment/);
    assert.match(headers['content-disposition'] ?? '', /filename\*=UTF-8''/);

    const json = await withContent.getTextbookUnitLessonPlan('cookie', unitId, undefined, fakeResponse()) as {
      filename: string;
      plan: { unitId: string };
      markdown: string;
    };
    assert.equal(json.plan.unitId, unitId);
    assert.equal(json.filename.endsWith('.md'), true);
    assert.match(json.markdown, /## 一、教学目标/);
  });
});

function fakeResponse() {
  return {
    setHeader() {
      // 非 md 分支不应写响应头。
      throw new Error('unexpected header write');
    },
  };
}

function makeController(content: TextbookUnitContent | null) {
  const prisma = {
    textbook_units: {
      findUnique: async () => ({
        id: unitId,
        textbookId: '11111111-1111-4111-8111-111111111111',
        unitCode: 'Unit 3',
        title: 'My Family',
        order: 3,
        passageSource: 'This is my family.',
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        textbook: {
          publisher: '人教版',
          publicationYear: 2024,
          grade: '三年级',
          title: '英语',
          edition: '上册',
        },
      }),
    },
    curriculum_units: {
      findFirst: async () => (content ? {
        id: curriculumUnitId,
        content,
        currentVersion: 3,
        contentVersion: 'abc123',
        availability: 'active',
      } : null),
    },
  };
  const adminAuth = {
    resolveRequest: () => ({ id: 'admin-1' }),
  };
  return new CurriculumAdminController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    adminAuth as never,
    {} as never,
    {} as never,
  );
}
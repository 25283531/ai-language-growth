/**
 * P4-03：角色扮演/复述模板的生成、参考答分与判分。
 *
 * 取题时只下发情境、指令和必用短语，参考答案在判分后才返回；判分按
 * 必用短语覆盖率，不要求逐字复述。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  textbookUnitContentSchema,
  type TextbookUnitContent,
} from '@alg/shared-contracts';
import {
  EXPRESSION_PASS_COVERAGE,
  ExpressionTaskService,
} from '../src/curriculum/expression-task.service';

const topicId = 'topic-textbook-unit-5';
const unitId = '77777777-7777-4777-8777-777777777777';

type ExpressionRow = {
  id: string;
  unitId: string;
  topicId: string;
  kind: string;
  title: string;
  scenarioZh: string;
  promptEn: string;
  promptZh: string;
  referenceAnswer: string;
  requiredPhrases: string[];
  sourceSentenceIds: string[];
  createdAt: Date;
};

function content(overrides: Partial<TextbookUnitContent> = {}): TextbookUnitContent {
  return textbookUnitContentSchema.parse({
    resourceType: 'textbook_unit',
    textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
    unit: { code: 'Unit 5', title: 'My Apples', order: 5 },
    objectives: ['能用本课表达谈论苹果'],
    passage: {
      title: 'My Apples',
      paragraphs: [{
        sentences: [
          { id: 'Unit-5-s01', en: 'I like red apples.', zh: '我喜欢红苹果。' },
          { id: 'Unit-5-s02', en: 'I eat apples every day.', zh: '我每天吃苹果。' },
        ],
      }],
    },
    grammarPoints: [{
      id: 'g01',
      pattern: 'I like ...',
      titleZh: '表达喜好',
      explanationZh: 'like 后面直接跟喜欢的事物。',
      examples: [{ en: 'I like red apples.', zh: '我喜欢红苹果。' }],
      commonErrorZh: '',
      sentenceIds: ['Unit-5-s01'],
    }],
    vocabulary: [
      { word: 'apples', phonetic: '/ˈæpəlz/', meaningZh: '苹果', syllables: ['ap', 'ples'] },
      { word: 'red', phonetic: '/red/', meaningZh: '红色的', syllables: ['red'] },
      { word: 'sweet', phonetic: '/swiːt/', meaningZh: '甜的', syllables: ['sweet'] },
    ],
    activities: [{
      id: 'Unit-5-a01',
      title: '朗读课文',
      taskType: 'reading_story',
      scenario: 'story_scene',
      skillNodeIds: ['LA.LISTEN.word_recognition'],
      targetWords: ['apples'],
      teacherUtteranceZh: '先听老师读一遍课文。',
      demonstrationText: 'I like red apples.',
      requiresPronunciationAssessment: false,
      requiresAsr: false,
      evidenceKind: 'reading_comprehension',
      assessment: { acceptedImageIds: [], acceptedTexts: [], requiredPhrases: [], openResponse: false },
      difficulty: 1,
      media: { speechKey: 'Unit-5-a01', speechText: 'I like red apples.' },
    }],
    qcReport: { validation: { ok: true, errors: [], warnings: [] } },
    ...overrides,
  });
}

function row(overrides: Partial<ExpressionRow> = {}): ExpressionRow {
  return {
    id: 'expr-1',
    unitId,
    topicId,
    kind: 'role_play',
    title: '角色扮演：My Apples',
    scenarioZh: '你和同学在谈论苹果。',
    promptEn: 'Talk about apples with your partner.',
    promptZh: '和同伴说一说苹果。',
    referenceAnswer: 'I like red apples. I eat apples every day.',
    requiredPhrases: ['apples', 'red', 'sweet'],
    sourceSentenceIds: ['Unit-5-s01', 'Unit-5-s02'],
    createdAt: new Date(),
    ...overrides,
  };
}

function fakePrisma(
  initial: ExpressionRow[] = [],
  options: { unitMissing?: boolean; content?: TextbookUnitContent } = {},
) {
  const rows = [...initial];
  const calls: string[] = [];
  const prisma = {
    curriculum_units: {
      findFirst: async () => {
        calls.push('curriculum_units.findFirst');
        if (options.unitMissing) return null;
        return { id: unitId, content: options.content ?? content() };
      },
    },
    unit_expression_tasks: {
      findFirst: async ({ where }: { where: { unitId: string } }) => {
        calls.push('unit_expression_tasks.findFirst');
        return rows.find((item) => item.unitId === where.unitId) ?? null;
      },
      create: async ({ data }: { data: Omit<ExpressionRow, 'id' | 'createdAt'> }) => {
        calls.push('unit_expression_tasks.create');
        const created = { ...data, id: 'expr-created', createdAt: new Date() };
        rows.push(created);
        return created;
      },
    },
  };
  return { prisma, rows, calls };
}

function fakeGateway(options: { fail?: boolean; payload?: unknown } = {}) {
  let calls = 0;
  return {
    gateway: {
      smallLlm: async () => {
        calls += 1;
        if (options.fail) throw new Error('model offline');
        return { content: JSON.stringify(options.payload ?? {}) };
      },
    },
    get calls() {
      return calls;
    },
  };
}

function service(
  prisma: ReturnType<typeof fakePrisma>['prisma'],
  gateway: ReturnType<typeof fakeGateway>['gateway'],
) {
  const router = { route: async () => ({ serviceKind: 'llm', level: 'L2', providerAlias: 'mock', modelAlias: 'mock' }) };
  return new ExpressionTaskService(prisma as never, gateway as never, router as never);
}

describe('P4-03 角色扮演/复述模板', () => {
  it('已有任务时不重复生成，且取题不泄露参考答案', async () => {
    const state = fakePrisma([row()]);
    const model = fakeGateway({ fail: true });
    const result = await service(state.prisma, model.gateway).payload(topicId);

    assert.equal(model.calls, 0);
    assert.equal(result.task.kind, 'role_play');
    assert.equal(result.task.requiredPhrases.length, 3);
    assert.equal('referenceAnswer' in result.task, false);
    assert.equal(result.rule.passCoverage, EXPRESSION_PASS_COVERAGE);
  });

  it('模型返回合法模板时落库，并过滤不在参考答案里的短语', async () => {
    const state = fakePrisma();
    const model = fakeGateway({
      payload: {
        task: {
          kind: 'retell',
          title: '复述：My Apples',
          scenarioZh: '请你复述课文。',
          promptEn: 'Retell the passage.',
          promptZh: '复述课文。',
          referenceAnswer: 'I like red apples. I eat apples every day.',
          requiredPhrases: ['red apples', 'every day', 'bananas'],
          sourceSentenceIds: ['Unit-5-s01', 'Unit-5-s02'],
        },
      },
    });

    const result = await service(state.prisma, model.gateway).payload(topicId);

    assert.equal(model.calls, 1);
    assert.equal(state.rows.length, 1);
    assert.equal(result.task.kind, 'retell');
    assert.deepEqual(state.rows[0].requiredPhrases, ['red apples', 'every day']);
    assert.equal('referenceAnswer' in result.task, false);
  });

  it('模型失败时用课文原句和重点词生成兜底任务', async () => {
    const state = fakePrisma();
    const model = fakeGateway({ fail: true });
    const result = await service(state.prisma, model.gateway).payload(topicId);

    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].kind, 'role_play');
    assert.match(state.rows[0].referenceAnswer, /I like red apples/);
    assert.equal(state.rows[0].requiredPhrases.length >= 2, true);
    assert.equal(result.task.title.includes('角色扮演'), true);
    assert.equal('referenceAnswer' in result.task, false);
  });

  it('按必用短语覆盖率判分，60% 达标并返回参考答案', async () => {
    const state = fakePrisma([row()]);
    const result = await service(state.prisma, fakeGateway({ fail: true }).gateway).grade(
      topicId,
      'I LIKE red apples!',
    );

    assert.equal(result.matchedPhrases.length, 2);
    assert.deepEqual(result.missingPhrases, ['sweet']);
    assert.equal(result.coverage, 2 / 3);
    assert.equal(result.passed, true);
    assert.equal(result.referenceAnswer, 'I like red apples. I eat apples every day.');
    assert.match(result.feedbackZh, /表达完整/);
  });

  it('覆盖率不足时不通过，并给出缺失短语', async () => {
    const state = fakePrisma([row()]);
    const result = await service(state.prisma, fakeGateway({ fail: true }).gateway).grade(
      topicId,
      'I like bananas.',
    );

    assert.equal(result.coverage, 0);
    assert.equal(result.passed, false);
    assert.deepEqual(result.missingPhrases, ['apples', 'red', 'sweet']);
    assert.match(result.feedbackZh, /apples/);
  });

  it('没有教材资源包或无法生成任务时明确报错', async () => {
    const missing = fakePrisma([], { unitMissing: true });
    await assert.rejects(
      () => service(missing.prisma, fakeGateway({ fail: true }).gateway).payload(topicId),
      /没有可用的教材资源包/,
    );

    const short = fakePrisma([], {
      content: content({
        passage: {
          title: 'Hi',
          paragraphs: [{ sentences: [{ id: 's1', en: 'Hi.', zh: '你好。' }] }],
        },
        vocabulary: [],
      }),
    });
    await assert.rejects(
      () => service(short.prisma, fakeGateway({ fail: true }).gateway).payload(topicId),
      /还没有可用的角色扮演/,
    );
  });
});
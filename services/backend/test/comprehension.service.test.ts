/**
 * P4-02：教材单元理解题的生成、判分与兜底。
 *
 * 覆盖：
 *  1. 已有题目时按单元返回，不重复调用模型；
 *  2. 模型返回合法题目时落库并去掉答案下发；
 *  3. 模型失败时用课文原句/重点词替换生成判断与单选题；
 *  4. 判分统计、答案归一化与缺少作答按错题处理；
 *  5. 没有教材资源包时明确报错。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  textbookUnitContentSchema,
  type TextbookUnitContent,
} from '@alg/shared-contracts';
import {
  COMPREHENSION_ITEM_COUNT,
  COMPREHENSION_MIN_ITEMS,
  ComprehensionService,
} from '../src/curriculum/comprehension.service';

const topicId = 'topic-textbook-unit-4';
const unitId = '66666666-6666-4666-8666-666666666666';

type ComprehensionRow = {
  id: string;
  unitId: string;
  topicId: string;
  itemIndex: number;
  kind: string;
  prompt: string;
  options: string[];
  answer: string;
  explanationZh: string;
  sourceSentenceIds: string[];
  createdAt: Date;
};

function content(overrides: Partial<TextbookUnitContent> = {}): TextbookUnitContent {
  return textbookUnitContentSchema.parse({
    resourceType: 'textbook_unit',
    textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
    unit: { code: 'Unit 4', title: 'Apples', order: 4 },
    objectives: ['能读懂课文并回答理解题'],
    passage: {
      title: 'Apples',
      paragraphs: [{
        sentences: [
          { id: 'Unit-4-s01', en: 'I like red apples.', zh: '我喜欢红苹果。' },
          { id: 'Unit-4-s02', en: 'I eat apples every day.', zh: '我每天吃苹果。' },
          { id: 'Unit-4-s03', en: 'Apples are sweet.', zh: '苹果很甜。' },
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
      sentenceIds: ['Unit-4-s01'],
    }],
    vocabulary: [
      { word: 'apples', phonetic: '/ˈæpəlz/', meaningZh: '苹果', syllables: ['ap', 'ples'] },
      { word: 'red', phonetic: '/red/', meaningZh: '红色的', syllables: ['red'] },
      { word: 'green', phonetic: '/ɡriːn/', meaningZh: '绿色的', syllables: ['green'] },
      { word: 'sweet', phonetic: '/swiːt/', meaningZh: '甜的', syllables: ['sweet'] },
    ],
    activities: [{
      id: 'Unit-4-a01',
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
      media: { speechKey: 'Unit-4-a01', speechText: 'I like red apples.' },
    }],
    qcReport: { validation: { ok: true, errors: [], warnings: [] } },
    ...overrides,
  });
}

function row(index: number, overrides: Partial<ComprehensionRow> = {}): ComprehensionRow {
  return {
    id: `comp-${index}`,
    unitId,
    topicId,
    itemIndex: index,
    kind: 'true_false',
    prompt: `Question ${index}`,
    options: [],
    answer: 'true',
    explanationZh: '课文原句如此。',
    sourceSentenceIds: [`Unit-4-s0${index + 1}`],
    createdAt: new Date(),
    ...overrides,
  };
}

function fakePrisma(
  initial: ComprehensionRow[] = [],
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
    unit_comprehension_items: {
      count: async ({ where }: { where: { unitId: string } }) => {
        calls.push('unit_comprehension_items.count');
        return rows.filter((item) => item.unitId === where.unitId).length;
      },
      createMany: async ({ data }: { data: Array<Omit<ComprehensionRow, 'id' | 'createdAt'>> }) => {
        calls.push('unit_comprehension_items.createMany');
        for (const item of data) {
          rows.push({ ...item, id: `comp-${item.itemIndex}`, createdAt: new Date() });
        }
        return { count: data.length };
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where: { unitId: string };
        orderBy?: { itemIndex: 'asc' };
      }) => {
        calls.push('unit_comprehension_items.findMany');
        return rows
          .filter((item) => item.unitId === where.unitId)
          .sort((left, right) => orderBy?.itemIndex === 'asc' ? left.itemIndex - right.itemIndex : 0);
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
        return { content: JSON.stringify(options.payload ?? { items: [] }) };
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
  return new ComprehensionService(prisma as never, gateway as never, router as never);
}

describe('P4-02 理解题生成与判分', () => {
  it('已有题目时按单元返回，不重复调用模型', async () => {
    const seeded = Array.from({ length: 3 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const model = fakeGateway({ fail: true });
    const result = await service(state.prisma, model.gateway).payload(topicId);

    assert.equal(result.items.length, COMPREHENSION_ITEM_COUNT);
    assert.equal(result.rule.minItems, COMPREHENSION_MIN_ITEMS);
    assert.equal(result.rule.maxItems, COMPREHENSION_ITEM_COUNT);
    assert.equal(model.calls, 0);
    for (const item of result.items) {
      assert.equal('answer' in item, false);
      assert.equal('explanationZh' in item, false);
    }
  });

  it('已有 2 题时按 2 题返回，不强行补到 3 题', async () => {
    const state = fakePrisma([row(0), row(1)]);
    const model = fakeGateway({ fail: true });
    const result = await service(state.prisma, model.gateway).payload(topicId);

    assert.equal(result.items.length, 2);
    assert.equal(model.calls, 0);
    assert.equal(state.calls.includes('unit_comprehension_items.createMany'), false);
  });

  it('模型返回合法题目时落库，并去掉答案下发', async () => {
    const state = fakePrisma();
    const model = fakeGateway({
      payload: {
        items: [
          {
            kind: 'true_false',
            prompt: 'The passage is about apples.',
            options: [],
            answer: 'TRUE',
            explanationZh: '课文围绕苹果展开。',
            sourceSentenceIds: ['Unit-4-s01'],
          },
          {
            kind: 'single_choice',
            prompt: 'What color are the apples?',
            options: [' red ', 'blue'],
            answer: '  red  ',
            explanationZh: '课文说 red apples。',
            sourceSentenceIds: ['Unit-4-s01'],
          },
          {
            kind: 'true_false',
            prompt: 'The boy likes bananas.',
            options: [],
            answer: 'false',
            explanationZh: '课文没有提到香蕉。',
            sourceSentenceIds: ['Unit-4-s01'],
          },
        ],
      },
    });

    const result = await service(state.prisma, model.gateway).payload(topicId);

    assert.equal(model.calls, 1);
    assert.equal(state.rows.length, 3);
    assert.equal(result.items.length, 3);
    assert.deepEqual(state.rows[0].options, ['true', 'false']);
    assert.equal(state.rows[0].answer, 'true');
    assert.equal(state.rows[1].answer, 'red');
    assert.deepEqual(state.rows[1].options, ['red', 'blue']);
    assert.equal(result.items[1].kind, 'single_choice');
    assert.equal('answer' in result.items[1], false);
  });

  it('模型失败时用课文原句与重点词替换兜底 3 题', async () => {
    const state = fakePrisma();
    const model = fakeGateway({ fail: true });
    const result = await service(state.prisma, model.gateway).payload(topicId);

    assert.equal(state.rows.length, 3);
    assert.equal(result.items.length, 3);
    assert.equal(state.calls.includes('unit_comprehension_items.createMany'), true);
    assert.deepEqual(state.rows.map((item) => item.kind), ['true_false', 'true_false', 'single_choice']);
    assert.deepEqual(state.rows.slice(0, 2).map((item) => item.answer), ['true', 'false']);
    assert.deepEqual(state.rows[0].options, ['true', 'false']);
    const choice = state.rows.find((item) => item.kind === 'single_choice');
    assert.ok(choice);
    assert.equal(choice.options.length >= 3, true);
    assert.equal(choice.options.includes(choice.answer), true);
    assert.match(choice.prompt, /appears in the passage/);
    for (const item of result.items) {
      assert.equal('answer' in item, false);
    }
  });

  it('判分统计正确率，支持大小写/空格并返回解析', async () => {
    const seeded = [
      row(0, { kind: 'true_false', prompt: 'Apples are red.', answer: 'true' }),
      row(1, { kind: 'true_false', prompt: 'Apples are blue.', answer: 'false' }),
      row(2, { kind: 'single_choice', prompt: 'What color are the apples?', options: ['red', 'blue'], answer: 'red' }),
    ];
    const state = fakePrisma(seeded);
    const result = await service(state.prisma, fakeGateway({ fail: true }).gateway).grade(topicId, [
      { itemId: 'comp-0', answer: ' TRUE ' },
      { itemId: 'comp-1', answer: 'false' },
      { itemId: 'comp-2', answer: 'blue' },
    ]);

    assert.equal(result.correct, 2);
    assert.equal(result.total, 3);
    assert.equal(result.accuracy, 2 / 3);
    assert.equal(result.details[0].correct, true);
    assert.equal(result.details[2].correct, false);
    assert.equal(result.details[2].correctAnswer, 'red');
    assert.equal(result.details[2].explanationZh, '课文原句如此。');
  });

  it('缺少作答按错题处理，不会把未答题算作正确', async () => {
    const seeded = Array.from({ length: 3 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const result = await service(state.prisma, fakeGateway({ fail: true }).gateway).grade(topicId, [
      { itemId: 'comp-0', answer: 'true' },
    ]);

    assert.equal(result.correct, 1);
    assert.equal(result.total, 3);
    assert.equal(result.details[1].answer, '');
    assert.equal(result.details[1].correct, false);
  });

  it('没有教材资源包时明确报错', async () => {
    const state = fakePrisma([], { unitMissing: true });
    await assert.rejects(
      () => service(state.prisma, fakeGateway({ fail: true }).gateway).payload(topicId),
      /没有可用的教材资源包/,
    );
  });
});
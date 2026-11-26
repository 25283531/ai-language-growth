/**
 * P4-01 / P4-04：语法练习（完形）的判分、续批与兜底出题。
 *
 * 这里直接测 ClozeService，不启动 Nest：
 *  1. 已有题目时按 batch 返回，不重复调用模型；
 *  2. 模型失败时用课文重点词兜底，保证每批仍有可判定的填空题；
 *  3. 正确率 >=80% 通过并结束；<80% 返回下一批索引，并在后台补齐下一批；
 *  4. 判分大小写/首尾空格不敏感，空批次返回 404。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  textbookUnitContentSchema,
  type TextbookUnitContent,
} from '@alg/shared-contracts';
import { ClozeService, CLOZE_BATCH_SIZE, CLOZE_PASS_RATE } from '../src/curriculum/cloze.service';

const topicId = 'topic-textbook-unit-3';
const unitId = '55555555-5555-4555-8555-555555555555';

type ClozeRow = {
  id: string;
  unitId: string;
  topicId: string;
  itemIndex: number;
  grammarPointId: string;
  sentence: string;
  answer: string;
  options: string[];
  explanationZh: string;
  createdAt: Date;
};

function content(): TextbookUnitContent {
  return textbookUnitContentSchema.parse({
    resourceType: 'textbook_unit',
    textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
    unit: { code: 'Unit 3', title: 'My Day', order: 3 },
    objectives: ['能读懂课文并完成语法填空'],
    passage: {
      title: 'My Day',
      paragraphs: [{
        sentences: [
          { id: 'Unit-3-s01', en: 'I like red apples.', zh: '我喜欢红苹果。' },
          { id: 'Unit-3-s02', en: 'I like green apples.', zh: '我喜欢绿苹果。' },
          { id: 'Unit-3-s03', en: 'I like big apples.', zh: '我喜欢大苹果。' },
          { id: 'Unit-3-s04', en: 'I like sweet apples.', zh: '我喜欢甜苹果。' },
          { id: 'Unit-3-s05', en: 'I like small apples.', zh: '我喜欢小苹果。' },
        ],
      }],
    },
    grammarPoints: [{
      id: 'g01',
      pattern: 'I like ...',
      titleZh: '表达喜好',
      explanationZh: 'like 后面直接跟喜欢的事物。',
      examples: [{ en: 'I like red apples.', zh: '我喜欢红苹果。' }],
      commonErrorZh: 'like 后面不再加 be 动词。',
      sentenceIds: ['Unit-3-s01'],
    }],
    vocabulary: [
      { word: 'apples', phonetic: '/ˈæpəlz/', meaningZh: '苹果', syllables: ['ap', 'ples'] },
      { word: 'red', phonetic: '/red/', meaningZh: '红色的', syllables: ['red'] },
      { word: 'green', phonetic: '/ɡriːn/', meaningZh: '绿色的', syllables: ['green'] },
    ],
    activities: [{
      id: 'Unit-3-a01',
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
      media: { speechKey: 'Unit-3-a01', speechText: '先听老师读一遍课文。 I like red apples.' },
    }],
    qcReport: { validation: { ok: true, errors: [], warnings: [] } },
  });
}

function row(index: number, overrides: Partial<ClozeRow> = {}): ClozeRow {
  return {
    id: `row-${index}`,
    unitId,
    topicId,
    itemIndex: index,
    grammarPointId: 'g01',
    sentence: `I ___ red apples ${index}.`,
    answer: 'like',
    options: ['like', 'likes', 'liking'],
    explanationZh: '主语 I 后用动词原形。',
    createdAt: new Date(),
    ...overrides,
  };
}

function fakePrisma(initial: ClozeRow[] = [], options: { unitMissing?: boolean } = {}) {
  const rows = [...initial];
  const calls: string[] = [];
  const prisma = {
    curriculum_units: {
      findFirst: async () => {
        calls.push('curriculum_units.findFirst');
        if (options.unitMissing) return null;
        return { id: unitId, content: content() };
      },
    },
    unit_cloze_items: {
      count: async ({ where }: { where: { unitId: string } }) => {
        calls.push('unit_cloze_items.count');
        return rows.filter((item) => item.unitId === where.unitId).length;
      },
      createMany: async ({ data }: { data: Array<Omit<ClozeRow, 'id' | 'createdAt'>> }) => {
        calls.push('unit_cloze_items.createMany');
        for (const item of data) {
          rows.push({ ...item, id: `row-${item.itemIndex}`, createdAt: new Date() });
        }
        return { count: data.length };
      },
      findMany: async ({
        where,
        orderBy,
      }: {
        where: { unitId: string; itemIndex: { gte: number; lt: number } };
        orderBy?: { itemIndex: 'asc' };
      }) => {
        calls.push('unit_cloze_items.findMany');
        const found = rows
          .filter((item) => item.unitId === where.unitId)
          .filter((item) => item.itemIndex >= where.itemIndex.gte && item.itemIndex < where.itemIndex.lt)
          .sort((left, right) => orderBy?.itemIndex === 'asc'
            ? left.itemIndex - right.itemIndex
            : 0);
        return found;
      },
    },
  };
  return { prisma, rows, calls };
}

function fakeLearnerModel() {
  const evidence: Array<Record<string, unknown>> = [];
  return {
    evidence,
    model: {
      appendEvidence: async (input: Record<string, unknown>) => {
        evidence.push(input);
        return `evidence-${evidence.length}`;
      },
    },
  };
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
  learnerModel: ReturnType<typeof fakeLearnerModel>['model'] = fakeLearnerModel().model,
) {
  const router = { route: async () => ({ serviceKind: 'llm', level: 'L2', providerAlias: 'mock', modelAlias: 'mock' }) };
  return new ClozeService(prisma as never, gateway as never, router as never, learnerModel as never);
}

async function flushBackground() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('P4-01/P4-04 完形判分与兜底', () => {
  it('已有题目时按批返回，不重复调用模型', async () => {
    const seeded = Array.from({ length: 6 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const model = fakeGateway({ fail: true });
    const cloze = service(state.prisma, model.gateway);

    const batch = await cloze.payload(topicId, 0);

    assert.equal(batch.grammarPoints.length, 1);
    assert.equal(batch.batchIndex, 0);
    assert.equal(batch.items.length, CLOZE_BATCH_SIZE);
    assert.equal(batch.rule.passRate, CLOZE_PASS_RATE);
    assert.deepEqual(batch.items.map((item) => item.id), ['row-0', 'row-1', 'row-2', 'row-3', 'row-4']);
    assert.equal(model.calls, 0);
    assert.equal(state.rows.length, 6);
  });

  it('模型失败时用课文重点词兜底，仍返回可判定的 5 题', async () => {
    const state = fakePrisma();
    const model = fakeGateway({ fail: true });
    const cloze = service(state.prisma, model.gateway);

    const batch = await cloze.payload(topicId, 0);

    assert.equal(batch.items.length, CLOZE_BATCH_SIZE);
    assert.equal(state.calls.includes('unit_cloze_items.createMany'), true);
    for (const item of batch.items) {
      assert.match(item.sentence, /___/);
      assert.equal(item.options.length, 3);
      assert.equal(item.grammarPointId, 'g01');
      assert.match(item.explanationZh, /apples/);
      // 下发题面不能带 answer，避免客户端直接拿到答案。
      assert.equal('answer' in item, false);
    }
    for (const item of state.rows) {
      assert.match(item.sentence, /___/);
      assert.equal(item.options.length, 3);
      assert.equal(item.options.includes(item.answer), true, JSON.stringify(item));
      assert.equal(item.answer.length > 0, true);
      assert.equal(item.grammarPointId, 'g01');
    }
  });

  it('5/5 通过：返回 nextBatchIndex=null，不追加题目', async () => {
    const seeded = Array.from({ length: 5 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const model = fakeGateway({ fail: true });
    const cloze = service(state.prisma, model.gateway);

    const result = await cloze.grade(topicId, 0, seeded.map((item) => ({
      itemId: item.id,
      answer: item.answer,
    })));

    assert.equal(result.correct, 5);
    assert.equal(result.total, 5);
    assert.equal(result.accuracy, 1);
    assert.equal(result.passed, true);
    assert.equal(result.nextBatchIndex, null);
    assert.equal(result.details.every((item) => item.correct), true);
    await flushBackground();
    assert.equal(state.rows.length, 5);
  });

  it('4/5 达到 80% 边界即通过，不续批', async () => {
    const seeded = Array.from({ length: 5 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const cloze = service(state.prisma, fakeGateway({ fail: true }).gateway);

    const result = await cloze.grade(topicId, 0, [
      { itemId: 'row-0', answer: 'like' },
      { itemId: 'row-1', answer: 'like' },
      { itemId: 'row-2', answer: 'like' },
      { itemId: 'row-3', answer: 'like' },
      { itemId: 'row-4', answer: 'wrong' },
    ]);

    assert.equal(result.accuracy, 0.8);
    assert.equal(result.passed, true);
    assert.equal(result.nextBatchIndex, null);
    await flushBackground();
    assert.equal(state.rows.length, 5);
  });

  it('3/5 未达标：返回下一批索引，并后台补齐第 2 批', async () => {
    const seeded = Array.from({ length: 5 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const model = fakeGateway({ fail: true });
    const cloze = service(state.prisma, model.gateway);

    const result = await cloze.grade(topicId, 0, [
      { itemId: 'row-0', answer: 'like' },
      { itemId: 'row-1', answer: 'like' },
      { itemId: 'row-2', answer: 'like' },
      { itemId: 'row-3', answer: 'wrong' },
      { itemId: 'row-4', answer: 'wrong' },
    ]);

    assert.equal(result.correct, 3);
    assert.equal(result.total, 5);
    assert.equal(result.accuracy, 0.6);
    assert.equal(result.passed, false);
    assert.equal(result.nextBatchIndex, 1);
    assert.equal(result.details.find((item) => item.itemId === 'row-3')?.correct, false);
    assert.equal(result.details.find((item) => item.itemId === 'row-3')?.correctAnswer, 'like');

    await flushBackground();
    assert.equal(state.rows.length, 10);
    assert.deepEqual(
      state.rows.filter((item) => item.itemIndex >= 5).map((item) => item.itemIndex).sort((a, b) => a - b),
      [5, 6, 7, 8, 9],
    );
  });

  it('通过时写一条语法域学习证据，不直接改掌握状态', async () => {
    const seeded = Array.from({ length: 5 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const learner = fakeLearnerModel();
    const cloze = service(state.prisma, fakeGateway({ fail: true }).gateway, learner.model);

    const result = await cloze.grade(topicId, 0, seeded.map((item) => ({
      itemId: item.id,
      answer: item.answer,
    })), 'learner-1');

    assert.equal(result.passed, true);
    assert.equal(learner.evidence.length, 1);
    const evidence = learner.evidence[0]!;
    assert.equal(evidence.learnerId, 'learner-1');
    assert.equal(evidence.lessonSessionId, null);
    assert.equal(evidence.skillNodeId, 'LA.GRAM.basic_pattern');
    assert.equal(evidence.abilityCategory, 'grammar');
    assert.equal(evidence.source, 'task_result');
    assert.equal(evidence.taskType, 'sentence_pattern');
    assert.equal(evidence.scenario, 'story_scene');
    assert.equal(evidence.prompted, false);
    assert.equal(evidence.independent, true);
    assert.equal(evidence.succeeded, true);
    assert.equal(evidence.score, 100);
    assert.match(String(evidence.note), /语法点 g01/);
  });

  it('未通过时不写语法域学习证据', async () => {
    const seeded = Array.from({ length: 5 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const learner = fakeLearnerModel();
    const cloze = service(state.prisma, fakeGateway({ fail: true }).gateway, learner.model);

    const result = await cloze.grade(topicId, 0, [
      { itemId: 'row-0', answer: 'like' },
      { itemId: 'row-1', answer: 'like' },
      { itemId: 'row-2', answer: 'like' },
      { itemId: 'row-3', answer: 'wrong' },
      { itemId: 'row-4', answer: 'wrong' },
    ], 'learner-1');

    assert.equal(result.passed, false);
    assert.equal(learner.evidence.length, 0);
    await flushBackground();
  });

  it('判分忽略大小写与首尾空格', async () => {
    const seeded = Array.from({ length: 5 }, (_, index) => row(index));
    const state = fakePrisma(seeded);
    const cloze = service(state.prisma, fakeGateway({ fail: true }).gateway);

    const result = await cloze.grade(topicId, 0, seeded.map((item) => ({
      itemId: item.id,
      answer: '  LIKE  ',
    })));

    assert.equal(result.passed, true);
    assert.equal(result.correct, 5);
  });

  it('没有可用单元或批次时明确报错，不伪造题目', async () => {
    const missing = fakePrisma([], { unitMissing: true });
    await assert.rejects(
      () => service(missing.prisma, fakeGateway().gateway).payload(topicId, 0),
      /没有可用的教材资源包/,
    );

    const empty = fakePrisma();
    await assert.rejects(
      () => service(empty.prisma, fakeGateway({ fail: true }).gateway).grade(topicId, 0, [
        { itemId: 'row-0', answer: 'like' },
      ]),
      /还没有生成/,
    );
  });
});
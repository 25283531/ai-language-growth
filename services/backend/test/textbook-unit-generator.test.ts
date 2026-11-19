import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TextbookUnitService } from '../src/curriculum/textbook-unit.service';

const unitId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-11-18T10:00:00.000Z');

const sentences = [
  'This is my family.',
  'This is my father.',
  'This is my mother.',
  'This is my brother.',
  'This is my sister.',
  'This is my grandpa.',
  'This is my grandma.',
  'I love my family.',
  'We eat together.',
  'We play together.',
  'We read together.',
  'This is my home.',
];
const passage = sentences.join(' ');
const words = ['family', 'father', 'mother', 'brother', 'sister', 'grandpa', 'grandma', 'love', 'eat', 'play', 'read', 'home'];

function unit(metadata: Record<string, unknown> = {}) {
  return {
    id: unitId,
    textbookId: '11111111-1111-4111-8111-111111111111',
    unitCode: 'Unit 3',
    title: 'My Family',
    order: 3,
    passageSource: passage,
    metadata: {
      textbook: { volume: '上册', edition: '2024 版' },
      words,
      grammarFocus: ['This is my family.'],
      objectives: ['认识家庭成员'],
      ...metadata,
    },
    createdAt: now,
    updatedAt: now,
    textbook: {
      publisher: '人教版',
      publicationYear: 2024,
      grade: '三年级',
      title: '英语',
      edition: '上册',
    },
  };
}

function fakePrisma(
  record: ReturnType<typeof unit> | null,
  mapping: Record<string, unknown> | null = null,
) {
  const calls: Array<{ action: string; args?: unknown }> = [];
  return {
    calls,
    prisma: {
      textbook_units: {
        findUnique: async (args: unknown) => {
          calls.push({ action: 'findUnique', args });
          return record;
        },
        update: async (args: unknown) => {
          calls.push({ action: 'update', args });
          return record;
        },
      },
      textbook_unit_mappings: {
        findUnique: async (args: unknown) => {
          calls.push({ action: 'mappingFindUnique', args });
          return mapping;
        },
      },
    },
  };
}

function fakeRouter() {
  const routes: string[] = [];
  return {
    routes,
    router: {
      route: async (input: { taskRoute: string }) => {
        routes.push(input.taskRoute);
        return {
          level: input.taskRoute.includes('enrich') ? 'L1' : 'L2',
          providerAlias: 'stub_llm',
          modelAlias: 'stub_llm_01',
          strategy: 'primary',
          fellBack: false,
          escalationSignals: [],
        };
      },
    },
  };
}

function fakeLexicon() {
  return {
    lookupMany: async (input: string[]) => new Map(input.map((word) => [word, {
      word,
      lemma: word,
      familyKey: word,
      phonetic: `/${word}/`,
      pos: 'n.',
      meaningZh: `${word} 的中文`,
      tags: [],
      domains: [],
      variants: [word],
      collocations: [],
      examples: [],
      source: 'ecdict',
      license: 'MIT',
      childSafe: true,
      isCore: true,
      isFunctionWord: false,
      textbookUnitIds: [],
      matchSource: 'textbook',
      matchedForm: word,
    }])),
  };
}

function jsonRequest(request: { messages: Array<{ content: string }> }): Record<string, unknown> {
  return JSON.parse(request.messages[0]?.content ?? '{}') as Record<string, unknown>;
}

function scriptedGateway(options: { invalid?: boolean } = {}) {
  const prompts: string[] = [];
  const respond = (request: { promptKey: string; messages: Array<{ content: string }> }) => {
    prompts.push(request.promptKey);
    if (options.invalid) return { content: 'not json at all' };
    const payload = jsonRequest(request);
    if (request.promptKey === 'curriculum.textbook_unit_plan') {
      return {
        content: JSON.stringify({
          objectives: ['能听懂课文并跟读', '能认读家庭成员词'],
          stageHint: 1,
        }),
      };
    }
    if (request.promptKey === 'curriculum.textbook_unit_enrich') {
      const inputSentences = Array.isArray(payload.sentences)
        ? payload.sentences as Array<{ id?: string; en?: string }>
        : [];
      const inputWords = Array.isArray(payload.words) ? payload.words as string[] : [];
      return {
        content: JSON.stringify({
          sentences: inputSentences.map((sentence, index) => ({
            id: sentence.id,
            en: sentence.en,
            zh: `这是第 ${index + 1} 句的中文翻译。`,
            keyWords: index === 0 ? ['family'] : [],
            schoolModules: index === 0 ? ['A'] : [],
          })),
          words: inputWords.map((word) => ({
            word,
            phonetic: `/${word}/`,
            meaningZh: `${word} 的中文`,
            syllables: [word],
            difficultPhonemes: [],
            phrases: [],
            exampleSentences: [],
          })),
        }),
      };
    }
    if (request.promptKey === 'curriculum.textbook_unit_grammar') {
      const inputSentences = Array.isArray(payload.sentences)
        ? payload.sentences as Array<{ id?: string; en?: string }>
        : [];
      return {
        content: JSON.stringify({
          grammarPoints: [{
            pattern: 'This is my ...',
            titleZh: '介绍家庭成员',
            explanationZh: '用 This is my ... 介绍家人。',
            examples: [{ en: 'This is my family.', zh: '这是我的家庭。' }],
            commonErrorZh: 'my 后面直接跟名词。',
            sentenceIds: inputSentences.slice(0, 2).map((sentence) => sentence.id),
            schoolModule: 'C',
          }],
        }),
      };
    }
    if (request.promptKey === 'curriculum.textbook_unit_activities') {
      return {
        content: JSON.stringify({
          activities: [{
            taskType: 'reading_story',
            scenario: 'story_scene',
            title: '课文朗读',
            targetWords: ['family'],
            teacherUtteranceZh: '请跟着老师读课文。',
            demonstrationText: 'This is my family.',
          }],
        }),
      };
    }
    return { content: '{}' };
  };
  return {
    prompts,
    gateway: {
      llm: async (request: { promptKey: string; messages: Array<{ content: string }> }) => respond(request),
      smallLlm: async (request: { promptKey: string; messages: Array<{ content: string }> }) => respond(request),
    },
  };
}

function serviceFor(
  record: ReturnType<typeof unit> | null,
  gateway: ReturnType<typeof scriptedGateway>['gateway'],
  mapping: Record<string, unknown> | null = null,
) {
  const prisma = fakePrisma(record, mapping);
  const router = fakeRouter();
  const service = new TextbookUnitService(
    prisma.prisma as never,
    router.router as never,
    gateway as never,
    fakeLexicon() as never,
  );
  return { service, ...prisma, ...router };
}

describe('教材单元生成管线', () => {
  it('12 句课文生成 12 个句子、语法点、词条和活动，并写回 metadata.content', async () => {
    const { gateway, prompts } = scriptedGateway();
    const { service, calls, routes } = serviceFor(unit(), gateway);

    const result = await service.generate(unitId);
    const generatedSentences = result.content.passage.paragraphs[0]?.sentences ?? [];

    assert.equal(generatedSentences.length, 12);
    assert.equal(generatedSentences[0]?.id, 'Unit-3-s01');
    assert.equal(generatedSentences[11]?.id, 'Unit-3-s12');
    assert.ok(generatedSentences.every((sentence) => /[\u3400-\u9fff]/.test(sentence.zh)));
    assert.ok(result.content.grammarPoints.length >= 1);
    assert.deepEqual(result.content.grammarPoints[0]?.sentenceIds, ['Unit-3-s01', 'Unit-3-s02']);
    assert.deepEqual(generatedSentences[0]?.grammarIds, ['g01']);
    assert.ok(result.content.vocabulary.length >= 10 && result.content.vocabulary.length <= 20);
    assert.ok(result.content.vocabulary.every((item) => item.phonetic && item.meaningZh));
    assert.ok(result.content.activities.length >= 3);
    assert.equal(result.content.activities[0]?.title, '课文朗读');
    assert.equal(result.content.textbook.volume, '上册');
    assert.equal(result.needsReview, false);
    assert.deepEqual(result.qcReport.issues, []);
    assert.equal(result.content.stageHint, 1);

    assert.deepEqual(new Set(routes), new Set([
      'llm.curriculum_unit_plan',
      'llm.curriculum_unit_enrich',
      'llm.curriculum_unit_grammar',
      'llm.curriculum_unit_activities',
    ]));
    assert.equal(prompts.length, 4);

    const update = calls.find((call) => call.action === 'update');
    const data = (update?.args as { data: { metadata: Record<string, unknown> } }).data;
    assert.equal((data.metadata.content as { resourceType: string }).resourceType, 'textbook_unit');
    assert.equal(data.metadata.needsReview, false);
    assert.equal((data.metadata.passage as { paragraphs: unknown[] }).paragraphs.length, 1);
  });

  it('按显式教材映射生成学校 A-E 轨活动，并覆盖建议阶段', async () => {
    const { gateway } = scriptedGateway();
    const { service } = serviceFor(unit(), gateway, {
      id: 'mapping-1',
      textbookId: '11111111-1111-4111-8111-111111111111',
      unitCode: 'Unit 3',
      skillNodeIds: ['LA.VOCAB.receptive', 'SE.SCHOOL.letters', 'SE.SCHOOL.reading'],
      domains: ['family'],
      schoolModules: ['A', 'C'],
      stageHint: 2,
      source: 'editorial',
      version: 3,
    });

    const result = await service.generate(unitId);
    assert.equal(result.content.stageHint, 2);
    assert.equal(result.needsReview, false, JSON.stringify(result.validation.errors));
    assert.deepEqual(result.content.schoolTrack?.modules, ['A', 'C']);
    assert.equal(result.content.schoolTrack?.activities.length, 2);
    assert.deepEqual(
      result.content.schoolTrack?.activities.map((activity) => activity.schoolModule),
      ['A', 'C'],
    );
    assert.ok(result.content.schoolTrack?.activities.every((activity) => activity.id.startsWith('Unit-3-s')));
    assert.ok(result.content.schoolTrack?.activities[0]?.skillNodeIds.includes('SE.SCHOOL.letters'));
    assert.ok(result.content.schoolTrack?.activities[1]?.skillNodeIds.includes('SE.SCHOOL.reading'));
    assert.ok(result.content.activities[0]?.skillNodeIds.includes('LA.VOCAB.receptive'));
    assert.deepEqual(
      (result.qcReport.mapping as { origin: string; version: number; schoolModules: string[] }).origin,
      'stored',
    );
    assert.equal(
      (result.qcReport.mapping as { origin: string; version: number; schoolModules: string[] }).version,
      3,
    );
  });

  it('AI 返回无效 JSON 时保留确定性结构、占位译文并标记 needsReview', async () => {
    const { gateway } = scriptedGateway({ invalid: true });
    const { service } = serviceFor(unit(), gateway);

    const result = await service.generate(unitId);
    const generatedSentences = result.content.passage.paragraphs[0]?.sentences ?? [];

    assert.equal(generatedSentences.length, 12);
    assert.ok(generatedSentences.every((sentence) => /[\u3400-\u9fff]/.test(sentence.zh)));
    assert.ok(generatedSentences.every((sentence) => sentence.zh.includes('待补充')));
    assert.equal(result.needsReview, true);
    assert.ok(result.content.grammarPoints.length >= 1);
    assert.ok(result.content.activities.length >= 3);
    assert.ok((result.qcReport.issues as Array<{ code: string }>).some((issue) => issue.code === 'missing_translation'));
    assert.ok((result.qcReport.issues as Array<{ code: string }>).some((issue) => issue.code === 'grammar_fallback'));
    assert.ok((result.qcReport.issues as Array<{ code: string }>).some((issue) => issue.code === 'activities_fallback'));
  });

  it('重新生成时优先保留同句已有译文，避免临时模型故障覆盖好内容', async () => {
    const previous = unit({
      passage: {
        title: 'My Family',
        paragraphs: [{
          sentences: [{ id: 'Unit-3-s01', en: 'This is my family.', zh: '这是我的家庭。' }],
        }],
      },
    });
    const { gateway } = scriptedGateway({ invalid: true });
    const { service } = serviceFor(previous, gateway);

    const result = await service.generate(unitId);
    const first = result.content.passage.paragraphs[0]?.sentences[0];
    assert.equal(first?.zh, '这是我的家庭。');
    assert.equal(result.needsReview, true);
  });

  it('缺少单元或课文原文时拒绝生成且不写库', async () => {
    const empty = fakePrisma(null);
    const router = fakeRouter();
    const service = new TextbookUnitService(
      empty.prisma as never,
      router.router as never,
      scriptedGateway().gateway as never,
      fakeLexicon() as never,
    );
    await assert.rejects(service.generate(unitId), /教材单元不存在/);
    assert.equal(empty.calls.filter((call) => call.action === 'update').length, 0);

    const noPassage = unit();
    noPassage.passageSource = '   ';
    const missing = fakePrisma(noPassage);
    const noPassageService = new TextbookUnitService(
      missing.prisma as never,
      router.router as never,
      scriptedGateway().gateway as never,
      fakeLexicon() as never,
    );
    await assert.rejects(noPassageService.generate(unitId), /请先录入课文原文/);
    assert.equal(missing.calls.filter((call) => call.action === 'update').length, 0);
  });
});

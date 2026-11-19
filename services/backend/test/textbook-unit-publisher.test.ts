import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  textbookUnitContentSchema,
  type TextbookUnitContent,
} from '@alg/shared-contracts';
import { contentHash } from '../src/curriculum/curriculum-publish';
import { TextbookUnitPublisherService } from '../src/curriculum/textbook-unit-publisher.service';

const unitId = '33333333-3333-4333-8333-333333333333';

function content(overrides: Partial<TextbookUnitContent> = {}): TextbookUnitContent {
  const base = textbookUnitContentSchema.parse({
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
    stageHint: 1,
    qcReport: { needsReview: false, issues: [] },
  });
  return { ...base, ...overrides };
}

function unitRecord(metadata: Record<string, unknown> = {}) {
  return {
    id: unitId,
    textbookId: '11111111-1111-4111-8111-111111111111',
    unitCode: 'Unit 3',
    title: 'My Family',
    order: 3,
    metadata: { grammarFocus: ['This is my ...'], ...metadata },
    textbook: { publisher: '人教版', grade: '三年级', title: '英语', edition: '上册' },
  };
}

function fakePublisher(options: {
  existingUnit?: Record<string, unknown> | null;
  existingDraft?: Record<string, unknown> | null;
  skills?: Array<{ id: string; code: string }>;
} = {}) {
  const state: {
    units: Array<Record<string, any>>;
    versions: Array<Record<string, any>>;
    items: Array<Record<string, any>>;
    vocabulary: Array<Record<string, any>>;
    draft: Record<string, any> | null;
    reviews: Array<Record<string, any>>;
    metadata: Record<string, unknown> | null;
    calls: string[];
  } = {
    units: options.existingUnit ? [{ ...options.existingUnit }] : [],
    versions: [],
    items: [],
    vocabulary: [],
    draft: options.existingDraft ? { ...options.existingDraft } : null,
    reviews: [],
    metadata: null,
    calls: [],
  };
  const skills = options.skills ?? [
    { id: 'skill-listen', code: 'LA.LISTEN.word_recognition' },
    { id: 'skill-read', code: 'SE.SCHOOL.reading' },
  ];

  const findUnit = async (args: { where?: Record<string, any> }) => {
    state.calls.push('curriculum_units.findFirst');
    const where = args?.where ?? {};
    if (where.textbookUnitId) return state.units[0] ?? null;
    if (where.topicId) {
      return state.units.find((unit) =>
        unit.topicId === where.topicId &&
        !(where.id?.not && unit.id === where.id.not),
      ) ?? null;
    }
    return state.units[0] ?? null;
  };

  const tx = {
    curriculum_units: {
      findFirst: findUnit,
      findUnique: async (args: { where: { id: string } }) => {
        state.calls.push('curriculum_units.findUnique');
        return state.units.find((unit) => unit.id === args.where.id) ?? null;
      },
      create: async (args: { data: Record<string, any> }) => {
        state.calls.push('curriculum_units.create');
        const row = { id: `cu-${state.units.length + 1}`, ...args.data };
        state.units.push(row);
        return row;
      },
      update: async (args: { where: { id: string }; data: Record<string, any> }) => {
        state.calls.push('curriculum_units.update');
        const row = state.units.find((unit) => unit.id === args.where.id);
        if (!row) throw new Error('unit missing');
        Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: { where: Record<string, any>; data: Record<string, any> }) => {
        state.calls.push('curriculum_units.updateMany');
        const rows = state.units.filter((unit) =>
          unit.id === args.where.id &&
          unit.currentVersion === args.where.currentVersion &&
          unit.reviewStatus === args.where.reviewStatus,
        );
        for (const row of rows) Object.assign(row, args.data);
        return { count: rows.length };
      },
    },
    curriculum_unit_versions: {
      findUnique: async (args: { where: { unitId_version: { unitId: string; version: number } } }) => {
        state.calls.push('curriculum_unit_versions.findUnique');
        return state.versions.find((row) =>
          row.unitId === args.where.unitId_version.unitId &&
          row.version === args.where.unitId_version.version,
        ) ?? null;
      },
      create: async (args: { data: Record<string, any> }) => {
        state.calls.push('curriculum_unit_versions.create');
        state.versions.push({ id: `ver-${state.versions.length + 1}`, ...args.data });
        return args.data;
      },
    },
    media_assets: {
      findFirst: async () => null,
      create: async () => ({ id: 'asset-1' }),
    },
    learning_items: {
      findMany: async (args: { where: { refId: { startsWith: string } } }) => {
        state.calls.push('learning_items.findMany');
        return state.items.filter((item) => item.refId.startsWith(args.where.refId.startsWith));
      },
      create: async (args: { data: Record<string, any> }) => {
        state.calls.push('learning_items.create');
        state.items.push({ id: `item-${state.items.length + 1}`, ...args.data });
        return args.data;
      },
      update: async (args: { where: { id: string }; data: Record<string, any> }) => {
        state.calls.push('learning_items.update');
        const row = state.items.find((item) => item.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: { where: { id: { in: string[] } }; data: Record<string, any> }) => {
        state.calls.push('learning_items.updateMany');
        for (const row of state.items) {
          if (args.where.id.in.includes(row.id)) Object.assign(row, args.data);
        }
      },
    },
    vocabulary_items: {
      findFirst: async (args: { where: { topicId: string; word: { equals: string } } }) => {
        state.calls.push('vocabulary_items.findFirst');
        return state.vocabulary.find((row) =>
          row.topicId === args.where.topicId &&
          row.word.toLowerCase() === args.where.word.equals.toLowerCase(),
        ) ?? null;
      },
      create: async (args: { data: Record<string, any> }) => {
        state.calls.push('vocabulary_items.create');
        state.vocabulary.push({ id: `vocab-${state.vocabulary.length + 1}`, ...args.data });
        return args.data;
      },
      update: async (args: { where: { id: string }; data: Record<string, any> }) => {
        state.calls.push('vocabulary_items.update');
        const row = state.vocabulary.find((item) => item.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      },
      updateMany: async (args: { where: Record<string, any>; data: Record<string, any> }) => {
        state.calls.push('vocabulary_items.updateMany');
        for (const row of state.vocabulary) {
          if (row.topicId === args.where.topicId) Object.assign(row, args.data);
        }
      },
    },
    curriculum_drafts: {
      update: async (args: { where: { id: string }; data: Record<string, any> }) => {
        state.calls.push('curriculum_drafts.update');
        if (!state.draft) throw new Error('draft missing');
        Object.assign(state.draft, args.data);
        return state.draft;
      },
      create: async (args: { data: Record<string, any> }) => {
        state.calls.push('curriculum_drafts.create');
        state.draft = { id: 'draft-1', ...args.data };
        return state.draft;
      },
    },
    curriculum_review_records: {
      create: async (args: { data: Record<string, any> }) => {
        state.calls.push('curriculum_review_records.create');
        state.reviews.push(args.data);
        return args.data;
      },
    },
    textbook_units: {
      update: async (args: { data: Record<string, any> }) => {
        state.calls.push('textbook_units.update');
        state.metadata = args.data.metadata;
        return args.data;
      },
    },
  };

  const prisma = {
    textbook_units: {
      findUnique: async () => unitRecord(),
      update: async (args: { data: Record<string, any> }) => {
        state.calls.push('textbook_units.update');
        state.metadata = args.data.metadata;
        return args.data;
      },
    },
    skill_nodes: {
      findMany: async () => skills,
    },
    phoneme_items: {
      findMany: async () => [],
    },
    curriculum_units: {
      findFirst: findUnit,
      findUnique: async (args: { where: { id: string } }) => {
        state.calls.push('curriculum_units.findUnique');
        return state.units.find((unit) => unit.id === args.where.id) ?? null;
      },
    },
    curriculum_unit_versions: {
      findUnique: async (args: { where: { unitId_version: { unitId: string; version: number } } }) => {
        state.calls.push('curriculum_unit_versions.findUnique');
        return state.versions.find((row) =>
          row.unitId === args.where.unitId_version.unitId &&
          row.version === args.where.unitId_version.version,
        ) ?? null;
      },
    },
    curriculum_drafts: {
      findFirst: async () => state.draft,
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  return { prisma, state };
}

describe('教材单元自动启用事务', () => {
  it('校验通过后创建 active 单元、版本、学习项、词条和审计', async () => {
    const fake = fakePublisher();
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.activate(unitId, content(), { issues: [], needsReview: false });

    assert.equal(result.activated, true);
    assert.equal(fake.state.units.length, 1);
    assert.equal(fake.state.units[0]?.availability, 'active');
    assert.equal(fake.state.units[0]?.reviewStatus, 'published');
    assert.equal(fake.state.units[0]?.currentVersion, 1);
    assert.equal(fake.state.versions.length, 1);
    assert.equal(fake.state.items.length, 1);
    assert.equal(fake.state.vocabulary.length, 2);
    assert.equal(fake.state.reviews.length, 1);
    assert.equal(fake.state.draft?.status, 'published');
    assert.equal((fake.state.metadata as { activation?: { activated?: boolean } }).activation?.activated, true);
  });

  it('校验失败时不创建 active 单元，只把可定位 issues 写回质检报告', async () => {
    const invalid = content();
    invalid.passage.paragraphs[0]!.sentences[0]!.zh = '（第 1 句译文待补充）';
    const fake = fakePublisher();
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.activate(unitId, invalid, { issues: [], needsReview: false });

    assert.equal(result.activated, false);
    assert.equal(fake.state.units.length, 0);
    assert.ok(result.validation.errors.some((issue) => issue.code === 'sentence_zh_placeholder'));
    const report = fake.state.metadata as { needsReview?: boolean; qcReport?: { validation?: { errors?: Array<{ code: string; path: string }> } } };
    assert.equal(report.needsReview, true);
    assert.ok(report.qcReport?.validation?.errors?.some((issue) => issue.code === 'sentence_zh_placeholder'));
  });

  it('已存在单元时递增版本并重新启用，保留旧版本快照', async () => {
    const oldContent = content({ resourceType: 'textbook_unit' } as never);
    const fake = fakePublisher({
      existingUnit: {
        id: 'cu-old',
        topicId: 'topic-old',
        currentVersion: 1,
        contentVersion: 'old-hash',
        availability: 'disabled',
        reviewStatus: 'published',
        content: oldContent,
      },
    });
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.activate(unitId, content(), { issues: [], needsReview: false });

    assert.equal(result.activated, true);
    assert.equal(fake.state.units[0]?.availability, 'active');
    assert.equal(fake.state.units[0]?.currentVersion, 2);
    assert.equal(fake.state.versions.length, 2);
    assert.ok(fake.state.versions.some((row) => row.version === 1 && row.note === '补录自动启用前版本'));
    assert.equal(fake.state.draft?.status, 'published');
  });

  it('内容哈希一致时不重复创建版本', async () => {
    const stable = content();
    const { qcReport: _qc, ...withoutReport } = stable;
    const fake = fakePublisher({
      existingUnit: {
        id: 'cu-old',
        topicId: 'topic-old',
        currentVersion: 1,
        contentVersion: contentHash(withoutReport),
        availability: 'active',
        reviewStatus: 'published',
        content: stable,
      },
    });
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.activate(unitId, stable, { issues: [], needsReview: false });

    assert.equal(result.activated, true);
    assert.equal(result.version, 1);
    assert.equal(fake.state.versions.length, 0);
  });

  it('能力节点不存在时不启用', async () => {
    const fake = fakePublisher({ skills: [] });
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.activate(unitId, content(), { issues: [], needsReview: false });

    assert.equal(result.activated, false);
    assert.equal(fake.state.units.length, 0);
    assert.ok(result.validation.errors.some((issue) => issue.code === 'activity_skill_node_unknown'));
  });
});

describe('P1-07 教材单元编辑与回滚', () => {
  function publishedUnit(options: { availability?: string } = {}) {
    const currentContent = content();
    return fakePublisher({
      existingUnit: {
        id: 'cu-1',
        textbookUnitId: unitId,
        topicId: 'topic-1',
        currentVersion: 1,
        contentVersion: 'old-hash',
        availability: options.availability ?? 'active',
        reviewStatus: 'published',
        publishedAt: new Date(),
        content: currentContent,
      },
      existingDraft: {
        id: 'draft-1',
        topicId: 'topic-1',
        status: 'published',
        version: 4,
        title: currentContent.unit.title,
        level: 'A1',
        wordList: currentContent.vocabulary.map((item) => item.word),
        generatedContent: currentContent,
      },
    });
  }

  it('编辑生成新版本并同步 unit、学习项、词条、草稿与审计', async () => {
    const fake = publishedUnit();
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const edited = content({ unit: { code: 'Unit 3', title: 'My Family 修订版', order: 3 } });
    const result = await publisher.updateTextbookUnit(unitId, edited, 1, 'admin', '修正标题');

    assert.equal(result.updated, true);
    assert.equal(result.version, 2);
    assert.equal(fake.state.units[0]?.title, 'My Family 修订版');
    assert.equal(fake.state.units[0]?.currentVersion, 2);
    const version2 = fake.state.versions.find((row) => row.version === 2);
    assert.ok(version2);
    assert.ok((version2.content as TextbookUnitContent).qcReport);
    assert.equal((fake.state.draft?.generatedContent as TextbookUnitContent).unit.title, 'My Family 修订版');
    assert.ok(fake.state.items.length > 0);
    assert.ok(fake.state.vocabulary.length > 0);
    assert.ok(fake.state.reviews.some((row) => row.action === 'edited'));
    assert.equal((fake.state.metadata as { lastEditedAt?: string }).lastEditedAt !== undefined, true);
  });

  it('编辑校验失败时不覆盖线上内容且不创建版本', async () => {
    const fake = publishedUnit();
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const invalid = content();
    invalid.passage.paragraphs[0]!.sentences[0]!.zh = '（译文待补充）';
    const result = await publisher.updateTextbookUnit(unitId, invalid, 1, 'admin');

    assert.equal(result.updated, false);
    assert.ok(result.validation.errors.some((issue) => issue.code === 'sentence_zh_placeholder'));
    assert.equal(fake.state.units[0]?.currentVersion, 1);
    assert.equal(fake.state.versions.length, 0);
    assert.equal(fake.state.reviews.length, 0);
  });

  it('编辑下架中的单元不会擅自重新启用', async () => {
    const fake = publishedUnit({ availability: 'disabled' });
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.updateTextbookUnit(unitId, content(), 1, 'admin');

    assert.equal(result.updated, true);
    assert.equal(result.availability, 'disabled');
    assert.equal(fake.state.units[0]?.availability, 'disabled');
    assert.ok(fake.state.items.every((item) => item.reviewStatus === 'disabled'));
  });

  it('编辑 expectedVersion 不匹配时返回冲突且不写入', async () => {
    const fake = publishedUnit();
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    await assert.rejects(
      publisher.updateTextbookUnit(unitId, content(), 99, 'admin'),
      /其他操作修改/,
    );
    assert.equal(fake.state.units[0]?.currentVersion, 1);
    assert.equal(fake.state.versions.length, 0);
  });

  it('回滚复制历史快照为新版本并保留 active 状态', async () => {
    const old = content();
    old.unit = { ...old.unit, title: '旧版家庭' };
    const currentContent = content();
    currentContent.unit = { ...currentContent.unit, title: '新版家庭' };
    const fake = fakePublisher({
      existingUnit: {
        id: 'cu-1',
        textbookUnitId: unitId,
        topicId: 'topic-1',
        currentVersion: 2,
        contentVersion: 'current-hash',
        availability: 'active',
        reviewStatus: 'published',
        publishedAt: new Date(),
        content: currentContent,
      },
      existingDraft: {
        id: 'draft-1',
        topicId: 'topic-1',
        status: 'published',
        version: 4,
        title: currentContent.unit.title,
        level: 'A1',
        wordList: currentContent.vocabulary.map((item) => item.word),
        generatedContent: currentContent,
      },
    });
    fake.state.versions.push(
      { id: 'ver-1', unitId: 'cu-1', version: 1, content: old, contentHash: 'old-hash' },
      { id: 'ver-2', unitId: 'cu-1', version: 2, content: currentContent, contentHash: 'current-hash' },
    );
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.rollbackTextbookUnit('cu-1', 1, '发音错误', 'admin');

    assert.equal(result.updated, true);
    assert.equal(result.rolledBack, true);
    assert.equal(result.sourceVersion, 1);
    assert.equal(result.version, 3);
    assert.equal(fake.state.units[0]?.title, '旧版家庭');
    assert.equal(fake.state.units[0]?.currentVersion, 3);
    assert.equal(fake.state.units[0]?.availability, 'active');
    assert.ok(fake.state.versions.some((row) => row.version === 3));
    assert.ok(fake.state.reviews.some((row) => row.action === 'rolled_back'));
  });

  it('回滚到无法通过校验的历史版本时拒绝写入', async () => {
    const broken = content();
    broken.passage.paragraphs[0]!.sentences[0]!.zh = '（译文待补充）';
    const fake = fakePublisher({
      existingUnit: {
        id: 'cu-1',
        textbookUnitId: unitId,
        topicId: 'topic-1',
        currentVersion: 2,
        contentVersion: 'current-hash',
        availability: 'active',
        reviewStatus: 'published',
        content: content(),
      },
      existingDraft: { id: 'draft-1', topicId: 'topic-1', status: 'published', version: 1 },
    });
    fake.state.versions.push({ id: 'ver-1', unitId: 'cu-1', version: 1, content: broken, contentHash: 'broken' });
    const publisher = new TextbookUnitPublisherService(fake.prisma as never);
    const result = await publisher.rollbackTextbookUnit('cu-1', 1, undefined, 'admin');

    assert.equal(result.updated, false);
    assert.ok(result.validation.errors.some((issue) => issue.code === 'sentence_zh_placeholder'));
    assert.equal(fake.state.units[0]?.currentVersion, 2);
    assert.equal(fake.state.versions.length, 1);
  });
});

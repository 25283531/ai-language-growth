import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CurriculumAdminController } from '../src/curriculum/curriculum-admin.controller.ts';

const textbookId = '11111111-1111-4111-8111-111111111111';
const unitId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-11-18T10:00:00.000Z');

type Call = { model: string; action: string; args?: unknown };

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    id: textbookId,
    publisher: '人教版',
    publicationYear: 2024,
    grade: '三年级',
    title: '英语',
    edition: '上册',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup(options: {
  existing?: { metadata: unknown; passageSource: string | null } | null;
  units?: unknown[];
  detail?: unknown;
  catalog?: Record<string, unknown>;
  textbookCreate?: boolean;
  published?: Record<string, unknown> | null;
  publishedUnits?: unknown[];
  mapping?: Record<string, unknown> | null;
  textbookUnits?: { generate: (id: string) => Promise<unknown> };
  publisher?: { activate: (...args: never[]) => Promise<unknown> };
  lexicon?: { textbookUnitCoverage: (id: string) => Promise<unknown> };
} = {}) {
  const calls: Call[] = [];
  const textbook = options.catalog ?? catalog();
  const prisma = {
    textbook_catalogs: {
      findUnique: async (args: unknown) => {
        calls.push({ model: 'catalog', action: 'findUnique', args });
        return textbook;
      },
      findFirst: async (args: unknown) => {
        calls.push({ model: 'catalog', action: 'findFirst', args });
        return options.textbookCreate ? null : textbook;
      },
      create: async (args: unknown) => {
        calls.push({ model: 'catalog', action: 'create', args });
        return { ...textbook, id: '22222222-2222-4222-8222-222222222222' };
      },
    },
    curriculum_units: {
      findMany: async (args: unknown) => {
        calls.push({ model: 'curriculumUnit', action: 'findMany', args });
        return options.publishedUnits ?? [];
      },
      findFirst: async (args: unknown) => {
        calls.push({ model: 'curriculumUnit', action: 'findFirst', args });
        return options.published ?? null;
      },
    },
    textbook_units: {
      findUnique: async (args: unknown) => {
        calls.push({ model: 'unit', action: 'findUnique', args });
        return options.detail === undefined ? (options.existing ?? null) : options.detail;
      },
      findMany: async (args: unknown) => {
        calls.push({ model: 'unit', action: 'findMany', args });
        return options.units ?? [];
      },
      upsert: async (args: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        calls.push({ model: 'unit', action: 'upsert', args });
        const selected = args.create;
        return {
          id: unitId,
          textbookId,
          unitCode: selected.unitCode,
          title: selected.title,
          order: selected.order,
          passageSource: selected.passageSource,
          metadata: selected.metadata,
          createdAt: now,
          updatedAt: now,
          textbook,
        };
      },
    },
    textbook_unit_mappings: {
      findUnique: async (args: unknown) => {
        calls.push({ model: 'mapping', action: 'findUnique', args });
        return options.mapping ?? null;
      },
      upsert: async (args: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        calls.push({ model: 'mapping', action: 'upsert', args });
        const update = { ...args.update };
        const increment = typeof update.version === 'object' && update.version && 'increment' in update.version
          ? Number((update.version as { increment: number }).increment)
          : 0;
        delete update.version;
        if (!options.mapping) {
          return {
            id: '44444444-4444-4444-8444-444444444444',
            ...args.create,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
        }
        return {
          id: '44444444-4444-4444-8444-444444444444',
          ...args.create,
          ...update,
          version: Number(options.mapping.version ?? 1) + increment,
          createdAt: now,
          updatedAt: now,
        };
      },
      deleteMany: async (args: unknown) => {
        calls.push({ model: 'mapping', action: 'deleteMany', args });
        return { count: options.mapping ? 1 : 0 };
      },
    },
  };
  const auth = { resolveRequest: () => 'admin' };
  const controller = new CurriculumAdminController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    auth as never,
    {} as never,
    {} as never,
    options.lexicon as never,
    options.textbookUnits as never,
    options.publisher as never,
  );
  return { controller, calls, auth, textbook };
}

const baseBody = {
  textbookId,
  unit: { code: 'Unit 3', title: 'My Family', order: 3 },
  passage: 'This is my family. This is my mother.',
};

const mappingUnit = {
  id: unitId,
  textbookId,
  unitCode: 'Unit 2',
  title: 'Letters and phonics 字母与拼读',
  order: 2,
  passageSource: 'A is for apple.',
  metadata: { grammarFocus: [], schoolModules: [] },
  createdAt: now,
  updatedAt: now,
  textbook: catalog(),
};

describe('教材单元映射 API', () => {
  it('要求管理员鉴权并校验 unitId', async () => {
    const { controller, auth } = setup({ detail: mappingUnit });
    auth.resolveRequest = () => { throw new Error('unauthorized'); };
    await assert.rejects(controller.getTextbookUnitMapping(undefined, unitId), /unauthorized/);
    auth.resolveRequest = () => 'admin';
    await assert.rejects(controller.getTextbookUnitMapping('cookie', 'not-a-uuid'), /unitId/);
  });

  it('没有显式映射时返回确定性推断结果和节点选项', async () => {
    const { controller } = setup({ detail: mappingUnit });
    const result = await controller.getTextbookUnitMapping('cookie', unitId) as {
      stored: unknown;
      effective: { skillNodeIds: string[]; schoolModules: string[]; origin: string };
      skillNodeOptions: Array<{ id: string }>;
    };
    assert.equal(result.stored, null);
    assert.equal(result.effective.origin, 'inferred');
    assert.deepEqual(result.effective.schoolModules, ['A', 'B']);
    assert.ok(result.effective.skillNodeIds.includes('SE.SCHOOL.letters'));
    assert.ok(result.skillNodeOptions.some((node) => node.id === 'SE.SCHOOL.letters'));
  });

  it('保存映射时拒绝图谱中不存在的能力节点', async () => {
    const { controller } = setup({ detail: mappingUnit });
    await assert.rejects(controller.saveTextbookUnitMapping('cookie', unitId, {
      skillNodeIds: ['NOT.A.NODE'],
      domains: [],
      schoolModules: ['A'],
      source: 'editorial',
    }), /能力图谱/);
  });

  it('保存映射后返回递增版本与生效的学校模块', async () => {
    const { controller, calls } = setup({ detail: mappingUnit });
    const result = await controller.saveTextbookUnitMapping('cookie', unitId, {
      skillNodeIds: ['LA.VOCAB.receptive', 'SE.SCHOOL.letters', 'SE.SCHOOL.reading'],
      domains: ['letters', 'phonics'],
      schoolModules: ['C', 'A'],
      stageHint: 2,
      source: 'editorial',
    }) as {
      stored: { version: number; schoolModules: string[] };
      effective: { origin: string; stageHint: number | null };
    };
    assert.equal(result.stored.version, 1);
    assert.deepEqual(result.stored.schoolModules, ['A', 'C']);
    assert.equal(result.effective.origin, 'stored');
    assert.equal(result.effective.stageHint, 2);
    const upsert = calls.find((call) => call.model === 'mapping' && call.action === 'upsert');
    assert.ok(upsert);
  });

  it('删除映射后回退到自动推断', async () => {
    const { controller } = setup({ detail: mappingUnit, mapping: {
      id: '44444444-4444-4444-8444-444444444444',
      textbookId,
      unitCode: 'Unit 2',
      skillNodeIds: ['SE.SCHOOL.letters'],
      domains: [],
      schoolModules: ['A'],
      stageHint: null,
      source: 'editorial',
      version: 2,
      createdAt: now,
      updatedAt: now,
    } });
    const result = await controller.deleteTextbookUnitMapping('cookie', unitId) as {
      deleted: boolean;
      stored: unknown;
      effective: { origin: string };
    };
    assert.equal(result.deleted, true);
    assert.equal(result.stored, null);
    assert.equal(result.effective.origin, 'inferred');
  });
});

describe('POST textbook/units 单元录入', () => {
  it('要求管理员鉴权', async () => {
    const { controller, auth } = setup();
    auth.resolveRequest = () => { throw new Error('unauthorized'); };
    await assert.rejects(controller.upsertTextbookUnit(undefined, baseBody), /unauthorized/);
  });

  it('生成接口要求管理员鉴权、校验 unitId，并把服务结果原样返回', async () => {
    let generated = '';
    const { controller, auth } = setup({
      textbookUnits: {
        generate: async (id: string) => {
          generated = id;
          return { unitId: id, unitCode: 'Unit 3', needsReview: false, content: { resourceType: 'textbook_unit' } };
        },
      },
    });
    auth.resolveRequest = () => { throw new Error('unauthorized'); };
    await assert.rejects(controller.generateTextbookUnit(undefined, unitId), /unauthorized/);
    auth.resolveRequest = () => 'admin';
    await assert.rejects(controller.generateTextbookUnit('cookie', 'not-a-uuid'), /unitId/);
    const result = await controller.generateTextbookUnit('cookie', unitId) as { unitCode: string; needsReview: boolean };
    assert.equal(generated, unitId);
    assert.equal(result.unitCode, 'Unit 3');
    assert.equal(result.needsReview, false);

    auth.resolveRequest = () => { throw new Error('unauthorized'); };
    await assert.rejects(controller.generateTextbookUnit('cookie', unitId), /unauthorized/);
  });

  it('自动校验失败时返回可定位 issues，不把未启用的结果当成功', async () => {
    const { controller } = setup({
      textbookUnits: {
        generate: async (id: string) => ({
          unitId: id,
          unitCode: 'Unit 3',
          generatedAt: now.toISOString(),
          needsReview: true,
          qcReport: { issues: [] },
          content: { resourceType: 'textbook_unit' },
        }),
      },
      publisher: {
        activate: async () => ({
          activated: false,
          validation: {
            ok: false,
            checkedAt: now.toISOString(),
            errors: [{ code: 'sentence_zh_placeholder', path: 'passage.paragraphs.0.sentences.0.zh', message: '占位译文' }],
            warnings: [],
            issues: [],
            stats: {},
            checks: {},
          },
        }),
      },
    });
    await assert.rejects(
      controller.generateTextbookUnit('cookie', unitId),
      (error: { getResponse?: () => { issues?: Array<{ path?: string }> } }) => {
        const response = error.getResponse?.();
        return response?.issues?.[0]?.path === 'passage.paragraphs.0.sentences.0.zh';
      },
    );
  });

  it('缺少教材、空课文或非法学校模块时拒绝，且不写库', async () => {
    const { controller, calls } = setup();
    for (const body of [
      { unit: baseBody.unit, passage: baseBody.passage },
      { ...baseBody, passage: '   ' },
      { ...baseBody, schoolModules: ['F'] },
      { ...baseBody, unit: { ...baseBody.unit, code: '' } },
    ]) {
      await assert.rejects(controller.upsertTextbookUnit('cookie', body));
    }
    assert.equal(calls.length, 0);
  });

  it('12 句课文切出 12 个稳定句子对象，并保存原文、词表与录入提示', async () => {
    const { controller, calls } = setup();
    const sentences = Array.from({ length: 12 }, (_, index) => `This is sentence number ${index + 1}.`);
    const passage = sentences.join(' ');
    const result = await controller.upsertTextbookUnit('cookie', {
      ...baseBody,
      passage,
      words: '1. family\nmother\nmother',
      grammarFocus: 'This is my family.',
      schoolModules: ['A', 'B'],
      objectives: '认识家庭成员\n能介绍家人',
    });
    assert.equal(result.sentences.length, 12);
    assert.equal((result.sentences[0] as { id: string }).id, 'Unit-3-s01');
    assert.equal((result.sentences[11] as { id: string }).id, 'Unit-3-s12');
    assert.equal(result.passageSource, passage);
    assert.deepEqual(result.words, ['family', 'mother']);
    assert.deepEqual(result.grammarFocus, ['This is my family.']);
    assert.deepEqual(result.schoolModules, ['A', 'B']);
    assert.deepEqual(result.objectives, ['认识家庭成员', '能介绍家人']);
    assert.equal(result.autoPublish, true);
    const upsert = calls.find((call) => call.action === 'upsert');
    const args = upsert?.args as { where: unknown; create: Record<string, unknown> };
    assert.deepEqual(args.where, { textbookId_unitCode: { textbookId, unitCode: 'Unit 3' } });
    assert.equal(args.create.passageSource, passage);
    const metadata = args.create.metadata as { passage: { paragraphs: Array<{ sentences: unknown[] }> } };
    assert.equal(metadata.passage.paragraphs.length, 1);
    assert.equal(metadata.passage.paragraphs[0]!.sentences.length, 12);
  });

  it('编辑已有单元时复用未变句子的 id，新句取最大序号 + 1', async () => {
    const { controller, calls } = setup({
      existing: {
        passageSource: 'Hello. Bye.',
        metadata: {
          passage: {
            title: 'My Family',
            paragraphs: [
              { sentences: [{ id: 'Unit-3-s01', en: 'Hello.' }, { id: 'Unit-3-s02', en: 'Bye.' }] },
            ],
          },
        },
      },
    });
    const result = await controller.upsertTextbookUnit('cookie', {
      ...baseBody,
      passage: 'Hello. Bye. A new sentence.',
    });
    assert.deepEqual(result.sentences.map((sentence) => (sentence as { id: string }).id), [
      'Unit-3-s01',
      'Unit-3-s02',
      'Unit-3-s03',
    ]);
    assert.equal(calls.filter((call) => call.model === 'unit' && call.action === 'findUnique').length, 1);
    assert.equal(calls.filter((call) => call.action === 'upsert').length, 1);
  });

  it('原文未变时保留已有译文、关键词等句子生成结果', async () => {
    const { controller, calls } = setup({
      existing: {
        passageSource: 'Hello.',
        metadata: {
          passage: {
            title: 'My Family',
            paragraphs: [{ sentences: [{ id: 'Unit-3-s01', en: 'Hello.', zh: '你好', keywords: ['hello'] }] }],
          },
        },
      },
    });
    await controller.upsertTextbookUnit('cookie', { ...baseBody, passage: 'Hello.' });
    const upsert = calls.find((call) => call.action === 'upsert')?.args as {
      create: { metadata: { passage: { paragraphs: Array<{ sentences: Array<Record<string, unknown>> }> } } };
    };
    assert.equal(upsert.create.metadata.passage.paragraphs[0]!.sentences[0]!.zh, '你好');
    assert.deepEqual(upsert.create.metadata.passage.paragraphs[0]!.sentences[0]!.keywords, ['hello']);
  });

  it('原文变化时清除过期资源包，显式传入 content 则保留', async () => {
    const { controller, calls } = setup({
      existing: {
        passageSource: 'Old text.',
        metadata: { content: { resourceType: 'textbook_unit' }, custom: 'keep' },
      },
    });
    await controller.upsertTextbookUnit('cookie', baseBody);
    const withoutContent = calls.find((call) => call.action === 'upsert')?.args as { create: { metadata: Record<string, unknown> } };
    assert.equal('content' in withoutContent.create.metadata, false);
    assert.equal(withoutContent.create.metadata.custom, 'keep');
  });

  it('textbook 对象可新建教材版本，并把 volume 写入单元 metadata', async () => {
    const { controller, calls } = setup({ textbookCreate: true });
    await controller.upsertTextbookUnit('cookie', {
      textbook: {
        publisher: '外研社',
        publicationYear: 2025,
        grade: '四年级',
        volume: '上册',
        edition: '2025 版',
      },
      unit: { code: 'M1', title: 'Hello', order: 1 },
      passage: 'Hello, children.',
    });
    const created = calls.find((call) => call.action === 'create')?.args as { data: Record<string, unknown> };
    assert.equal(created.data.title, '上册');
    assert.equal(created.data.edition, '2025 版');
    const upsert = calls.find((call) => call.action === 'upsert')?.args as { create: { metadata: { textbook: { volume: string } } } };
    assert.equal(upsert.create.metadata.textbook.volume, '上册');
  });

  it('content 使用 textbookUnitContentSchema 校验，非法资源包在写库前拒绝', async () => {
    const { controller, calls } = setup();
    await assert.rejects(
      controller.upsertTextbookUnit('cookie', {
        ...baseBody,
        content: { resourceType: 'textbook_unit' },
      }),
    );
    assert.equal(calls.length, 0);
  });

  it('超过 8,000 字符的原文拒绝', async () => {
    const { controller } = setup();
    await assert.rejects(controller.upsertTextbookUnit('cookie', { ...baseBody, passage: 'a'.repeat(8001) }));
  });
});

describe('GET textbook/units 单元列表与详情', () => {  it('词库覆盖接口校验鉴权与 unitId，并返回统计结果', async () => {
    const coverage = {
      counts: { total: 2, covered: 2, newWords: 1, reusedWords: 1, gaps: 0 },
      hitRate: 1,
      newWords: [{ word: 'family', matchedWord: 'family' }],
      reusedWords: [{ word: 'mother', matchedWord: 'mother', priorUnitCodes: ['Unit 1'] }],
      gaps: [],
    };
    const { controller, auth } = setup({ lexicon: { textbookUnitCoverage: async () => coverage } });

    await assert.rejects(controller.textbookUnitLexiconCoverage('cookie', 'not-a-uuid'), /unitId/);
    auth.resolveRequest = () => { throw new Error('unauthorized'); };
    await assert.rejects(controller.textbookUnitLexiconCoverage('cookie', unitId), /unauthorized/);
    auth.resolveRequest = () => 'admin';
    assert.deepEqual(await controller.textbookUnitLexiconCoverage('cookie', unitId), coverage);
  });

  it('词库覆盖接口在单元不存在或词库服务未启用时拒绝', async () => {
    const missing = setup({ lexicon: { textbookUnitCoverage: async () => null } });
    await assert.rejects(missing.controller.textbookUnitLexiconCoverage('cookie', unitId), /不存在/);

    const disabled = setup();
    await assert.rejects(disabled.controller.textbookUnitLexiconCoverage('cookie', unitId), /词库服务未启用/);
  });

  it('按教材和关键词过滤，并返回切句/词表摘要', async () => {
    const unit = {
      id: unitId,
      textbookId,
      unitCode: 'Unit 3',
      title: 'My Family',
      order: 3,
      passageSource: 'This is my family.',
      metadata: {
        passage: { title: 'My Family', paragraphs: [{ sentences: [{ id: 'Unit-3-s01', en: 'This is my family.' }] }] },
        words: ['family'],
        schoolModules: ['A'],
        objectives: ['认识家庭成员'],
        autoPublish: true,
      },
      createdAt: now,
      updatedAt: now,
      textbook: catalog(),
    };
    const { controller, calls } = setup({
      units: [unit],
      publishedUnits: [{
        id: 'cu-1',
        textbookUnitId: unitId,
        currentVersion: 2,
        contentVersion: 'hash-2',
        availability: 'active',
        reviewStatus: 'approved',
      }],
    });
    const result = await controller.listTextbookUnits('cookie', textbookId, 'Family', '50');
    assert.equal(result.length, 1);
    assert.equal(result[0]!.unitCode, 'Unit 3');
    assert.equal(result[0]!.sentences.length, 1);
    assert.deepEqual(result[0]!.words, ['family']);
    assert.equal(result[0]!.publishedUnitId, 'cu-1');
    assert.equal(result[0]!.currentVersion, 2);
    assert.equal(result[0]!.availability, 'active');
    const findMany = calls.find((call) => call.action === 'findMany')?.args as {
      where: { textbookId: string; OR: unknown[] };
      take: number;
    };
    assert.equal(findMany.where.textbookId, textbookId);
    assert.equal(findMany.take, 50);
    assert.equal(findMany.where.OR.length, 2);
  });

  it('详情返回 404，非法 unitId 返回 400', async () => {
    const { controller } = setup({ detail: null });
    await assert.rejects(controller.getTextbookUnit('cookie', 'not-a-uuid'), /unitId/);
    await assert.rejects(controller.getTextbookUnit('cookie', unitId), /不存在/);
  });

  it('详情返回原文、已生成内容和教材 volume', async () => {
    const unit = {
      id: unitId,
      textbookId,
      unitCode: 'Unit 3',
      title: 'My Family',
      order: 3,
      passageSource: 'This is my family.',
      metadata: {
        textbook: { volume: '上册', edition: '2024 版' },
        passage: { title: 'My Family', paragraphs: [{ sentences: [{ id: 'Unit-3-s01', en: 'This is my family.' }] }] },
        content: { resourceType: 'textbook_unit' },
      },
      createdAt: now,
      updatedAt: now,
      textbook: catalog(),
    };
    const { controller } = setup({
      detail: unit,
      published: {
        id: 'cu-1',
        textbookUnitId: unitId,
        currentVersion: 3,
        contentVersion: 'hash-3',
        availability: 'active',
        reviewStatus: 'approved',
      },
    });
    const result = await controller.getTextbookUnit('cookie', unitId);
    assert.equal(result.passageSource, 'This is my family.');
    assert.equal(result.textbook?.volume, '上册');
    assert.deepEqual(result.content, { resourceType: 'textbook_unit' });
    assert.equal(result.currentVersion, 3);
    assert.equal(result.publishedUnitId, 'cu-1');
    assert.equal(result.reviewStatus, 'approved');
  });
});

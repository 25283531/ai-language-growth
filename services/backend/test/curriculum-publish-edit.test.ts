import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CurriculumAdminController } from '../src/curriculum/curriculum-admin.controller.ts';

const draftId = '11111111-1111-4111-8111-111111111111';
const unitId = '33333333-3333-4333-8333-333333333333';

const content = {
  title: '动物',
  level: 'pre-A1',
  objectives: ['听懂动物名称'],
  vocabulary: [{
    word: 'cat',
    phonetic: '/kæt/',
    meaningZh: '猫',
    syllables: ['cat'],
    difficultPhonemes: [],
    phrases: ['a cat'],
    exampleSentences: ['This is a cat.'],
  }],
  activities: [{
    taskType: 'word_mimicry',
    scenario: 'object_pic_scene',
    targetWords: ['cat'],
    teacherUtteranceZh: '请跟读',
    demonstrationText: 'cat',
    skillNodeIds: ['LA.VOCAB.receptive'],
    requiresPronunciationAssessment: true,
    requiresAsr: false,
    difficulty: 1,
    assessment: { acceptedTexts: ['cat'], acceptedImageIds: [], requiredPhrases: [], openResponse: false },
  }],
  images: [],
};

type Call = { model: string; action: string; data?: unknown; where?: unknown };

function setup(options: { status?: string; version?: number; expectedVersion?: number; noPublishedReview?: boolean; claimCount?: number; currentVersionExists?: boolean; availability?: string } = {}) {
  const calls: Call[] = [];
  const draft = {
    id: draftId,
    title: '动物',
    level: 'pre-A1',
    topicId: 'topic-1',
    textbookUnitId: null,
    status: options.status ?? 'generated',
    version: options.version ?? 1,
    reviewedBy: 'admin',
    wordList: ['cat'],
    generatedContent: content,
  };
  const tx = {
    curriculum_units: {
      create: async ({ data }: { data: unknown }) => {
        calls.push({ model: 'unit', action: 'create', data });
        return { id: unitId, topicId: 'topic-1' };
      },
      findUnique: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'unit', action: 'findUnique', where });
        return { id: unitId, topicId: 'topic-1', currentVersion: 1, availability: 'active', reviewStatus: 'published' };
      },
      update: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'unit', action: 'update', where, data });
        return { id: unitId, topicId: 'topic-1' };
      },
      updateMany: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'unit', action: 'updateMany', where, data });
        return { count: 1 };
      },
    },
    media_assets: {
      findFirst: async () => null,
      create: async ({ data }: { data: unknown }) => {
        calls.push({ model: 'media', action: 'create', data });
        return { id: 'image-1' };
      },
    },
    learning_items: {
      findMany: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'item', action: 'findMany', where });
        return options.status === 'published' ? [{ id: 'item-1', refId: `${unitId}:0` }] : [];
      },
      create: async ({ data }: { data: unknown }) => {
        calls.push({ model: 'item', action: 'create', data });
        return { id: 'item-new' };
      },
      update: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'item', action: 'update', where, data });
        return { id: 'item-1' };
      },
      updateMany: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'item', action: 'updateMany', where, data });
        return { count: 0 };
      },
    },
    vocabulary_items: {
      findFirst: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'vocab', action: 'findFirst', where });
        return options.status === 'published' ? { id: 'vocab-1' } : null;
      },
      create: async ({ data }: { data: unknown }) => {
        calls.push({ model: 'vocab', action: 'create', data });
        return { id: 'vocab-new' };
      },
      update: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'vocab', action: 'update', where, data });
        return { id: 'vocab-1' };
      },
      updateMany: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'vocab', action: 'updateMany', where, data });
        return { count: 1 };
      },
    },
    curriculum_unit_versions: {
      findUnique: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'version', action: 'findUnique', where });
        return options.currentVersionExists ? { id: 'version-1' } : null;
      },
      create: async ({ data }: { data: unknown }) => {
        calls.push({ model: 'version', action: 'create', data });
        return { id: 'version-new' };
      },
    },
    curriculum_drafts: {
      updateMany: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'draft', action: 'updateMany', where, data });
        return { count: options.claimCount ?? 1 };
      },
      findUnique: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'draft', action: 'findUnique', where });
        return { ...draft, status: 'published', version: draft.version + 1 };
      },
      update: async ({ where, data }: { where: unknown; data: unknown }) => {
        calls.push({ model: 'draft', action: 'update', where, data });
        return { ...draft, status: 'published', version: draft.version + 1 };
      },
    },
    curriculum_review_records: {
      create: async ({ data }: { data: unknown }) => {
        calls.push({ model: 'audit', action: 'create', data });
        return { id: 'audit-1' };
      },
    },
  };
  const prisma = {
    curriculum_drafts: {
      findUnique: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'draft', action: 'findUnique', where });
        return draft;
      },
    },
    curriculum_units: {
      findUnique: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'unit', action: 'findUnique', where });
        return { id: unitId, topicId: 'topic-1', currentVersion: 1, availability: options.availability ?? 'active', reviewStatus: 'published' };
      },
    },
    curriculum_unit_versions: {
      findUnique: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'version', action: 'findUnique', where });
        return { id: 'version-1', unitId, version: 1, content, contentHash: 'hash-1' };
      },
    },
    curriculum_review_records: {
      findFirst: async ({ where }: { where: unknown }) => {
        calls.push({ model: 'audit', action: 'findFirst', where });
        return options.noPublishedReview ? null : { draftId, snapshot: { unitId } };
      },
      findMany: async () => options.noPublishedReview ? [] : [{ draftId, snapshot: { unitId } }],
    },
    skill_nodes: {
      findMany: async () => [{ id: 'skill-1', code: 'LA.VOCAB.receptive' }],
    },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  };
  const controller = new CurriculumAdminController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    { resolveRequest: () => 'admin' } as never,
  );
  return { controller, calls };
}

describe('P0 发布门禁与已上线内容编辑', () => {
  it('generated 草稿可直接发布，并写入 learning_items 与 vocabulary_items', async () => {
    const { controller, calls } = setup();
    const result = await controller.publishDraft('cookie', draftId);

    assert.equal(result.draft.status, 'published');
    assert.ok(calls.some((call) => call.model === 'unit' && call.action === 'create'));
    assert.ok(calls.some((call) => call.model === 'item' && call.action === 'create'));

    const vocab = calls.find((call) => call.model === 'vocab' && call.action === 'create');
    assert.ok(vocab, '发布必须写入 vocabulary_items');
    const data = vocab.data as Record<string, unknown>;
    assert.equal(data.word, 'cat');
    assert.equal(data.phonetic, '/kæt/');
    assert.equal(data.meaningZh, '猫');
    assert.equal(data.reviewStatus, 'published');
    assert.deepEqual(data.exampleSentences, [{ en: 'This is a cat.', zh: '' }]);
    assert.deepEqual(data.skillNodeIds, ['skill-1']);
  });

  it('已发布草稿拒绝重复发布，避免生成第二个 unit', async () => {
    const { controller, calls } = setup({ status: 'published' });
    await assert.rejects(controller.publishDraft('cookie', draftId), /不能发布/);
    assert.equal(calls.filter((call) => call.model === 'unit').length, 0);
  });

  it('并发发布时只有抢到状态声明的请求能创建 unit', async () => {
    const { controller, calls } = setup({ status: 'generated', claimCount: 0 });
    await assert.rejects(controller.publishDraft('cookie', draftId), /已被发布|状态已变化/);
    assert.equal(calls.filter((call) => call.model === 'unit').length, 0);
    assert.equal(calls.filter((call) => call.model === 'item' && call.action === 'create').length, 0);
    assert.equal(calls.filter((call) => call.model === 'vocab' && call.action === 'create').length, 0);
  });

  it('编辑已上线内容会更新原 unit、learning_items 与 vocabulary_items', async () => {
    const { controller, calls } = setup({ status: 'published', version: 3 });
    const result = await controller.updateDraftContent('cookie', draftId, { ...content, expectedVersion: 3 });

    assert.equal(result.unitId, unitId);
    assert.ok(calls.some((call) => call.model === 'unit' && call.action === 'updateMany'));
    assert.ok(calls.some((call) => call.model === 'version' && call.action === 'create'));
    assert.ok(!calls.some((call) => call.model === 'unit' && call.action === 'create'));
    assert.ok(calls.some((call) => call.model === 'item' && call.action === 'update'));
    assert.ok(calls.some((call) => call.model === 'vocab' && call.action === 'update'));
    assert.ok(calls.some((call) => {
      const data = call.data as { reviewStatus?: string } | undefined;
      return call.model === 'vocab' && call.action === 'updateMany' && data?.reviewStatus === 'archived';
    }));
    assert.ok(calls.some((call) => {
      const data = call.data as { action?: string } | undefined;
      return call.model === 'audit' && data?.action === 'edited';
    }));
  });

  it('编辑已上线内容的 expectedVersion 不匹配时返回冲突且不写入', async () => {
    const { controller, calls } = setup({ status: 'published', version: 3 });
    await assert.rejects(
      controller.updateDraftContent('cookie', draftId, { ...content, expectedVersion: 2 }),
      /其他操作修改/,
    );
    assert.equal(calls.filter((call) => call.model === 'unit' || call.model === 'item' || call.model === 'vocab').length, 0);
  });

  it('unit 路由可通过发布快照找到草稿并编辑', async () => {
    const { controller, calls } = setup({ status: 'published', version: 5 });
    const result = await controller.updateUnitContent('cookie', unitId, { ...content, expectedVersion: 5 });
    assert.equal(result.unitId, unitId);
    assert.ok(calls.some((call) => call.model === 'draft' && call.action === 'findUnique'));
  });

  it('回滚复制历史快照为新版本并同步学习项', async () => {
    const { controller, calls } = setup({ status: 'published', version: 4 });
    const result = await controller.rollbackUnit('cookie', unitId, { version: 1, reason: '发音错误' });
    assert.equal(result.sourceVersion, 1);
    assert.equal(result.version, 2);
    assert.ok(calls.some((call) => call.model === 'version' && call.action === 'create'));
    assert.ok(calls.some((call) => call.model === 'audit' && (call.data as { action?: string })?.action === 'rolled_back'));
  });

  it('停用单元会同时停用学习项与词卡，并写审计', async () => {
    const { controller, calls } = setup({ status: 'published', version: 2 });
    const result = await controller.disableUnit('cookie', unitId, { reason: '抽检发现问题' });
    assert.deepEqual(result, { unitId, availability: 'disabled', changed: true });
    assert.ok(calls.some((call) => call.model === 'item' && call.action === 'updateMany'));
    assert.ok(calls.some((call) => call.model === 'vocab' && call.action === 'updateMany'));
    assert.ok(calls.some((call) => call.model === 'audit' && (call.data as { action?: string })?.action === 'disabled'));
  });

  it('已停用单元再次停用是幂等操作，不重复写审计', async () => {
    const { controller, calls } = setup({ status: 'published', version: 2, availability: 'disabled' });
    const result = await controller.disableUnit('cookie', unitId, {});
    assert.deepEqual(result, { unitId, availability: 'disabled', changed: false });
    assert.ok(!calls.some((call) => call.model === 'audit'));
  });

  it('启用已停用单元会恢复学习项与词卡', async () => {
    const { controller, calls } = setup({ status: 'published', version: 2, availability: 'disabled' });
    const result = await controller.enableUnit('cookie', unitId, { reason: '复检通过' });
    assert.deepEqual(result, { unitId, availability: 'active', changed: true });
    assert.ok(calls.some((call) => call.model === 'audit' && (call.data as { action?: string })?.action === 'enabled'));
  });
});

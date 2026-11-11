import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CurriculumAdminController } from '../src/curriculum/curriculum-admin.controller.ts';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const unitIds = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];

function setup(options: { drafts?: Array<{ id: string; status: string; topicId: string | null }>; shared?: boolean; reviews?: boolean; legacySnapshot?: boolean } = {}) {
  const drafts = options.drafts ?? ids.map((id) => ({ id, status: 'published', topicId: `topic-curriculum-${id}` }));
  const calls: Array<{ model: string; where: unknown; data?: unknown }> = [];
  const tx = {
    curriculum_drafts: {
      findMany: async ({ where }: { where: { id?: { in?: string[]; not?: string }; topicId?: string } }) => {
        if (where.id?.in) return drafts.filter((draft) => where.id!.in!.includes(draft.id));
        if (where.topicId) return options.shared ? [{ id: 'other' }] : [];
        return [];
      },
      updateMany: async (args: { where: unknown; data: unknown }) => { calls.push({ model: 'draft', ...args }); return { count: drafts.length }; },
    },
    curriculum_review_records: {
      findMany: async () => options.reviews === false ? [] : drafts.map((draft, index) => ({ draftId: draft.id, action: 'published', createdAt: new Date(), snapshot: options.legacySnapshot ? {} : { unitId: unitIds[index] } })),
      create: async ({ data }: { data: unknown }) => { calls.push({ model: 'audit', data, where: null }); },
    },
    curriculum_units: {
      findMany: async () => [{ id: unitIds[0] }],
      updateMany: async (args: { where: unknown; data: unknown }) => { calls.push({ model: 'unit', ...args }); return { count: 1 }; },
    },
    learning_items: {
      updateMany: async (args: { where: unknown; data: unknown }) => { calls.push({ model: 'item', ...args }); return { count: 1 }; },
    },
  };
  const prisma = { $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx) };
  const auth = { resolveRequest: () => 'admin' };
  const controller = new CurriculumAdminController(prisma as never, {} as never, {} as never, {} as never, auth as never);
  return { controller, calls, auth };
}

describe('POST 批量归档已发布课程', () => {
  it('要求管理员鉴权', async () => {
    const { controller, auth } = setup();
    auth.resolveRequest = () => { throw new Error('unauthorized'); };
    await assert.rejects(controller.batchArchivePublishedDrafts(undefined, { draftIds: [ids[0]], confirm: true }), /unauthorized/);
  });

  it('拒绝缺失确认、重复 ID 和超出批量边界', async () => {
    const { controller } = setup();
    for (const body of [
      { draftIds: [ids[0]] },
      { draftIds: [ids[0], ids[0]], confirm: true },
      { draftIds: Array(101).fill(ids[0]), confirm: true },
    ]) await assert.rejects(controller.batchArchivePublishedDrafts('cookie', body));
  });

  it('拒绝混合状态且不写入', async () => {
    const { controller, calls } = setup({ drafts: [{ id: ids[0], status: 'published', topicId: `topic-curriculum-${ids[0]}` }, { id: ids[1], status: 'approved', topicId: `topic-curriculum-${ids[1]}` }] });
    await assert.rejects(controller.batchArchivePublishedDrafts('cookie', { draftIds: ids, confirm: true }));
    assert.equal(calls.length, 0);
  });

  it('事务中条件归档课程、单元和学习条目，并记录管理员审计', async () => {
    const { controller, calls } = setup();
    const result = await controller.batchArchivePublishedDrafts('cookie', { draftIds: ids, confirm: true });
    assert.equal(result.count, 2);
    assert.equal(calls.filter((call) => call.model === 'draft').length, 1);
    assert.deepEqual(calls.filter((call) => call.model === 'unit').map((call) => call.where), unitIds.map((id) => ({ id, reviewStatus: 'published' })));
    assert.equal(calls.filter((call) => call.model === 'item').length, 2);
    assert.equal(calls.filter((call) => call.model === 'audit').length, 2);
    assert.ok(calls.filter((call) => call.model === 'audit').every((call) => (call.data as { reviewer: string }).reviewer === 'admin'));
  });

  it('共享 topic 的旧发布快照拒绝且不做任何写入', async () => {
    const { controller, calls } = setup({
      drafts: [{ id: ids[0], status: 'published', topicId: `topic-curriculum-${ids[0]}` }],
      legacySnapshot: true,
      shared: true,
    });
    await assert.rejects(controller.batchArchivePublishedDrafts('cookie', { draftIds: [ids[0]], confirm: true }));
    assert.equal(calls.length, 0);
  });

  it('缺少发布审核记录时拒绝归档且不写入', async () => {
    const { controller, calls } = setup({ reviews: false });
    await assert.rejects(controller.batchArchivePublishedDrafts('cookie', { draftIds: ids, confirm: true }), /缺少发布审核记录/);
    assert.equal(calls.length, 0);
  });

  it('旧确定性 topic 仅在单 unit 且无共享 draft 时允许归档', async () => {
    const { controller, calls } = setup({
      drafts: [{ id: ids[0], status: 'published', topicId: null }],
      legacySnapshot: true,
    });
    const result = await controller.batchArchivePublishedDrafts('cookie', { draftIds: [ids[0]], confirm: true });
    assert.equal(result.count, 1);
    assert.ok(calls.some((call) => call.model === 'unit'));
  });
});

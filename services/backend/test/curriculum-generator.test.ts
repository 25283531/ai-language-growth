import assert from 'node:assert/strict';
import test from 'node:test';
import { CurriculumGeneratorService } from '../src/curriculum/curriculum-generator.service';
import { CurriculumWarmupService } from '../src/curriculum/curriculum-warmup.service';

function fakePrisma() {
  let created = 0;
  return {
    curriculum_drafts: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created += 1;
        return { id: `draft-${created}`, ...data };
      },
    },
    curriculum_review_records: { create: async () => ({}) },
  };
}

test('教材词表生成完整 JSON 并按单元写入草稿', async () => {
  const service = new CurriculumGeneratorService(
    fakePrisma() as never,
    { smallLlm: async () => ({ content: '{}' }) } as never,
    { route: async () => ({}) } as never,
  );
  const result = await service.generateTextbook({
    title: '三年级上册 Unit 3',
    level: 'A1',
    words: 'apple\nbanana\nmysteryword',
    unitSize: 3,
    useAi: false,
    persist: true,
  }, 'tester');
  assert.equal(result.package.schemaVersion, 2);
  assert.equal(result.levels[0]?.code, 'A1');
  assert.equal(result.levels[0]?.units, 1);
  assert.equal(result.levels[0]?.lessons, 11);
  assert.equal(result.draftCount, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.package.levels[0]?.units[0]?.vocabulary.length, 3);
});

test('预置 CEFR JSON 可整体读取，也可按级别过滤', () => {
  const service = new CurriculumGeneratorService(fakePrisma() as never, {} as never, {} as never);
  const all = service.preset();
  assert.equal(all.levels.length, 7);
  const a1 = service.preset('a1');
  assert.equal(a1.levels.length, 1);
  assert.equal(a1.levels[0]?.code, 'A1');
  assert.equal(a1.levels[0]?.units.length, 7);
});

test('级别尚未发布课程时，媒体预热明确返回原因且不搜索/合成', async () => {
  let ttsCalls = 0;
  const service = new CurriculumWarmupService(
    { curriculum_units: { findMany: async () => [] } } as never,
    { ttsWithResult: async () => { ttsCalls += 1; return {}; } } as never,
    { route: async () => ({}) } as never,
    { cacheNext: async () => undefined } as never,
  );
  const result = await service.warmLevel('B1');
  assert.equal(result.publishedUnits, 0);
  assert.equal(result.imagesResolved, 0);
  assert.equal(result.speechGenerated, 0);
  assert.match(result.reason ?? '', /还没有已发布课程/);
  assert.equal(ttsCalls, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImageCacheService, persistCachedImage } from '../src/media/image-cache.service';
import fs, { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('disk persistence validates EEXIST content and propagates disk path errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alg-image-'));
  const bytes = Buffer.from('image-test-bytes');
  try {
    const checksum = await persistCachedImage(bytes, 'png', directory);
    const path = join(directory, `${checksum}.png`);
    assert.equal(checksum, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(await persistCachedImage(bytes, 'png', directory), checksum);
    await writeFile(path, 'corrupted');
    await assert.rejects(persistCachedImage(bytes, 'png', directory), /内容校验失败/);
    await assert.rejects(persistCachedImage(bytes, 'png', path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
import type { PrismaService } from '../src/prisma/prisma.service';
import type { QueueRuntimeService } from '../src/queue/queue-runtime.service';

test('EACCES and ENOSPC write failures propagate without being accepted as EEXIST', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'alg-image-errors-'));
  try {
    for (const code of ['EACCES', 'ENOSPC']) {
      const error = Object.assign(new Error('synthetic disk failure'), { code });
      const mocked = t.mock.method(fs, 'writeFile', async () => { throw error; });
      await assert.rejects(persistCachedImage(Buffer.from('bytes'), 'png', directory), (actual) => actual === error);
      mocked.mock.restore();
    }
  } finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
});

test('image initialization only registers a queue processor, never scans immediately', () => {
  let registered = 0;
  const service = new ImageCacheService({} as PrismaService, {
    startImageCache: () => { registered += 1; },
  } as unknown as QueueRuntimeService);
  service.onModuleInit();
  assert.equal(registered, 1);
});

test('DB reconciliation retains pending, cooldown and stale downloading recovery', async () => {
  let query: any;
  const service = new ImageCacheService({ media_assets: {
    findFirst: async (input: any) => { query = input; return null; },
  } } as unknown as PrismaService, {} as QueueRuntimeService);
  await service.cacheNext();
  assert.equal(query.where.kind, 'image');
  assert.deepEqual(query.where.OR[0], { cacheStatus: 'pending' });
  assert.equal(query.where.OR[1].cacheStatus, 'failed');
  assert.equal(query.where.OR[2].cacheStatus, 'downloading');
  assert.ok(query.where.OR[2].cacheAttemptedAt.lte instanceof Date);
});

test('failed download is sanitized, thrown for retry, and retry revisits its asset', async () => {
  const queries: any[] = [];
  const updates: any[] = [];
  const service = new ImageCacheService({ media_assets: {
    findFirst: async (query: any) => { queries.push(query); return { id: 'asset-1', sourceUrl: 'http://localhost/private?token=sensitive' }; },
    update: async (input: any) => { updates.push(input); },
  } } as unknown as PrismaService, {} as QueueRuntimeService);
  let remembered = '';
  await assert.rejects(service.cacheNext(undefined, async (id) => { remembered = id; }), { message: '课程图片缓存失败' });
  assert.equal(remembered, 'asset-1');
  assert.deepEqual(updates[1].data, { cacheStatus: 'failed', cacheError: '课程图片缓存失败，等待后台重试' });
  await assert.rejects(service.cacheNext(remembered), { message: '课程图片缓存失败' });
  assert.deepEqual(queries[1].where, { id: 'asset-1', kind: 'image', cacheStatus: { not: 'cached' } });
  assert.ok(!JSON.stringify(updates).includes('sensitive'));
});

test('disk failures and corrupt existing bytes never mark DB cached', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alg-image-db-'));
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from('valid-image-fixture');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  try {
    globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'image/png' } });
    for (const damaged of [false, true]) {
      const updates: any[] = [];
      const service = new ImageCacheService({ media_assets: {
        findFirst: async () => ({ id: 'asset', sourceUrl: 'https://images.example.test/image' }),
        update: async (input: any) => { updates.push(input); },
      } } as unknown as PrismaService, {} as QueueRuntimeService);
      if (damaged) {
        await writeFile(join(directory, `${checksum}.png`), 'corrupt');
        (service as any).imageDirectory = directory;
      } else {
        const blocker = join(directory, 'not-a-directory');
        await writeFile(blocker, 'blocker');
        (service as any).imageDirectory = blocker;
      }
      await assert.rejects(service.cacheNext(), /课程图片缓存失败/);
      assert.equal(updates.at(-1).data.cacheStatus, 'failed');
      assert.ok(!updates.some((entry) => entry.data.cacheStatus === 'cached'));
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('already cached or removed retry asset is a safe no-op', async () => {
  const service = new ImageCacheService({ media_assets: { findFirst: async () => null } } as unknown as PrismaService, {} as QueueRuntimeService);
  await service.cacheNext('gone');
});

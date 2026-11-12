/**
 * P0-5：TTS 音频缓存定时清理。
 *
 * 全部离线：临时目录 + 假 Prisma，不连接数据库、不调用供应商。
 * 重点验证“可证明无用才删”：过期资产/索引、真正孤儿文件会删；
 * 公共课程音频、仍被数据库或索引引用的文件、宽限期内的新文件一律保留。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { PrismaService } from '../src/prisma/prisma.service.ts';
import {
  TtsCacheMaintenanceService,
  cleanupTtsCache,
  type TtsCacheCleanupOptions,
} from '../src/speech/tts-cache-maintenance.service.ts';

interface FakeAsset {
  id: string;
  ref: string;
  checksum: string | null;
  cacheExtension: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

function audioName(label: string): string {
  return `${createHash('sha1').update(label).digest('hex').slice(0, 24)}.mp3`;
}

function fakeStore(initial: FakeAsset[], options: { failDelete?: boolean } = {}) {
  let assets = initial.map((asset) => ({ ...asset }));
  const prisma = {
    media_assets: {
      findMany: async () => assets.slice(),
      deleteMany: async (args: { where: { id: { in: string[] } } }) => {
        if (options.failDelete) throw new Error('synthetic database failure');
        const ids = new Set(args.where.id.in);
        const before = assets.length;
        assets = assets.filter((asset) => !ids.has(asset.id));
        return { count: before - assets.length };
      },
    },
  } as unknown as PrismaService;
  return { prisma, assets: () => assets };
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'alg-tts-cleanup-'));
}

function addAudio(dir: string, label: string, now: Date, ageMs: number): string {
  const name = audioName(label);
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(`audio-${label}`));
  const time = new Date(now.getTime() - ageMs);
  utimesSync(path, time, time);
  return name;
}

function addIndex(
  dir: string,
  label: string,
  audioRef: string,
  expiresAt: string | null,
  scope = 'PRIVATE_DYNAMIC',
): string {
  const name = `.tts-${createHash('sha256').update(label).digest('hex')}.json`;
  writeFileSync(join(dir, name), JSON.stringify({
    keyVersion: 'tts-v3-course',
    scope,
    topicId: 'topic-test',
    contentId: 'content-test',
    contentVersion: 'v1',
    ownerLearnerId: scope === 'PRIVATE_DYNAMIC' ? 'learner-1' : null,
    expiresAt,
    audioRef,
    textHash: 'hash',
  }));
  return name;
}

async function runCleanup(
  options: Partial<TtsCacheCleanupOptions> & Pick<TtsCacheCleanupOptions, 'prisma' | 'audioDir' | 'now'>,
) {
  return cleanupTtsCache({
    orphanGraceMs: 24 * 60 * 60 * 1000,
    ...options,
  });
}

describe('TTS 缓存定时清理：只删可证明无用的资源', () => {
  it('1. 删除过期资产/索引与旧孤儿；保留公共音频、双引用音频、宽限期文件和非音频文件', async () => {
    const dir = makeDir();
    const now = new Date('2026-11-12T12:00:00Z');
    const old = 48 * 60 * 60 * 1000;
    try {
      const expired = addAudio(dir, 'expired', now, old);
      const publicAudio = addAudio(dir, 'public', now, old);
      const orphanOld = addAudio(dir, 'orphan-old', now, old);
      const orphanYoung = addAudio(dir, 'orphan-young', now, 60 * 60 * 1000);
      const indexOnly = addAudio(dir, 'index-only', now, old);
      const dbOnly = addAudio(dir, 'db-only', now, old);
      const unknown = 'notes.txt';
      writeFileSync(join(dir, unknown), 'keep me');

      addIndex(dir, 'expired-index', `/api/v1/media/audio/${expired}`, new Date(now.getTime() - 60 * 60 * 1000).toISOString());
      addIndex(dir, 'public-index', `/api/v1/media/audio/${publicAudio}`, new Date(now.getTime() - 60 * 60 * 1000).toISOString(), 'PUBLIC_CURRICULUM');
      addIndex(dir, 'index-only', `/api/v1/media/audio/${indexOnly}`, null);

      const store = fakeStore([
        {
          id: 'asset-expired',
          ref: `/api/v1/media/audio/${expired}`,
          checksum: expired.slice(0, 24),
          cacheExtension: 'mp3',
          expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
          scope: 'PRIVATE_DYNAMIC',
        },
        {
          id: 'asset-public',
          ref: `/api/v1/media/audio/${publicAudio}`,
          checksum: publicAudio.slice(0, 24),
          cacheExtension: 'mp3',
          expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
          scope: 'PUBLIC_CURRICULUM',
        },
        {
          id: 'asset-db-only',
          ref: `/api/v1/media/audio/${dbOnly}`,
          checksum: dbOnly.slice(0, 24),
          cacheExtension: 'mp3',
          expiresAt: null,
          scope: 'PRIVATE_DYNAMIC',
        },
      ]);

      const stats = await runCleanup({ prisma: store.prisma, audioDir: dir, now });

      assert.equal(stats.expiredAssetsDeleted, 1);
      assert.equal(stats.expiredIndexesDeleted, 1);
      assert.equal(stats.orphanAudioFilesDeleted, 2, '过期文件与旧孤儿应删除');
      assert.equal(stats.protectedAudioFiles, 3, '公共、索引引用、数据库引用都应保留');
      assert.equal(stats.youngOrphanFilesSkipped, 1);
      assert.equal(stats.orphanDeletionSkippedReason, null);
      assert.deepEqual(stats.errors, []);
      assert.ok(stats.bytesFreed > 0);

      assert.equal(existsSync(join(dir, expired)), false);
      assert.equal(existsSync(join(dir, orphanOld)), false);
      assert.equal(existsSync(join(dir, publicAudio)), true);
      assert.equal(existsSync(join(dir, indexOnly)), true);
      assert.equal(existsSync(join(dir, dbOnly)), true);
      assert.equal(existsSync(join(dir, orphanYoung)), true);
      assert.equal(existsSync(join(dir, unknown)), true);
      assert.equal(store.assets().some((asset) => asset.id === 'asset-expired'), false);

      const second = await runCleanup({ prisma: store.prisma, audioDir: dir, now });
      assert.equal(second.expiredAssetsDeleted, 0);
      assert.equal(second.expiredIndexesDeleted, 0);
      assert.equal(second.orphanAudioFilesDeleted, 0, '重复清理必须幂等');
      assert.deepEqual(second.errors, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. 数据库行已过期但仍有活跃索引引用时，只删行、不删音频', async () => {
    const dir = makeDir();
    const now = new Date('2026-11-12T12:00:00Z');
    const old = 48 * 60 * 60 * 1000;
    try {
      const shared = addAudio(dir, 'shared', now, old);
      addIndex(dir, 'active-index', `/api/v1/media/audio/${shared}`, null);
      const store = fakeStore([{
        id: 'asset-expired-but-indexed',
        ref: `/api/v1/media/audio/${shared}`,
        checksum: shared.slice(0, 24),
        cacheExtension: 'mp3',
        expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
        scope: 'PRIVATE_DYNAMIC',
      }]);

      const stats = await runCleanup({ prisma: store.prisma, audioDir: dir, now });

      assert.equal(stats.expiredAssetsDeleted, 1);
      assert.equal(stats.orphanAudioFilesDeleted, 0);
      assert.equal(stats.protectedAudioFiles, 1);
      assert.equal(existsSync(join(dir, shared)), true);
      assert.equal(store.assets().length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. 索引损坏时跳过本轮孤儿删除，避免误删仍可能被引用的音频', async () => {
    const dir = makeDir();
    const now = new Date('2026-11-12T12:00:00Z');
    try {
      const orphan = addAudio(dir, 'orphan-with-broken-index', now, 48 * 60 * 60 * 1000);
      writeFileSync(
        join(dir, `.tts-${createHash('sha256').update('broken').digest('hex')}.json`),
        '{not-json',
      );

      const stats = await runCleanup({ prisma: fakeStore([]).prisma, audioDir: dir, now });

      assert.equal(stats.indexScanIncomplete, true);
      assert.equal(stats.orphanDeletionSkippedReason, 'index_scan_incomplete');
      assert.equal(stats.orphanAudioFilesDeleted, 0);
      assert.equal(existsSync(join(dir, orphan)), true);
      assert.ok(stats.errors.some((error) => error.includes('读取 TTS 索引失败')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. 数据库删除失败时不删任何音频文件', async () => {
    const dir = makeDir();
    const now = new Date('2026-11-12T12:00:00Z');
    try {
      const expired = addAudio(dir, 'db-failure-expired', now, 48 * 60 * 60 * 1000);
      const store = fakeStore([{
        id: 'asset-expired',
        ref: `/api/v1/media/audio/${expired}`,
        checksum: expired.slice(0, 24),
        cacheExtension: 'mp3',
        expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
        scope: 'PRIVATE_DYNAMIC',
      }], { failDelete: true });

      const stats = await runCleanup({ prisma: store.prisma, audioDir: dir, now });

      assert.equal(stats.expiredAssetsDeleted, 0);
      assert.equal(stats.orphanAudioFilesDeleted, 0);
      assert.equal(stats.orphanDeletionSkippedReason, 'asset_deletion_failed');
      assert.equal(existsSync(join(dir, expired)), true);
      assert.equal(store.assets().length, 1);
      assert.ok(stats.errors.some((error) => error.includes('删除过期媒体资产失败')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5. 维护服务记录最近一次结果，供管理端只读查看', async () => {
    const dir = makeDir();
    const previous = process.env.AI_AUDIO_DIR;
    const now = new Date();
    try {
      process.env.AI_AUDIO_DIR = dir;
      const expired = addAudio(dir, 'service-expired', now, 48 * 60 * 60 * 1000);
      const store = fakeStore([{
        id: 'asset-service-expired',
        ref: `/api/v1/media/audio/${expired}`,
        checksum: expired.slice(0, 24),
        cacheExtension: 'mp3',
        expiresAt: new Date(now.getTime() - 60 * 60 * 1000),
        scope: 'PRIVATE_DYNAMIC',
      }]);
      const service = new TtsCacheMaintenanceService(store.prisma);
      try {
        const stats = await service.run();
        assert.equal(stats.expiredAssetsDeleted, 1);
        assert.equal(service.status().lastRun?.expiredAssetsDeleted, 1);
        assert.equal(service.status().lastError, null);
        assert.equal(service.status().running, false);
      } finally {
        service.onModuleDestroy();
      }
    } finally {
      if (previous === undefined) delete process.env.AI_AUDIO_DIR;
      else process.env.AI_AUDIO_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

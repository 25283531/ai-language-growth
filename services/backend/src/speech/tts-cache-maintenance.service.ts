/**
 * TTS 音频缓存维护。
 *
 * 目标：只清理两类可证明无用的资源，绝不误删仍被引用的公共课程语音。
 *  1. 已到期资源：media_assets.expiresAt 已过，且索引记录的 expiresAt 已过；
 *  2. 孤儿文件：没有任何活跃 media_assets / .tts-*.json 索引引用，且超过宽限期。
 *
 * 安全约束：
 *  - PUBLIC_CURRICULUM / PRONUNCIATION 永远不按 TTL 删除；
 *  - 索引解析不完整、数据库删除失败时，跳过本轮音频文件删除；
 *  - 只处理 resolveAudioDir() 顶层的 24-hex 音频文件，不碰 uploads/ 与未知文件；
 *  - 删除顺序是先数据库/索引，再基于剩余引用重算孤儿，保证同文件多引用时不误删。
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAudioDir } from '@alg/ai-provider-sdk';
import { PrismaService } from '../prisma/prisma.service';

const AUDIO_FILE = /^[a-f0-9]{24}\.(?:mp3|wav|m4a)$/i;
const INDEX_FILE = /^\.tts-[a-f0-9]{64}\.json$/i;
const PUBLIC_SCOPES = new Set(['PUBLIC_CURRICULUM', 'PRONUNCIATION']);
const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INITIAL_DELAY_MS = 10 * 60 * 1000;

export interface TtsCacheCleanupStats {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scannedAudioFiles: number;
  scannedIndexFiles: number;
  scannedAssetRows: number;
  expiredAssetsDeleted: number;
  expiredIndexesDeleted: number;
  orphanAudioFilesDeleted: number;
  protectedAudioFiles: number;
  youngOrphanFilesSkipped: number;
  bytesFreed: number;
  indexScanIncomplete: boolean;
  orphanDeletionSkippedReason: string | null;
  errors: string[];
}

export interface TtsCacheCleanupOptions {
  prisma: PrismaService;
  audioDir: string;
  now: Date;
  orphanGraceMs: number;
}

interface AudioAssetRow {
  id: string;
  ref: string;
  checksum: string | null;
  cacheExtension: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

/**
 * 执行一次清理。纯函数式入口便于用临时目录与假 Prisma 覆盖所有危险分支。
 */
export async function cleanupTtsCache(options: TtsCacheCleanupOptions): Promise<TtsCacheCleanupStats> {
  const startedMs = Date.now();
  const now = options.now;
  const orphanGraceMs = Math.max(0, options.orphanGraceMs);
  const stats: TtsCacheCleanupStats = {
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: '',
    durationMs: 0,
    scannedAudioFiles: 0,
    scannedIndexFiles: 0,
    scannedAssetRows: 0,
    expiredAssetsDeleted: 0,
    expiredIndexesDeleted: 0,
    orphanAudioFilesDeleted: 0,
    protectedAudioFiles: 0,
    youngOrphanFilesSkipped: 0,
    bytesFreed: 0,
    indexScanIncomplete: false,
    orphanDeletionSkippedReason: null,
    errors: [],
  };
  const finish = (): TtsCacheCleanupStats => {
    stats.finishedAt = new Date().toISOString();
    stats.durationMs = Math.max(0, Date.now() - startedMs);
    return stats;
  };

  let entries;
  try {
    entries = await readdir(options.audioDir, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return finish();
    stats.errors.push(`读取音频目录失败：${errorMessage(error)}`);
    return finish();
  }

  const audioFiles = entries
    .filter((entry) => entry.isFile() && AUDIO_FILE.test(entry.name))
    .map((entry) => entry.name);
  stats.scannedAudioFiles = audioFiles.length;

  const activeAudioNames = new Set<string>();
  let assetRows: AudioAssetRow[] = [];
  try {
    assetRows = await options.prisma.media_assets.findMany({
      where: { kind: 'audio' },
      select: {
        id: true,
        ref: true,
        checksum: true,
        cacheExtension: true,
        expiresAt: true,
        scope: true,
      },
    });
  } catch (error) {
    stats.errors.push(`读取媒体资产失败：${errorMessage(error)}`);
    return finish();
  }
  stats.scannedAssetRows = assetRows.length;

  const expiredAssetIds: string[] = [];
  for (const row of assetRows) {
    const fileName = audioFileNameFromAsset(row);
    const expired = isExpired(row.expiresAt, row.scope, now);
    if (expired) {
      expiredAssetIds.push(row.id);
      continue;
    }
    if (fileName) activeAudioNames.add(fileName);
  }

  let assetDeletionFailed = false;
  if (expiredAssetIds.length) {
    try {
      const result = await options.prisma.media_assets.deleteMany({
        where: { id: { in: expiredAssetIds } },
      });
      stats.expiredAssetsDeleted = result.count;
    } catch (error) {
      assetDeletionFailed = true;
      stats.errors.push(`删除过期媒体资产失败：${errorMessage(error)}`);
    }
  }

  const indexFiles = entries
    .filter((entry) => entry.isFile() && INDEX_FILE.test(entry.name))
    .map((entry) => entry.name);
  stats.scannedIndexFiles = indexFiles.length;

  for (const indexName of indexFiles) {
    const indexPath = join(options.audioDir, indexName);
    let parsed: Record<string, unknown>;
    try {
      const raw = await readFile(indexPath, 'utf8');
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('索引不是 JSON 对象');
      }
      parsed = value as Record<string, unknown>;
    } catch (error) {
      // 无法确认索引内容时不做孤儿删除，避免把仍被引用的音频当成垃圾。
      stats.indexScanIncomplete = true;
      stats.errors.push(`读取 TTS 索引失败（${indexName}）：${errorMessage(error)}`);
      continue;
    }

    const scope = typeof parsed.scope === 'string' ? parsed.scope : null;
    const audioName = audioFileNameFromRef(parsed.audioRef);
    const expired = isExpired(parsed.expiresAt, scope, now);
    if (!expired) {
      if (audioName) activeAudioNames.add(audioName);
      continue;
    }

    let size = 0;
    try {
      size = (await stat(indexPath)).size;
    } catch {
      // 文件可能已被其他进程删除；仍然尝试 unlink。
    }
    try {
      await unlink(indexPath);
      stats.expiredIndexesDeleted += 1;
      stats.bytesFreed += size;
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') continue;
      stats.errors.push(`删除过期 TTS 索引失败（${indexName}）：${errorMessage(error)}`);
      // 删除失败意味着索引仍可能存在；保守保护它引用的音频。
      if (audioName) activeAudioNames.add(audioName);
    }
  }

  if (assetDeletionFailed) {
    stats.orphanDeletionSkippedReason = 'asset_deletion_failed';
    return finish();
  }
  if (stats.indexScanIncomplete) {
    stats.orphanDeletionSkippedReason = 'index_scan_incomplete';
    return finish();
  }

  for (const audioName of audioFiles) {
    if (activeAudioNames.has(audioName)) {
      stats.protectedAudioFiles += 1;
      continue;
    }
    const audioPath = join(options.audioDir, audioName);
    let fileStat;
    try {
      fileStat = await stat(audioPath);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        stats.errors.push(`读取音频文件状态失败（${audioName}）：${errorMessage(error)}`);
      }
      continue;
    }
    const ageMs = Math.max(0, now.getTime() - fileStat.mtimeMs);
    if (ageMs < orphanGraceMs) {
      stats.youngOrphanFilesSkipped += 1;
      continue;
    }
    try {
      await unlink(audioPath);
      stats.orphanAudioFilesDeleted += 1;
      stats.bytesFreed += fileStat.size;
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') continue;
      stats.errors.push(`删除孤儿音频失败（${audioName}）：${errorMessage(error)}`);
    }
  }

  return finish();
}

/** 定时清理服务。默认每 6 小时一次，启动 10 分钟后首跑；可用环境变量关闭或调整。 */
@Injectable()
export class TtsCacheMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TtsCacheMaintenanceService.name);
  private initialTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private lastRun?: TtsCacheCleanupStats;
  private lastError: string | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('TTS 缓存定时清理已关闭（TTS_CACHE_CLEANUP_ENABLED=false）');
      return;
    }
    const initialDelayMs = envMilliseconds(
      'TTS_CACHE_CLEANUP_INITIAL_DELAY_MS',
      DEFAULT_CLEANUP_INITIAL_DELAY_MS,
    );
    const intervalMs = Math.max(60_000, envMilliseconds(
      'TTS_CACHE_CLEANUP_INTERVAL_MS',
      DEFAULT_CLEANUP_INTERVAL_MS,
    ));
    this.initialTimer = setTimeout(() => {
      void this.run();
      this.intervalTimer = setInterval(() => void this.run(), intervalMs);
      this.intervalTimer.unref?.();
    }, initialDelayMs);
    this.initialTimer.unref?.();
    this.logger.log(`TTS 缓存定时清理已启用：首跑 ${initialDelayMs}ms 后，每 ${intervalMs}ms 一次`);
  }

  onModuleDestroy(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = undefined;
    this.intervalTimer = undefined;
  }

  /** 手动执行一次；与定时任务共用同一互斥标记，避免并发删除。 */
  async run(): Promise<TtsCacheCleanupStats> {
    if (this.running) {
      return {
        ...emptyStats(new Date()),
        orphanDeletionSkippedReason: 'already_running',
      };
    }
    this.running = true;
    try {
      const stats = await cleanupTtsCache({
        prisma: this.prisma,
        audioDir: resolveAudioDir(),
        now: new Date(),
        orphanGraceMs: envMilliseconds('TTS_CACHE_ORPHAN_GRACE_MS', DEFAULT_ORPHAN_GRACE_MS),
      });
      this.lastRun = stats;
      this.lastError = stats.errors.length ? stats.errors.join('; ') : null;
      this.logger.log(
        `TTS 缓存清理完成：过期资产 ${stats.expiredAssetsDeleted}、过期索引 ${stats.expiredIndexesDeleted}、` +
        `孤儿音频 ${stats.orphanAudioFilesDeleted}、保护 ${stats.protectedAudioFiles}、` +
        `释放 ${stats.bytesFreed} 字节、错误 ${stats.errors.length}`,
      );
      if (stats.orphanDeletionSkippedReason) {
        this.logger.warn(`本轮跳过音频孤儿删除：${stats.orphanDeletionSkippedReason}`);
      }
      return stats;
    } catch (error) {
      this.lastError = errorMessage(error);
      this.logger.error(`TTS 缓存清理异常：${this.lastError}`);
      const stats = emptyStats(new Date());
      stats.errors.push(this.lastError);
      stats.finishedAt = new Date().toISOString();
      this.lastRun = stats;
      return stats;
    } finally {
      this.running = false;
    }
  }

  /** 供管理端只读查看最近一次结果；不触发清理。 */
  status(): {
    enabled: boolean;
    intervalMs: number;
    initialDelayMs: number;
    orphanGraceMs: number;
    running: boolean;
    lastError: string | null;
    lastRun: TtsCacheCleanupStats | null;
  } {
    return {
      enabled: this.enabled(),
      intervalMs: Math.max(60_000, envMilliseconds(
        'TTS_CACHE_CLEANUP_INTERVAL_MS',
        DEFAULT_CLEANUP_INTERVAL_MS,
      )),
      initialDelayMs: envMilliseconds(
        'TTS_CACHE_CLEANUP_INITIAL_DELAY_MS',
        DEFAULT_CLEANUP_INITIAL_DELAY_MS,
      ),
      orphanGraceMs: envMilliseconds('TTS_CACHE_ORPHAN_GRACE_MS', DEFAULT_ORPHAN_GRACE_MS),
      running: this.running,
      lastError: this.lastError,
      lastRun: this.lastRun ?? null,
    };
  }

  private enabled(): boolean {
    return (process.env.TTS_CACHE_CLEANUP_ENABLED ?? 'true').toLowerCase() !== 'false';
  }
}

function emptyStats(now: Date): TtsCacheCleanupStats {
  return {
    startedAt: now.toISOString(),
    finishedAt: '',
    durationMs: 0,
    scannedAudioFiles: 0,
    scannedIndexFiles: 0,
    scannedAssetRows: 0,
    expiredAssetsDeleted: 0,
    expiredIndexesDeleted: 0,
    orphanAudioFilesDeleted: 0,
    protectedAudioFiles: 0,
    youngOrphanFilesSkipped: 0,
    bytesFreed: 0,
    indexScanIncomplete: false,
    orphanDeletionSkippedReason: null,
    errors: [],
  };
}

function isExpired(value: unknown, scope: string | null, now: Date): boolean {
  if (scope && PUBLIC_SCOPES.has(scope)) return false;
  if (value === null || value === undefined || value === '') return false;
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  // 无效的 expiresAt 一律按“仍有效”处理，宁可多留，不可误删。
  return Number.isFinite(parsed) && parsed <= now.getTime();
}

function audioFileNameFromAsset(row: AudioAssetRow): string | null {
  const fromRef = audioFileNameFromRef(row.ref);
  if (fromRef) return fromRef;
  const checksum = row.checksum?.toLowerCase();
  const extension = row.cacheExtension?.replace(/^\./, '').toLowerCase();
  if (!checksum || !/^[a-f0-9]{24}$/.test(checksum)) return null;
  if (!extension || !['mp3', 'wav', 'm4a'].includes(extension)) return null;
  return `${checksum}.${extension}`;
}

function audioFileNameFromRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.slice(value.lastIndexOf('/') + 1);
  return AUDIO_FILE.test(name) ? name.toLowerCase() : null;
}

function envMilliseconds(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

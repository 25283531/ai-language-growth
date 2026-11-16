import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  detectPregenLang,
  pregenTextHash,
  speedTierForTeacherSpeed,
  type PregenLang,
  type PregenSpeedTierId,
} from '@alg/ai-provider-sdk';
import { PrismaService } from '../prisma/prisma.service';

/** 预生成索引的工作模式；默认 off，未验证前不改变任何既有行为。 */
export type PregenerationMode = 'off' | 'shadow' | 'on';

export interface PregenerationClip {
  id: string;
  lang: PregenLang;
  speedTier: PregenSpeedTierId;
  teacherSpeed: number;
  audioFile: string;
  audioRef: string;
  sha256: string;
  durationMs: number;
  bytes: number;
  voiceId: string;
  engineVersion: string;
}

export type PregenerationLookupOutcome =
  | 'hit'
  | 'miss'
  | 'ineligible'
  | 'disabled'
  | 'shadow_hit'
  | 'error';

export interface PregenerationLookupResult {
  outcome: PregenerationLookupOutcome;
  clip?: PregenerationClip;
  /** 未命中的可读原因，用于日志与排查；不含任何文本内容。 */
  reason?: string;
}

interface CacheItem<T> {
  value: T;
  expiresAt: number;
}

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/** 预生成只服务公共课程语音；私人动态话语（含姓名/进度）永不查表。 */
const ELIGIBLE_SCOPES = new Set(['PUBLIC_CURRICULUM', 'PRONUNCIATION']);
const MAX_TEXT_LENGTH = 1200;

/**
 * 预生成语音索引查询（设计文档第 4 节第 3 步）。
 *
 * 职责边界很窄：判断「这句请求该不该查表」→ 查表 → 返回 clip 元数据。
 * 文件存在性与字节校验、缓存回写、计费口径由网关负责，避免这里重复实现
 * 一遍缓存语义（那正是最容易漂移的地方）。
 *
 * 三层防护，保证「表还没建」「索引是空的」「模式关着」三种情况都不会伤到课堂：
 *  1. TTS_PREGEN_MODE 默认 off —— 连一次查询都不会发出；
 *  2. 表不存在（迁移未执行）时置 tableMissing 并长时间退避，不刷日志、不拖慢请求；
 *  3. 负缓存 5 分钟 —— 未覆盖的文本不会每次都打库。
 */
@Injectable()
export class PregenerationIndexService implements OnModuleInit {
  private readonly logger = new Logger(PregenerationIndexService.name);
  private readonly mode: PregenerationMode;
  /** 命中过的 clip，10 分钟内不再查库。 */
  private readonly positiveCache = new Map<string, CacheItem<PregenerationClip>>();
  /** 未命中的 key，5 分钟内不再查库。 */
  private readonly negativeCache = new Map<string, number>();
  /** 表缺失/权限错误的退避截止时间。 */
  private tableUnavailableUntil = 0;
  private engineVersionCache: CacheItem<string | null> | null = null;

  private hits = 0;
  private shadowHits = 0;
  private misses = 0;
  private ineligible = 0;
  private errors = 0;

  constructor(private readonly prisma: PrismaService) {
    const raw = (process.env.TTS_PREGEN_MODE ?? 'off').trim().toLowerCase();
    this.mode = raw === 'on' || raw === 'shadow' ? (raw as PregenerationMode) : 'off';
  }

  onModuleInit(): void {
    this.logger.log(`预生成语音索引模式：${this.mode}`);
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  get isShadow(): boolean {
    return this.mode === 'shadow';
  }

  /**
   * 按「内容身份」查表。只认精确语速档：0.85 之类落在档位之间的请求即便吸附到
   * 0.8 档也不使用预生成音频，否则「慢一点」的回合内微调会被静默吞掉。
   */
  async lookupForTts(input: {
    text: string;
    teacherSpeed: number;
    scope: string;
  }): Promise<PregenerationLookupResult> {
    if (this.mode === 'off') return { outcome: 'disabled', reason: 'mode_off' };
    if (!ELIGIBLE_SCOPES.has(input.scope)) {
      this.ineligible += 1;
      return { outcome: 'ineligible', reason: 'scope_not_public' };
    }
    const text = input.text.trim();
    if (!text || text.length > MAX_TEXT_LENGTH) {
      this.ineligible += 1;
      return { outcome: 'ineligible', reason: 'text_out_of_range' };
    }
    const tier = speedTierForTeacherSpeed(input.teacherSpeed);
    if (!tier) {
      this.ineligible += 1;
      return { outcome: 'ineligible', reason: 'speed_not_on_tier' };
    }

    const lang = detectPregenLang(text);
    // 归一化必须与导入端同源（SDK 唯一实现），否则 textHash 永远对不上。
    const textHash = pregenTextHash(text);
    const key = `${textHash}|${lang}|${tier.id}`;

    const positive = this.positiveCache.get(key);
    if (positive && positive.expiresAt > Date.now()) {
      return this.hitResult(positive.value);
    }
    const negativeUntil = this.negativeCache.get(key);
    if (negativeUntil && negativeUntil > Date.now()) {
      this.misses += 1;
      return { outcome: 'miss', reason: 'negative_cache' };
    }

    const engineVersion = await this.resolveEngineVersion();
    if (!engineVersion) {
      this.misses += 1;
      return { outcome: 'miss', reason: 'no_engine_version' };
    }

    try {
      // 用 textHash + lang + 档位 + 引擎版本精确定位；status 必须是 ready，
      // stale / missing / disabled 的行一律不参与命中（保留可回滚的审计痕迹）。
      const rows = await this.prisma.$queryRaw<PregenerationClipRow[]>(Prisma.sql`
        SELECT id,
               lang,
               "speedTier"     AS "speedTier",
               "teacherSpeed"  AS "teacherSpeed",
               "audioFile"     AS "audioFile",
               "audioRef"      AS "audioRef",
               sha256,
               "durationMs"    AS "durationMs",
               bytes,
               "voiceId"       AS "voiceId",
               "engineVersion" AS "engineVersion"
          FROM pregenerated_clips
         WHERE "textHash" = ${textHash}
           AND lang = ${lang}
           AND "speedTier" = ${tier.id}
           AND "engineVersion" = ${engineVersion}
           AND status = 'ready'
         LIMIT 1
      `);
      const row = rows[0];
      if (!row) {
        this.negativeCache.set(key, Date.now() + NEGATIVE_TTL_MS);
        this.misses += 1;
        return { outcome: 'miss', reason: 'not_indexed' };
      }
      const clip = this.toClip(row);
      this.positiveCache.set(key, { value: clip, expiresAt: Date.now() + POSITIVE_TTL_MS });
      this.trimCaches();
      return this.hitResult(clip);
    } catch (error) {
      this.errors += 1;
      const message = (error as Error).message ?? String(error);
      // 表未建 / 权限不足属于「还没接线」，不是故障：退避 10 分钟，避免刷屏与拖慢课堂。
      if (/relation .* does not exist|permission denied/i.test(message)) {
        this.tableUnavailableUntil = Date.now() + 10 * 60 * 1000;
        this.logger.warn(`预生成索引表不可用，暂停查表 10 分钟：${message.slice(0, 160)}`);
      } else {
        this.logger.warn(`预生成索引查询失败：${message.slice(0, 160)}`);
      }
      return { outcome: 'error', reason: 'query_failed' };
    }
  }

  /** 把不可用的 clip 从正缓存剔除，避免同一请求反复命中坏文件。 */
  invalidate(clipId: string): void {
    for (const [key, item] of this.positiveCache) {
      if (item.value.id === clipId) this.positiveCache.delete(key);
    }
  }

  snapshot(): {
    mode: PregenerationMode;
    engineVersion: string | null;
    hits: number;
    shadowHits: number;
    misses: number;
    ineligible: number;
    errors: number;
    positiveCached: number;
    negativeCached: number;
    tableAvailable: boolean;
  } {
    return {
      mode: this.mode,
      engineVersion: this.engineVersionCache?.value ?? null,
      hits: this.hits,
      shadowHits: this.shadowHits,
      misses: this.misses,
      ineligible: this.ineligible,
      errors: this.errors,
      positiveCached: this.positiveCache.size,
      negativeCached: this.negativeCache.size,
      tableAvailable: Date.now() >= this.tableUnavailableUntil,
    };
  }

  private hitResult(clip: PregenerationClip): PregenerationLookupResult {
    if (this.mode === 'shadow') {
      this.shadowHits += 1;
      // shadow 模式只记录「本可命中」，绝不改变返回结果。
      return { outcome: 'shadow_hit', clip, reason: 'shadow_mode' };
    }
    this.hits += 1;
    return { outcome: 'hit', clip };
  }

  /**
   * 当前生效的引擎版本：环境变量优先，否则取最近一次导入批次。
   * 版本一变，旧批次的行自然不再参与查询（保留可回滚），无需删数据。
   */
  private async resolveEngineVersion(): Promise<string | null> {
    const pinned = (process.env.TTS_PREGEN_ENGINE_VERSION ?? '').trim();
    if (pinned) return pinned;
    if (this.engineVersionCache && this.engineVersionCache.expiresAt > Date.now()) {
      return this.engineVersionCache.value;
    }
    if (Date.now() < this.tableUnavailableUntil) return null;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ engineVersion: string }>>(Prisma.sql`
        SELECT "engineVersion" FROM pregeneration_batches
         ORDER BY "startedAt" DESC
         LIMIT 1
      `);
      const value = rows[0]?.engineVersion ?? null;
      this.engineVersionCache = { value, expiresAt: Date.now() + NEGATIVE_TTL_MS };
      return value;
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (/relation .* does not exist|permission denied/i.test(message)) {
        this.tableUnavailableUntil = Date.now() + 10 * 60 * 1000;
        this.logger.warn(`预生成索引表不可用，暂停查表 10 分钟：${message.slice(0, 160)}`);
      } else {
        this.logger.warn(`读取预生成批次失败：${message.slice(0, 160)}`);
      }
      return null;
    }
  }

  private toClip(row: PregenerationClipRow): PregenerationClip {
    return {
      id: String(row.id),
      lang: row.lang as PregenLang,
      speedTier: row.speedTier as PregenSpeedTierId,
      teacherSpeed: Number(row.teacherSpeed),
      audioFile: String(row.audioFile),
      audioRef: String(row.audioRef),
      sha256: String(row.sha256),
      durationMs: Number(row.durationMs),
      bytes: Number(row.bytes),
      voiceId: String(row.voiceId),
      engineVersion: String(row.engineVersion),
    };
  }

  /** 简单容量控制：进程内缓存只做加速，错了顶多多查一次库。 */
  private trimCaches(): void {
    const now = Date.now();
    if (this.positiveCache.size > 2000) {
      for (const [key, item] of this.positiveCache) {
        if (item.expiresAt <= now) this.positiveCache.delete(key);
      }
    }
    if (this.negativeCache.size > 4000) {
      for (const [key, until] of this.negativeCache) {
        if (until <= now) this.negativeCache.delete(key);
      }
    }
  }
}

interface PregenerationClipRow {
  id: string;
  lang: string;
  speedTier: string;
  teacherSpeed: number | string;
  audioFile: string;
  audioRef: string;
  sha256: string;
  durationMs: number;
  bytes: number;
  voiceId: string;
  engineVersion: string;
}

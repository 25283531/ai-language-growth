import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizeCefrLevel } from '@alg/curriculum';
import type { CefrCurriculumLevel } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';
import { ImageCacheService } from '../media/image-cache.service';
import type { Prisma } from '@prisma/client';

type WarmLevelOptions = {
  /** 单次最多解析多少张新图片，避免管理员点击后长时间占用连接。 */
  maxImages?: number;
  /** 单次最多合成多少条语音；其余交给后续增量任务。 */
  maxSpeech?: number;
  /** 管理员手动触发时忽略内存去重。 */
  force?: boolean;
};

type WarmLevelResult = {
  level: string;
  publishedUnits: number;
  publishedItems: number;
  imagesResolved: number;
  imagesAttached: number;
  speechGenerated: number;
  speechSkipped: number;
  speechFailed: number;
  mode: 'live' | 'mock-skip' | 'disabled';
  reason?: string;
};

type ImageAssetView = { id: string; ref: string; sourceUrl?: string | null; targetWord: string };

@Injectable()
export class CurriculumWarmupService {
  private readonly logger = new Logger(CurriculumWarmupService.name);
  /** learnerId:level -> last trigger; 防止仪表盘刷新重复扫描。 */
  private readonly recentlyWarmed = new Map<string, number>();
  private readonly wordImageCache = new Map<string, ImageAssetView | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly router: ModelRouterImpl,
    private readonly imageCache: ImageCacheService,
  ) {}

  /**
   * 到达新级别时预热该级别的图片与语音。
   *
   * 设计为 fire-and-forget：仪表盘只负责触发，不能因为图片搜索/TTS 供应商慢而
   * 阻塞首页；失败只记录，不影响级别展示。同一学习者同一级别 7 天内只触发一次。
   */
  warmLearnerLevel(learnerId: string, level: string): void {
    if (process.env.CURRICULUM_WARMUP_ENABLED === 'false') return;
    const key = `${learnerId}:${level}`;
    const last = this.recentlyWarmed.get(key) ?? 0;
    if (Date.now() - last < 7 * 24 * 60 * 60 * 1000) return;
    this.recentlyWarmed.set(key, Date.now());
    void this.warmLevel(level, { maxImages: 24, maxSpeech: 30 })
      .catch((error) => this.logger.warn(`级别媒体预热失败 ${level}：${error instanceof Error ? error.message : '未知错误'}`));
  }

  async warmLevel(level: string, options: WarmLevelOptions = {}): Promise<WarmLevelResult> {
    const normalized = this.normalizeLevel(level);
    if (options.force) this.wordImageCache.clear();
    const aliases = levelAliases(normalized);
    const maxImages = Math.max(0, Math.min(60, options.maxImages ?? 24));
    const maxSpeech = Math.max(0, Math.min(120, options.maxSpeech ?? 30));
    const gatewayMode = (process.env.AI_GATEWAY_MODE || '').toLowerCase();
    const result: WarmLevelResult = {
      level: normalized,
      publishedUnits: 0,
      publishedItems: 0,
      imagesResolved: 0,
      imagesAttached: 0,
      speechGenerated: 0,
      speechSkipped: 0,
      speechFailed: 0,
      mode: gatewayMode === 'mock' ? 'mock-skip' : 'live',
    };
    const units = await this.prisma.curriculum_units.findMany({
      where: { level: { in: aliases }, reviewStatus: 'published' },
      select: { id: true, topicId: true },
      orderBy: [{ level: 'asc' }, { order: 'asc' }],
      take: 200,
    });
    result.publishedUnits = units.length;
    if (!units.length) {
      return { ...result, reason: '该级别还没有已发布课程；请先在课程管理中审核并发布。' };
    }
    const topicIds = [...new Set(units.map((unit) => unit.topicId).filter(Boolean))];
    const items = await this.prisma.learning_items.findMany({
      where: {
        reviewStatus: 'published',
        itemType: 'curriculum_activity',
        topicId: { in: topicIds },
      },
      select: { id: true, refId: true, topicId: true, content: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
      take: Math.min(400, Math.max(60, maxSpeech * 4)),
    });
    result.publishedItems = items.length;
    if (!items.length) {
      return { ...result, reason: '该级别没有已发布的课程活动。' };
    }

    // —— 1. 图片：只为真实用到的目标词解析，缓存失败不回滚课程。 ——
    const words = [...new Set(items.flatMap((item) => targetWordsOf(item.content)))];
    const imageByWord = new Map<string, ImageAssetView>();
    for (const item of items) {
      for (const asset of imageAssetsOf(item.content)) {
        if (asset.targetWord) imageByWord.set(asset.targetWord.toLowerCase(), asset);
      }
    }
    let imageBudget = maxImages;
    for (const word of words) {
      if (imageBudget <= 0) break;
      if (imageByWord.has(word.toLowerCase())) continue;
      const asset = await this.resolveImage(word);
      imageBudget -= 1;
      if (!asset) continue;
      result.imagesResolved += 1;
      imageByWord.set(word.toLowerCase(), asset);
    }

    const finalContents = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const original = asObject(item.content);
      if (!original) continue;
      const desired = targetWordsOf(original)
        .map((word) => imageByWord.get(word.toLowerCase()))
        .filter((asset): asset is ImageAssetView => Boolean(asset));
      if (!desired.length) {
        finalContents.set(item.id, original);
        continue;
      }
      const existing = imageAssetsOf(original);
      const byId = new Map([...existing, ...desired].map((asset) => [asset.id, asset]));
      const imageAssets = [...byId.values()];
      const imageAssetIds = imageAssets.map((asset) => asset.id);
      const changed = JSON.stringify(imageAssetIds) !== JSON.stringify(original.imageAssetIds ?? []);
      if (changed) {
        const updated = { ...original, imageAssetIds, imageAssets };
        await this.prisma.learning_items.update({
          where: { id: item.id },
          data: { content: updated as Prisma.InputJsonValue },
        });
        finalContents.set(item.id, updated);
        result.imagesAttached += desired.length;
      } else {
        finalContents.set(item.id, original);
      }
    }

    // —— 2. 语音：必须等图片回填后再计算 contentVersion，避免刚生成就失效。 ——
    if (result.mode === 'mock-skip' || maxSpeech === 0) {
      result.reason = result.mode === 'mock-skip'
        ? '当前 AI_GATEWAY_MODE=mock，已跳过语音预生成，避免把占位音频写入正式缓存。'
        : undefined;
      return result;
    }
    let speechBudget = maxSpeech;
    for (const item of items) {
      if (speechBudget <= 0) break;
      const content = finalContents.get(item.id) ?? asObject(item.content);
      if (!content) continue;
      const teacherUtterance = typeof content.teacherUtteranceZh === 'string' ? content.teacherUtteranceZh : '';
      const demonstration = typeof content.demonstrationText === 'string' ? content.demonstrationText : '';
      const speechText = [teacherUtterance, demonstration].filter(Boolean).join(' ');
      if (!speechText) {
        result.speechSkipped += 1;
        continue;
      }
      if (Array.from(speechText).length > 500) {
        result.speechSkipped += 1;
        continue;
      }
      // 从数据库重新读取最终内容，contentVersion 与编排器读取同一份 JSONB。
      const fresh = await this.prisma.learning_items.findUnique({
        where: { id: item.id },
        select: { content: true, refId: true, topicId: true },
      });
      if (!fresh) continue;
      const contentVersion = createHash('sha256').update(JSON.stringify(fresh.content)).digest('hex');
      try {
        const decision = await this.router.route({ serviceKind: 'tts', taskRoute: 'tts.dynamic_teaching' });
        await this.gateway.ttsWithResult({
          text: speechText,
          voice: {
            teacherSpeed: 0.65,
            voiceStyle: 'gentle',
            pauseAfterSentenceMs: 1000,
            pronunciationMode: 'slow_clear',
          },
          voiceIdentity: 'teacher_default',
          timeoutMs: 12000,
          cacheScope: {
            scope: 'PUBLIC_CURRICULUM',
            topicId: fresh.topicId || '',
            contentId: fresh.refId,
            contentVersion,
          },
        }, decision);
        result.speechGenerated += 1;
        speechBudget -= 1;
      } catch {
        result.speechFailed += 1;
        // 单条失败不阻断该级别其余课程；下一次管理员/级别触发会重试。
      }
    }
    return result;
  }

  private normalizeLevel(level: string): CefrCurriculumLevel {
    try {
      return normalizeCefrLevel(level);
    } catch {
      throw new BadRequestException(`不支持的 CEFR 等级：${level}`);
    }
  }

  private async resolveImage(word: string): Promise<ImageAssetView | null> {
    const key = word.toLowerCase();
    if (this.wordImageCache.has(key)) return this.wordImageCache.get(key) ?? null;
    if (process.env.CURRICULUM_IMAGE_SEARCH === 'disabled') {
      this.wordImageCache.set(key, null);
      return null;
    }
    const searchBase = process.env.CURRICULUM_IMAGE_SEARCH_URL || 'https://api.openverse.org/v1/images/';
    try {
      const url = new URL(searchBase);
      url.searchParams.set('q', `${word} children flashcard`);
      url.searchParams.set('page_size', '3');
      url.searchParams.set('license_type', 'commercial');
      url.searchParams.set('mature', 'false');
      const response = await fetch(url, {
        headers: { 'user-agent': 'ai-language-growth-curriculum/1.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`图片搜索失败 (${response.status})`);
      const payload = await response.json() as { results?: Array<Record<string, unknown>> };
      const candidate = (payload.results ?? []).find((item) => {
        const sourceUrl = typeof item.url === 'string' ? item.url : '';
        return /^https?:\/\//i.test(sourceUrl) && typeof item.license === 'string' && item.license.length > 0;
      });
      if (!candidate) {
        this.wordImageCache.set(key, null);
        return null;
      }
      const sourceUrl = String(candidate.url);
      const existing = await this.prisma.media_assets.findFirst({
        where: { kind: 'image', sourceUrl },
        select: { id: true, ref: true, sourceUrl: true, cacheStatus: true },
      });
      const license = [candidate.license, candidate.license_version].filter(Boolean).join(' ');
      const attribution = [candidate.creator, candidate.title].filter((part) => typeof part === 'string' && part.trim()).join(' — ');
      const asset = existing ?? await this.prisma.media_assets.create({
        data: {
          kind: 'image',
          ref: sourceUrl,
          sourceUrl,
          license,
          attribution: attribution || null,
          sourceProvider: 'openverse_curriculum',
          cacheStatus: 'pending',
        },
        select: { id: true, ref: true, sourceUrl: true, cacheStatus: true },
      });
      if (asset.cacheStatus !== 'cached') {
        try {
          await this.imageCache.cacheNext(asset.id);
        } catch {
          // 缓存失败保留 media_assets 记录，调度器会按冷却时间重试。
        }
      }
      const fresh = await this.prisma.media_assets.findUnique({
        where: { id: asset.id },
        select: { id: true, ref: true, sourceUrl: true },
      });
      const view: ImageAssetView | null = fresh
        ? { id: fresh.id, ref: `/api/v1/media/audio/images/${fresh.id}`, sourceUrl: fresh.sourceUrl, targetWord: word }
        : null;
      this.wordImageCache.set(key, view);
      return view;
    } catch (error) {
      this.logger.warn(`图片解析失败 ${word}：${error instanceof Error ? error.message : '未知错误'}`);
      // 不缓存失败结果，允许下次级别预热重试。
      return null;
    }
  }
}

function levelAliases(level: CefrCurriculumLevel): string[] {
  const base = [level, level.toLowerCase(), level.toUpperCase()];
  if (level === 'pre-A1') base.push('pre-A', 'pre_a1', 'prea1', 'pre-a1');
  return [...new Set(base)];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function targetWordsOf(content: unknown): string[] {
  const object = asObject(content);
  if (!object || !Array.isArray(object.targetWords)) return [];
  return object.targetWords.filter((word): word is string => typeof word === 'string' && word.trim().length > 0);
}

function imageAssetsOf(content: unknown): ImageAssetView[] {
  const object = asObject(content);
  if (!object || !Array.isArray(object.imageAssets)) return [];
  return object.imageAssets.flatMap((asset) => {
    const item = asObject(asset);
    if (!item || typeof item.id !== 'string' || typeof item.ref !== 'string') return [];
    return [{
      id: item.id,
      ref: item.ref,
      sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : null,
      targetWord: typeof item.targetWord === 'string' ? item.targetWord : '',
    }];
  });
}

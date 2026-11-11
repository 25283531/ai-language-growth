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

type MissingImage = {
  key: string;
  kind: ImageKind;
  targetText: string;
  query: string;
  reason: string;
};

type WarmLevelResult = {
  level: string;
  publishedUnits: number;
  publishedItems: number;
  imagesResolved: number;
  imagesQueued: number;
  imagesAttached: number;
  missingImages: MissingImage[];
  speechGenerated: number;
  speechSkipped: number;
  speechFailed: number;
  mode: 'live' | 'mock-skip' | 'disabled';
  reason?: string;
};

type ImageKind = 'word' | 'phrase' | 'scene';

type ImageRequirement = {
  key: string;
  kind: ImageKind;
  targetWord?: string;
  targetText: string;
  query: string;
  alt: string;
};

type ImageAssetView = {
  id: string;
  ref: string;
  sourceUrl?: string | null;
  key: string;
  kind: ImageKind;
  targetWord?: string;
  targetText: string;
};

type ImageCandidate = {
  url: string;
  license: string;
  attribution: string;
  provider: string;
  title: string;
  tags: string;
  width: number;
  height: number;
};

@Injectable()
export class CurriculumWarmupService {
  private readonly logger = new Logger(CurriculumWarmupService.name);
  /** learnerId:level -> last trigger; 防止仪表盘刷新重复扫描。 */
  private readonly recentlyWarmed = new Map<string, number>();
  /** requirement.key -> resolved asset / null；管理员可 force 清空重试。 */
  private readonly imageResolutionCache = new Map<string, ImageAssetView | null>();

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
    if (options.force) this.imageResolutionCache.clear();
    const aliases = levelAliases(normalized);
    const maxImages = Math.max(0, Math.min(60, options.maxImages ?? 24));
    const maxSpeech = Math.max(0, Math.min(120, options.maxSpeech ?? 30));
    const gatewayMode = (process.env.AI_GATEWAY_MODE || '').toLowerCase();
    const result: WarmLevelResult = {
      level: normalized,
      publishedUnits: 0,
      publishedItems: 0,
      imagesResolved: 0,
      imagesQueued: 0,
      imagesAttached: 0,
      missingImages: [],
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

    // —— 1. 图片：按单词/短句/场景需求解析；只处理真实用到的需求。 ——
    const existingByKey = new Map<string, ImageAssetView>();
    const existingByText = new Map<string, ImageAssetView>();
    for (const item of items) {
      for (const asset of imageAssetsOf(item.content)) {
        if (asset.key) existingByKey.set(asset.key, asset);
        if (asset.targetText) existingByText.set(normalizeKeyText(asset.targetText), asset);
      }
    }
    const requirementByKey = new Map<string, ImageRequirement>();
    for (const item of items) {
      for (const requirement of imageRequirementsOf(item.content)) {
        if (!requirementByKey.has(requirement.key)) requirementByKey.set(requirement.key, requirement);
      }
    }

    let imageBudget = maxImages;
    for (const requirement of requirementByKey.values()) {
      if (imageBudget <= 0) break;
      const matched = existingByKey.get(requirement.key) || existingByText.get(normalizeKeyText(requirement.targetText));
      if (matched) {
        existingByKey.set(requirement.key, { ...matched, key: requirement.key });
        continue;
      }
      const resolution = await this.resolveImage(requirement);
      imageBudget -= 1;
      if (resolution.asset) {
        existingByKey.set(requirement.key, resolution.asset);
        if (resolution.queued) result.imagesQueued += 1;
        else result.imagesResolved += 1;
      } else {
        result.missingImages.push({
          key: requirement.key,
          kind: requirement.kind,
          targetText: requirement.targetText,
          query: requirement.query,
          reason: resolution.reason || '未找到合适的图片',
        });
      }
    }

    const finalContents = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const original = asObject(item.content);
      if (!original) continue;
      const requirements = imageRequirementsOf(original);
      const desired = requirements
        .map((requirement) => existingByKey.get(requirement.key))
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

  /**
   * 管理员上传图片后，把图片挂到所有包含该 imageKey 的已发布活动上。
   * 只改 media 字段，不改教师话语和评估规则。
   */
  async attachUploadedImage(input: {
    assetId: string;
    key: string;
    kind: ImageKind;
    targetText: string;
    targetWord?: string;
  }): Promise<{ attached: number }> {
    const asset = await this.prisma.media_assets.findUnique({
      where: { id: input.assetId },
      select: { id: true, sourceUrl: true, ref: true },
    });
    if (!asset) throw new BadRequestException('图片资源不存在');
    const view: ImageAssetView = {
      id: asset.id,
      ref: `/api/v1/media/audio/images/${asset.id}`,
      sourceUrl: asset.sourceUrl,
      key: input.key,
      kind: input.kind,
      targetWord: input.targetWord,
      targetText: input.targetText,
    };
    const items = await this.prisma.learning_items.findMany({
      where: { reviewStatus: 'published', itemType: 'curriculum_activity' },
      select: { id: true, content: true },
      take: 1000,
      orderBy: { updatedAt: 'desc' },
    });
    let attached = 0;
    for (const item of items) {
      const content = asObject(item.content);
      if (!content) continue;
      const requirements = imageRequirementsOf(content);
      if (!requirements.some((requirement) => requirement.key === input.key)) continue;
      const existing = imageAssetsOf(content);
      if (existing.some((itemAsset) => itemAsset.key === input.key)) continue;
      const imageAssets = [...existing, view];
      await this.prisma.learning_items.update({
        where: { id: item.id },
        data: {
          content: {
            ...content,
            imageAssetIds: imageAssets.map((itemAsset) => itemAsset.id),
            imageAssets,
          } as Prisma.InputJsonValue,
        },
      });
      attached += 1;
    }
    this.imageResolutionCache.set(input.key, view);
    return { attached };
  }

  private normalizeLevel(level: string): CefrCurriculumLevel {
    try {
      return normalizeCefrLevel(level);
    } catch {
      throw new BadRequestException(`不支持的 CEFR 等级：${level}`);
    }
  }

  private async resolveImage(requirement: ImageRequirement): Promise<{
    asset?: ImageAssetView;
    queued?: boolean;
    reason?: string;
  }> {
    if (this.imageResolutionCache.has(requirement.key)) {
      const cached = this.imageResolutionCache.get(requirement.key);
      return cached ? { asset: cached } : { reason: '此前未找到合适的图片，可重试或由管理员上传' };
    }
    if (process.env.CURRICULUM_IMAGE_SEARCH === 'disabled') {
      this.imageResolutionCache.set(requirement.key, null);
      return { reason: '图片网络搜索已关闭；可由管理员上传' };
    }
    let candidates: ImageCandidate[];
    try {
      candidates = await this.searchCandidates(requirement);
    } catch (error) {
      this.logger.warn(`图片搜索失败 ${requirement.key}：${error instanceof Error ? error.message : '未知错误'}`);
      return { reason: '图片搜索服务暂时不可用；可由管理员上传' };
    }
    if (!candidates.length) {
      this.imageResolutionCache.set(requirement.key, null);
      return { reason: '未搜索到授权明确的图片' };
    }
    let lastReason = '候选图片下载或格式校验失败';
    for (const candidate of candidates.slice(0, 5)) {
      try {
        const existing = await this.prisma.media_assets.findFirst({
          where: { kind: 'image', sourceUrl: candidate.url },
          select: { id: true, ref: true, sourceUrl: true, cacheStatus: true },
        });
        const asset = existing ?? await this.prisma.media_assets.create({
          data: {
            kind: 'image',
            ref: candidate.url,
            sourceUrl: candidate.url,
            license: candidate.license,
            attribution: candidate.attribution || null,
            sourceProvider: candidate.provider,
            cacheStatus: 'pending',
          },
          select: { id: true, ref: true, sourceUrl: true, cacheStatus: true },
        });
        if (asset.cacheStatus !== 'cached') {
          try {
            await this.imageCache.cacheNext(asset.id);
          } catch {
            // 失败保留记录，调度器会按冷却时间重试；继续尝试下一候选。
          }
        }
        const fresh = await this.prisma.media_assets.findUnique({
          where: { id: asset.id },
          select: { id: true, ref: true, sourceUrl: true, cacheStatus: true },
        });
        if (!fresh) continue;
        if (fresh.cacheStatus === 'failed') {
          lastReason = '图片下载失败或格式不支持';
          continue;
        }
        const view: ImageAssetView = {
          id: fresh.id,
          ref: `/api/v1/media/audio/images/${fresh.id}`,
          sourceUrl: fresh.sourceUrl,
          key: requirement.key,
          kind: requirement.kind,
          targetWord: requirement.targetWord,
          targetText: requirement.targetText,
        };
        this.imageResolutionCache.set(requirement.key, view);
        return { asset: view, queued: fresh.cacheStatus !== 'cached' };
      } catch (error) {
        lastReason = error instanceof Error ? error.message : '图片下载失败';
      }
    }
    // 有候选但全部失败：不缓存 null，下一次触发仍可重试。
    return { reason: `${lastReason}；可由管理员上传` };
  }

  /** Openverse + Wikimedia Commons 两个免密钥来源；按标题/标签与目标文本匹配度排序。 */
  private async searchCandidates(requirement: ImageRequirement): Promise<ImageCandidate[]> {
    const results = await Promise.allSettled([
      this.searchOpenverse(requirement),
      this.searchWikimediaCommons(requirement),
    ]);
    const candidates = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const unique = new Map<string, ImageCandidate>();
    for (const candidate of candidates) {
      if (!candidate.url || !candidate.license) continue;
      if (!/^https:\/\//i.test(candidate.url)) continue;
      if (/\.svg(?:$|\?)/i.test(candidate.url)) continue;
      if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
    }
    return [...unique.values()]
      .sort((left, right) => scoreCandidate(right, requirement) - scoreCandidate(left, requirement))
      .slice(0, 8);
  }

  private async searchOpenverse(requirement: ImageRequirement): Promise<ImageCandidate[]> {
    const searchBase = process.env.CURRICULUM_IMAGE_SEARCH_URL || 'https://api.openverse.org/v1/images/';
    const url = new URL(searchBase);
    url.searchParams.set('q', requirement.query);
    url.searchParams.set('page_size', '10');
    url.searchParams.set('mature', 'false');
    const response = await fetch(url, {
      headers: { 'user-agent': 'ai-language-growth-curriculum/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const payload = await response.json() as { results?: Array<Record<string, unknown>> };
    return (payload.results ?? []).flatMap((item) => {
      const sourceUrl = typeof item.url === 'string' ? item.url : '';
      const license = [item.license, item.license_version].filter(Boolean).join(' ');
      if (!sourceUrl || !license) return [];
      const tags = Array.isArray(item.tags)
        ? item.tags.map((tag) => {
          if (typeof tag === 'string') return tag;
          if (tag && typeof tag === 'object' && typeof (tag as { name?: unknown }).name === 'string') {
            return (tag as { name: string }).name;
          }
          return '';
        }).join(' ')
        : '';
      return [{
        url: sourceUrl,
        license,
        attribution: [item.creator, item.title, item.source].filter((part) => typeof part === 'string' && part.trim()).join(' — '),
        provider: 'openverse_curriculum',
        title: typeof item.title === 'string' ? item.title : '',
        tags,
        width: typeof item.width === 'number' ? item.width : 0,
        height: typeof item.height === 'number' ? item.height : 0,
      }];
    });
  }

  private async searchWikimediaCommons(requirement: ImageRequirement): Promise<ImageCandidate[]> {
    if (process.env.CURRICULUM_IMAGE_COMMONS === 'disabled') return [];
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', requirement.query);
    url.searchParams.set('gsrnamespace', '6');
    url.searchParams.set('gsrlimit', '8');
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|size|extmetadata');
    url.searchParams.set('iiurlwidth', '900');
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');
    const response = await fetch(url, {
      headers: { 'user-agent': 'ai-language-growth-curriculum/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];
    const payload = await response.json() as {
      query?: {
        pages?: Record<string, {
          title?: string;
          imageinfo?: Array<{
            thumburl?: string;
            url?: string;
            width?: number;
            height?: number;
            extmetadata?: Record<string, { value?: unknown }>;
          }>;
        }>;
      };
    };
    return Object.values(payload.query?.pages ?? {}).flatMap((page) => {
      const info = page.imageinfo?.[0];
      if (!info) return [];
      const sourceUrl = info.thumburl || info.url || '';
      const license = stripHtml(info.extmetadata?.LicenseShortName?.value);
      if (!sourceUrl || !license) return [];
      return [{
        url: sourceUrl,
        license,
        attribution: stripHtml(info.extmetadata?.Artist?.value) || stripHtml(page.title),
        provider: 'wikimedia_commons',
        title: stripHtml(page.title),
        tags: stripHtml(info.extmetadata?.ImageDescription?.value),
        width: info.width || 0,
        height: info.height || 0,
      }];
    });
  }
}

function scoreCandidate(candidate: ImageCandidate, requirement: ImageRequirement): number {
  const target = normalizeText(requirement.targetText);
  const metadata = normalizeText(`${candidate.title} ${candidate.tags}`);
  let score = 0;
  if (target && metadata.includes(target)) score += 60;
  if (requirement.kind === 'word' && metadata.includes(target)) score += 15;
  if (candidate.width >= 800 && candidate.height >= 600) score += 12;
  else if (candidate.width >= 500 && candidate.height >= 350) score += 6;
  if (candidate.width && candidate.height && candidate.width >= candidate.height) score += 5;
  if (candidate.provider === 'openverse_curriculum') score += 3;
  if (/illustration|cartoon|child|kid|flashcard|drawing/i.test(metadata)) score += 8;
  return score;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeKeyText(value: string): string {
  return normalizeText(value);
}

function stripHtml(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
    : '';
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

function imageRequirementsOf(content: unknown): ImageRequirement[] {
  const object = asObject(content);
  if (!object) return [];
  if (Array.isArray(object.imageRequirements)) {
    return object.imageRequirements.flatMap((value) => {
      const item = asObject(value);
      if (!item || typeof item.key !== 'string') return [];
      const targetText = typeof item.targetText === 'string'
        ? item.targetText
        : typeof item.targetWord === 'string' ? item.targetWord : '';
      if (!targetText) return [];
      const kind: ImageKind = item.kind === 'phrase' || item.kind === 'scene' ? item.kind : 'word';
      return [{
        key: item.key,
        kind,
        targetWord: typeof item.targetWord === 'string' ? item.targetWord : undefined,
        targetText,
        query: typeof item.query === 'string' && item.query ? item.query : `${targetText} children illustration`,
        alt: typeof item.alt === 'string' && item.alt ? item.alt : `${targetText} 配图`,
      }];
    });
  }
  // 兼容旧发布内容：没有 imageRequirements 时，按 targetWords 生成单词图需求。
  return targetWordsOf(content).map((word) => ({
    key: `word:${slug(word)}`,
    kind: 'word',
    targetWord: word,
    targetText: word,
    query: `${word} children flashcard illustration`,
    alt: `${word} 的儿童教学图片`,
  }));
}

function imageAssetsOf(content: unknown): ImageAssetView[] {
  const object = asObject(content);
  if (!object || !Array.isArray(object.imageAssets)) return [];
  return object.imageAssets.flatMap((asset) => {
    const item = asObject(asset);
    if (!item || typeof item.id !== 'string' || typeof item.ref !== 'string') return [];
    const targetText = typeof item.targetText === 'string'
      ? item.targetText
      : typeof item.targetWord === 'string' ? item.targetWord : '';
    const key = typeof item.key === 'string' && item.key
      ? item.key
      : targetText ? `word:${slug(targetText)}` : item.id;
    return [{
      id: item.id,
      ref: item.ref,
      sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : null,
      key,
      kind: item.kind === 'phrase' || item.kind === 'scene' ? item.kind : 'word',
      targetWord: typeof item.targetWord === 'string' ? item.targetWord : undefined,
      targetText,
    }];
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}

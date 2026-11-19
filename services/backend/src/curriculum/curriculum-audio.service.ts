import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { textbookUnitContentSchema, type TextbookUnitContent } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';
import { contentHash } from './curriculum-publish';
import {
  assembleCurriculumPassage,
  buildCurriculumAudioPlan,
  normalizePhoneme,
  type AudioClipSpec,
  type CurriculumAudioPlan,
} from './curriculum-audio-plan';

export type CurriculumAudioMode = 'live' | 'mock-skip' | 'disabled' | 'no-content';

export interface CurriculumAudioWarmResult {
  unitId: string;
  topicId: string;
  contentVersion: string;
  mode: CurriculumAudioMode;
  plannedSentences: number;
  plannedFocusWords: number;
  plannedClips: number;
  generated: number;
  reused: number;
  failed: number;
  skipped: number;
  sentenceClips: number;
  wordClips: number;
  errors: Array<{ clipKey: string; kind: string; message: string }>;
  reason?: string;
}

export interface CurriculumAudioRebuildResult extends CurriculumAudioWarmResult {
  invalidated: number;
}

type UnitRecord = {
  id: string;
  topicId: string;
  contentVersion: string | null;
  content: unknown;
};

type StoredClip = {
  clipKey: string;
  kind: string;
  partIndex: number;
  position: number;
  speedTier: string;
  speed: number;
  text: string;
  audioRef: string | null;
  durationMs: number | null;
  status: string;
};

/**
 * 课程双速/拆读音频预热、版本失效与运行时装配。
 *
 * 设计与 D-014 / D-1006 对齐：
 *  - 缓存作用域的 contentId 为 `${unitId}#${clipKey}`，因此键里显式包含句子/词身份；
 *  - contentVersion 取课程发布版本，编辑后旧片段不再被选中；
 *  - 旧音频不删除，回滚到旧版本时可直接复用；
 *  - 从不按纯文本哈希跨课程复用。
 */
@Injectable()
export class CurriculumAudioService {
  private readonly logger = new Logger(CurriculumAudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly router: ModelRouterImpl,
  ) {}

  get enabled(): boolean {
    return process.env.CURRICULUM_WARMUP_ENABLED !== 'false';
  }

  /** 预热一个课程单元当前版本的逐句双速与重点词拆读音频。 */
  async warmUnit(
    unitId: string,
    options: { force?: boolean; maxClips?: number } = {},
  ): Promise<CurriculumAudioWarmResult> {
    const unit = await this.loadUnit(unitId);
    const parsed = textbookUnitContentSchema.safeParse(unit.content);
    const version = unit.contentVersion?.trim() || contentHash(unit.content);
    const empty = this.emptyResult(unit, version);
    if (!this.enabled) {
      return { ...empty, mode: 'disabled', reason: 'CURRICULUM_WARMUP_ENABLED=false，跳过课程音频合成。' };
    }
    if (!parsed.success) {
      return { ...empty, mode: 'no-content', reason: '课程内容不是教材单元资源包，跳过音频预热。' };
    }
    const content = parsed.data;
    const plan = buildCurriculumAudioPlan(content, {
      knownPhonemes: await this.loadKnownPhonemes(),
    });
    const allClips = [...plan.sentenceClips, ...plan.wordClips];
    const maxClips = Math.max(0, Math.min(240, options.maxClips ?? 120));
    const selected = allClips.slice(0, maxClips);
    const result: CurriculumAudioWarmResult = {
      ...empty,
      plannedSentences: new Set(plan.sentenceClips.map((clip) => clip.clipKey)).size,
      plannedFocusWords: plan.focusWords.length,
      plannedClips: allClips.length,
      skipped: plan.skipped.length + Math.max(0, allClips.length - selected.length),
    };
    if (!selected.length) {
      return { ...result, mode: 'live', reason: '该单元没有可预热的句子或重点词。' };
    }

    const decision = await this.router.route({ serviceKind: 'tts', taskRoute: 'tts.curriculum_clip' });
    for (const spec of selected) {
      const existing = await this.prisma.curriculum_audio_clips.findUnique({
        where: {
          curriculum_audio_clip_identity: {
            unitId: unit.id,
            contentVersion: version,
            clipKey: spec.clipKey,
            kind: spec.kind,
            partIndex: spec.partIndex,
            speedTier: spec.speedTier,
          },
        },
        select: { audioRef: true, status: true },
      });
      if (!options.force && existing?.status === 'ready' && existing.audioRef) {
        result.reused += 1;
        this.countKind(result, spec.kind);
        continue;
      }

      try {
        const outcome = await this.gateway.ttsWithResult({
          text: spec.text,
          voice: {
            teacherSpeed: spec.speed,
            voiceStyle: spec.voiceStyle,
            pauseAfterSentenceMs: spec.speed < 0.9 ? 900 : 600,
            pronunciationMode: spec.pronunciationMode,
          },
          voiceIdentity: 'teacher_default',
          timeoutMs: 12000,
          cacheScope: {
            scope: 'PUBLIC_CURRICULUM',
            topicId: unit.topicId,
            // 显式把句子/词身份与档位放进 contentId：键 = 课程身份 + 片段身份 + 版本 + 语速。
            contentId: `${unit.id}#${spec.clipKey}`,
            contentVersion: version,
          },
        }, decision);

        if (outcome.result.providerAlias.startsWith('mock')) {
          // mock 音频不能进入正式课程缓存；等到真实供应商可用时由重建接口重试。
          result.mode = 'mock-skip';
          result.failed += 1;
          this.countKind(result, spec.kind);
          result.errors.push({ clipKey: spec.clipKey, kind: spec.kind, message: 'mock_provider' });
          continue;
        }

        await this.prisma.curriculum_audio_clips.upsert({
          where: {
            curriculum_audio_clip_identity: {
              unitId: unit.id,
              contentVersion: version,
              clipKey: spec.clipKey,
              kind: spec.kind,
              partIndex: spec.partIndex,
              speedTier: spec.speedTier,
            },
          },
          create: {
            unitId: unit.id,
            topicId: unit.topicId,
            contentVersion: version,
            ...clipRow(spec, outcome.result.audioRef, null),
          },
          update: {
            ...clipRow(spec, outcome.result.audioRef, null),
          },
        });
        if (outcome.result.cached) result.reused += 1;
        else result.generated += 1;
        this.countKind(result, spec.kind);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`课程音频合成失败 ${unit.id}/${spec.clipKey}/${spec.kind}: ${message.slice(0, 160)}`);
        result.failed += 1;
        this.countKind(result, spec.kind);
        result.errors.push({ clipKey: spec.clipKey, kind: spec.kind, message: message.slice(0, 200) });
        await this.prisma.curriculum_audio_clips.upsert({
          where: {
            curriculum_audio_clip_identity: {
              unitId: unit.id,
              contentVersion: version,
              clipKey: spec.clipKey,
              kind: spec.kind,
              partIndex: spec.partIndex,
              speedTier: spec.speedTier,
            },
          },
          create: {
            unitId: unit.id,
            topicId: unit.topicId,
            contentVersion: version,
            ...clipRow(spec, null, message.slice(0, 500)),
          },
          update: {
            ...clipRow(spec, null, message.slice(0, 500)),
          },
        }).catch(() => undefined);
      }
    }
    return result;
  }

  /**
   * 重建当前版本的全部课程音频：先把 ready/failed 片段标记 stale，再强制重新请求 TTS；
   * 供应商缓存仍命中时记为 reused（不重复付费）。
   * 失败片段会保留可读错误，不影响文本与课堂继续使用。
   */
  async rebuildUnit(
    unitId: string,
    options: { maxClips?: number } = {},
  ): Promise<CurriculumAudioRebuildResult> {
    const unit = await this.loadUnit(unitId);
    const version = unit.contentVersion?.trim() || contentHash(unit.content);
    const before = await this.prisma.curriculum_audio_clips.findMany({
      where: { unitId, contentVersion: version, status: { in: ['ready', 'failed'] } },
      select: { id: true, status: true },
    });
    const readyIds = before.filter((row) => row.status === 'ready').map((row) => row.id);
    const invalidated = await this.prisma.curriculum_audio_clips.updateMany({
      where: { unitId, contentVersion: version, status: { in: ['ready', 'failed'] } },
      data: { status: 'stale' },
    });
    const warmed = await this.warmUnit(unitId, { force: true, maxClips: options.maxClips });
    // 供应商不可用（或开关关闭）时不要把本来可播的音频留在 stale：
    // 没有新音频可替换时，继续提供旧音频比让孩子听到空地址更安全。
    if (warmed.mode === 'mock-skip' || warmed.mode === 'disabled') {
      if (readyIds.length) {
        await this.prisma.curriculum_audio_clips.updateMany({
          where: { id: { in: readyIds } },
          data: { status: 'ready' },
        }).catch(() => undefined);
      }
    }
    return { ...warmed, invalidated: invalidated.count };
  }

  /** 返回当前版本音频覆盖情况；管理端可据此决定是否重建。 */
  async statusForUnit(unitId: string) {
    const unit = await this.loadUnit(unitId);
    const version = unit.contentVersion?.trim() || contentHash(unit.content);
    const rows = await this.prisma.curriculum_audio_clips.findMany({
      where: { unitId, contentVersion: version },
      select: { kind: true, status: true },
    });
    const byStatus: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    }
    return { unitId, topicId: unit.topicId, contentVersion: version, total: rows.length, byStatus, byKind };
  }

  /**
   * 运行时装配课文教学包。文本来自发布内容；音频只取当前 contentVersion 的 ready 片段，
   * 因此编辑后新版本不会误播旧音频。
   */
  async passageForTopic(topicId: string) {
    const unit = await this.prisma.curriculum_units.findFirst({
      where: { topicId, reviewStatus: 'published', availability: 'active' },
      orderBy: [{ publishedAt: 'desc' }, { currentVersion: 'desc' }],
      select: { id: true, topicId: true, content: true, contentVersion: true },
    });
    if (!unit?.content) return null;
    const parsed = textbookUnitContentSchema.safeParse(unit.content);
    if (!parsed.success) return null;
    const version = unit.contentVersion?.trim() || contentHash(unit.content);
    const rows = await this.prisma.curriculum_audio_clips.findMany({
      where: { unitId: unit.id, contentVersion: version, status: 'ready' },
      orderBy: [{ position: 'asc' }, { partIndex: 'asc' }],
      select: {
        clipKey: true,
        kind: true,
        partIndex: true,
        position: true,
        speedTier: true,
        speed: true,
        text: true,
        audioRef: true,
        durationMs: true,
        status: true,
      },
    });
    const lexicon = await this.loadSentencePhonetics(parsed.data);
    return assembleCurriculumPassage({
      unitId: unit.id,
      topicId: unit.topicId,
      contentVersion: version,
      content: parsed.data,
      clips: rows,
      knownPhonemes: await this.loadKnownPhonemes(),
      wordPhonetic: lexicon.phonetic,
      wordPos: lexicon.pos,
    });
  }

  /**
   * P1：为整句音标准备词表。单元自带词条优先，其余词用 lexicon_entries 补齐
   * （含屈折形式 variants）。查不到的词由 sentencePhonetic() 直接放弃。
   */
  private async loadSentencePhonetics(
    content: TextbookUnitContent,
  ): Promise<{ phonetic: Map<string, string>; pos: Map<string, string> }> {
    const table = new Map<string, string>();
    for (const item of content.vocabulary) {
      const word = item.word.trim().toLowerCase();
      const phonetic = (item.phonetic ?? '').trim();
      if (word && phonetic) table.set(word, phonetic);
    }
    const words = [...new Set([
      ...content.vocabulary.map((item) => item.word.trim().toLowerCase()),
      ...content.passage.paragraphs
        .flatMap((paragraph) => paragraph.sentences)
        .flatMap((sentence) => sentence.en.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []),
    ])].filter((word) => word.length > 1);
    if (!words.length) return { phonetic: table, pos: new Map() };
    const rows = await this.prisma.lexicon_entries.findMany({
      where: { OR: [{ word: { in: words } }, { variants: { hasSome: words } }] },
      select: { word: true, variants: true, phonetic: true, pos: true },
    });
    const pos = new Map<string, string>();
    for (const row of rows) {
      const phonetic = firstPronunciation(row.phonetic);
      const partOfSpeech = row.pos?.trim();
      const word = row.word.toLowerCase();
      if (phonetic) table.set(word, phonetic);
      if (partOfSpeech) pos.set(word, partOfSpeech);
      for (const variant of row.variants ?? []) {
        const form = variant.trim().toLowerCase();
        // 只接受规则屈折（helped→help、dishes→dish）；was→be、did→do 这类不规则形式
        // 读音与词干不同，猜了就教错，留给 AI 判定后再补。
        if (!isRegularVariant(form, word)) continue;
        if (phonetic) table.set(form, phonetic);
        if (partOfSpeech) pos.set(form, partOfSpeech);
      }
    }
    return { phonetic: table, pos };
  }

  /** 供管理端预览规划结果，不触发 TTS。 */
  async planForUnit(unitId: string): Promise<{ plan: CurriculumAudioPlan; contentVersion: string }> {
    const unit = await this.loadUnit(unitId);
    const parsed = textbookUnitContentSchema.safeParse(unit.content);
    if (!parsed.success) throw new NotFoundException('该单元没有可用的教材资源包');
    return {
      contentVersion: unit.contentVersion?.trim() || contentHash(unit.content),
      plan: buildCurriculumAudioPlan(parsed.data, { knownPhonemes: await this.loadKnownPhonemes() }),
    };
  }

  private async loadUnit(unitId: string): Promise<UnitRecord> {
    const unit = await this.prisma.curriculum_units.findUnique({
      where: { id: unitId },
      select: { id: true, topicId: true, content: true, contentVersion: true },
    });
    if (!unit) throw new NotFoundException('课程单元不存在');
    return unit;
  }

  private async loadKnownPhonemes(): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.phoneme_items.findMany({ select: { phoneme: true, ipa: true } });
    return new Set(
      rows.flatMap((row) => [normalizePhoneme(row.phoneme), normalizePhoneme(row.ipa)]).filter(Boolean),
    );
  }

  private emptyResult(unit: UnitRecord, version: string): CurriculumAudioWarmResult {
    return {
      unitId: unit.id,
      topicId: unit.topicId,
      contentVersion: version,
      mode: 'live',
      plannedSentences: 0,
      plannedFocusWords: 0,
      plannedClips: 0,
      generated: 0,
      reused: 0,
      failed: 0,
      skipped: 0,
      sentenceClips: 0,
      wordClips: 0,
      errors: [],
    };
  }

  private countKind(
    result: CurriculumAudioWarmResult,
    kind: string,
  ): void {
    if (kind === 'sentence') {
      result.sentenceClips += 1;
      return;
    }
    result.wordClips += 1;
  }
}

function clipRow(
  spec: AudioClipSpec,
  audioRef: string | null,
  error: string | null,
): Omit<Prisma.curriculum_audio_clipsUncheckedCreateInput, 'unitId' | 'topicId' | 'contentVersion'> {
  return {
    clipKey: spec.clipKey,
    kind: spec.kind,
    partIndex: spec.partIndex,
    position: spec.position,
    speedTier: spec.speedTier,
    speed: spec.speed,
    text: spec.text,
    audioRef,
    status: error ? 'failed' : 'ready',
    error,
  };
}

/** 词库一条记录可能带多个读音（用 . 或 ; 分隔），教学上只取第一个。 */
function firstPronunciation(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  return (value.split(/[.;]/)[0] ?? '').trim();
}

/** 规则屈折：变体以词干开头（help→helped、dish→dishes、open→opened）。 */
function isRegularVariant(form: string, lemma: string): boolean {
  if (!lemma || form === lemma) return false;
  return form.startsWith(lemma) && form.length <= lemma.length + 5;
}
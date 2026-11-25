import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/**
 * 课程发布/编辑/自动启用共用的落库动作。
 *
 * 这里不包含状态机，只负责把已经通过校验的内容写成 learning_items /
 * vocabulary_items 和图片资产。放在独立模块是为了让教材单元自动启用
 * 与人工发布走完全相同的运行时数据结构。
 */

export type PublishableImage = {
  url: string;
  license: string;
  attribution?: string;
};

export type PublishableVocabulary = {
  word: string;
  phonetic?: string;
  meaningZh?: string;
  syllables?: string[];
  difficultPhonemes?: string[];
  phrases?: string[];
  exampleSentences?: unknown;
  image?: PublishableImage;
};

export type PublishableActivity = {
  id?: string;
  title?: string;
  taskType: string;
  scenario?: string;
  difficulty?: number;
  order?: number;
  evidenceKind?: string;
  transferScenarioKey?: string;
  /** 课文跟读活动在复习轮保留目标文本。 */
  reviewMode?: 'read_aloud';
  skillNodeIds: string[];
  targetWords: string[];
  teacherUtteranceZh?: string;
  demonstrationText?: string;
  requiresPronunciationAssessment?: boolean;
  requiresAsr?: boolean;
  assessment?: {
    acceptedImageIds?: string[];
    acceptedTexts?: string[];
    requiredPhrases?: string[];
    openResponse?: boolean;
  };
  imageRequirements?: Array<{
    key: string;
    kind?: 'word' | 'phrase' | 'scene';
    targetWord?: string;
    targetText?: string;
    query?: string;
    alt?: string;
  }>;
  media?: {
    speechKey?: string;
    speechText?: string;
    imageKeys?: string[];
  };
};

export type PublishableLesson = {
  title: string;
  level: string;
  objectives?: string[];
  vocabulary: PublishableVocabulary[];
  activities: PublishableActivity[];
  images?: PublishableImage[];
};

export function contentHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** 登记内容引用的图片，返回 word -> media_asset.id 映射。 */
export async function registerContentImages(
  tx: Prisma.TransactionClient,
  content: PublishableLesson,
): Promise<Map<string, string>> {
  const imageByWord = new Map<string, string>();
  const imageSources = [
    ...(content.images ?? []),
    ...content.vocabulary.flatMap((item) => item.image ? [item.image] : []),
  ];
  for (const image of imageSources) {
    if (!image?.url || !image.license) continue;
    const existing = await tx.media_assets.findFirst({
      where: { kind: 'image', sourceUrl: image.url },
      select: { id: true },
    });
    const asset = existing ?? await tx.media_assets.create({
      data: {
        kind: 'image',
        ref: image.url,
        sourceUrl: image.url,
        license: image.license,
        attribution: image.attribution || null,
        sourceProvider: 'admin_curriculum',
      },
      select: { id: true },
    });
    for (const item of content.vocabulary) {
      if (item.image?.url === image.url) imageByWord.set(item.word.toLowerCase(), asset.id);
    }
  }
  return imageByWord;
}

/** 发布/编辑/自动启用共用：写入或更新 learning_items，编辑时归档被移除的活动。 */
export async function syncLearningItems(
  tx: Prisma.TransactionClient,
  unitId: string,
  topicId: string,
  content: PublishableLesson,
  skillIdByCode: Map<string, string>,
  imageByWord: Map<string, string>,
  archiveMissing: boolean,
  reviewStatus = 'published',
): Promise<void> {
  const existing = await tx.learning_items.findMany({
    where: { itemType: 'curriculum_activity', refId: { startsWith: `${unitId}:` } },
    select: { id: true, refId: true },
  });
  const idByRef = new Map(existing.map((item) => [item.refId, item.id]));
  const keepRefs = new Set<string>();

  for (const [index, activity] of content.activities.entries()) {
    const skillNodeId = skillIdByCode.get(activity.skillNodeIds[0] ?? '');
    if (!skillNodeId) throw new BadRequestException(`第 ${index + 1} 个活动绑定了不存在的能力节点`);
    const refId = `${unitId}:${index}`;
    keepRefs.add(refId);
    const data = {
      skillNodeId,
      itemType: 'curriculum_activity',
      refId,
      topicId,
      reviewStatus,
      content: buildLearningItemContent(activity, index, unitId, topicId, content, imageByWord),
    };
    const existingId = idByRef.get(refId);
    if (existingId) {
      await tx.learning_items.update({ where: { id: existingId }, data });
    } else {
      await tx.learning_items.create({ data });
    }
  }

  if (archiveMissing) {
    const staleIds = existing.filter((item) => !keepRefs.has(item.refId)).map((item) => item.id);
    if (staleIds.length) {
      await tx.learning_items.updateMany({ where: { id: { in: staleIds } }, data: { reviewStatus: 'archived' } });
    }
  }
}

function buildLearningItemContent(
  activity: PublishableActivity,
  index: number,
  unitId: string,
  topicId: string,
  content: PublishableLesson,
  imageByWord: Map<string, string>,
): Prisma.InputJsonValue {
  const imageAssetIds = activity.targetWords
    .map((word) => imageByWord.get(word.toLowerCase()))
    .filter((id): id is string => Boolean(id));
  const imageAssets = activity.targetWords.flatMap((word) => {
    const id = imageByWord.get(word.toLowerCase());
    if (!id) return [];
    const image = content.vocabulary.find((item) => item.word.toLowerCase() === word.toLowerCase())?.image;
    const requirement = activity.imageRequirements?.find((item) =>
      item.targetWord?.toLowerCase() === word.toLowerCase() || item.targetText === word,
    );
    return [{
      id,
      ref: `/api/v1/media/audio/images/${id}`,
      ...(image?.url ? { sourceUrl: image.url } : {}),
      targetWord: word,
      ...(requirement ? {
        key: requirement.key,
        kind: requirement.kind || 'word',
        ...(requirement.targetText ? { targetText: requirement.targetText } : {}),
      } : {}),
    }];
  });
  return {
    ...activity,
    imageAssetIds,
    imageAssets,
    id: `${unitId}:${index}`,
    // 保留发布前的稳定活动键（如 `U07-s01`），运行时据此把课文句子/重点词
    // 对回 learning_items 行主键；`id` 仍是预置课程沿用的 `${unitId}:${index}`。
    activityKey: activity.id ?? null,
    topicId,
    order: index,
    m1Scope: false,
  } as Prisma.InputJsonValue;
}

/** 发布/编辑/自动启用共用：按 topicId + word 幂等写入 vocabulary_items。 */
export async function upsertVocabularyItems(
  tx: Prisma.TransactionClient,
  topicId: string,
  content: PublishableLesson,
  skillIdByCode: Map<string, string>,
  reviewStatus = 'published',
  archiveMissing = false,
): Promise<void> {
  for (const item of content.vocabulary) {
    const word = item.word.trim();
    if (!word) continue;
    const wordKey = word.toLowerCase();
    const skillNodeIds = [...new Set(
      content.activities
        .filter((activity) => (activity.targetWords ?? []).some((target) => target.toLowerCase() === wordKey))
        .flatMap((activity) => activity.skillNodeIds ?? [])
        .map((id) => skillIdByCode.get(id) ?? id),
    )];
    const data = {
      topicId,
      word,
      phonetic: item.phonetic || '',
      syllables: (item.syllables ?? []) as Prisma.InputJsonValue,
      meaningZh: item.meaningZh || '',
      imageRef: item.image?.url || null,
      collocations: (item.phrases ?? []) as Prisma.InputJsonValue,
      exampleSentences: normalizeExampleSentences(item.exampleSentences) as Prisma.InputJsonValue,
      difficultPhonemes: (item.difficultPhonemes ?? []) as Prisma.InputJsonValue,
      skillNodeIds: skillNodeIds as Prisma.InputJsonValue,
      relatedWords: [] as Prisma.InputJsonValue,
      reviewStatus,
    };
    const existing = await tx.vocabulary_items.findFirst({
      where: { topicId, word: { equals: word, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      await tx.vocabulary_items.update({ where: { id: existing.id }, data });
    } else {
      await tx.vocabulary_items.create({ data });
    }
  }
  if (archiveMissing) {
    const words = [...new Set(content.vocabulary.map((item) => item.word.trim().toLowerCase()).filter(Boolean))];
    await tx.vocabulary_items.updateMany({
      where: {
        topicId,
        reviewStatus: { in: ['published', 'pending_review'] },
        word: { notIn: words, mode: 'insensitive' },
      },
      data: { reviewStatus: 'archived' },
    });
  }
}

/** 与 orchestrator.synthesize 一致的整轮合成文本（两段 join，单次 TTS）。 */
export function teacherSpeechText(teacherUtteranceZh: string, demonstrationText: string): string {
  return [teacherUtteranceZh, demonstrationText].filter(Boolean).join(' ');
}

/**
 * 发布硬拦：整轮教师话语必须同时满足 ≤150 汉字且 ≤500 字符（按码点计）。
 *
 * 口径与 packages/ai-provider-sdk/src/signed-tts.ts 一致。服务端是
 * “整轮单次合成、不静默截断”，超限必须明确拒绝，否则已发布课程会在合成时抛错。
 */
export function teacherSpeechLimitMessage(label: string, text: string): string | null {
  const codePoints = Array.from(text);
  const cjkCount = codePoints.filter((ch) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)).length;
  if (cjkCount > 150 || codePoints.length > 500) {
    return `${label}整轮教师话语超出单次 TTS 合成上限（汉字/全角=${cjkCount}/150，字符=${codePoints.length}/500）；` +
      '请缩短 teacherUtteranceZh / demonstrationText 后重新生成，长文章留待支持长文本的语音供应商。';
  }
  return null;
}

export function hasPublishableAssessment(activity: PublishableActivity): boolean {
  const hasTextAnswerRule = Boolean(
    activity.assessment?.acceptedTexts?.length ||
    activity.assessment?.requiredPhrases?.length ||
    activity.assessment?.openResponse,
  );
  if (activity.taskType === 'image_identification') {
    return Boolean(activity.assessment?.acceptedImageIds?.length);
  }
  if (activity.taskType === 'listening_comprehension' || activity.taskType === 'reading_story') {
    return Boolean(
      hasTextAnswerRule ||
      activity.assessment?.acceptedImageIds?.length ||
      (!activity.requiresAsr && !activity.requiresPronunciationAssessment),
    );
  }
  return Boolean(
    hasTextAnswerRule ||
    activity.requiresPronunciationAssessment,
  );
}

export function normalizeExampleSentences(value: unknown): Array<{ en: string; zh: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      const en = entry.trim();
      return en ? [{ en, zh: '' }] : [];
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const en = typeof record.en === 'string' ? record.en.trim() : '';
    if (!en) return [];
    return [{ en, zh: typeof record.zh === 'string' ? record.zh : '' }];
  });
}

import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderConfigService } from '../providers/provider-config.service';
import { z } from 'zod';
import { teachingActivitySchema } from '@alg/shared-contracts';
import type { Prisma } from '@prisma/client';
import AdmZip from 'adm-zip';

const levelSchema = z.string().trim().min(1).max(24);
const textbookSchema = z.object({
  publisher: z.string().trim().min(1).max(160),
  publicationYear: z.number().int().min(1900).max(2200),
  grade: z.string().trim().min(1).max(80),
  title: z.string().trim().max(200).optional(),
  edition: z.string().trim().max(120).optional(),
});
const unitSchema = z.object({
  unitCode: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  order: z.number().int().min(0).max(10000).default(0),
  metadata: z.record(z.unknown()).default({}),
});
const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  level: levelSchema,
  topicId: z.string().trim().max(120).optional(),
  textbookId: z.string().uuid().optional(),
  textbookUnitId: z.string().uuid().optional(),
  words: z.string().min(1).max(20000),
  createdBy: z.string().trim().max(120).optional(),
});
const reviewSchema = z.object({
  action: z.enum(['submit', 'approve', 'reject']),
  reviewer: z.string().trim().min(1).max(120),
  note: z.string().trim().max(2000).optional(),
});
const curriculumPackageSchema = z.object({
  schemaVersion: z.literal(1),
  packageId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(500),
  levels: z.array(z.object({
    code: z.enum(['pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2']),
    nameZh: z.string().trim().min(1).max(80),
    canDo: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
    units: z.array(z.object({
      code: z.string().trim().min(1).max(80),
      title: z.string().trim().min(1).max(200),
      objectives: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
      vocabulary: z.array(z.object({
        word: z.string().trim().min(1).max(100),
        phonetic: z.string().max(100).default(''),
        meaningZh: z.string().max(200).default(''),
      })).min(1).max(100),
      patterns: z.array(z.object({
        en: z.string().trim().min(1).max(300),
        zh: z.string().trim().min(1).max(300),
      })).max(30),
      lessons: z.array(z.object({
        title: z.string().trim().min(1).max(200),
        taskType: z.enum(['listening_comprehension', 'image_identification', 'word_mimicry', 'pronunciation_drill', 'phrase_assembly', 'sentence_pattern', 'situational_dialogue', 'reading_story', 'free_response']),
        scenario: z.enum(['greeting_scene', 'self_intro_scene', 'object_pic_scene', 'object_shop_scene', 'free_chat_scene', 'story_scene', 'assessment_scene']),
        teacherPrompt: z.string().trim().min(1).max(500),
        demonstrationText: z.string().max(2000).default(''),
        targetWords: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
      })).min(1).max(12),
    })).min(1).max(40),
  })).length(7),
});

type GeneratedLesson = {
  title: string;
  level: string;
  objectives: string[];
  vocabulary: Array<{
    word: string;
    phonetic: string;
    meaningZh: string;
    syllables: string[];
    difficultPhonemes: string[];
    image?: { url: string; license: string; attribution?: string };
  }>;
  activities: Array<{
    taskType: string;
    scenario: string;
    targetWords: string[];
    teacherUtteranceZh: string;
    demonstrationText: string;
    skillNodeIds: string[];
    requiresPronunciationAssessment: boolean;
    requiresAsr: boolean;
    difficulty: number;
  }>;
  images: Array<{ url: string; license: string; attribution?: string }>;
};

@Controller('api/v1/admin/curriculum')
export class CurriculumAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configs: ProviderConfigService,
    private readonly gateway: AiGatewayService,
    private readonly router: ModelRouterImpl,
  ) {}

  private authorize(token?: string) {
    this.configs.assertAdminToken(token);
  }

  @Post('package/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  async importCurriculumPackage(
    @Headers('x-admin-token') token: string | undefined,
    @UploadedFile() file?: { originalname: string; buffer: Buffer },
  ) {
    this.authorize(token);
    if (!file || !file.originalname.toLowerCase().endsWith('.zip')) {
      throw new BadRequestException('请选择 ZIP 格式的课程包');
    }
    let packageText: string;
    try {
      const zip = new AdmZip(file.buffer);
      const entry = zip.getEntry('curriculum-package.json');
      if (!entry || entry.header.size > 10 * 1024 * 1024) {
        throw new Error('课程包缺少有效的 curriculum-package.json');
      }
      packageText = entry.getData().toString('utf8');
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '课程 ZIP 无法读取');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(packageText);
    } catch {
      throw new BadRequestException('课程包中的 JSON 格式无效');
    }
    const parsed = curriculumPackageSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ message: '课程包结构不符合规范', details: parsed.error.flatten() });
    const levels = parsed.data.levels;
    const expectedLevels = ['pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    if (expectedLevels.some((level, index) => levels[index]?.code !== level)) {
      throw new BadRequestException('课程包等级必须依照 pre-A1、A1、A2、B1、B2、C1、C2 排列');
    }

    const created: Array<{ id: string; title: string; level: string }> = [];
    let skipped = 0;
    for (const level of levels) {
      for (const unit of level.units) {
        const topicId = `bundle:${parsed.data.packageId}:${level.code}:${unit.code}`.slice(0, 120);
        const existing = await this.prisma.curriculum_drafts.findFirst({ where: { topicId }, select: { id: true } });
        if (existing) {
          skipped += 1;
          continue;
        }
        const vocabulary = unit.vocabulary.map((item) => ({
          ...item,
          syllables: [item.word],
          difficultPhonemes: [],
        }));
        const generatedContent: GeneratedLesson = {
          title: unit.title,
          level: level.code,
          objectives: [...level.canDo, ...unit.objectives],
          vocabulary,
          activities: unit.lessons.map((lesson, index) => ({
            taskType: lesson.taskType,
            scenario: lesson.scenario,
            targetWords: lesson.targetWords,
            teacherUtteranceZh: lesson.teacherPrompt,
            demonstrationText: lesson.demonstrationText || '',
            skillNodeIds: [curriculumSkillNodeFor(lesson.taskType)],
            requiresPronunciationAssessment: ['word_mimicry', 'pronunciation_drill'].includes(lesson.taskType),
            requiresAsr: ['sentence_pattern', 'situational_dialogue', 'free_response'].includes(lesson.taskType),
            difficulty: Math.min(5, Math.max(1, Math.ceil((index + 1) / 2))),
          })),
          images: [],
        };
        const draft = await this.prisma.curriculum_drafts.create({
          data: {
            title: unit.title,
            level: level.code,
            topicId,
            wordList: unit.vocabulary.map((item) => item.word),
            generatedContent: generatedContent as unknown as Prisma.InputJsonValue,
            status: 'generated',
            generatedAt: new Date(),
            createdBy: `package:${parsed.data.packageId}`,
          },
        });
        await this.prisma.curriculum_review_records.create({
          data: {
            draftId: draft.id,
            action: 'generated',
            reviewer: `package:${parsed.data.packageId}`,
            note: `导入课程包「${parsed.data.title}」；必须经人工审核后发布。句型：${unit.patterns.map((pattern) => pattern.en).join(' / ')}`.slice(0, 2000),
            snapshot: generatedContent as unknown as Prisma.InputJsonValue,
          },
        });
        created.push({ id: draft.id, title: unit.title, level: level.code });
      }
    }
    return {
      packageId: parsed.data.packageId,
      packageTitle: parsed.data.title,
      imported: created.length,
      skipped,
      levels: levels.map((level) => ({ code: level.code, units: level.units.length })),
      drafts: created,
    };
  }

  @Get('textbooks')
  async listTextbooks(@Headers('x-admin-token') token?: string) {
    this.authorize(token);
    return this.prisma.textbook_catalogs.findMany({
      include: { units: { orderBy: { order: 'asc' } } },
      orderBy: [{ publisher: 'asc' }, { publicationYear: 'desc' }, { grade: 'asc' }],
    });
  }

  @Post('textbooks')
  async createTextbook(@Headers('x-admin-token') token: string | undefined, @Body() body: unknown) {
    this.authorize(token);
    const parsed = textbookSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.prisma.textbook_catalogs.create({
      data: {
        ...parsed.data,
        title: parsed.data.title || null,
        edition: parsed.data.edition || null,
      },
    });
  }

  @Post('textbooks/:textbookId/units')
  async createTextbookUnit(
    @Headers('x-admin-token') token: string | undefined,
    @Param('textbookId') textbookId: string,
    @Body() body: unknown,
  ) {
    this.authorize(token);
    const parsed = unitSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const textbook = await this.prisma.textbook_catalogs.findUnique({ where: { id: textbookId }, select: { id: true } });
    if (!textbook) throw new BadRequestException('教材不存在');
    return this.prisma.textbook_units.create({
      data: {
        textbook: { connect: { id: textbookId } },
        unitCode: parsed.data.unitCode,
        title: parsed.data.title,
        order: parsed.data.order,
        metadata: parsed.data.metadata as Prisma.InputJsonValue,
      },
    });
  }

  @Get('drafts')
  async listDrafts(
    @Headers('x-admin-token') token: string | undefined,
    @Query('status') status?: string,
    @Query('level') level?: string,
  ) {
    this.authorize(token);
    return this.prisma.curriculum_drafts.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(level ? { level } : {}),
      },
      include: { textbook: true, textbookUnit: true, reviews: { orderBy: { createdAt: 'desc' }, take: 10 } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  @Post('drafts')
  async createDraft(@Headers('x-admin-token') token: string | undefined, @Body() body: unknown) {
    this.authorize(token);
    const parsed = draftSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const words = normalizeWords(parsed.data.words);
    if (!words.length) throw new BadRequestException('词表至少需要一行有效单词');
    if (parsed.data.textbookId) {
      const exists = await this.prisma.textbook_catalogs.findUnique({ where: { id: parsed.data.textbookId }, select: { id: true } });
      if (!exists) throw new BadRequestException('教材不存在');
    }
    if (parsed.data.textbookUnitId) {
      const exists = await this.prisma.textbook_units.findUnique({ where: { id: parsed.data.textbookUnitId }, select: { id: true } });
      if (!exists) throw new BadRequestException('教材单元不存在');
    }
    const draft = await this.prisma.curriculum_drafts.create({
      data: {
        title: parsed.data.title,
        level: parsed.data.level,
        topicId: parsed.data.topicId || null,
        textbookId: parsed.data.textbookId || null,
        textbookUnitId: parsed.data.textbookUnitId || null,
        wordList: words,
        createdBy: parsed.data.createdBy || null,
      },
    });
    await this.prisma.curriculum_review_records.create({
      data: { draftId: draft.id, action: 'submitted', reviewer: parsed.data.createdBy || null, snapshot: { words, title: draft.title, level: draft.level } },
    });
    return draft;
  }

  @Post('drafts/:draftId/generate')
  async generateDraft(@Headers('x-admin-token') token: string | undefined, @Param('draftId') draftId: string) {
    this.authorize(token);
    const draft = await this.prisma.curriculum_drafts.findUnique({ where: { id: draftId } });
    if (!draft) throw new BadRequestException('课程草稿不存在');
    const words = Array.isArray(draft.wordList) ? draft.wordList.filter((word): word is string => typeof word === 'string') : [];
    const skillNodes = await this.prisma.skill_nodes.findMany({
      where: { m1Scope: true },
      orderBy: [{ growthStage: 'asc' }, { code: 'asc' }],
      take: 80,
      select: { id: true, code: true, name: true, objective: true },
    });
    const fallback = buildFallbackLesson(draft.title, draft.level, words, skillNodes[0]?.id ?? '');
    let content = fallback;
    try {
      const decision = await this.router.route({ serviceKind: 'llm', taskRoute: 'llm.learning_plan' });
      const result = await this.gateway.llm({
        promptKey: 'curriculum.generate',
        promptVersion: 'm2.1',
        system: [
          '你是儿童英语课程编辑。只输出 JSON，不要 markdown。',
          '为 6—9 岁中国儿童生成可人工审核的课程草稿。',
          '课程等级必须保留输入 level；每个词包含音标、中文释义、音节、发音难点。',
          `活动必须使用以下能力节点 ID，不得自行编造：${JSON.stringify(skillNodes)}。活动 taskType/scenario 必须使用系统已支持的值。不能声称孩子已掌握。`,
          '图片只能给出可公开访问且授权明确的网络资源建议，必须填写 url、license、attribution；无法确认时 images 为空。',
          '输出字段：title,level,objectives,vocabulary,activities,images。',
        ].join(''),
        messages: [{ role: 'user', content: JSON.stringify({ title: draft.title, level: draft.level, words }) }],
        temperature: 0.3,
        maxTokens: 1800,
        timeoutMs: 20000,
      }, decision);
      const parsed = parseJsonObject(result.content);
      if (parsed && Array.isArray(parsed.vocabulary) && Array.isArray(parsed.activities)) {
        const candidate = { ...fallback, ...parsed, level: draft.level } as GeneratedLesson;
        const allowedSkills = new Set(skillNodes.map((node) => node.id));
        const activitiesValid = candidate.activities.every((activity) => {
          if (!Array.isArray(activity.skillNodeIds)) return false;
          const normalized = teachingActivitySchema.safeParse({
            ...activity,
            id: `generated-${draft.id}-${candidate.activities.indexOf(activity)}`,
            topicId: draft.topicId || `topic-curriculum-${draft.id}`,
            m1Scope: false,
            order: candidate.activities.indexOf(activity),
          });
          return normalized.success && activity.skillNodeIds.length > 0 && activity.skillNodeIds.every((id) => allowedSkills.has(id));
        });
        if (activitiesValid) content = candidate;
      }
    } catch {
      // AI 不可用时仍保留可审核草稿，避免课程生产流程被供应商中断。
    }
    const updated = await this.prisma.curriculum_drafts.update({
      where: { id: draftId },
      data: { generatedContent: content as object, status: 'generated', generatedAt: new Date(), version: { increment: 1 } },
    });
    await this.prisma.curriculum_review_records.create({
      data: { draftId, action: 'generated', snapshot: content as object, note: 'AI 生成；若模型不可用则使用结构化保底草稿' },
    });
    return updated;
  }

  @Put('drafts/:draftId/review')
  async reviewDraft(@Headers('x-admin-token') token: string | undefined, @Param('draftId') draftId: string, @Body() body: unknown) {
    this.authorize(token);
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const draft = await this.prisma.curriculum_drafts.findUnique({ where: { id: draftId } });
    if (!draft) throw new BadRequestException('课程草稿不存在');
    if (!draft.generatedContent) throw new BadRequestException('请先生成课程草稿');
    if (parsed.data.action === 'submit' && !['generated', 'rejected'].includes(draft.status)) {
      throw new BadRequestException('当前状态不能提交审核');
    }
    if (parsed.data.action === 'approve' && draft.status !== 'under_review') {
      throw new BadRequestException('课程必须先提交人工审核');
    }
    if (parsed.data.action === 'reject' && draft.status !== 'under_review') {
      throw new BadRequestException('只有审核中的课程才能退回');
    }
    const status = parsed.data.action === 'submit' ? 'under_review' : parsed.data.action === 'approve' ? 'approved' : 'rejected';
    const updated = await this.prisma.curriculum_drafts.update({
      where: { id: draftId },
      data: { status, reviewedBy: parsed.data.reviewer, reviewNote: parsed.data.note || null, version: { increment: 1 } },
    });
    await this.prisma.curriculum_review_records.create({
      data: { draftId, action: parsed.data.action === 'submit' ? 'submitted' : parsed.data.action === 'approve' ? 'approved' : 'rejected', reviewer: parsed.data.reviewer, note: parsed.data.note || null, snapshot: draft.generatedContent as object },
    });
    return updated;
  }

  @Put('drafts/:draftId/content')
  async updateDraftContent(
    @Headers('x-admin-token') token: string | undefined,
    @Param('draftId') draftId: string,
    @Body() body: unknown,
  ) {
    this.authorize(token);
    const draft = await this.prisma.curriculum_drafts.findUnique({ where: { id: draftId } });
    if (!draft || !['generated', 'rejected'].includes(draft.status)) {
      throw new BadRequestException('当前课程状态不允许编辑');
    }
    const parsed = z.object({
      title: z.string().trim().min(1).max(200),
      level: levelSchema,
      objectives: z.array(z.string().trim().min(1).max(300)).max(30),
      vocabulary: z.array(z.record(z.unknown())).max(500),
      activities: z.array(z.record(z.unknown())).min(1).max(100),
      images: z.array(z.object({
        url: z.string().url().max(2048),
        license: z.string().trim().min(1).max(300),
        attribution: z.string().trim().max(500).optional(),
      })).max(100),
    }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const content = { ...parsed.data, level: draft.level };
    const updated = await this.prisma.curriculum_drafts.update({
      where: { id: draftId },
      data: { title: parsed.data.title, generatedContent: content as Prisma.InputJsonValue, status: 'generated', version: { increment: 1 } },
    });
    await this.prisma.curriculum_review_records.create({
      data: { draftId, action: 'generated', reviewer: 'admin-edit', note: '人工编辑课程草稿', snapshot: content as Prisma.InputJsonValue },
    });
    return updated;
  }

  @Post('drafts/:draftId/publish')
  async publishDraft(@Headers('x-admin-token') token: string | undefined, @Param('draftId') draftId: string) {
    this.authorize(token);
    const draft = await this.prisma.curriculum_drafts.findUnique({ where: { id: draftId } });
    if (!draft || draft.status !== 'approved') throw new BadRequestException('只有人工审核通过的课程才能发布');
    const content = draft.generatedContent as unknown as GeneratedLesson | null;
    if (!content?.activities?.length) throw new BadRequestException('课程缺少可发布活动');
    const skillIds = [...new Set(content.activities.flatMap((activity) => activity.skillNodeIds ?? []))];
    if (!skillIds.length) throw new BadRequestException('课程活动没有绑定能力节点，不能发布');
    const validSkills = await this.prisma.skill_nodes.findMany({ where: { id: { in: skillIds } }, select: { id: true } });
    if (validSkills.length !== skillIds.length) throw new BadRequestException('课程绑定了不存在的能力节点，不能发布');
    const topicId = draft.topicId || `topic-curriculum-${draft.id}`;
    const published = await this.prisma.$transaction(async (tx) => {
      const unit = await tx.curriculum_units.create({
        data: {
          topicId,
          stage: levelToStage(draft.level),
          level: draft.level,
          title: draft.title,
          description: content.objectives?.join('；') || null,
          textbookUnitId: draft.textbookUnitId,
          reviewStatus: 'published',
          publishedAt: new Date(),
        },
      });
      for (const [index, activity] of content.activities.entries()) {
        await tx.learning_items.create({
          data: {
            skillNodeId: activity.skillNodeIds[0]!,
            itemType: 'curriculum_activity',
            refId: `${unit.id}:${index}`,
            topicId,
            reviewStatus: 'published',
            content: { ...activity, id: `${unit.id}:${index}`, topicId, order: index, m1Scope: false },
          },
        });
      }
      for (const image of content.images ?? []) {
        if (image.url && image.license) {
          await tx.media_assets.create({ data: { kind: 'image', ref: image.url, sourceUrl: image.url, license: image.license, attribution: image.attribution || null, sourceProvider: 'admin_curriculum' } });
        }
      }
      const updated = await tx.curriculum_drafts.update({ where: { id: draftId }, data: { status: 'published', publishedAt: new Date(), version: { increment: 1 } } });
      await tx.curriculum_review_records.create({ data: { draftId, action: 'published', reviewer: draft.reviewedBy, snapshot: content as object } });
      return { draft: updated, unitId: unit.id, topicId };
    });
    return published;
  }
}

function normalizeWords(input: string): string[] {
  return [...new Set(input.split(/\r?\n/).map((word) => word.trim().replace(/^\d+[.)]\s*/, '')).filter(Boolean))].slice(0, 500);
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function buildFallbackLesson(title: string, level: string, words: string[], skillNodeId: string): GeneratedLesson {
  const vocabulary = words.map((word) => ({
    word,
    phonetic: '',
    meaningZh: '',
    syllables: [word],
    difficultPhonemes: [],
  }));
  return {
    title,
    level,
    objectives: [`认识并理解 ${words.length} 个目标词`, '在图片和简单句中尝试使用目标词'],
    vocabulary,
    activities: words.slice(0, 12).map((word, index) => ({
      taskType: index % 2 ? 'word_mimicry' : 'image_identification',
      scenario: index % 2 ? 'object_shop_scene' : 'object_pic_scene',
      targetWords: [word],
      teacherUtteranceZh: `我们来认识单词 ${word}。`,
      demonstrationText: word,
      skillNodeIds: skillNodeId ? [skillNodeId] : [],
      requiresPronunciationAssessment: index % 2 === 1,
      requiresAsr: false,
      difficulty: 1,
    })),
    images: [],
  };
}

function levelToStage(level: string): number {
  const stages: Record<string, number> = { 'pre-a1': 0, 'pre-a': 0, a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6 };
  return stages[level.toLowerCase()] ?? 0;
}

function curriculumSkillNodeFor(taskType: string): string {
  const nodeByTask: Record<string, string> = {
    listening_comprehension: 'LA.LISTEN.word_recognition',
    image_identification: 'LA.VOCAB.receptive',
    word_mimicry: 'LA.SPEAK.imitation',
    pronunciation_drill: 'LA.PRON.phonemes',
    phrase_assembly: 'LA.SPEAK.phrases',
    sentence_pattern: 'LA.SPEAK.simple_sentences',
    situational_dialogue: 'LA.COMM.dialogue',
    reading_story: 'SE.SCHOOL.reading',
    free_response: 'LA.COMM.free_talk',
  };
  return nodeByTask[taskType] ?? 'LA.VOCAB.receptive';
}

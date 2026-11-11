import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import { deriveAvatarLevel, isValidAvatarUrl } from '@alg/shared-contracts';
import { AuthService, assertPassword, extractBearerToken } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { mapTextbookUnitToSkillNodeIds } from '../curriculum/textbook-skill-mapping';
import { CurriculumWarmupService } from '../curriculum/curriculum-warmup.service';

// avatarUrl 字段名保持不变：允许 http(s):// 外链或 preset:// 本地头像资源标识。
// preset:// 不是通用 URL，不能用 .url()；不改数据库 schema、不加 migration。
const avatarUrlSchema = z.string().trim().max(1000).refine(isValidAvatarUrl, {
  message: 'avatarUrl 必须是 http(s):// 外链或 preset:// 本地头像资源标识',
});
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatarUrl: avatarUrlSchema.nullable().optional(),
});
const passwordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});

const abilityLabels: Record<string, string> = {
  listening: '听力',
  pronunciation: '语音',
  vocabulary: '词汇',
  grammar: '语法',
  speaking: '口语',
  communication: '交流',
  school_english: '学校',
};

@Controller('api/v1/user')
export class UserController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly warmup: CurriculumWarmupService,
  ) {}

  private async session(authorization?: string, cookie?: string) {
    return this.auth.resolveSession(extractBearerToken(authorization, cookie));
  }

  private async learner(userId: string) {
    const learner = await this.prisma.learner_profiles.findFirst({
      where: { userId, guardianId: userId },
    });
    if (!learner) throw new BadRequestException('账户尚未关联学习者档案');
    return learner;
  }

  @Get('dashboard')
  async dashboard(
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const user = await this.session(authorization, cookie);
    const learner = await this.learner(user.id);
    const [profile, mapping, abilities, evidence, textbooks] = await Promise.all([
      this.prisma.learner_profiles.findUnique({
        where: { id: learner.id },
        include: { preferences: true },
      }),
      this.prisma.textbook_mappings.findFirst({ where: { learnerId: learner.id } }),
      this.prisma.learner_skill_states.findMany({
        where: { learnerId: learner.id },
        include: { skillNode: { select: { name: true, abilityCategory: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.learning_evidence.findMany({
        where: { learnerId: learner.id },
        select: {
          abilityCategory: true,
          vocabularyDimension: true,
          taskType: true,
          learningItemId: true,
          succeeded: true,
          independent: true,
          score: true,
          occurredAt: true,
          skillNodeId: true,
        },
        orderBy: { occurredAt: 'desc' },
        take: 5000,
      }),
      this.prisma.textbook_catalogs.findMany({
        include: { units: { orderBy: { order: 'asc' } } },
        orderBy: [{ publisher: 'asc' }, { publicationYear: 'desc' }, { grade: 'asc' }],
      }),
    ]);

    const succeeded = evidence.filter((row) => row.succeeded);
    const distinct = (rows: typeof evidence) => new Set(rows.map((row) => row.skillNodeId)).size;
    const dates = new Set(succeeded.map((row) => row.occurredAt.toISOString().slice(0, 10)));
    let streak = 0;
    const day = new Date();
    if (!dates.has(day.toISOString().slice(0, 10))) day.setUTCDate(day.getUTCDate() - 1);
    while (dates.has(day.toISOString().slice(0, 10))) {
      streak += 1;
      day.setUTCDate(day.getUTCDate() - 1);
    }
    const uniqueItems = (rows: typeof evidence) =>
      new Set(rows.map((row) => row.learningItemId).filter((id): id is string => Boolean(id))).size;
    const abilitiesByCategory = Object.entries(abilityLabels).map(([category, label]) => {
      const rows = abilities.filter((row) => row.skillNode?.abilityCategory === category);
      const best = rows.reduce((max, row) => Math.max(max, row.masteryCode), 0);
      return { category, label, stage: best, calibrated: rows.some((row) => row.calibrationStatus === 'calibrated') };
    });
    // CEFR 参考档位 / 头像解锁档位由后端确定性推导（D-024 约束一：客户端只展示）。
    // 单调保护取 max(当前 abilities, append-only learning_evidence 历史累计)，
    // 保证能力状态回落不重新锁定头像；纯函数、不写库、不改 mastery 判定。
    const avatarLevel = deriveAvatarLevel(abilitiesByCategory, evidence);
    // 级别变化后异步预热该级别已发布课程的图片/语音；失败不影响仪表盘。
    this.warmup.warmLearnerLevel(learner.id, avatarLevel.level);
    const stats = {
      dictationWords: uniqueItems(succeeded.filter((row) => row.vocabularyDimension === 'use_in_sentence')),
      understoodWords: uniqueItems(succeeded.filter((row) => row.vocabularyDimension === 'heard_identify')),
      usedWords: uniqueItems(succeeded.filter((row) => ['seen_speak', 'use_in_sentence', 'use_in_new_context'].includes(row.vocabularyDimension ?? ''))),
      grammarCategories: distinct(succeeded.filter((row) => row.abilityCategory === 'grammar')),
      pronunciationWords: uniqueItems(succeeded.filter((row) => row.abilityCategory === 'pronunciation' || row.vocabularyDimension === 'heard_pronounce')),
      speakingScore: Math.round((succeeded.filter((row) => row.abilityCategory === 'speaking').reduce((sum, row) => sum + (row.score ?? 0), 0) /
        Math.max(1, succeeded.filter((row) => row.abilityCategory === 'speaking').length)) * 10) / 10,
      streak,
    };
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        membershipTier: user.membershipTier,
        emailVerifiedAt: user.emailVerifiedAt,
      },
      learner: {
        id: learner.id,
        displayName: learner.displayName,
        entryLevel: learner.entryLevel,
        currentTopic: learner.currentTopic,
        membershipTier: learner.membershipTier,
      },
      textbook: mapping,
      // 新增字段（additive）：既有字段一律不变。learner.entryLevel 仍是入学起点 pre_a1，
      // level 是当前参考档位（仅展示）；avatarTier / unlockedCount 是解锁计数，
      // 客户端不存解锁状态，也不得自行推导 CEFR。
      level: avatarLevel.level,
      avatarTier: avatarLevel.avatarTier,
      unlockedCount: avatarLevel.unlockedCount,
      levelProgress: avatarLevel.progress,
      abilities: abilitiesByCategory,
      stats,
      achievements: {
        hundredWords: stats.usedWords >= 100,
        streak10: streak >= 10,
        streak20: streak >= 20,
        streak30: streak >= 30,
        streak50: streak >= 50,
        streak100: streak >= 100,
      },
      textbooks,
      calibrationNotice: '能力阶段由服务端学习证据计算；未校准项目仅供教学参考。',
      profile,
    };
  }

  @Put('profile')
  async updateProfile(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
  ) {
    const user = await this.session(authorization, cookie);
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const learner = await this.learner(user.id);
    const data = parsed.data;
    await this.prisma.$transaction([
      this.prisma.users.update({ where: { id: user.id }, data }),
      ...(data.displayName
        ? [this.prisma.learner_profiles.update({ where: { id: learner.id }, data: { displayName: data.displayName } })]
        : []),
    ]);
    return { ok: true };
  }

  @Put('password')
  async updatePassword(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
  ) {
    const user = await this.session(authorization, cookie);
    const parsed = passwordSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('请输入当前密码和新密码');
    const valid = await this.auth.verifyPassword(user.id, parsed.data.currentPassword);
    if (!valid) throw new BadRequestException('当前密码不正确');
    const password = assertPassword(parsed.data.newPassword);
    await this.auth.changePassword(user.id, password);
    return { ok: true };
  }

  @Put('textbook')
  async updateTextbook(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
  ) {
    const user = await this.session(authorization, cookie);
    const learner = await this.learner(user.id);
    const parsed = z.object({ textbookId: z.string().uuid(), unitId: z.string().uuid().optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException('教材选择无效');
    const textbook = await this.prisma.textbook_catalogs.findUnique({ where: { id: parsed.data.textbookId } });
    if (!textbook) throw new BadRequestException('教材不存在');
    const unit = parsed.data.unitId
      ? await this.prisma.textbook_units.findFirst({ where: { id: parsed.data.unitId, textbookId: textbook.id } })
      : null;
    if (parsed.data.unitId && !unit) throw new BadRequestException('教材单元不存在');
    // 单元 → 能力节点映射由服务端确定性推导（关键词规则，不改 schema）。
    // 之前这里恒为空数组，等于把「教材同步」变成了空承诺；Planner 现在会真的读它。
    const mappingData = {
      publisher: textbook.publisher,
      grade: textbook.grade,
      version: textbook.edition ?? textbook.title ?? '',
      currentUnit: parsed.data.unitId ?? '',
      skillNodeIds: mapTextbookUnitToSkillNodeIds({
        unitCode: unit?.unitCode,
        unitTitle: unit?.title,
        textbookTitle: textbook.title,
        grade: textbook.grade,
      }),
    };
    const existing = await this.prisma.textbook_mappings.findFirst({ where: { learnerId: learner.id } });
    if (existing) {
      await this.prisma.textbook_mappings.update({ where: { id: existing.id }, data: mappingData });
    } else {
      await this.prisma.textbook_mappings.create({ data: { learnerId: learner.id, ...mappingData } });
    }
    return { ok: true };
  }

  @Delete('account')
  async deleteAccount(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
  ) {
    const user = await this.session(authorization, cookie);
    await this.prisma.$transaction([
      this.prisma.users.update({ where: { id: user.id }, data: { disabledAt: new Date() } }),
      this.prisma.auth_sessions.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { ok: true };
  }
}

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
import { AuthService, assertPassword, extractBearerToken } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.string().trim().url().max(1000).nullable().optional(),
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
    if (parsed.data.unitId) {
      const unit = await this.prisma.textbook_units.findFirst({ where: { id: parsed.data.unitId, textbookId: textbook.id } });
      if (!unit) throw new BadRequestException('教材单元不存在');
    }
    const mappingData = {
      publisher: textbook.publisher,
      grade: textbook.grade,
      version: textbook.edition ?? textbook.title ?? '',
      currentUnit: parsed.data.unitId ?? '',
      skillNodeIds: [] as never[],
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

import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderConfigService } from '../providers/provider-config.service';

const memoryInput = z.object({
  memoryType: z.enum(['learning_preference', 'encouragement_preference', 'lesson_learning_summary', 'caregiver_note']),
  content: z.string().trim().min(1).max(2000),
  importance: z.number().min(0).max(1).default(0.5),
  expiresAt: z.string().datetime().nullable().optional(),
});
const adjustableSchema = z.object({
  tone: z.enum(['gentle', 'lively', 'calm']),
  encouragement: z.enum(['light', 'balanced', 'frequent']),
  correctionStyle: z.enum(['model_first', 'hint_first', 'encourage_retry']),
  speakingRate: z.number().min(0.45).max(0.85),
}).strict();
const profileInput = z.object({
  adjustable: adjustableSchema,
  style: z.enum(['patient_guide', 'playful_companion', 'calm_coach']),
  reason: z.string().trim().min(1).max(500),
}).strict();
const defaultCore = { childSafety: true, honestAiIdentity: true, noShaming: true, noPressure: true, ageAppropriate: true };
const defaultAdjustable = { tone: 'gentle', encouragement: 'balanced', correctionStyle: 'hint_first', speakingRate: 0.65 };

/** Management APIs for learner memories and the bounded teacher persona. */
@Controller('api/v1/admin/learning')
export class MemoryAdminController {
  constructor(private readonly prisma: PrismaService, private readonly configs: ProviderConfigService) {}
  private authorize(token?: string) { this.configs.assertAdminToken(token); }

  @Get('learners/:learnerId/memories')
  async listMemories(@Headers('x-admin-token') token: string | undefined, @Param('learnerId') learnerId: string) {
    this.authorize(token);
    return this.prisma.interaction_memories.findMany({ where: { learnerId }, orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }], take: 100 });
  }

  @Put('learners/:learnerId/memories/:memoryId')
  async updateMemory(@Headers('x-admin-token') token: string | undefined, @Param('learnerId') learnerId: string, @Param('memoryId') memoryId: string, @Body() body: unknown) {
    this.authorize(token);
    const parsed = memoryInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const existing = await this.prisma.interaction_memories.findFirst({ where: { id: memoryId, learnerId }, select: { id: true } });
    if (!existing) throw new BadRequestException('学习记忆不存在');
    return this.prisma.interaction_memories.update({
      where: { id: memoryId },
      data: { ...parsed.data, expiresAt: parsed.data.expiresAt === undefined ? undefined : parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null, source: 'admin_corrected' },
    });
  }

  @Delete('learners/:learnerId/memories/:memoryId')
  async deleteMemory(@Headers('x-admin-token') token: string | undefined, @Param('learnerId') learnerId: string, @Param('memoryId') memoryId: string) {
    this.authorize(token);
    const result = await this.prisma.interaction_memories.deleteMany({ where: { id: memoryId, learnerId } });
    if (!result.count) throw new BadRequestException('学习记忆不存在');
    return { deleted: true, memoryId };
  }

  @Get('teacher-profile')
  async getTeacherProfile(@Headers('x-admin-token') token: string | undefined) {
    this.authorize(token);
    const profile = await this.prisma.teacher_profiles.findFirst({ orderBy: { createdAt: 'asc' } });
    return profile ?? this.prisma.teacher_profiles.create({ data: { id: 'default-teacher', name: '英语成长老师', coreTraits: defaultCore, adjustable: defaultAdjustable, style: 'patient_guide' } });
  }

  @Put('teacher-profile')
  async updateTeacherProfile(@Headers('x-admin-token') token: string | undefined, @Body() body: unknown) {
    this.authorize(token);
    const parsed = profileInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const current = await this.prisma.teacher_profiles.findFirst({ orderBy: { createdAt: 'asc' } }) ?? await this.prisma.teacher_profiles.create({ data: { id: 'default-teacher', name: '英语成长老师', coreTraits: defaultCore, adjustable: defaultAdjustable, style: 'patient_guide' } });
    const nextVersion = current.version + 1;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.teacher_profiles.update({ where: { id: current.id }, data: { adjustable: parsed.data.adjustable, style: parsed.data.style, stage: 1, version: nextVersion } });
      await tx.persona_history.create({
        data: { teacherProfileId: current.id, changeContent: JSON.stringify({ before: { adjustable: current.adjustable, style: current.style }, after: parsed.data }), reason: parsed.data.reason, version: nextVersion },
      });
      return updated;
    });
  }

  @Get('teacher-profile/history')
  async teacherProfileHistory(@Headers('x-admin-token') token: string | undefined) {
    this.authorize(token);
    const profile = await this.prisma.teacher_profiles.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!profile) return [];
    return this.prisma.persona_history.findMany({ where: { teacherProfileId: profile.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Put('teacher-profile/rollback/:historyId')
  async rollbackTeacherProfile(@Headers('x-admin-token') token: string | undefined, @Param('historyId') historyId: string) {
    this.authorize(token);
    const history = await this.prisma.persona_history.findUnique({ where: { id: historyId } });
    if (!history) throw new BadRequestException('人格变更记录不存在');
    let before: { adjustable?: unknown; style?: unknown };
    try { before = JSON.parse(history.changeContent).before; } catch { throw new BadRequestException('人格历史记录无法解析'); }
    const adjustable = adjustableSchema.safeParse(before.adjustable);
    if (!adjustable.success || !['patient_guide', 'playful_companion', 'calm_coach'].includes(String(before.style))) throw new BadRequestException('历史记录中的配置不符合当前安全约束');
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.teacher_profiles.update({ where: { id: history.teacherProfileId }, data: { adjustable: adjustable.data, style: before.style as string, version: { increment: 1 } } });
      await tx.persona_history.create({ data: { teacherProfileId: profile.id, changeContent: JSON.stringify({ rollbackOf: history.id, restored: before }), reason: `回滚到版本 ${history.version}`, version: profile.version, rollbackOf: history.id } });
      return profile;
    });
  }
}

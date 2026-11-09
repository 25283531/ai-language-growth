import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { SpeechQuotaService } from '../usage/speech-quota.service';

const updateMembershipSchema = z.object({
  tier: z.enum(['guest', 'free', 'member', 'advanced']),
});

@Controller('api/v1/admin/learners')
export class MembershipAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: SpeechQuotaService,
  ) {}

  @Get(':learnerId/membership')
  async getMembership(@Param('learnerId') learnerId: string) {
    const learner = await this.prisma.learner_profiles.findUnique({
      where: { id: learnerId },
      select: { id: true, displayName: true, membershipTier: true, updatedAt: true },
    });
    if (!learner) throw new BadRequestException('未找到学习者档案');
    return { ...learner, speechQuota: await this.quota.status(learnerId) };
  }

  @Put(':learnerId/membership')
  async setMembership(
    @Param('learnerId') learnerId: string,
    @Body() body: unknown,
  ) {
    const parsed = updateMembershipSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const updated = await this.prisma.learner_profiles.updateMany({
      where: { id: learnerId },
      data: { membershipTier: parsed.data.tier },
    });
    if (updated.count !== 1) throw new BadRequestException('未找到学习者档案');
    return this.getMembership(learnerId);
  }
}

import { BadRequestException, Body, Controller, Get, Headers, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderConfigService } from '../providers/provider-config.service';
import { SpeechQuotaService } from '../usage/speech-quota.service';

const updateMembershipSchema = z.object({
  tier: z.enum(['guest', 'free', 'member', 'advanced']),
});

@Controller('api/v1/admin/learners')
export class MembershipAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProviderConfigService,
    private readonly quota: SpeechQuotaService,
  ) {}

  @Get(':learnerId/membership')
  async getMembership(@Headers('x-admin-token') token: string | undefined, @Param('learnerId') learnerId: string) {
    this.config.assertAdminToken(token);
    const learner = await this.prisma.learner_profiles.findUnique({
      where: { id: learnerId },
      select: { id: true, displayName: true, membershipTier: true, updatedAt: true },
    });
    if (!learner) throw new BadRequestException('未找到学习者档案');
    return { ...learner, speechQuota: await this.quota.status(learnerId) };
  }

  @Put(':learnerId/membership')
  async setMembership(
    @Headers('x-admin-token') token: string | undefined,
    @Param('learnerId') learnerId: string,
    @Body() body: unknown,
  ) {
    this.config.assertAdminToken(token);
    const parsed = updateMembershipSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const updated = await this.prisma.learner_profiles.updateMany({
      where: { id: learnerId },
      data: { membershipTier: parsed.data.tier },
    });
    if (updated.count !== 1) throw new BadRequestException('未找到学习者档案');
    return this.getMembership(token, learnerId);
  }
}

/**
 * 七领域阶段画像接口。
 *
 * - 家长端：`GET /api/v1/learners/:id/stages`，必须登录且只能读自己的孩子。
 * - 管理端：`GET /api/v1/admin/curriculum/learners/:learnerId/stages`。
 *
 * 返回结构只含阶段、当前阶段节点数和证据数，不返回“总等级”，
 * 也不把阶段作为课程访问门槛。
 */
import { Controller, Get, Headers, Inject, NotFoundException, Param } from '@nestjs/common';
import type { StageProfile } from '@alg/shared-contracts';
import { AdminAuthService } from '../auth/admin-auth.service';
import { AuthService, extractBearerToken } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { StageProfileService } from './stage-profile.service';

@Controller('api/v1/learners')
export class LearnerStageController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(StageProfileService) private readonly profiles: StageProfileService,
  ) {}

  @Get(':id/stages')
  async stages(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ): Promise<StageProfile> {
    await this.auth.assertLearnerOwnership(extractBearerToken(authorization, cookie), id);
    return this.load(id);
  }

  private async load(learnerId: string): Promise<StageProfile> {
    const learner = await this.prisma.learner_profiles.findUnique({
      where: { id: learnerId },
      select: { id: true },
    });
    if (!learner) throw new NotFoundException('学习者不存在');
    return this.profiles.compute(learnerId);
  }
}

@Controller('api/v1/admin/curriculum')
export class CurriculumStageAdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminAuthService) private readonly adminAuth: AdminAuthService,
    @Inject(StageProfileService) private readonly profiles: StageProfileService,
  ) {}

  @Get('learners/:learnerId/stages')
  async stages(
    @Param('learnerId') learnerId: string,
    @Headers('cookie') cookie?: string,
  ): Promise<StageProfile> {
    this.adminAuth.resolveRequest({ headers: { cookie } });
    const learner = await this.prisma.learner_profiles.findUnique({
      where: { id: learnerId },
      select: { id: true },
    });
    if (!learner) throw new NotFoundException('学习者不存在');
    return this.profiles.compute(learnerId);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  Query,
  Put,
  Param,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthService, extractBearerToken, MEMBERSHIP_TIERS } from '../auth/auth.service';
import { ProviderConfigService } from '../providers/provider-config.service';
import { PrismaService } from '../prisma/prisma.service';

const requestSchema = z.object({
  tier: z.literal('member').default('member'),
  note: z.string().max(500).optional(),
});
const updateTierSchema = z.object({
  tier: z.enum(MEMBERSHIP_TIERS),
  note: z.string().max(500).optional(),
});

@Controller('api/v1/membership')
export class MembershipController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me')
  async me(
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const user = await this.auth.resolveSession(extractBearerToken(authorization, cookie));
    const [learners, requests, events] = await Promise.all([
      this.prisma.learner_profiles.findMany({
        where: { userId: user.id },
        select: { id: true, displayName: true, membershipTier: true },
      }),
      this.prisma.membership_requests.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.membership_events.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return {
      membershipTier: user.membershipTier,
      availableTiers: MEMBERSHIP_TIERS,
      learners,
      requests,
      events,
    };
  }

  @Post('requests')
  async request(
    @Headers('authorization') authorization: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Body() body: unknown,
  ) {
    const user = await this.auth.resolveSession(extractBearerToken(authorization, cookie));
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const existing = await this.prisma.membership_requests.findFirst({
      where: { userId: user.id, status: 'pending' },
    });
    if (existing) throw new HttpException('已有待处理的会员申请', 409);
    return this.prisma.membership_requests.create({
      data: {
        userId: user.id,
        requestedTier: parsed.data.tier,
        note: parsed.data.note,
      },
    });
  }
}

@Controller('api/v1/admin/users')
export class MembershipUsersAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ProviderConfigService,
  ) {}

  @Get()
  async list(@Headers('x-admin-token') token: string | undefined, @Query('q') query?: string) {
    this.config.assertAdminToken(token);
    const q = query?.trim().toLowerCase();
    const users = await this.prisma.users.findMany({
      where: q
        ? { OR: [{ email: { contains: q } }, { displayName: { contains: q, mode: 'insensitive' } }] }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        displayName: true,
        membershipTier: true,
        disabledAt: true,
        createdAt: true,
        learners: { select: { id: true, displayName: true, membershipTier: true } },
      },
    });
    return users;
  }

  @Get('membership-requests')
  async requests(@Headers('x-admin-token') token: string | undefined) {
    this.config.assertAdminToken(token);
    return this.prisma.membership_requests.findMany({
      where: { status: 'pending' },
      include: { user: { select: { id: true, email: true, displayName: true, membershipTier: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  }

  @Put(':userId/membership')
  async update(
    @Headers('x-admin-token') token: string | undefined,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    this.config.assertAdminToken(token);
    const parsed = updateTierSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.users.findUnique({ where: { id: userId } });
      if (!current) throw new BadRequestException('未找到注册用户');
      const user = await tx.users.update({
        where: { id: userId },
        data: { membershipTier: parsed.data.tier },
        select: {
          id: true,
          email: true,
          displayName: true,
          membershipTier: true,
          createdAt: true,
        },
      });
      await tx.learner_profiles.updateMany({
        where: { userId },
        data: { membershipTier: parsed.data.tier },
      });
      if (current.membershipTier !== parsed.data.tier) {
        await tx.membership_events.create({
          data: {
            userId,
            fromTier: current.membershipTier,
            toTier: parsed.data.tier,
            source: 'admin',
            note: parsed.data.note,
          },
        });
      }
      await tx.membership_requests.updateMany({
        where: { userId, status: 'pending' },
        data: {
          status: parsed.data.tier === 'free' || parsed.data.tier === 'guest' ? 'rejected' : 'approved',
          reviewedAt: new Date(),
          reviewedBy: 'admin',
        },
      });
      return {
        ...user,
        learners: await tx.learner_profiles.findMany({
          where: { userId },
          select: { id: true, displayName: true, membershipTier: true },
        }),
      };
    });
  }
}

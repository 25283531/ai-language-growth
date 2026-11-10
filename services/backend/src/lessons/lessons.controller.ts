/**
 * 教学接口控制器。
 *
 * 路径与任务书第 7 章「核心教学 API」对齐：
 *   POST /api/v1/lessons/start
 *   POST /api/v1/lessons/{id}/turn    ← 全局核心接口
 *   POST /api/v1/lessons/{id}/finish
 */
import { Body, Controller, Get, Headers, HttpException, Inject, Param, Post, Query } from '@nestjs/common';
import {
  lessonFinishRequestSchema,
  lessonStartRequestSchema,
  turnRequestSchema,
} from '@alg/shared-contracts';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { LearnerModelService } from '../learner-model/learner-model.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpeechQuotaService } from '../usage/speech-quota.service';
import { AuthService, extractBearerToken } from '../auth/auth.service';

@Controller('api/v1/lessons')
export class LessonsController {
  constructor(
    @Inject(OrchestratorService) private readonly orchestrator: OrchestratorService,
    @Inject(LearnerModelService) private readonly learnerModel: LearnerModelService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SpeechQuotaService) private readonly quota: SpeechQuotaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Post('start')
  async start(
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const parsed = lessonStartRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '请求参数不合法', detail: parsed.error.flatten() }, 400);
    }
    await this.auth.assertLearnerOwnership(extractBearerToken(authorization, cookie), parsed.data.learnerId);
    return this.orchestrator.startLesson(parsed.data);
  }

  @Post(':id/turn')
  async turn(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-speech-quota-reservation') reservationHeader?: string,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const parsed = turnRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '请求参数不合法', detail: parsed.error.flatten() }, 400);
    }
    await this.auth.assertLearnerOwnership(extractBearerToken(authorization, cookie), parsed.data.learnerId);
    if (parsed.data.response.audioRef) {
      const reservationId = String(reservationHeader ?? '').trim();
      if (!reservationId) throw new HttpException('语音课堂提交缺少 ASR 额度租约', 400);
      const reservation = await this.quota.assertReservation({
        reservationId,
        learnerId: parsed.data.learnerId,
        serviceKind: 'asr',
      });
      try {
        const result = await this.orchestrator.handleTurn({
          lessonSessionId: id,
          learnerId: parsed.data.learnerId,
          response: parsed.data.response,
          idempotencyKey: parsed.data.idempotencyKey,
        });
        const seconds = Math.min(
          reservation.requestedUnits,
          Math.max(0, (parsed.data.response.audioDurationMs ?? 0) / 1000),
        );
        await this.quota.settle(reservationId, seconds);
        return result;
      } catch (error) {
        await this.quota.release(reservationId).catch(() => undefined);
        throw error;
      }
    }
    try {
      return await this.orchestrator.handleTurn({
        lessonSessionId: id,
        learnerId: parsed.data.learnerId,
        response: parsed.data.response,
        idempotencyKey: parsed.data.idempotencyKey,
      });
    } catch (error) {
      // 外部服务全不可用时保留固定课程与缓存音频，保证课程不中断（D-015）。
      // 必须返回完整可渲染的 TurnResponse：只回一个「降级错误体」没有
      // directive，客户端其实无法继续上课，不算真正的课程不中断。
      return this.orchestrator.offlineFallback({
        lessonSessionId: id,
        learnerId: parsed.data.learnerId,
        reason: (error as Error).message,
      });
    }
  }

  @Post(':id/finish')
  async finish(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const parsed = lessonFinishRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException({ message: '请求参数不合法', detail: parsed.error.flatten() }, 400);
    }
    await this.auth.assertLearnerOwnership(extractBearerToken(authorization, cookie), parsed.data.learnerId);
    const session = await this.prisma.lesson_sessions.findUnique({ where: { id }, select: { learnerId: true } });
    if (!session || session.learnerId !== parsed.data.learnerId) throw new HttpException('无权访问该课堂', 403);
    return this.orchestrator.finishLesson(id, parsed.data.learnerId);
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const session = await this.prisma.lesson_sessions.findUnique({
      where: { id },
      include: {
        interactions: { orderBy: { turnIndex: 'asc' } },
      },
    });
    if (!session) throw new HttpException({ message: '课堂不存在' }, 404);
    await this.auth.assertLearnerOwnership(extractBearerToken(authorization, cookie), session.learnerId);
    return session;
  }
}

/**
 * 学习者接口。
 *
 * 与课程接口使用同一套会话鉴权（AuthService + extractBearerToken）：
 * 每个路由都必须先解析会话，再校验该 learner 是否属于当前账号，
 * 列表接口只返回当前账号名下的学习者 —— 儿童档案属于敏感个人信息，
 * 不允许匿名枚举。（本项目既有鉴权模型不变，这里只是补上遗漏的路由。）
 */
@Controller('api/v1/learners')
export class LearnersController {
  constructor(
    @Inject(LearnerModelService) private readonly learnerModel: LearnerModelService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /** 统一入口：解析会话 + 校验归属，返回当前账号 user id。 */
  private async authorize(authorization: string | undefined, cookie: string | undefined, learnerId: string) {
    return this.auth.assertLearnerOwnership(extractBearerToken(authorization, cookie), learnerId);
  }

  @Get()
  async list(
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    // 先解析会话：无 cookie / 会话过期 -> 401，绝不返回任何学习者的存在性。
    const user = await this.auth.resolveSession(extractBearerToken(authorization, cookie));
    return this.prisma.learner_profiles.findMany({
      where: { userId: user.id, guardianId: user.id },
      select: {
        id: true,
        displayName: true,
        ageGroup: true,
        entryLevel: true,
        currentTopic: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get(':id/profile')
  async profile(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    await this.authorize(authorization, cookie, id);
    const profile = await this.prisma.learner_profiles.findUnique({
      where: { id },
      include: { preferences: true },
    });
    if (!profile) throw new HttpException({ message: '学习者不存在' }, 404);
    return profile;
  }

  @Get(':id/abilities')
  async abilities(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    await this.authorize(authorization, cookie, id);
    const states = await this.learnerModel.abilitySnapshot(id);
    return {
      learnerId: id,
      states,
      // ⚠️ M1 阈值全部未校准，不得对外表述为「已掌握」
      calibrationNotice:
        'M1 阈值来自原型示意值，尚未经真实儿童样本校准；状态仅供内部教学决策参考。',
    };
  }

  @Get(':id/evidence')
  async evidence(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
    @Query('skillNodeId') skillNodeId?: string,
  ) {
    await this.authorize(authorization, cookie, id);
    const rows = await this.prisma.learning_evidence.findMany({
      where: { learnerId: id, ...(skillNodeId ? { skillNodeId } : {}) },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    });
    return rows;
  }

  @Get(':id/growth')
  async growth(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Headers('cookie') cookie?: string,
  ) {
    await this.authorize(authorization, cookie, id);
    const learner = await this.prisma.learner_profiles.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!learner) throw new HttpException({ message: '学习者不存在' }, 404);

    const [snapshots, memories, upcomingReviews] = await Promise.all([
      this.prisma.learner_growth_snapshots.findMany({
        where: { learnerId: id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      this.prisma.interaction_memories.findMany({
        where: {
          learnerId: id,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
        take: 30,
        select: {
          id: true,
          memoryType: true,
          content: true,
          importance: true,
          source: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.review_schedules.findMany({
        where: { learnerId: id, completedAt: null },
        orderBy: { dueAt: 'asc' },
        take: 30,
        select: { skillNodeId: true, dueAt: true, intervalDays: true },
      }),
    ]);

    return {
      learnerId: id,
      snapshots,
      memories,
      upcomingReviews,
      calibrationNotice: '内部原型记录；能力阈值未经真实儿童样本校准，不代表已掌握。',
    };
  }
}

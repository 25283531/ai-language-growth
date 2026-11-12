import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminAuthService } from '../auth/admin-auth.service';
import { UsageCostService } from './usage-cost.service';

const querySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  learnerId: z.string().trim().min(1).max(100).optional(),
  lessonSessionId: z.string().trim().min(1).max(100).optional(),
  topicId: z.string().trim().min(1).max(120).optional(),
});

const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * 管理员只读成本聚合。
 *
 * 返回按 learner / topic / day 三个维度的 TTS 字符、ASR 秒、发音次数、
 * 估算金额与未计价调用数。不提供写入、改价或删除能力。
 */
@Controller('api/v1/admin/usage')
export class UsageAdminController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly costs: UsageCostService,
  ) {}

  @Get('cost')
  async cost(
    @Req() request: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('learnerId') learnerId?: string,
    @Query('lessonSessionId') lessonSessionId?: string,
    @Query('topicId') topicId?: string,
  ) {
    this.adminAuth.resolveRequest(request);
    const parsed = querySchema.safeParse({ from, to, learnerId, lessonSessionId, topicId });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    const end = parsed.data.to ? parseDate(parsed.data.to, 'to') : new Date();
    const start = parsed.data.from
      ? parseDate(parsed.data.from, 'from')
      : new Date(end.getTime() - DEFAULT_RANGE_MS);
    if (start >= end) throw new BadRequestException('from 必须早于 to');
    if (end.getTime() - start.getTime() > MAX_RANGE_MS) {
      throw new BadRequestException('查询范围不能超过 366 天');
    }

    return this.costs.aggregate({
      from: start,
      to: end,
      ...(parsed.data.learnerId ? { learnerId: parsed.data.learnerId } : {}),
      ...(parsed.data.lessonSessionId ? { lessonSessionId: parsed.data.lessonSessionId } : {}),
      ...(parsed.data.topicId ? { topicId: parsed.data.topicId } : {}),
    });
  }
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} 需要有效的 ISO 日期时间`);
  }
  return date;
}

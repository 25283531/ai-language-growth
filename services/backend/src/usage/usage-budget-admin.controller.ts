import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminAuthService } from '../auth/admin-auth.service';
import { USAGE_BUDGET_SCOPES } from './usage-budget';
import { UsageBudgetService } from './usage-budget.service';

const querySchema = z.object({
  scope: z.enum(USAGE_BUDGET_SCOPES),
  learnerId: z.string().trim().min(1).max(100).optional(),
  topicId: z.string().trim().min(1).max(120).optional(),
});

/**
 * P2-2D 预算只读入口。
 *
 * 配置由环境变量提供，接口只返回生效快照和评估结果；不提供写配置、改价或
 * 阻断开关。100% 仅为 advisory 告警。
 */
@Controller('api/v1/admin/usage')
export class UsageBudgetAdminController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly budget: UsageBudgetService,
  ) {}

  @Get('budget')
  budgetSnapshot(@Req() request: Request) {
    this.adminAuth.resolveRequest(request);
    return this.budget.getSnapshot();
  }

  @Get('budget/evaluate')
  async evaluate(
    @Req() request: Request,
    @Query('scope') scope?: string,
    @Query('learnerId') learnerId?: string,
    @Query('topicId') topicId?: string,
  ) {
    this.adminAuth.resolveRequest(request);
    const parsed = querySchema.safeParse({ scope, learnerId, topicId });
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.budget.evaluate(parsed.data);
  }
}

import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { UsageCostService } from './usage-cost.service';
import {
  buildUsageBudgetSnapshot,
  evaluateUsageBudget,
  loadUsageBudgetConfig,
  usageBudgetWindow,
  USAGE_BUDGET_SCOPES,
  UsageBudgetConfigError,
  type UsageBudgetEvaluation,
  type UsageBudgetScope,
  type UsageBudgetSnapshot,
} from './usage-budget';

export interface UsageBudgetEvaluateInput {
  scope: UsageBudgetScope;
  learnerId?: string;
  topicId?: string;
  now?: Date;
}

/**
 * P2-2D 用量预算读取与评估。
 *
 * 只读 ai_usage_logs 聚合；配置从环境变量读取，不持久化、不改 router 的
 * dailyBudgetCny，也不执行 100% 阻断。
 */
@Injectable()
export class UsageBudgetService {
  constructor(private readonly costs: UsageCostService) {}

  getSnapshot(): UsageBudgetSnapshot {
    return buildUsageBudgetSnapshot(this.config());
  }

  async evaluate(input: UsageBudgetEvaluateInput): Promise<UsageBudgetEvaluation> {
    if (!USAGE_BUDGET_SCOPES.includes(input.scope)) {
      throw new BadRequestException('scope 必须是 learner_day 或 topic_month');
    }
    const learnerId = input.learnerId?.trim();
    const topicId = input.topicId?.trim();
    if (input.scope === 'learner_day' && !learnerId) {
      throw new BadRequestException('learner_day 需要 learnerId');
    }
    if (input.scope === 'topic_month' && !topicId) {
      throw new BadRequestException('topic_month 需要 topicId');
    }

    const config = this.config();
    const window = usageBudgetWindow(input.scope, input.now ?? new Date());
    const report = await this.costs.aggregate({
      from: window.from,
      to: window.to,
      ...(learnerId ? { learnerId } : {}),
      ...(topicId ? { topicId } : {}),
    });
    const limits = input.scope === 'learner_day' ? config.learnerDay : config.topicMonth;
    return evaluateUsageBudget(input.scope, limits, report.totals, window);
  }

  private config() {
    try {
      return loadUsageBudgetConfig();
    } catch (error) {
      if (error instanceof UsageBudgetConfigError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
  }
}

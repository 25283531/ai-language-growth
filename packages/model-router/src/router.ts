/**
 * Model Router —— 多模型分级调度（只选模型，不调用）。
 *
 * 依据：D-011「多模型分级调度：L0—L3，提前到 M1」；
 *      D-012「Router 与 Gateway 分离」；
 *      D-015「升级机制与成本指标：不信自报置信度」。
 *
 * 铁律：
 *  1. 业务代码只依赖本包的 ModelRouter 接口，不知道任何服务商或模型名称。
 *  2. 升级依据是多信号（结构化合规、任务完成、ASR 失败、发音困难、
 *     连续不懂、已换方法、与档案矛盾），绝不使用模型自报置信度。
 *  3. LLM / TTS / ASR / 发音评估四类服务各自独立路由与故障切换。
 */
import type {
  EscalationSignal,
  ModelLevel,
  RouteRule,
  RoutingDecision,
  ServiceKind,
  TaskRoute,
  UsageRecord,
} from '@alg/shared-contracts';

/** 路由配置表。可在管理后台调整，换模型不发版（D-012）。 */
export interface RouterConfig {
  rules: RouteRule[];
  /**
   * 升级判定：出现这些信号时提升服务等级。
   * 每类服务独立配置升级到哪一级。
   */
  escalationTargets: Record<ServiceKind, Partial<Record<EscalationSignal, ModelLevel>>>;
  /**
   * 降级链（固定四步，D-015）：
   *   免费模型优先 → 限流时切付费低价 → 预算上限时保障关键教学交互
   *   → 外部服务全不可用时保留固定课程与缓存音频
   */
  fallbackOrder: ModelLevel[];
}

/**
 * Mock 模式下四类服务实际注册的适配器别名。
 *
 * M1 用 Mock Provider Adapter 打通闭环（既定执行边界）。若 Router 仍返回
 * free_llm / lowcost_tts 这类「逻辑别名」，Gateway 会因找不到适配器而每次
 * fallback 到 mock_*，把「模式配置」误报成「服务降级」；反过来若只在
 * degradation 里填 false，又会静默掩盖真实发生的切换。
 *
 * 传入该映射后，Router 的分级、升级、降级策略完全照常执行
 * （level / strategy / fellBack 全部真实），只把最终供应商别名指向当前
 * 确实存在的 Mock 适配器。生产模式不传此映射，别名来自可配置的路由表。
 */
export const MOCK_PROVIDER_ALIASES: Record<ServiceKind, string> = {
  llm: 'mock_llm',
  tts: 'mock_tts',
  asr: 'mock_asr',
  pronunciation: 'mock_pronunciation',
};

/** 默认路由配置。全部使用配置别名，不含任何厂商或模型名（约束二）。 */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  rules: [
    {
      taskRoute: 'llm.simple_dialogue',
      primary: { providerAlias: 'free_llm', modelAlias: 'free_llm_01', level: 'L1' },
      fallback: [
        { providerAlias: 'lowcost_llm', modelAlias: 'lowcost_llm_01', level: 'L1' },
        { providerAlias: 'mid_llm', modelAlias: 'mid_llm_01', level: 'L2' },
      ],
      maxConcurrency: 8,
      dailyBudgetCny: 50,
      enabled: true,
    },
    {
      taskRoute: 'llm.teaching_explanation',
      primary: { providerAlias: 'lowcost_llm', modelAlias: 'lowcost_llm_01', level: 'L1' },
      fallback: [{ providerAlias: 'mid_llm', modelAlias: 'mid_llm_01', level: 'L2' }],
      maxConcurrency: 6,
      dailyBudgetCny: 100,
      enabled: true,
    },
    {
      taskRoute: 'llm.method_adaptation',
      primary: { providerAlias: 'mid_llm', modelAlias: 'mid_llm_01', level: 'L2' },
      fallback: [{ providerAlias: 'premium_llm', modelAlias: 'premium_llm_01', level: 'L3' }],
      maxConcurrency: 4,
      dailyBudgetCny: 200,
      enabled: true,
    },
    {
      taskRoute: 'llm.learning_plan',
      primary: { providerAlias: 'premium_llm', modelAlias: 'premium_llm_01', level: 'L3' },
      fallback: [{ providerAlias: 'mid_llm', modelAlias: 'mid_llm_01', level: 'L2' }],
      maxConcurrency: 2,
      dailyBudgetCny: 300,
      enabled: true,
    },
    {
      taskRoute: 'tts.fixed_course',
      primary: { providerAlias: 'course_audio_cache', modelAlias: 'course_audio_cache', level: 'L0' },
      fallback: [{ providerAlias: 'lowcost_tts', modelAlias: 'lowcost_tts_01', level: 'L1' }],
      maxConcurrency: 16,
      dailyBudgetCny: 20,
      enabled: true,
    },
    {
      taskRoute: 'tts.dynamic_teaching',
      primary: { providerAlias: 'lowcost_tts', modelAlias: 'lowcost_tts_01', level: 'L1' },
      fallback: [{ providerAlias: 'premium_tts', modelAlias: 'premium_tts_01', level: 'L2' }],
      maxConcurrency: 8,
      dailyBudgetCny: 60,
      enabled: true,
    },
    {
      taskRoute: 'tts.narrative',
      primary: { providerAlias: 'lowcost_tts', modelAlias: 'lowcost_tts_01', level: 'L1' },
      fallback: [{ providerAlias: 'premium_tts', modelAlias: 'premium_tts_01', level: 'L2' }],
      maxConcurrency: 6,
      dailyBudgetCny: 80,
      enabled: true,
    },
    {
      taskRoute: 'asr.free_speech',
      primary: { providerAlias: 'free_asr', modelAlias: 'free_asr_01', level: 'L1' },
      fallback: [{ providerAlias: 'paid_asr', modelAlias: 'paid_asr_01', level: 'L1' }],
      maxConcurrency: 8,
      dailyBudgetCny: 80,
      enabled: true,
    },
    {
      taskRoute: 'asr.follow_read',
      primary: { providerAlias: 'free_asr', modelAlias: 'free_asr_01', level: 'L1' },
      fallback: [{ providerAlias: 'paid_asr', modelAlias: 'paid_asr_01', level: 'L1' }],
      maxConcurrency: 8,
      dailyBudgetCny: 80,
      enabled: true,
    },
    {
      taskRoute: 'pronunciation.word',
      primary: { providerAlias: 'pronunciation_svc', modelAlias: 'pronunciation_01', level: 'L1' },
      fallback: [],
      maxConcurrency: 6,
      dailyBudgetCny: 150,
      enabled: true,
    },
    {
      taskRoute: 'pronunciation.phoneme',
      primary: { providerAlias: 'pronunciation_svc', modelAlias: 'pronunciation_01', level: 'L1' },
      fallback: [],
      maxConcurrency: 6,
      dailyBudgetCny: 150,
      enabled: true,
    },
  ],
  escalationTargets: {
    llm: {
      schema_invalid: 'L2',
      task_incomplete: 'L2',
      child_did_not_understand: 'L2',
      method_already_changed: 'L3',
      conflicts_with_profile: 'L3',
      asr_failed: 'L2',
      pronunciation_difficulty: 'L2',
    },
    tts: {
      schema_invalid: 'L2',
      task_incomplete: 'L2',
    },
    asr: {
      asr_failed: 'L1',
      schema_invalid: 'L2',
    },
    pronunciation: {
      pronunciation_difficulty: 'L2',
      schema_invalid: 'L2',
    },
  },
  fallbackOrder: ['L1', 'L2', 'L3'],
};

/** 成本账本接口：测试可用内存实现，后端生产通过 Prisma 写入 ai_usage_logs。 */
export interface UsageLedger {
  add(record: UsageRecord): void | Promise<void>;
  summary(filter?: {
    learnerId?: string;
    lessonSessionId?: string;
  }): {
    totalCostCny: number;
    byService: Record<string, { calls: number; costCny: number }>;
    byLevel: Record<string, { calls: number; costCny: number }>;
  } | Promise<{
    totalCostCny: number;
    byService: Record<string, { calls: number; costCny: number }>;
    byLevel: Record<string, { calls: number; costCny: number }>;
  }>;
  list(filter?: { learnerId?: string; lessonSessionId?: string }): UsageRecord[] | Promise<UsageRecord[]>;
}

/** 内存用量账本。用于单测与独立本地运行；后端生产注入 Prisma 实现。 */
export class InMemoryUsageLedger implements UsageLedger {
  private readonly records: UsageRecord[] = [];

  add(record: UsageRecord): void {
    this.records.push(record);
  }

  list(filter?: { learnerId?: string; lessonSessionId?: string }): UsageRecord[] {
    return this.records.filter(
      (r) =>
        (!filter?.learnerId || r.learnerId === filter.learnerId) &&
        (!filter?.lessonSessionId || r.lessonSessionId === filter.lessonSessionId),
    );
  }

  summary(filter?: { learnerId?: string; lessonSessionId?: string }) {
    const rows = this.list(filter);
    const byService: Record<string, { calls: number; costCny: number }> = {};
    const byLevel: Record<string, { calls: number; costCny: number }> = {};
    let totalCostCny = 0;

    for (const r of rows) {
      totalCostCny += r.estimatedCostCny;
      const s = (byService[r.serviceKind] ??= { calls: 0, costCny: 0 });
      s.calls += 1;
      s.costCny += r.estimatedCostCny;
      const l = (byLevel[r.level] ??= { calls: 0, costCny: 0 });
      l.calls += 1;
      l.costCny += r.estimatedCostCny;
    }

    return { totalCostCny, byService, byLevel };
  }
}

/**
 * Model Router 实现。
 *
 * 只做选择，不做调用 —— 调用由 AI Gateway 负责（D-012）。
 */
export class ModelRouterImpl {
  private config: RouterConfig;
  private readonly ledger: UsageLedger;
  private providerAliases?: Partial<Record<ServiceKind, string>>;
  private modelAliases?: Partial<Record<ServiceKind, string>>;

  constructor(
    config: RouterConfig = DEFAULT_ROUTER_CONFIG,
    ledger?: UsageLedger,
    providerAliases?: Record<ServiceKind, string>,
  ) {
    this.config = config;
    this.ledger = ledger ?? new InMemoryUsageLedger();
    this.providerAliases = providerAliases;
  }

  /** Apply an operator-managed adapter selection without changing task routing rules. */
  setProviderAlias(serviceKind: ServiceKind, providerAlias: string, modelAlias = providerAlias): void {
    this.providerAliases ??= {};
    this.modelAliases ??= {};
    this.providerAliases[serviceKind] = providerAlias;
    this.modelAliases[serviceKind] = modelAlias;
  }

  /** Replace policy after a validated admin/database configuration update. */
  setConfig(config: RouterConfig): void {
    this.config = config;
  }

  /** Return a snapshot for persistence and the admin console. */
  getConfig(): RouterConfig {
    return this.config;
  }

  get usageLedger(): UsageLedger {
    return this.ledger;
  }

  /**
   * Mock 模式下把供应商别名改指到实际注册的适配器。
   * 只改别名，不改 level / strategy / fellBack —— 路由决策本身保持真实。
   */
  private finalize(decision: RoutingDecision, serviceKind: ServiceKind): RoutingDecision {
    const alias = this.providerAliases?.[serviceKind];
    if (!alias) return decision;
    return { ...decision, providerAlias: alias, modelAlias: this.modelAliases?.[serviceKind] ?? alias };
  }

  private findRule(taskRoute: string): RouteRule | undefined {
    return this.config.rules.find((r) => r.taskRoute === taskRoute && r.enabled);
  }

  /**
   * 选择模型并执行升级判定。
   *
   * @param serviceKind 服务类型（四类独立）
   * @param taskRoute   任务路由标识
   * @param escalationSignals 升级信号（多信号，不含模型自报置信度）
   */
  async route(input: {
    serviceKind: ServiceKind;
    taskRoute: TaskRoute | string;
    escalationSignals?: EscalationSignal[];
    /** 已失败的备选（由 Gateway 在调用失败后传入，用于选下一个） */
    failedAliases?: string[];
  }): Promise<RoutingDecision> {
    const rule = this.findRule(input.taskRoute);
    if (!rule) {
      // 无规则时退到 L0 本地处理，保证流程不中断
      return {
        level: 'L0',
        providerAlias: 'local_rules',
        modelAlias: 'local_rules',
        strategy: 'no_rule_local_fallback',
        fellBack: true,
        escalationSignals: [],
      };
    }

    const signals = input.escalationSignals ?? [];
    const failed = new Set(input.failedAliases ?? []);

    // —— 升级判定：取所有信号对应目标级别中的最高级 ——
    const targets = this.config.escalationTargets[input.serviceKind] ?? {};
    let escalatedLevel: ModelLevel | null = null;
    for (const signal of signals) {
      const target = targets[signal];
      if (target && (!escalatedLevel || levelRank(target) > levelRank(escalatedLevel))) {
        escalatedLevel = target;
      }
    }

    // —— 候选序列：主模型 → 升级模型 → 降级链 ——
    const candidates: Array<{
      providerAlias: string;
      modelAlias: string;
      level: ModelLevel;
      strategy: string;
    }> = [];

    let escalatedCandidates = escalatedLevel && levelRank(escalatedLevel) > levelRank(rule.primary.level)
      ? rule.fallback
          .filter((candidate) => levelRank(candidate.level) >= levelRank(escalatedLevel))
          .sort((a, b) => levelRank(a.level) - levelRank(b.level))
      : [];
    const escalationTargetUnavailable = escalatedLevel !== null &&
      levelRank(escalatedLevel) > levelRank(rule.primary.level) &&
      escalatedCandidates.length === 0;
    if (escalationTargetUnavailable) {
      escalatedCandidates = rule.fallback
        .filter((candidate) => levelRank(candidate.level) > levelRank(rule.primary.level))
        .sort((a, b) => levelRank(b.level) - levelRank(a.level))
        .slice(0, 1);
    }
    for (const candidate of escalatedCandidates) {
      candidates.push({
        ...candidate,
        strategy: escalationTargetUnavailable
          ? `escalation_target_${escalatedLevel!.toLowerCase()}_unavailable_using_${candidate.level.toLowerCase()}`
          : `escalated_on_${signals.join('+')}`,
      });
    }

    candidates.push({ ...rule.primary, strategy: 'primary' });
    for (const fb of rule.fallback) {
      if (escalatedCandidates.some((candidate) => candidate.providerAlias === fb.providerAlias && candidate.modelAlias === fb.modelAlias)) {
        continue;
      }
      candidates.push({ ...fb, strategy: 'fallback' });
    }

    for (const candidate of candidates) {
      if (failed.has(candidate.providerAlias)) continue;
      return this.finalize(
        {
          level: candidate.level,
          providerAlias: candidate.providerAlias,
          modelAlias: candidate.modelAlias,
          strategy: candidate.strategy,
          fellBack: candidate.strategy !== 'primary',
          escalationSignals: signals,
        },
        input.serviceKind,
      );
    }

    // 全部失败 → L0 本地兜底
    return {
      level: 'L0',
      providerAlias: 'local_rules',
      modelAlias: 'local_rules',
      strategy: 'all_providers_failed_local_fallback',
      fellBack: true,
      escalationSignals: signals,
    };
  }

  /** 记录一条用量。 */
  async recordUsage(record: UsageRecord): Promise<void> {
    await this.ledger.add(record);
  }

  /** 查询用量汇总。 */
  async usageSummary(filter?: { learnerId?: string; lessonSessionId?: string }) {
    return await this.ledger.summary(filter);
  }
}

export function levelRank(level: ModelLevel): number {
  return { L0: 0, L1: 1, L2: 2, L3: 3 }[level];
}

/** ModelRouter 接口实现类导出。 */
export type { ModelRouter } from '@alg/shared-contracts';

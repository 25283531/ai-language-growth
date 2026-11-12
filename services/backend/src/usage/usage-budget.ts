/**
 * P2-2D 用量预算契约。
 *
 * 作用域固定为 learner/day 与 topic/month；预算只做告警评估，不接 router 阻断。
 * 配置来源当前为环境变量 USAGE_BUDGET_CONFIG_JSON（JSON 对象），管理员只读接口
 * 返回生效快照，不返回任何密钥。未配置金额或存在未计价调用时，只展示字符/秒/次数。
 */

export const USAGE_BUDGET_SCOPES = ['learner_day', 'topic_month'] as const;
export type UsageBudgetScope = (typeof USAGE_BUDGET_SCOPES)[number];

export const USAGE_BUDGET_WARNING_RATIO = 0.8;
export const USAGE_BUDGET_EXCEEDED_RATIO = 1;

export type UsageBudgetMetricKey =
  | 'ttsCharacters'
  | 'asrSeconds'
  | 'pronunciationCalls'
  | 'estimatedCostCny';

export type UsageBudgetLimits = Partial<Record<UsageBudgetMetricKey, number>>;

export interface UsageBudgetConfig {
  learnerDay: UsageBudgetLimits;
  topicMonth: UsageBudgetLimits;
}

export interface UsageBudgetSnapshot {
  source: 'environment';
  enforcement: 'advisory';
  thresholds: { warning: number; exceeded: number };
  scopes: {
    learnerDay: { scope: 'learner_day'; limits: UsageBudgetLimits };
    topicMonth: { scope: 'topic_month'; limits: UsageBudgetLimits };
  };
}

export interface UsageBudgetObserved {
  calls: number;
  ttsCharacters: number;
  asrSeconds: number;
  pronunciationCalls: number;
  estimatedCostCny: number;
  unpricedCalls: number;
}

export type UsageBudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface UsageBudgetMetric {
  key: UsageBudgetMetricKey;
  label: string;
  used: number;
  limit: number;
  ratio: number;
  status: UsageBudgetStatus;
}

export interface UsageBudgetEvaluation {
  scope: UsageBudgetScope;
  window: { from: string; to: string };
  status: UsageBudgetStatus;
  enforcement: 'advisory';
  /** 当前没有接 router，100% 也只告警，不阻断教学。 */
  blocked: false;
  /** usage = 只展示字符/秒/次数；cost_and_usage = 价格可用时才附带金额。 */
  displayMode: 'usage' | 'cost_and_usage';
  metrics: UsageBudgetMetric[];
  cost: UsageBudgetMetric | null;
  unpricedCalls: number;
  notices: string[];
}

export class UsageBudgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageBudgetConfigError';
  }
}

const METRIC_DEFINITIONS: Array<{ key: UsageBudgetMetricKey; label: string }> = [
  { key: 'ttsCharacters', label: 'TTS 字符' },
  { key: 'asrSeconds', label: 'ASR 秒数' },
  { key: 'pronunciationCalls', label: '发音次数' },
  { key: 'estimatedCostCny', label: '估算金额' },
];

/**
 * 解析并校验预算 JSON。
 *
 * 示例：
 * {"learnerDay":{"ttsCharacters":50000,"asrSeconds":1800,"pronunciationCalls":200},
 *  "topicMonth":{"ttsCharacters":200000,"asrSeconds":7200,"pronunciationCalls":800,
 *                "estimatedCostCny":20}}
 */
export function parseUsageBudgetConfig(raw: string | undefined): UsageBudgetConfig {
  if (!raw?.trim()) {
    return { learnerDay: {}, topicMonth: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageBudgetConfigError('USAGE_BUDGET_CONFIG_JSON 不是合法 JSON');
  }
  if (!isRecord(parsed)) {
    throw new UsageBudgetConfigError('USAGE_BUDGET_CONFIG_JSON 必须是对象');
  }
  return {
    learnerDay: parseLimits(parsed.learnerDay, 'learnerDay'),
    topicMonth: parseLimits(parsed.topicMonth, 'topicMonth'),
  };
}

export function loadUsageBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
): UsageBudgetConfig {
  return parseUsageBudgetConfig(env.USAGE_BUDGET_CONFIG_JSON);
}

export function buildUsageBudgetSnapshot(config: UsageBudgetConfig): UsageBudgetSnapshot {
  return {
    source: 'environment',
    enforcement: 'advisory',
    thresholds: {
      warning: USAGE_BUDGET_WARNING_RATIO,
      exceeded: USAGE_BUDGET_EXCEEDED_RATIO,
    },
    scopes: {
      learnerDay: { scope: 'learner_day', limits: config.learnerDay },
      topicMonth: { scope: 'topic_month', limits: config.topicMonth },
    },
  };
}

/** 按 UTC 自然日 / UTC 自然月计算预算窗口，终点不包含。 */
export function usageBudgetWindow(
  scope: UsageBudgetScope,
  now: Date = new Date(),
): { from: Date; to: Date } {
  if (Number.isNaN(now.getTime())) throw new Error('预算窗口时间无效');
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (scope === 'learner_day') {
    const from = new Date(Date.UTC(year, month, now.getUTCDate()));
    const to = new Date(Date.UTC(year, month, now.getUTCDate() + 1));
    return { from, to };
  }
  if (scope === 'topic_month') {
    return {
      from: new Date(Date.UTC(year, month, 1)),
      to: new Date(Date.UTC(year, month + 1, 1)),
    };
  }
  throw new Error(`未知预算作用域: ${String(scope)}`);
}

export function evaluateUsageBudget(
  scope: UsageBudgetScope,
  limits: UsageBudgetLimits,
  usage: UsageBudgetObserved,
  window: { from: Date; to: Date },
): UsageBudgetEvaluation {
  const observed = normalizeObserved(usage);
  const metrics: UsageBudgetMetric[] = [];
  for (const definition of METRIC_DEFINITIONS.slice(0, 3)) {
    const limit = limits[definition.key];
    if (!isPositiveLimit(limit)) continue;
    metrics.push(buildMetric(definition.key, definition.label, observed[definition.key], limit));
  }

  const notices: string[] = [];
  let status = highestStatus(metrics.map((metric) => metric.status));
  let cost: UsageBudgetMetric | null = null;
  const costLimit = limits.estimatedCostCny;
  if (isPositiveLimit(costLimit)) {
    if (observed.unpricedCalls > 0) {
      notices.push(
        `有 ${observed.unpricedCalls} 次未计价调用，金额预算未参与判定；只按字符/秒/次数展示。`,
      );
    } else {
      cost = buildMetric('estimatedCostCny', '估算金额', observed.estimatedCostCny, costLimit);
      status = highestStatus([status, cost.status]);
    }
  } else {
    notices.push('未配置金额预算，仅按字符/秒/次数展示。');
  }
  if (observed.unpricedCalls > 0 && !notices.some((notice) => notice.includes('未计价'))) {
    notices.push(`有 ${observed.unpricedCalls} 次未计价调用，金额不可用于预算判断。`);
  }
  if (status === 'exceeded') {
    notices.push('已达到 100% 预算阈值；当前仅告警，不阻断教学。');
  } else if (status === 'warning') {
    notices.push('已达到 80% 软告警阈值。');
  }

  return {
    scope,
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    status,
    enforcement: 'advisory',
    blocked: false,
    displayMode: cost ? 'cost_and_usage' : 'usage',
    metrics,
    cost,
    unpricedCalls: observed.unpricedCalls,
    notices,
  };
}

function parseLimits(value: unknown, field: string): UsageBudgetLimits {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new UsageBudgetConfigError(`${field} 必须是对象`);
  }
  const result: UsageBudgetLimits = {};
  for (const { key } of METRIC_DEFINITIONS) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      throw new UsageBudgetConfigError(`${field}.${key} 必须是正数`);
    }
    result[key] = raw;
  }
  return result;
}

function normalizeObserved(usage: UsageBudgetObserved): UsageBudgetObserved {
  return {
    calls: nonNegative(usage.calls),
    ttsCharacters: nonNegative(usage.ttsCharacters),
    asrSeconds: nonNegative(usage.asrSeconds),
    pronunciationCalls: nonNegative(usage.pronunciationCalls),
    estimatedCostCny: nonNegative(usage.estimatedCostCny),
    unpricedCalls: nonNegative(usage.unpricedCalls),
  };
}

function buildMetric(
  key: UsageBudgetMetricKey,
  label: string,
  usedInput: number,
  limit: number,
): UsageBudgetMetric {
  const used = nonNegative(usedInput);
  const ratio = used / limit;
  return {
    key,
    label,
    used,
    limit,
    ratio: Math.round(ratio * 10_000) / 10_000,
    status: ratio >= USAGE_BUDGET_EXCEEDED_RATIO
      ? 'exceeded'
      : ratio >= USAGE_BUDGET_WARNING_RATIO
        ? 'warning'
        : 'ok',
  };
}

function highestStatus(statuses: UsageBudgetStatus[]): UsageBudgetStatus {
  if (statuses.includes('exceeded')) return 'exceeded';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isPositiveLimit(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

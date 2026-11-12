'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminNav } from '../admin-nav';
import { AdminApiError, adminFetch } from '../admin-auth';

type TtsCacheStats = {
  entries: number;
  hitCharactersSaved: number;
  requests: number;
  cacheHits: number;
  coalesced: number;
  misses: number;
  hitRate: number;
  charactersSynthesized: number;
};

type CleanupStats = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scannedAudioFiles: number;
  scannedIndexFiles: number;
  scannedAssetRows: number;
  expiredAssetsDeleted: number;
  expiredIndexesDeleted: number;
  orphanAudioFilesDeleted: number;
  protectedAudioFiles: number;
  youngOrphanFilesSkipped: number;
  bytesFreed: number;
  indexScanIncomplete: boolean;
  orphanDeletionSkippedReason: string | null;
  errors: string[];
};

type MaintenanceStatus = {
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  orphanGraceMs: number;
  running: boolean;
  lastError: string | null;
  lastRun: CleanupStats | null;
};

type TtsCacheResponse = {
  cache?: Partial<TtsCacheStats>;
  maintenance?: Partial<MaintenanceStatus>;
};

type UsageMetrics = {
  calls: number;
  ttsCharacters: number;
  asrSeconds: number;
  pronunciationCalls: number;
  estimatedCostCny: number;
  unpricedCalls: number;
};

type UsageLearnerBucket = UsageMetrics & { learnerId: string | null };
type UsageTopicBucket = UsageMetrics & { topicId: string | null };
type UsageDayBucket = UsageMetrics & { date: string };

type UsageReport = {
  from: string;
  to: string;
  totals: UsageMetrics;
  byLearner: UsageLearnerBucket[];
  byTopic: UsageTopicBucket[];
  byDay: UsageDayBucket[];
  note: string;
};

type UsageCostResponse = {
  from?: string;
  to?: string;
  totals?: Partial<UsageMetrics>;
  byLearner?: Array<Partial<UsageMetrics> & { learnerId?: string | null }>;
  byTopic?: Array<Partial<UsageMetrics> & { topicId?: string | null }>;
  byDay?: Array<Partial<UsageMetrics> & { date?: string }>;
  note?: string;
};

type BudgetMetricKey =
  | 'ttsCharacters'
  | 'asrSeconds'
  | 'pronunciationCalls'
  | 'estimatedCostCny';

type BudgetLimits = Partial<Record<BudgetMetricKey, number>>;
type BudgetStatus = 'ok' | 'warning' | 'exceeded';

type BudgetMetric = {
  key: BudgetMetricKey;
  label: string;
  used: number;
  limit: number;
  ratio: number;
  status: BudgetStatus;
};

type UsageBudgetSnapshotResponse = {
  source?: string;
  enforcement?: string;
  thresholds?: { warning?: number; exceeded?: number };
  scopes?: {
    learnerDay?: { scope?: string; limits?: BudgetLimits };
    topicMonth?: { scope?: string; limits?: BudgetLimits };
  };
};

type UsageBudgetSnapshot = {
  source: string;
  enforcement: string;
  thresholds: { warning: number; exceeded: number };
  scopes: {
    learnerDay: { scope: string; limits: BudgetLimits };
    topicMonth: { scope: string; limits: BudgetLimits };
  };
};

type UsageBudgetEvaluationResponse = {
  scope?: string;
  window?: { from?: string; to?: string };
  status?: string;
  enforcement?: string;
  blocked?: boolean;
  displayMode?: string;
  metrics?: Array<Partial<BudgetMetric>>;
  cost?: Partial<BudgetMetric> | null;
  unpricedCalls?: number;
  notices?: string[];
};

type UsageBudgetEvaluation = {
  scope: string;
  window: { from: string; to: string };
  status: BudgetStatus;
  enforcement: string;
  blocked: boolean;
  displayMode: 'usage' | 'cost_and_usage';
  metrics: BudgetMetric[];
  cost: BudgetMetric | null;
  unpricedCalls: number;
  notices: string[];
};

type UsageFilters = {
  from: string;
  to: string;
  learnerId: string;
  topicId: string;
};

type LoadState = 'loading' | 'ready' | 'error';

const EMPTY_CACHE: TtsCacheStats = {
  entries: 0,
  hitCharactersSaved: 0,
  requests: 0,
  cacheHits: 0,
  coalesced: 0,
  misses: 0,
  hitRate: 0,
  charactersSynthesized: 0,
};

const EMPTY_MAINTENANCE: MaintenanceStatus = {
  enabled: false,
  intervalMs: 0,
  initialDelayMs: 0,
  orphanGraceMs: 0,
  running: false,
  lastError: null,
  lastRun: null,
};

const EMPTY_FILTERS: UsageFilters = {
  from: '',
  to: '',
  learnerId: '',
  topicId: '',
};

function emptyMetrics(): UsageMetrics {
  return {
    calls: 0,
    ttsCharacters: 0,
    asrSeconds: 0,
    pronunciationCalls: 0,
    estimatedCostCny: 0,
    unpricedCalls: 0,
  };
}

const EMPTY_USAGE: UsageReport = {
  from: '',
  to: '',
  totals: emptyMetrics(),
  byLearner: [],
  byTopic: [],
  byDay: [],
  note: '',
};

const BUDGET_METRIC_KEYS: BudgetMetricKey[] = [
  'ttsCharacters',
  'asrSeconds',
  'pronunciationCalls',
  'estimatedCostCny',
];

const EMPTY_BUDGET_SNAPSHOT: UsageBudgetSnapshot = {
  source: 'environment',
  enforcement: 'advisory',
  thresholds: { warning: 0.8, exceeded: 1 },
  scopes: {
    learnerDay: { scope: 'learner_day', limits: {} },
    topicMonth: { scope: 'topic_month', limits: {} },
  },
};

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function integer(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
}

function normalizeMetrics(value: Partial<UsageMetrics> | undefined): UsageMetrics {
  return {
    calls: integer(value?.calls),
    ttsCharacters: integer(value?.ttsCharacters),
    asrSeconds: Math.max(0, finite(value?.asrSeconds)),
    pronunciationCalls: integer(value?.pronunciationCalls),
    estimatedCostCny: Math.max(0, finite(value?.estimatedCostCny)),
    unpricedCalls: integer(value?.unpricedCalls),
  };
}

function normalizeUsage(value: UsageCostResponse | undefined): UsageReport {
  const source = value ?? {};
  return {
    from: typeof source.from === 'string' ? source.from : '',
    to: typeof source.to === 'string' ? source.to : '',
    totals: normalizeMetrics(source.totals),
    byLearner: Array.isArray(source.byLearner)
      ? source.byLearner.map((bucket) => ({
          ...normalizeMetrics(bucket),
          learnerId: typeof bucket.learnerId === 'string' ? bucket.learnerId : null,
        }))
      : [],
    byTopic: Array.isArray(source.byTopic)
      ? source.byTopic.map((bucket) => ({
          ...normalizeMetrics(bucket),
          topicId: typeof bucket.topicId === 'string' ? bucket.topicId : null,
        }))
      : [],
    byDay: Array.isArray(source.byDay)
      ? source.byDay.map((bucket) => ({
          ...normalizeMetrics(bucket),
          date: typeof bucket.date === 'string' ? bucket.date : '',
        }))
      : [],
    note: typeof source.note === 'string' ? source.note : '',
  };
}

function normalizeBudgetLimits(value: unknown): BudgetLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const limits: BudgetLimits = {};
  for (const key of BUDGET_METRIC_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) limits[key] = raw;
  }
  return limits;
}

function normalizeBudgetSnapshot(value: UsageBudgetSnapshotResponse | undefined): UsageBudgetSnapshot {
  const source = value ?? {};
  const warning = finite(source.thresholds?.warning);
  const exceeded = finite(source.thresholds?.exceeded);
  return {
    source: typeof source.source === 'string' ? source.source : 'environment',
    enforcement: typeof source.enforcement === 'string' ? source.enforcement : 'advisory',
    thresholds: {
      warning: warning > 0 ? warning : 0.8,
      exceeded: exceeded > 0 ? exceeded : 1,
    },
    scopes: {
      learnerDay: {
        scope: typeof source.scopes?.learnerDay?.scope === 'string'
          ? source.scopes.learnerDay.scope
          : 'learner_day',
        limits: normalizeBudgetLimits(source.scopes?.learnerDay?.limits),
      },
      topicMonth: {
        scope: typeof source.scopes?.topicMonth?.scope === 'string'
          ? source.scopes.topicMonth.scope
          : 'topic_month',
        limits: normalizeBudgetLimits(source.scopes?.topicMonth?.limits),
      },
    },
  };
}

function normalizeBudgetStatus(value: unknown): BudgetStatus {
  return value === 'warning' || value === 'exceeded' ? value : 'ok';
}

function normalizeBudgetMetric(value: Partial<BudgetMetric> | null | undefined): BudgetMetric | null {
  if (!value || !BUDGET_METRIC_KEYS.includes(value.key as BudgetMetricKey)) return null;
  const key = value.key as BudgetMetricKey;
  const used = Math.max(0, finite(value.used));
  const limit = Math.max(0, finite(value.limit));
  if (limit <= 0) return null;
  const ratio = typeof value.ratio === 'number' && Number.isFinite(value.ratio)
    ? Math.max(0, value.ratio)
    : used / limit;
  return {
    key,
    label: typeof value.label === 'string' ? value.label : budgetMetricLabel(key),
    used,
    limit,
    ratio,
    status: normalizeBudgetStatus(value.status),
  };
}

function normalizeBudgetEvaluation(
  value: UsageBudgetEvaluationResponse | null | undefined,
): UsageBudgetEvaluation | null {
  if (!value) return null;
  const displayMode = value.displayMode === 'cost_and_usage' ? 'cost_and_usage' : 'usage';
  const metrics = Array.isArray(value.metrics)
    ? value.metrics
        .map(normalizeBudgetMetric)
        .filter((metric): metric is BudgetMetric => Boolean(metric))
        .filter((metric) => metric.key !== 'estimatedCostCny')
    : [];
  const cost = displayMode === 'cost_and_usage' ? normalizeBudgetMetric(value.cost) : null;
  return {
    scope: typeof value.scope === 'string' ? value.scope : '',
    window: {
      from: typeof value.window?.from === 'string' ? value.window.from : '',
      to: typeof value.window?.to === 'string' ? value.window.to : '',
    },
    status: normalizeBudgetStatus(value.status),
    enforcement: typeof value.enforcement === 'string' ? value.enforcement : 'advisory',
    blocked: Boolean(value.blocked),
    displayMode,
    metrics,
    cost,
    unpricedCalls: integer(value.unpricedCalls),
    notices: Array.isArray(value.notices)
      ? value.notices.filter((notice): notice is string => typeof notice === 'string')
      : [],
  };
}

function normalizeCache(value: TtsCacheResponse['cache']): TtsCacheStats {
  const cache = value ?? {};
  return {
    entries: integer(cache.entries),
    hitCharactersSaved: integer(cache.hitCharactersSaved),
    requests: integer(cache.requests),
    cacheHits: integer(cache.cacheHits),
    coalesced: integer(cache.coalesced),
    misses: integer(cache.misses),
    hitRate: Math.min(1, Math.max(0, finite(cache.hitRate))),
    charactersSynthesized: integer(cache.charactersSynthesized),
  };
}

function normalizeMaintenance(value: TtsCacheResponse['maintenance']): MaintenanceStatus {
  const maintenance = value ?? {};
  return {
    enabled: Boolean(maintenance.enabled),
    intervalMs: integer(maintenance.intervalMs),
    initialDelayMs: integer(maintenance.initialDelayMs),
    orphanGraceMs: integer(maintenance.orphanGraceMs),
    running: Boolean(maintenance.running),
    lastError: typeof maintenance.lastError === 'string' ? maintenance.lastError : null,
    lastRun: maintenance.lastRun ?? null,
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(value)));
}

function formatPercent(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%`;
}

function formatCny(value: number): string {
  return `¥${new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(Math.max(0, finite(value)))}`;
}

function formatSeconds(value: number): string {
  return `${Math.max(0, finite(value)).toFixed(2)} 秒`;
}

function budgetMetricLabel(key: BudgetMetricKey): string {
  switch (key) {
    case 'ttsCharacters': return 'TTS 字符';
    case 'asrSeconds': return 'ASR 秒数';
    case 'pronunciationCalls': return '发音次数';
    case 'estimatedCostCny': return '估算金额';
  }
}

function formatBudgetValue(key: BudgetMetricKey, value: number): string {
  if (key === 'asrSeconds') return formatSeconds(value);
  if (key === 'estimatedCostCny') return formatCny(value);
  return formatInteger(value);
}

function formatBudgetRatio(value: number): string {
  return `${(Math.max(0, finite(value)) * 100).toFixed(1)}%`;
}

function budgetStatusText(status: BudgetStatus): string {
  if (status === 'exceeded') return '100% 超限';
  if (status === 'warning') return '80% 告警';
  return '正常';
}

function budgetStatusClass(status: BudgetStatus): string {
  return status === 'ok' ? '' : ` ${status}`;
}

function configuredUsageLimits(limits: BudgetLimits): Array<[BudgetMetricKey, number]> {
  return BUDGET_METRIC_KEYS
    .filter((key) => key !== 'estimatedCostCny')
    .map((key) => [key, limits[key]] as [BudgetMetricKey, number | undefined])
    .filter((entry): entry is [BudgetMetricKey, number] => entry[1] !== undefined && entry[1] > 0);
}

function hasAnyBudgetLimit(snapshot: UsageBudgetSnapshot): boolean {
  return BUDGET_METRIC_KEYS.some((key) =>
    Boolean(snapshot.scopes.learnerDay.limits[key] || snapshot.scopes.topicMonth.limits[key]),
  );
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, finite(value));
  if (bytes < 1024) return `${formatInteger(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(value: number): string {
  const ms = Math.max(0, finite(value));
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '尚未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间格式无效' : date.toLocaleString('zh-CN', { hour12: false });
}

function formatRange(from: string, to: string): string {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  const format = (value: Date | null) => value && !Number.isNaN(value.getTime())
    ? value.toLocaleString('zh-CN', { hour12: false })
    : '—';
  return `${format(start)} 至 ${format(end)}`;
}

function dateInputValue(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function defaultFilters(): UsageFilters {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return {
    from: dateInputValue(from),
    to: dateInputValue(to),
    learnerId: '',
    topicId: '',
  };
}

function validateFilters(filters: UsageFilters): string {
  if (!filters.from || !filters.to) return '请选择开始和结束日期。';
  const from = new Date(`${filters.from}T00:00:00`);
  const to = new Date(`${filters.to}T23:59:59.999`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return '日期格式无效，请重新选择。';
  }
  if (from > to) return '开始日期不能晚于结束日期。';
  if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
    return '日期范围不能超过 366 天。';
  }
  return '';
}

function buildUsagePath(filters: UsageFilters): string {
  const params = new URLSearchParams();
  const from = new Date(`${filters.from}T00:00:00`);
  const to = new Date(`${filters.to}T23:59:59.999`);
  if (!Number.isNaN(from.getTime())) params.set('from', from.toISOString());
  if (!Number.isNaN(to.getTime())) params.set('to', to.toISOString());
  const learnerId = filters.learnerId.trim();
  const topicId = filters.topicId.trim();
  if (learnerId) params.set('learnerId', learnerId);
  if (topicId) params.set('topicId', topicId);
  return `/usage/cost?${params.toString()}`;
}

function buildBudgetPath(scope: 'learner_day' | 'topic_month', value: string): string {
  const params = new URLSearchParams({ scope });
  params.set(scope === 'learner_day' ? 'learnerId' : 'topicId', value);
  return `/usage/budget/evaluate?${params.toString()}`;
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isSessionExpired(error: unknown): boolean {
  if (error instanceof AdminApiError) return error.status === 401 || error.status === 403;
  return error instanceof Error && error.message.includes('登录已失效');
}

type BudgetCardProps = {
  title: string;
  scope: string;
  entityLabel: string;
  limits: BudgetLimits;
  evaluation: UsageBudgetEvaluation | null;
  loading: boolean;
  error: string;
  missingHint: string;
  onRetry: () => void;
};

function BudgetMetricRow({ metric }: { metric: BudgetMetric }) {
  const width = Math.min(100, Math.max(0, finite(metric.ratio) * 100));
  return <div className="budget-metric">
    <div className="budget-metric-head">
      <span>{metric.label}</span>
      <strong>{formatBudgetValue(metric.key, metric.used)} / {formatBudgetValue(metric.key, metric.limit)}</strong>
    </div>
    <div
      className="budget-track"
      role="progressbar"
      aria-label={`${metric.label}预算使用率`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
    >
      <span className={`budget-fill ${metric.status}`} style={{ width: `${width}%` }} />
      <i className="budget-threshold" aria-hidden="true" />
    </div>
    <div className="budget-caption">
      <span className={metric.status === 'ok' ? '' : metric.status}>{budgetStatusText(metric.status)}</span>
      <span>{formatBudgetRatio(metric.ratio)}</span>
    </div>
  </div>;
}

function BudgetScopeCard({
  title,
  scope,
  entityLabel,
  limits,
  evaluation,
  loading,
  error,
  missingHint,
  onRetry,
}: BudgetCardProps) {
  const metrics = evaluation
    ? [...evaluation.metrics, ...(evaluation.cost ? [evaluation.cost] : [])]
    : [];
  const configured = configuredUsageLimits(limits);
  const hasEvaluation = Boolean(evaluation);
  const badgeClass = evaluation
    ? metrics.length === 0
      ? ''
      : budgetStatusClass(evaluation.status)
    : '';
  const badgeText = loading
    ? '读取中'
    : error
      ? '读取失败'
      : evaluation
        ? metrics.length === 0
          ? '未配置'
          : budgetStatusText(evaluation.status)
        : '待指定';

  return <article className="budget-card">
    <div className="budget-card-head">
      <div>
        <h3>{title}</h3>
        <p className="budget-scope"><code>{scope}</code><span>{entityLabel}</span></p>
      </div>
      <span className={`metric-badge${badgeClass}`}>{badgeText}</span>
    </div>

    {loading && <p className="status">正在读取预算评估…</p>}
    {!loading && error && <div className="feedback error" role="alert">
      {error}
      <button className="secondary" type="button" onClick={onRetry}>重试</button>
    </div>}

    {!loading && !error && hasEvaluation && evaluation && <>
      <p className="budget-window">窗口：{formatRange(evaluation.window.from, evaluation.window.to)}（终点不含）</p>
      {metrics.length > 0
        ? <div className="budget-metrics">{metrics.map((metric) => <BudgetMetricRow key={metric.key} metric={metric} />)}</div>
        : <p className="empty-state">该作用域未配置字符/秒/次数上限。</p>}
      {evaluation.unpricedCalls > 0 &&
        !evaluation.notices.some((notice) => notice.includes('未计价')) && <div className="feedback warn" role="status">
        有 {formatInteger(evaluation.unpricedCalls)} 次未计价调用；金额预算未参与判定，本卡只展示字符/秒/次数。
      </div>}
      {evaluation.notices.length > 0 && <ul className="budget-notices">
        {evaluation.notices.map((notice, index) => <li key={`${notice}-${index}`}>{notice}</li>)}
      </ul>}
      <p className="helper budget-advisory">
        {evaluation.enforcement === 'advisory' || !evaluation.blocked
          ? '当前为 advisory：达到阈值只告警，不阻断教学。'
          : '预算策略包含阻断，请以服务端策略为准。'}
      </p>
    </>}

    {!loading && !hasEvaluation && <>
      {configured.length > 0
        ? <div className="budget-limits">
            {configured.map(([key, limit]) => <div className="budget-limit-row" key={key}>
              <span>{budgetMetricLabel(key)}</span>
              <strong>{formatBudgetValue(key, limit)}</strong>
            </div>)}
          </div>
        : <p className="empty-state">该作用域未配置字符/秒/次数上限。</p>}
      {limits.estimatedCostCny !== undefined && <p className="helper">
        已配置金额上限；仅当评估窗口内没有未计价调用且金额可用于预算时才会展示金额。
      </p>}
      <p className="helper">{missingHint}</p>
    </>}
  </article>;
}

type UsageTableRow = UsageMetrics & { label: string };

function UsageTable({
  title,
  labelHeader,
  rows,
}: {
  title: string;
  labelHeader: string;
  rows: UsageTableRow[];
}) {
  return <div className="usage-table-block">
    <h3>{title}</h3>
    {rows.length === 0
      ? <p className="empty-state">暂无记录。</p>
      : <div className="table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th>{labelHeader}</th>
              <th>调用</th>
              <th>TTS 字符</th>
              <th>ASR 秒</th>
              <th>发音次数</th>
              <th>估算金额</th>
              <th>未计价</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => <tr key={`${row.label}-${index}`}>
              <td className="usage-label" title={row.label}>{row.label}</td>
              <td>{formatInteger(row.calls)}</td>
              <td>{formatInteger(row.ttsCharacters)}</td>
              <td>{formatSeconds(row.asrSeconds)}</td>
              <td>{formatInteger(row.pronunciationCalls)}</td>
              <td>{formatCny(row.estimatedCostCny)}</td>
              <td className={row.unpricedCalls > 0 ? 'usage-unpriced' : ''}>{formatInteger(row.unpricedCalls)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
  </div>;
}

export default function CostsPage() {
  const [cache, setCache] = useState<TtsCacheStats>(EMPTY_CACHE);
  const [maintenance, setMaintenance] = useState<MaintenanceStatus>(EMPTY_MAINTENANCE);
  const [usage, setUsage] = useState<UsageReport>(EMPTY_USAGE);
  const [budgetSnapshot, setBudgetSnapshot] = useState<UsageBudgetSnapshot>(EMPTY_BUDGET_SNAPSHOT);
  const [learnerBudget, setLearnerBudget] = useState<UsageBudgetEvaluation | null>(null);
  const [topicBudget, setTopicBudget] = useState<UsageBudgetEvaluation | null>(null);
  const [filters, setFilters] = useState<UsageFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<UsageFilters | null>(null);
  const [filterError, setFilterError] = useState('');
  const [cacheState, setCacheState] = useState<LoadState>('loading');
  const [usageState, setUsageState] = useState<LoadState>('loading');
  const [budgetState, setBudgetState] = useState<LoadState>('loading');
  const [cacheMessage, setCacheMessage] = useState('');
  const [usageMessage, setUsageMessage] = useState('');
  const [budgetMessage, setBudgetMessage] = useState('');
  const [learnerBudgetError, setLearnerBudgetError] = useState('');
  const [topicBudgetError, setTopicBudgetError] = useState('');
  const [loadedAt, setLoadedAt] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const sessionExpiredRef = useRef(false);

  const load = useCallback(async () => {
    if (!appliedFilters) return;
    const seq = ++requestSeqRef.current;
    if (mountedRef.current) {
      setCacheState('loading');
      setUsageState('loading');
      setBudgetState('loading');
      setCacheMessage('');
      setUsageMessage('');
      setBudgetMessage('');
      setLearnerBudgetError('');
      setTopicBudgetError('');
      setLearnerBudget(null);
      setTopicBudget(null);
    }
    const learnerId = appliedFilters.learnerId.trim();
    const topicId = appliedFilters.topicId.trim();
    const [cacheResult, usageResult, budgetResult, learnerBudgetResult, topicBudgetResult] = await Promise.allSettled([
      adminFetch<TtsCacheResponse>('/tts-cache'),
      adminFetch<UsageCostResponse>(buildUsagePath(appliedFilters)),
      adminFetch<UsageBudgetSnapshotResponse>('/usage/budget'),
      learnerId
        ? adminFetch<UsageBudgetEvaluationResponse>(buildBudgetPath('learner_day', learnerId))
        : Promise.resolve(null),
      topicId
        ? adminFetch<UsageBudgetEvaluationResponse>(buildBudgetPath('topic_month', topicId))
        : Promise.resolve(null),
    ]);
    if (!mountedRef.current || seq !== requestSeqRef.current) return;

    let expired = false;
    if (cacheResult.status === 'fulfilled') {
      setCache(normalizeCache(cacheResult.value.cache));
      setMaintenance(normalizeMaintenance(cacheResult.value.maintenance));
      setCacheState('ready');
    } else {
      expired = expired || isSessionExpired(cacheResult.reason);
      setCacheState('error');
      setCacheMessage(readableError(cacheResult.reason, '读取 TTS 进程缓存指标失败'));
    }

    if (usageResult.status === 'fulfilled') {
      setUsage(normalizeUsage(usageResult.value));
      setUsageState('ready');
    } else {
      expired = expired || isSessionExpired(usageResult.reason);
      setUsageState('error');
      setUsageMessage(readableError(usageResult.reason, '读取账本用量失败'));
    }

    if (budgetResult.status === 'fulfilled') {
      setBudgetSnapshot(normalizeBudgetSnapshot(budgetResult.value));
      setBudgetState('ready');
    } else {
      expired = expired || isSessionExpired(budgetResult.reason);
      setBudgetState('error');
      setBudgetMessage(readableError(budgetResult.reason, '读取预算快照失败'));
    }

    if (learnerBudgetResult.status === 'fulfilled') {
      setLearnerBudget(normalizeBudgetEvaluation(learnerBudgetResult.value));
    } else {
      expired = expired || isSessionExpired(learnerBudgetResult.reason);
      setLearnerBudgetError(readableError(learnerBudgetResult.reason, '读取 learner/day 预算失败'));
    }

    if (topicBudgetResult.status === 'fulfilled') {
      setTopicBudget(normalizeBudgetEvaluation(topicBudgetResult.value));
    } else {
      expired = expired || isSessionExpired(topicBudgetResult.reason);
      setTopicBudgetError(readableError(topicBudgetResult.reason, '读取 topic/month 预算失败'));
    }

    sessionExpiredRef.current = expired;
    setSessionExpired(expired);
    if (
      cacheResult.status === 'fulfilled' ||
      usageResult.status === 'fulfilled' ||
      budgetResult.status === 'fulfilled' ||
      learnerBudgetResult.status === 'fulfilled' ||
      topicBudgetResult.status === 'fulfilled'
    ) {
      setLoadedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
    }
  }, [appliedFilters]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const initial = defaultFilters();
    setFilters(initial);
    setAppliedFilters(initial);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const retryAfterReauth = () => {
      if (document.visibilityState !== 'hidden' && sessionExpiredRef.current) void load();
    };
    window.addEventListener('focus', retryAfterReauth);
    document.addEventListener('visibilitychange', retryAfterReauth);
    return () => {
      window.removeEventListener('focus', retryAfterReauth);
      document.removeEventListener('visibilitychange', retryAfterReauth);
    };
  }, [load]);

  function applyFilters() {
    const error = validateFilters(filters);
    setFilterError(error);
    if (error) return;
    setAppliedFilters({
      ...filters,
      learnerId: filters.learnerId.trim(),
      topicId: filters.topicId.trim(),
    });
  }

  function resetFilters() {
    const next = defaultFilters();
    setFilters(next);
    setAppliedFilters(next);
    setFilterError('');
  }

  const avoided = cache.cacheHits + cache.coalesced;
  const averageSynthesisCharacters = cache.misses > 0
    ? cache.charactersSynthesized / cache.misses
    : null;
  const lastRun = maintenance.lastRun;
  const cacheBarWidth = `${(cache.hitRate * 100).toFixed(1)}%`;
  const busy = cacheState === 'loading' || usageState === 'loading' || budgetState === 'loading';
  const learnerId = appliedFilters?.learnerId.trim() ?? '';
  const topicId = appliedFilters?.topicId.trim() ?? '';
  const budgetConfigured = hasAnyBudgetLimit(budgetSnapshot);
  const learnerRows: UsageTableRow[] = usage.byLearner.map((bucket) => ({
    ...bucket,
    label: bucket.learnerId ?? '未归属学习者',
  }));
  const topicRows: UsageTableRow[] = usage.byTopic.map((bucket) => ({
    ...bucket,
    label: bucket.topicId ?? '未关联主题',
  }));
  const dayRows: UsageTableRow[] = usage.byDay.map((bucket) => ({
    ...bucket,
    label: bucket.date || '日期未知',
  }));

  return <main className="shell costs-page">
    <AdminNav />
    <header className="topbar">
      <div>
        <p className="eyebrow">COST & CACHE</p>
        <h1>成本与缓存</h1>
        <p className="muted">历史账本用量与当前进程缓存分开查看；本页只读，不提供清理、改价或写入操作。</p>
      </div>
      <button className="secondary" type="button" disabled={busy || !appliedFilters} onClick={() => void load()}>
        {busy ? '读取中…' : '刷新数据'}
      </button>
    </header>

    {sessionExpired && <div className="feedback error" role="alert">
      管理登录已失效，请重新登录后再查看成本指标。
      <div className="row-actions">
        <button className="secondary" type="button" onClick={() => void load()}>重试读取</button>
        <button type="button" onClick={() => window.location.reload()}>重新登录</button>
      </div>
    </div>}

    <div className="costs-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>账本筛选</h2>
            <p className="muted">按日期范围查询历史账本；学习者与主题可留空。结束日期按当天 23:59:59 提交。</p>
          </div>
          <span className="metric-badge">只读</span>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
          <div className="filter-grid">
            <label>开始日期<input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
            <label>结束日期<input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
            <label>learnerId<input value={filters.learnerId} placeholder="可选，精确匹配" onChange={(event) => setFilters({ ...filters, learnerId: event.target.value })} /></label>
            <label>topicId<input value={filters.topicId} placeholder="可选，精确匹配" onChange={(event) => setFilters({ ...filters, topicId: event.target.value })} /></label>
          </div>
          <div className="filter-actions">
            <button type="submit" disabled={busy}>应用筛选</button>
            <button className="secondary" type="button" onClick={resetFilters}>恢复默认范围</button>
            {loadedAt && <span className="status">最近读取：{loadedAt}</span>}
          </div>
        </form>
        {filterError && <div className="feedback error" role="alert">{filterError}</div>}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">USAGE BUDGET</p>
            <h2>用量预算</h2>
            <p className="muted">读取环境变量配置快照，并按当前 UTC 自然日 / 自然月评估；80% 软告警、100% 超限告警，当前不阻断教学。</p>
          </div>
          <span className={`metric-badge ${budgetState === 'error' ? 'warn' : ''}`}>
            {budgetState === 'loading'
              ? '读取中'
              : budgetState === 'error'
                ? '读取失败'
                : budgetConfigured
                  ? 'advisory'
                  : '未配置'}
          </span>
        </div>

        {budgetState === 'error' && !sessionExpired && <div className="feedback error" role="alert">
          {budgetMessage || '读取预算快照失败。'}
          <button className="secondary" type="button" onClick={() => void load()}>重试</button>
        </div>}
        {budgetState === 'ready' && !budgetConfigured && <div className="feedback warn" role="status">
          <code>USAGE_BUDGET_CONFIG_JSON</code> 未配置 learner/day 或 topic/month 限额；页面只显示配置状态，不会把 0 元当作免费额度。
        </div>}

        <div className="cost-summary budget-summary">
          <div className="cost-stat"><span>配置来源</span><strong>{budgetSnapshot.source === 'environment' ? '环境变量' : budgetSnapshot.source}</strong></div>
          <div className="cost-stat"><span>告警阈值</span><strong>{formatBudgetRatio(budgetSnapshot.thresholds.warning)} / {formatBudgetRatio(budgetSnapshot.thresholds.exceeded)}</strong></div>
          <div className="cost-stat"><span>执行方式</span><strong>{budgetSnapshot.enforcement === 'advisory' ? '仅告警，不阻断' : budgetSnapshot.enforcement}</strong></div>
          <div className="cost-stat"><span>已指定对象</span><strong>{learnerId ? 'learnerId 已填写' : 'learnerId 待填写'} / {topicId ? 'topicId 已填写' : 'topicId 待填写'}</strong></div>
        </div>

        <div className="budget-grid">
          <BudgetScopeCard
            title="learner / day"
            scope="learner_day"
            entityLabel={learnerId ? `learnerId: ${learnerId}` : '未指定 learnerId'}
            limits={budgetSnapshot.scopes.learnerDay.limits}
            evaluation={learnerBudget}
            loading={budgetState === 'loading'}
            error={learnerBudgetError}
            missingHint="在筛选区填写 learnerId 并应用筛选后，读取该学习者当前 UTC 自然日的用量。"
            onRetry={() => void load()}
          />
          <BudgetScopeCard
            title="topic / month"
            scope="topic_month"
            entityLabel={topicId ? `topicId: ${topicId}` : '未指定 topicId'}
            limits={budgetSnapshot.scopes.topicMonth.limits}
            evaluation={topicBudget}
            loading={budgetState === 'loading'}
            error={topicBudgetError}
            missingHint="在筛选区填写 topicId 并应用筛选后，读取该主题当前 UTC 自然月的用量。"
            onRetry={() => void load()}
          />
        </div>

        <p className="helper">预算窗口固定为当前 UTC 自然日 / 自然月，不受上方账本日期范围影响。存在未计价调用或未配置金额上限时，预算卡只展示字符/秒/次数；advisory 状态下 100% 也只告警。</p>
      </section>

      <div className="cost-columns">
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">USAGE LEDGER</p>
              <h2>账本用量</h2>
              <p className="muted">来自历史账本聚合，跨进程保留；与右侧进程缓存指标不相加。</p>
            </div>
            <span className={`metric-badge ${usage.totals.unpricedCalls > 0 ? 'warn' : ''}`}>
              {usageState === 'loading' ? '读取中' : usage.totals.unpricedCalls > 0 ? '含未计价' : '已计价'}
            </span>
          </div>

          {usageState === 'error' && !sessionExpired && <div className="feedback error" role="alert">
            {usageMessage || '读取账本用量失败。'}
            <button className="secondary" type="button" onClick={() => void load()}>重试</button>
          </div>}
          {usageState === 'loading' && <p className="status">正在读取账本用量…</p>}

          {usageState === 'ready' && <>
            <div className="cost-grid ledger-grid">
              <article className="metric-card accent">
                <span>调用次数</span>
                <strong>{formatInteger(usage.totals.calls)}</strong>
                <small>该范围内的账本行数，包含全部计量类型。</small>
              </article>
              <article className="metric-card">
                <span>TTS 字符</span>
                <strong>{formatInteger(usage.totals.ttsCharacters)}</strong>
                <small>实际入账的合成字符数。</small>
              </article>
              <article className="metric-card">
                <span>ASR 秒数</span>
                <strong>{formatSeconds(usage.totals.asrSeconds)}</strong>
                <small>语音识别实际消耗秒数。</small>
              </article>
              <article className="metric-card">
                <span>发音评测次数</span>
                <strong>{formatInteger(usage.totals.pronunciationCalls)}</strong>
                <small>发音评测实际调用次数。</small>
              </article>
              <article className="metric-card">
                <span>估算金额</span>
                <strong>{formatCny(usage.totals.estimatedCostCny)}</strong>
                <small>按账本 estimatedCostCny 累加，不等于财务结算金额。</small>
              </article>
              <article className={`metric-card ${usage.totals.unpricedCalls > 0 ? 'warn' : ''}`}>
                <span>未计价调用</span>
                <strong>{formatInteger(usage.totals.unpricedCalls)}</strong>
                <small>有计量单位但缺少模型或对应价格类型；0 元不等于免费。</small>
              </article>
            </div>
            <p className="helper">查询范围：{formatRange(usage.from, usage.to)}（终点不含）。金额为 0 可能是未计价，请结合 `unpricedCalls` 判断。</p>
            {usage.totals.unpricedCalls > 0 && <div className="feedback warn" role="status">
              本范围有 {formatInteger(usage.totals.unpricedCalls)} 次调用未匹配价格，估算金额可能偏低；不会自动补价或写入账本。
            </div>}
          </>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">PROCESS CACHE</p>
              <h2>进程 TTS 缓存</h2>
              <p className="muted">当前后端进程的缓存效率；重启归零，不与历史账本相加。</p>
            </div>
            <span className="metric-badge">当前进程</span>
          </div>

          {cacheState === 'error' && !sessionExpired && <div className="feedback error" role="alert">
            {cacheMessage || '读取 TTS 进程缓存指标失败。'}
            <button className="secondary" type="button" onClick={() => void load()}>重试</button>
          </div>}
          {cacheState === 'loading' && <p className="status">正在读取进程缓存指标…</p>}

          {cacheState === 'ready' && <>
            <div className="cost-grid ledger-grid">
              <article className="metric-card accent">
                <span>缓存命中率</span>
                <strong>{formatPercent(cache.hitRate)}</strong>
                <div className="cache-bar" aria-hidden="true"><span style={{ width: cacheBarWidth }} /></div>
                <small>命中 + 合并 {formatInteger(avoided)} 次 / 总请求 {formatInteger(cache.requests)} 次</small>
              </article>
              <article className="metric-card">
                <span>实际合成字符</span>
                <strong>{formatInteger(cache.charactersSynthesized)}</strong>
                <small>缓存命中不重复送供应商；进程启动以来累计。</small>
              </article>
              <article className="metric-card">
                <span>未命中 / 总请求</span>
                <strong>{formatInteger(cache.misses)} / {formatInteger(cache.requests)}</strong>
                <small>未命中才会触发供应商合成。</small>
              </article>
              <article className="metric-card">
                <span>当前缓存条目</span>
                <strong>{formatInteger(cache.entries)}</strong>
                <small>进程内保留的课程级音频索引。</small>
              </article>
            </div>
            <p className="helper">进程指标只描述当前进程，不能与账本历史金额或字符数相加；单次合成字符均摊为 {averageSynthesisCharacters === null ? '—' : `${formatInteger(averageSynthesisCharacters)} 字符`}。</p>
          </>}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>账本明细</h2>
            <p className="muted">按 learner / topic / day 三个维度分别展示；topic 取 lesson_sessions.topicId，未关联会话单列为空。</p>
          </div>
          <span className="metric-badge">只读</span>
        </div>

        {usageState === 'loading' && <p className="status">正在读取账本明细…</p>}
        {usageState === 'error' && !sessionExpired && <div className="feedback error" role="alert">
          {usageMessage || '读取账本明细失败。'}
          <button className="secondary" type="button" onClick={() => void load()}>重试</button>
        </div>}
        {usageState === 'ready' && (usage.totals.calls === 0
          ? <p className="empty-state">该时间范围内没有账本记录；可以调整日期或留空过滤条件后重试。</p>
          : <div className="usage-tables">
            <UsageTable title="按学习者" labelHeader="learnerId" rows={learnerRows} />
            <UsageTable title="按课程主题" labelHeader="topicId" rows={topicRows} />
          </div>)}
        {usageState === 'ready' && usage.byDay.length > 0 && <UsageTable title="按日期（UTC）" labelHeader="日期" rows={dayRows} />}
        {usageState === 'ready' && usage.note && <p className="helper">账本口径：{usage.note}</p>}
      </section>

      {cacheState === 'ready' && <>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>进程请求明细</h2>
              <p className="muted">以下值均为当前后端进程的累计值，不包含历史重启前数据。</p>
            </div>
          </div>
          <div className="cost-summary">
            <div className="cost-stat"><span>总请求</span><strong>{formatInteger(cache.requests)}</strong></div>
            <div className="cost-stat"><span>缓存命中</span><strong>{formatInteger(cache.cacheHits)}</strong></div>
            <div className="cost-stat"><span>并发合并</span><strong>{formatInteger(cache.coalesced)}</strong></div>
            <div className="cost-stat"><span>未命中 / 实际合成</span><strong>{formatInteger(cache.misses)}</strong></div>
            <div className="cost-stat"><span>缓存条目字符总量</span><strong>{formatInteger(cache.hitCharactersSaved)}</strong></div>
            <div className="cost-stat"><span>避免重复合成</span><strong>{formatInteger(avoided)}</strong></div>
          </div>
          <p className="helper">「缓存条目字符总量」是当前缓存中保留内容的字符量，不是按命中次数累计的节省量；真实节省需结合每次命中的文本长度。</p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>缓存清理</h2>
              <p className="muted">默认每 6 小时执行一次，启动 10 分钟后首跑；仅清理到期资产、到期索引和无引用孤儿音频。</p>
            </div>
            <span className={`metric-badge ${maintenance.running ? 'warn' : ''}`}>
              {maintenance.running ? '清理中' : maintenance.enabled ? '已启用' : '已停用'}
            </span>
          </div>

          {maintenance.lastError && <div className="feedback warn" role="status">最近一次维护错误：{maintenance.lastError}</div>}
          {lastRun?.indexScanIncomplete && <div className="feedback warn" role="status">最近一次索引扫描不完整，本轮已跳过孤儿音频删除。</div>}
          {lastRun?.orphanDeletionSkippedReason && <div className="feedback warn" role="status">孤儿音频删除被跳过：{lastRun.orphanDeletionSkippedReason}</div>}

          <div className="cost-summary">
            <div className="cost-stat"><span>运行状态</span><strong>{maintenance.enabled ? '已启用' : '已停用'}</strong></div>
            <div className="cost-stat"><span>执行间隔</span><strong>{maintenance.intervalMs ? formatDuration(maintenance.intervalMs) : '—'}</strong></div>
            <div className="cost-stat"><span>孤儿宽限期</span><strong>{maintenance.orphanGraceMs ? `${Math.round(maintenance.orphanGraceMs / 86_400_000)} 天` : '—'}</strong></div>
            <div className="cost-stat"><span>最近清理</span><strong>{lastRun ? formatDate(lastRun.finishedAt || lastRun.startedAt) : maintenance.running ? '执行中' : '尚未执行'}</strong></div>
            <div className="cost-stat"><span>执行耗时</span><strong>{lastRun ? formatDuration(lastRun.durationMs) : '—'}</strong></div>
            <div className="cost-stat"><span>释放空间</span><strong>{lastRun ? formatBytes(lastRun.bytesFreed) : '—'}</strong></div>
            <div className="cost-stat"><span>到期资产 / 索引</span><strong>{lastRun ? `${formatInteger(lastRun.expiredAssetsDeleted)} / ${formatInteger(lastRun.expiredIndexesDeleted)}` : '—'}</strong></div>
            <div className="cost-stat"><span>孤儿音频删除</span><strong>{lastRun ? formatInteger(lastRun.orphanAudioFilesDeleted) : '—'}</strong></div>
            <div className="cost-stat"><span>保护音频</span><strong>{lastRun ? formatInteger(lastRun.protectedAudioFiles) : '—'}</strong></div>
            <div className="cost-stat"><span>扫描音频 / 索引 / 资产</span><strong>{lastRun ? `${formatInteger(lastRun.scannedAudioFiles)} / ${formatInteger(lastRun.scannedIndexFiles)} / ${formatInteger(lastRun.scannedAssetRows)}` : '—'}</strong></div>
          </div>

          {lastRun?.errors?.length ? <div className="feedback error" role="alert">
            <strong>最近清理有 {lastRun.errors.length} 条错误</strong>
            <span>{lastRun.errors.slice(0, 3).join('；')}</span>
          </div> : null}

          <p className="helper">公共课程语音（PUBLIC_CURRICULUM）与发音资源（PRONUNCIATION）不会按 TTL 删除；索引损坏或数据库删除失败时会跳过音频删除。</p>
        </section>
      </>}
    </div>
  </main>;
}

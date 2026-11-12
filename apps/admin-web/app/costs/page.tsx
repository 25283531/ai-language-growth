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

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isSessionExpired(error: unknown): boolean {
  if (error instanceof AdminApiError) return error.status === 401 || error.status === 403;
  return error instanceof Error && error.message.includes('登录已失效');
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
  const [filters, setFilters] = useState<UsageFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<UsageFilters | null>(null);
  const [filterError, setFilterError] = useState('');
  const [cacheState, setCacheState] = useState<LoadState>('loading');
  const [usageState, setUsageState] = useState<LoadState>('loading');
  const [cacheMessage, setCacheMessage] = useState('');
  const [usageMessage, setUsageMessage] = useState('');
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
      setCacheMessage('');
      setUsageMessage('');
    }
    const [cacheResult, usageResult] = await Promise.allSettled([
      adminFetch<TtsCacheResponse>('/tts-cache'),
      adminFetch<UsageCostResponse>(buildUsagePath(appliedFilters)),
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

    sessionExpiredRef.current = expired;
    setSessionExpired(expired);
    if (cacheResult.status === 'fulfilled' || usageResult.status === 'fulfilled') {
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
  const busy = cacheState === 'loading' || usageState === 'loading';
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

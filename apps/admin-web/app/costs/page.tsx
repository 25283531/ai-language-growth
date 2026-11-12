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

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function integer(value: unknown): number {
  return Math.max(0, Math.round(finite(value)));
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

export default function CostsPage() {
  const [cache, setCache] = useState<TtsCacheStats>(EMPTY_CACHE);
  const [maintenance, setMaintenance] = useState<MaintenanceStatus>(EMPTY_MAINTENANCE);
  const [loadedAt, setLoadedAt] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [message, setMessage] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const sessionExpiredRef = useRef(false);

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    if (mountedRef.current) {
      setLoadState('loading');
      setMessage('');
    }
    try {
      const body = await adminFetch<TtsCacheResponse>('/tts-cache');
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      setCache(normalizeCache(body.cache));
      setMaintenance(normalizeMaintenance(body.maintenance));
      setLoadedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
      sessionExpiredRef.current = false;
      setSessionExpired(false);
      setLoadState('ready');
    } catch (error) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      const text = error instanceof Error ? error.message : '读取 TTS 成本与缓存指标失败';
      const expired = error instanceof AdminApiError
        ? error.status === 401 || error.status === 403
        : text.includes('登录已失效');
      sessionExpiredRef.current = expired;
      setSessionExpired(expired);
      setLoadState('error');
      setMessage(text);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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

  const avoided = cache.cacheHits + cache.coalesced;
  const averageSynthesisCharacters = cache.misses > 0
    ? cache.charactersSynthesized / cache.misses
    : null;
  const lastRun = maintenance.lastRun;
  const cacheBarWidth = `${(cache.hitRate * 100).toFixed(1)}%`;

  return <main className="shell costs-page">
    <AdminNav />
    <header className="topbar">
      <div>
        <p className="eyebrow">COST & CACHE</p>
        <h1>成本与缓存</h1>
        <p className="muted">只读查看 TTS 进程内指标与音频缓存清理状态。本页不提供清理、改价或写入操作。</p>
      </div>
      <button className="secondary" type="button" disabled={loadState === 'loading'} onClick={() => void load()}>
        {loadState === 'loading' ? '读取中…' : '刷新指标'}
      </button>
    </header>

    {loadState === 'error' && <div className="feedback error" role="alert">
      {sessionExpired ? '管理登录已失效，请重新登录后再查看成本指标。' : (message || '读取 TTS 成本与缓存指标失败。')}
      <div className="row-actions">
        <button className="secondary" type="button" onClick={() => void load()}>重试读取</button>
        {sessionExpired && <button type="button" onClick={() => window.location.reload()}>重新登录</button>}
      </div>
    </div>}

    {loadState === 'loading' && !loadedAt ? <section className="panel">
      <p className="status">正在读取 TTS 成本与缓存指标…</p>
    </section> : null}

    {loadedAt ? <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>缓存效率</h2>
            <p className="muted">命中率包含缓存命中与 single-flight 合并请求；进程重启后归零。</p>
          </div>
          <span className="metric-badge">只读</span>
        </div>
        <div className="cost-grid">
          <article className="metric-card accent">
            <span>缓存命中率</span>
            <strong>{formatPercent(cache.hitRate)}</strong>
            <div className="cache-bar" aria-hidden="true"><span style={{ width: cacheBarWidth }} /></div>
            <small>命中 + 合并 {formatInteger(avoided)} 次 / 总请求 {formatInteger(cache.requests)} 次</small>
          </article>
          <article className="metric-card">
            <span>单课成本（估算）</span>
            <strong>{averageSynthesisCharacters === null ? '—' : `${formatInteger(averageSynthesisCharacters)} 字符`}</strong>
            <small>
              {averageSynthesisCharacters === null
                ? '尚无实际合成记录，无法计算均摊。'
                : '按实际合成字符 ÷ 合成次数均摊；接口无课程维度和单价，金额不估算。'}
            </small>
          </article>
          <article className="metric-card">
            <span>实际合成字符</span>
            <strong>{formatInteger(cache.charactersSynthesized)}</strong>
            <small>缓存命中不重复计费；这是进程启动以来实际送供应商合成的字符数。</small>
          </article>
          <article className="metric-card">
            <span>当前缓存条目</span>
            <strong>{formatInteger(cache.entries)}</strong>
            <small>进程内保留的课程级音频索引；磁盘清理不会改变本页历史计数。</small>
          </article>
        </div>
        <p className="helper cost-formula">单课成本估算口径：实际合成字符 ÷ 未命中次数。当前接口没有 lessonId / 课程数，不能据此推导真实财务整课成本，因此金额列不估算。</p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>请求与计费明细</h2>
            <p className="muted">所有值均为当前后端进程的累计值，不包含历史重启前数据。</p>
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

        <p className="helper">当前数据读取时间：{loadedAt || '—'}。公共课程语音（PUBLIC_CURRICULUM）与发音资源（PRONUNCIATION）不会按 TTL 删除；索引损坏或数据库删除失败时会跳过音频删除。</p>
      </section>
    </> : null}
  </main>;
}
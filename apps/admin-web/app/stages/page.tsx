'use client';

import { useState } from 'react';
import { AdminNav } from '../admin-nav';
import { adminFetch, AdminApiError } from '../admin-auth';

const DOMAINS = [
  { key: 'listening', label: '听力' },
  { key: 'pronunciation', label: '发音' },
  { key: 'vocabulary', label: '词汇' },
  { key: 'grammar', label: '语法' },
  { key: 'speaking', label: '口语' },
  { key: 'communication', label: '交流' },
  { key: 'schoolEnglish', label: '学校英语' },
] as const;

type StageProfile = {
  learnerId: string;
  stages: Record<(typeof DOMAINS)[number]['key'], number>;
  stageNodeCounts: Record<string, number>;
  evidenceCounts: Record<string, number>;
  computedAt: string;
};

function readableError(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  return error instanceof Error ? error.message : '读取阶段画像失败';
}

export default function StagesPage() {
  const [learnerId, setLearnerId] = useState('');
  const [profile, setProfile] = useState<StageProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const id = learnerId.trim();
    if (!id || loading) return;
    setLoading(true);
    setError('');
    try {
      const body = await adminFetch<StageProfile>(
        `/curriculum/learners/${encodeURIComponent(id)}/stages`,
      );
      setProfile(body);
    } catch (caught) {
      setProfile(null);
      setError(readableError(caught));
    } finally {
      setLoading(false);
    }
  }

  return <main className="shell">
    <AdminNav />
    <header className="topbar">
      <div>
        <p className="eyebrow">STAGE PROFILE</p>
        <h1>七领域阶段画像</h1>
        <p className="muted">听力、发音、词汇、语法、口语、交流、学校英语分别计算。阶段只作展示与规划参考，不是课程解锁门槛，也不存在“总等级”。</p>
      </div>
    </header>

    <section className="panel">
      <div className="fields">
        <label>
          学习者 ID
          <input
            value={learnerId}
            onChange={(event) => { setLearnerId(event.target.value); setProfile(null); setError(''); }}
            placeholder="从学习者档案中复制 ID"
          />
          <small>输入后点击「读取阶段画像」；空结果不代表加载失败。</small>
        </label>
        <div className="row-actions" style={{ alignItems: 'flex-start' }}>
          <button className="secondary" type="button" disabled={!learnerId.trim() || loading} onClick={() => void load()}>
            {loading ? '读取中…' : '读取阶段画像'}
          </button>
        </div>
      </div>

      {error && <div className="feedback error" role="alert">{error}</div>}
      {loading && <p className="status">正在按能力节点与证据聚合七个领域…</p>}

      {profile && <>
        <p className="status">
          学习者 {profile.learnerId} · 计算时间 {new Date(profile.computedAt).toLocaleString('zh-CN', { hour12: false })}
        </p>
        <div className="stage-grid">
          {DOMAINS.map((domain) => {
            const stage = profile.stages[domain.key] ?? 0;
            const nodeCount = profile.stageNodeCounts[domain.key] ?? 0;
            const evidenceCount = profile.evidenceCounts[domain.key] ?? 0;
            return <div className="stage-row" key={domain.key}>
              <div className="stage-head">
                <strong>{domain.label}</strong>
                <span>{stage === 0 ? '尚未开始' : `阶段 ${stage}`}</span>
              </div>
              <div className="stage-track" role="img" aria-label={`${domain.label}阶段 ${stage}，共 6 阶段`}>
                <div className="stage-fill" style={{ width: `${Math.min(100, Math.max(0, stage / 6 * 100))}%` }} />
              </div>
              <div className="stage-meta">
                当前阶段 {nodeCount} 个能力节点 · 累计 {evidenceCount} 条证据
              </div>
            </div>;
          })}
        </div>
        <p className="helper">某领域阶段低不会阻塞其他领域：课程可排性仍由活动自身能力节点的硬前置决定。阶段不写掌握状态，证据只读聚合。</p>
      </>}

      {!profile && !loading && !error && <p className="helper">尚未读取。该页面不会自动列出全部学习者，必须输入已知 ID。</p>}
    </section>
  </main>;
}

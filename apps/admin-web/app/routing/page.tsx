'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminNav } from '../admin-nav';

type Level = 'L0' | 'L1' | 'L2' | 'L3';
type Endpoint = { providerAlias: string; modelAlias: string; level: Level };
type RouteRule = {
  taskRoute: string;
  primary: Endpoint;
  fallback: Endpoint[];
  maxConcurrency: number;
  dailyBudgetCny: number;
  enabled: boolean;
};
type Routing = {
  rules: RouteRule[];
  escalationTargets: Record<string, Record<string, Level>>;
  fallbackOrder: Level[];
};
type ProviderConfig = { id: string; serviceKind: string; providerName: string; modelAlias: string; enabled: boolean; priority: number; options?: Record<string, unknown> };

const levelNames: Record<Level, string> = {
  L0: '免费或本地',
  L1: '低成本',
  L2: '标准质量',
  L3: '高质量',
};
const routeNames: Record<string, string> = {
  'llm.simple_dialogue': '简单教学对话',
  'llm.teaching_explanation': '知识讲解',
  'llm.method_adaptation': '教学方式调整',
  'llm.learning_plan': '学习计划与课程生成',
  'llm.growth_report': '成长报告',
  'llm.memory_extraction': '学习记忆整理',
  'llm.personality_adjustment': '教师性格调整',
  'tts.fixed_course': '固定课程语音',
  'tts.dynamic_teaching': '动态教学语音',
  'tts.narrative': '故事语音',
  'asr.free_speech': '自由表达识别',
  'asr.follow_read': '跟读转写',
  'pronunciation.word': '单词发音评测',
  'pronunciation.phoneme': '音素级发音评测',
};
const signalNames: Record<string, string> = {
  low_confidence: '识别或评测信心不足',
  repeated_failure: '连续答题失败',
  high_stakes: '关键教学任务',
  child_frustration: '孩子表现出挫败',
};

function errorText(body: unknown, status: number) {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('；');
  }
  return `请求失败 (${status})`;
}

export default function RoutingPage() {
  const [routing, setRouting] = useState<Routing | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => providers.map((provider) => ({
    key: `configured_${provider.serviceKind}_${provider.id}::${provider.modelAlias}`,
    endpoint: {
      providerAlias: `configured_${provider.serviceKind}_${provider.id}`,
      modelAlias: provider.modelAlias,
      level: (provider.options?.level as Level) || 'L2',
    },
    label: `${provider.providerName} · ${provider.modelAlias}`,
    serviceKind: provider.serviceKind,
  })), [providers]);

  async function load() {
    const [routeResponse, providerResponse] = await Promise.all([
      fetch('/api/v1/admin/model-routing'),
      fetch('/api/v1/admin/model-providers/configs'),
    ]);
    const [routeBody, providerBody] = await Promise.all([
      routeResponse.json().catch(() => ({})),
      providerResponse.json().catch(() => []),
    ]);
    if (!routeResponse.ok) throw new Error(errorText(routeBody, routeResponse.status));
    if (!providerResponse.ok) throw new Error(errorText(providerBody, providerResponse.status));
    setRouting(routeBody as Routing);
    setProviders(providerBody as ProviderConfig[]);
    setMessage('路由规则已读取。');
  }

  async function save() {
    if (!routing) return;
    setBusy(true);
    try {
      const response = await fetch('/api/v1/admin/model-routing', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(routing),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorText(body, response.status));
      setRouting(body as Routing);
      setMessage('路由规则已保存并立即生效。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  function updateRule(index: number, patch: Partial<RouteRule>) {
    setRouting((current) => current && ({
      ...current,
      rules: current.rules.map((rule, itemIndex) => itemIndex === index ? { ...rule, ...patch } : rule),
    }));
  }

  function modelSelect(serviceKind: string, value: Endpoint, onChange: (endpoint: Endpoint) => void) {
    const endpointKey = `${value.providerAlias}::${value.modelAlias}`;
    const options = candidates.filter((candidate) => candidate.serviceKind === serviceKind);
    const exists = options.some((candidate) => candidate.key === endpointKey);
    return <select value={exists ? endpointKey : '__current'} onChange={(event) => {
      const found = options.find((candidate) => candidate.key === event.target.value);
      if (found) onChange(found.endpoint);
    }}>
      {!exists && <option value="__current">{value.providerAlias} · {value.modelAlias}（当前规则）</option>}
      {options.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.label}</option>)}
    </select>;
  }

  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, []);

  return <main className="shell">
    <AdminNav />
    <header className="topbar">
      <div><p className="eyebrow">ROUTING</p><h1>任务路由</h1><p className="muted">为每类教学任务选择主模型、备用模型和预算。备用顺序按列表排列。</p></div>
      <button className="secondary" disabled={busy} onClick={() => void load().catch((error) => setMessage(error.message))}>刷新</button>
    </header>
    {!routing ? <section className="panel"><p className="status">{message || '正在读取路由规则…'}</p></section> : <>
      <section className="panel">
        <div className="panel-head"><div><p className="eyebrow">MODEL ORDER</p><h2>模型等级顺序</h2><p className="muted">决定系统自动降级时优先尝试的模型档位。</p></div></div>
        <div className="fields">{(['L0', 'L1', 'L2', 'L3'] as Level[]).map((level) => <label key={level}>{levelNames[level]}<select value={String(routing.fallbackOrder.indexOf(level))} onChange={(event) => {
          const order = [...routing.fallbackOrder];
          const oldIndex = order.indexOf(level);
          const newIndex = Number(event.target.value);
          if (oldIndex >= 0) order.splice(oldIndex, 1);
          order.splice(newIndex, 0, level);
          setRouting({ ...routing, fallbackOrder: order });
        }}>{routing.fallbackOrder.map((item, index) => <option key={item} value={index}>第 {index + 1} 优先：{levelNames[item]}</option>)}</select></label>)}</div>
      </section>
      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head"><div><p className="eyebrow">TASK ROUTES</p><h2>任务模型安排</h2><p className="muted">模型来自“模型接入”中保存的配置。先在那里添加并启用供应商，再返回此处选择。生产模式（AI_GATEWAY_MODE=live）下，最近一次 Benchmark 未通过的配置不能保存为已启用路由；mock 模式不阻断。</p></div></div>
        {routing.rules.map((rule, index) => {
          const serviceKind = rule.taskRoute.split('.')[0] || '';
          return <article className="panel" key={rule.taskRoute} style={{ marginTop: 14, padding: 18 }}>
            <div className="panel-head">
              <div><p className="eyebrow">{serviceKind.toUpperCase()}</p><h3>{routeNames[rule.taskRoute] || rule.taskRoute}</h3><p className="muted">{rule.taskRoute}</p></div>
              <label className="switch"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(index, { enabled: event.target.checked })}/><span>启用此路由</span></label>
            </div>
            <div className="fields">
              <label>首选模型{modelSelect(serviceKind, rule.primary, (primary) => updateRule(index, { primary }))}</label>
              <label>最大同时处理数<input type="number" min="1" max="1000" value={rule.maxConcurrency} onChange={(event) => updateRule(index, { maxConcurrency: Number(event.target.value) })}/></label>
              <label>每日预算（元，0 表示不设上限）<input type="number" min="0" step="0.01" value={rule.dailyBudgetCny} onChange={(event) => updateRule(index, { dailyBudgetCny: Number(event.target.value) })}/></label>
            </div>
            <div style={{ marginTop: 14 }}>
              <strong>备用模型</strong>
              {rule.fallback.map((endpoint, fallbackIndex) => <div className="fields" key={`${endpoint.providerAlias}-${fallbackIndex}`} style={{ marginTop: 8 }}>
                <label>备用 {fallbackIndex + 1}{modelSelect(serviceKind, endpoint, (next) => updateRule(index, { fallback: rule.fallback.map((item, i) => i === fallbackIndex ? next : item) }))}</label>
                <label>模型等级<select value={endpoint.level} onChange={(event) => updateRule(index, { fallback: rule.fallback.map((item, i) => i === fallbackIndex ? { ...item, level: event.target.value as Level } : item) })}>{Object.entries(levelNames).map(([level, name]) => <option key={level} value={level}>{level} · {name}</option>)}</select></label>
                <button className="secondary" onClick={() => updateRule(index, { fallback: rule.fallback.filter((_, i) => i !== fallbackIndex) })}>移除此备用模型</button>
              </div>)}
              <button className="secondary" style={{ marginTop: 8 }} disabled={!candidates.some((candidate) => candidate.serviceKind === serviceKind)} onClick={() => {
                const next = candidates.find((candidate) => candidate.serviceKind === serviceKind);
                if (next) updateRule(index, { fallback: [...rule.fallback, next.endpoint] });
              }}>添加备用模型</button>
            </div>
          </article>;
        })}
      </section>
      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head"><div><p className="eyebrow">ESCALATION</p><h2>何时升级模型</h2><p className="muted">出现相应情况时，临时升级到指定模型等级处理。</p></div></div>
        {Object.entries(routing.escalationTargets).map(([serviceKind, signals]) => <div key={serviceKind} style={{ marginTop: 16 }}>
          <h3>{serviceKind.toUpperCase()}</h3><div className="fields">{Object.entries(signals).map(([signal, level]) => <label key={signal}>{signalNames[signal] || signal}<select value={level} onChange={(event) => setRouting({ ...routing, escalationTargets: { ...routing.escalationTargets, [serviceKind]: { ...signals, [signal]: event.target.value as Level } } })}>{Object.entries(levelNames).map(([id, name]) => <option key={id} value={id}>{id} · {name}</option>)}</select></label>)}</div>
        </div>)}
      </section>
      <footer style={{ marginTop: 20 }}><span className="status">{message}</span><button disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存并应用路由'}</button></footer>
    </>}
  </main>;
}

'use client';

import { useEffect, useMemo, useState } from 'react';

type ServiceKind = 'llm' | 'tts' | 'asr' | 'pronunciation';
type Preset = {
  id: string;
  name: string;
  protocol: string;
  services: ServiceKind[];
  defaultBaseUrls: Partial<Record<ServiceKind, string>>;
  credentialRequired: boolean;
  documentationUrl: string | null;
  documentationUrls?: Partial<Record<ServiceKind, string>>;
};
type Config = {
  serviceKind: ServiceKind;
  providerPresetId: string;
  baseUrl: string;
  modelAlias: string;
  enabled: boolean;
  credentialConfigured?: boolean;
  options: Record<string, unknown>;
};
type ModelBenchmark = {
  modelAlias: string;
  level: string;
  enabled: boolean;
  benchmarks: Array<{ id: string; score: number; sampleCount: number; passed: boolean; notes: string | null; testedAt: string }>;
};
type TeacherProfile = {
  id: string; style: 'patient_guide' | 'playful_companion' | 'calm_coach';
  adjustable: { tone: 'gentle' | 'lively' | 'calm'; encouragement: 'light' | 'balanced' | 'frequent'; correctionStyle: 'model_first' | 'hint_first' | 'encourage_retry'; speakingRate: number };
};
type Memory = { id: string; memoryType: string; content: string; importance: number; source: string; expiresAt: string | null };
type RouterConfig = {
  rules: Array<{
    taskRoute: string;
    primary: { providerAlias: string; modelAlias: string; level: string };
    fallback: Array<{ providerAlias: string; modelAlias: string; level: string }>;
    maxConcurrency: number;
    dailyBudgetCny: number;
    enabled: boolean;
  }>;
  escalationTargets: Record<string, Record<string, string>>;
  fallbackOrder: string[];
};

function apiRoot(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) return process.env.NEXT_PUBLIC_BACKEND_URL;
  return typeof window === 'undefined' ? '' : `${window.location.protocol}//${window.location.hostname}:3100`;
}
const services: Array<{ id: ServiceKind; title: string; help: string }> = [
  { id: 'llm', title: '文本模型 LLM', help: '教学对话、解释与学习计划' },
  { id: 'tts', title: '语音合成 TTS', help: '把教师文本合成为播放音频' },
  { id: 'asr', title: '普通语音识别 ASR', help: '只转写“说了什么”，不评判发音对错' },
  { id: 'pronunciation', title: '音素级发音评测', help: '对照目标文本评估单词、音节或音素发音；需要支持评测的专用服务' },
];
const credentialLabels: Record<string, Array<[string, string]>> = {
  bailian: [['apiKey', '百炼 API Key']],
  volcengine: [['apiKey', '火山 API Key']],
  'baidu-qianfan': [['apiKey', '百度 API Key'], ['secretKey', '百度 Secret Key']],
  'iflytek-spark': [['appId', '讯飞 AppID'], ['apiKey', '讯飞服务 API Key'], ['apiSecret', '讯飞 TTS/星火 API Secret']],
  minimax: [['apiKey', 'MiniMax API Key'], ['groupId', 'Group ID（如接口要求）']],
  ollama: [],
  'openai-compatible': [['apiKey', 'API Key（可选）']],
  'tencent-soe': [['appId', '腾讯云 AppID'], ['secretId', 'Secret ID'], ['secretKey', 'Secret Key']],
  'azure-speech': [['subscriptionKey', 'Azure Speech 资源密钥']],
  speechace: [['apiKey', 'Speechace API Key']],
  chivox: [['apiKey', '驰声评测 API Key']],
};

function emptyConfig(serviceKind: ServiceKind): Config {
  return { serviceKind, providerPresetId: '', baseUrl: '', modelAlias: '', enabled: false, options: {} };
}

export default function AdminPage() {
  const [catalog, setCatalog] = useState<Preset[]>([]);
  const [configs, setConfigs] = useState<Record<ServiceKind, Config>>({
    llm: emptyConfig('llm'), tts: emptyConfig('tts'), asr: emptyConfig('asr'), pronunciation: emptyConfig('pronunciation'),
  });
  const [credentials, setCredentials] = useState<Record<ServiceKind, Record<string, string>>>({
    llm: {}, tts: {}, asr: {}, pronunciation: {},
  });
  const [token, setToken] = useState('');
  const [active, setActive] = useState<ServiceKind>('llm');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [benchmarks, setBenchmarks] = useState<ModelBenchmark[]>([]);
  const [benchmarkScore, setBenchmarkScore] = useState('');
  const [benchmarkSamples, setBenchmarkSamples] = useState('');
  const [benchmarkPassed, setBenchmarkPassed] = useState(false);
  const [benchmarkNotes, setBenchmarkNotes] = useState('');
  const [teacher, setTeacher] = useState<TeacherProfile | null>(null);
  const [teacherReason, setTeacherReason] = useState('');
  const [personaHistory, setPersonaHistory] = useState<Array<{ id: string; version: number; reason: string; createdAt: string; changeContent: string }>>([]);
  const [learnerId, setLearnerId] = useState('');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [routingJson, setRoutingJson] = useState('');
  const service = services.find((item) => item.id === active)!;
  const available = useMemo(() => catalog.filter((item) => item.services.includes(active)), [catalog, active]);
  const current = configs[active];
  const credentialFields = (credentialLabels[current.providerPresetId] ?? []).filter(([key]) => current.providerPresetId !== 'iflytek-spark' || active !== 'pronunciation' || key !== 'apiSecret');

  useEffect(() => {
    void fetch(`${apiRoot()}/api/v1/admin/model-providers/catalog`).then((res) => res.json()).then(setCatalog).catch(() => setMessage('无法连接后端，请检查管理后台与 API 的访问地址。'));
  }, []);

  useEffect(() => {
    if (!token) return;
    void fetch(`${apiRoot()}/api/v1/admin/model-providers/benchmarks?serviceKind=${active}`, { headers: { 'x-admin-token': token } })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).message ?? `读取 Benchmark 失败 (${res.status})`);
        return res.json();
      })
      .then(setBenchmarks)
      .catch((error) => setMessage(error instanceof Error ? error.message : '读取 Benchmark 失败'));
  }, [active, token]);

  async function loadConfigs() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/configs`, { headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json()).message ?? `读取失败 (${res.status})`);
    const rows: Config[] = await res.json();
    setConfigs((old) => ({ ...old, ...Object.fromEntries(rows.map((row) => [row.serviceKind, row])) }));
    await loadBenchmarks();
    await loadLearningSettings();
    await loadRouting();
    setMessage('已读取现有配置。');
  }

  async function loadRouting() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/model-routing`, { headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json()).message ?? `读取路由规则失败 (${res.status})`);
    const body: RouterConfig = await res.json();
    setRoutingJson(JSON.stringify(body, null, 2));
  }

  async function saveRouting() {
    setBusy(true);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(routingJson); } catch { throw new Error('路由规则必须是合法 JSON'); }
      const res = await fetch(`${apiRoot()}/api/v1/admin/model-routing`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify(parsed),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `保存路由规则失败 (${res.status})`);
      setRoutingJson(JSON.stringify(body, null, 2));
      setMessage('路由规则已保存并立即生效。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存路由规则失败');
    } finally {
      setBusy(false);
    }
  }

  async function loadLearningSettings() {
    const headers = { 'x-admin-token': token };
    const [profileRes, historyRes] = await Promise.all([
      fetch(`${apiRoot()}/api/v1/admin/learning/teacher-profile`, { headers }),
      fetch(`${apiRoot()}/api/v1/admin/learning/teacher-profile/history`, { headers }),
    ]);
    if (!profileRes.ok || !historyRes.ok) throw new Error('读取教师人格配置失败');
    setTeacher(await profileRes.json());
    setPersonaHistory(await historyRes.json());
  }

  async function saveTeacher() {
    if (!teacher) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiRoot()}/api/v1/admin/learning/teacher-profile`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ adjustable: teacher.adjustable, style: teacher.style, reason: teacherReason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `保存失败 (${res.status})`);
      setTeacher(body); setTeacherReason(''); await loadLearningSettings(); setMessage('教师风格已保存并记录版本。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }

  async function loadMemories() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/learning/learners/${encodeURIComponent(learnerId)}/memories`, { headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json()).message ?? `读取记忆失败 (${res.status})`);
    setMemories(await res.json());
  }

  async function deleteMemory(memoryId: string) {
    const res = await fetch(`${apiRoot()}/api/v1/admin/learning/learners/${encodeURIComponent(learnerId)}/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE', headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json()).message ?? `删除失败 (${res.status})`);
    await loadMemories();
  }

  async function saveMemoryEdit() {
    if (!editingMemory) return;
    const res = await fetch(`${apiRoot()}/api/v1/admin/learning/learners/${encodeURIComponent(learnerId)}/memories/${encodeURIComponent(editingMemory.id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ memoryType: editingMemory.memoryType, content: editingMemory.content, importance: editingMemory.importance, expiresAt: editingMemory.expiresAt }),
    });
    if (!res.ok) throw new Error((await res.json()).message ?? `保存失败 (${res.status})`);
    setEditingMemory(null); await loadMemories();
  }

  async function rollbackPersona(historyId: string) {
    const res = await fetch(`${apiRoot()}/api/v1/admin/learning/teacher-profile/rollback/${encodeURIComponent(historyId)}`, { method: 'PUT', headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json()).message ?? `回滚失败 (${res.status})`);
    await loadLearningSettings(); setMessage('教师风格已回滚并生成新版本。');
  }

  async function loadBenchmarks() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/benchmarks?serviceKind=${active}`, { headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json()).message ?? `读取 Benchmark 失败 (${res.status})`);
    setBenchmarks(await res.json());
  }

  async function saveBenchmark() {
    setBusy(true); setMessage('正在保存儿童专项测试结果…');
    try {
      const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/benchmarks`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ serviceKind: active, modelAlias: current.modelAlias, score: Number(benchmarkScore), sampleCount: Number(benchmarkSamples), passed: benchmarkPassed, notes: benchmarkNotes }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `保存失败 (${res.status})`);
      await loadBenchmarks();
      setMessage(body.passed ? '测试记录已保存，模型通过 Benchmark 并已应用。' : '测试记录已保存，模型仍由本地 Mock 处理。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }

  function chooseProvider(id: string) {
    const preset = catalog.find((item) => item.id === id);
    setConfigs((old) => ({ ...old, [active]: { ...old[active], providerPresetId: id, baseUrl: preset?.defaultBaseUrls[active] ?? '', modelAlias: id, options: id === 'azure-speech' ? { region: 'eastus' } : {} } }));
    setCredentials((old) => ({ ...old, [active]: {} }));
  }

  async function save() {
    setBusy(true); setMessage('正在保存并切换运行时模型…');
    try {
      const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/configs`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ ...current, credentials: credentials[active] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `保存失败 (${res.status})`);
      setConfigs((old) => ({ ...old, [active]: body }));
      setCredentials((old) => ({ ...old, [active]: {} }));
      await loadBenchmarks();
      setMessage('配置已加密保存；通过儿童专项 Benchmark 后才会启用真实模型。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }

  return <main className="shell">
    <header className="topbar"><div><p className="eyebrow">AI LANGUAGE GROWTH</p><h1>模型接入</h1><p className="muted">选择服务商，填写平台账号信息，后端会自动适配对应接口。</p></div><div className="token"><label htmlFor="token">后台管理令牌</label><input id="token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ADMIN_CONFIG_TOKEN"/><button className="secondary" onClick={() => void loadConfigs().catch((error) => setMessage(error.message))}>读取配置</button></div></header>
      <section className="notice"><strong>两类语音能力分开配置</strong><span>普通 ASR 只返回转写文本；音素级发音评测会对照目标文本评估发音，不会用转写结果代替评分。真实模型须先通过对应的儿童专项 Benchmark。</span></section>
    <div className="workspace"><nav className="services">{services.map((item) => <button key={item.id} className={active === item.id ? 'service active' : 'service'} onClick={() => setActive(item.id)}><span>{item.title}</span><small>{item.help}</small><i>{configs[item.id].enabled ? '已启用' : '未启用'}</i></button>)}</nav>
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">{service.id.toUpperCase()}</p><h2>{service.title}</h2><p className="muted">{service.help}</p></div><label className="switch"><input type="checkbox" checked={current.enabled} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, enabled: event.target.checked } }))}/><span>启用</span></label></div>
        <label>预置平台<select value={current.providerPresetId} onChange={(event) => chooseProvider(event.target.value)}><option value="">请选择平台</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {current.providerPresetId && <>
          <div className="fields"><label>接入地址<input value={current.baseUrl} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, baseUrl: event.target.value } }))}/><small>已填平台默认地址，区域或自建部署不同时可调整。</small></label><label>{active === 'pronunciation' ? '评测服务/模型' : active === 'asr' ? 'ASR 模型' : active === 'tts' ? 'TTS 模型' : '模型名称'}<input value={current.modelAlias} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, modelAlias: event.target.value } }))} placeholder="填写控制台中已开通的模型标识"/></label></div>
          {current.providerPresetId === 'azure-speech' && active === 'pronunciation' && <label>Azure Speech 区域<input value={String(current.options.region ?? 'eastus')} onChange={(event) => setConfigs((old) => {
            const region = event.target.value.trim();
            const defaultEndpoint = /^https:\/\/[^/.]+\.stt\.speech\.microsoft\.com\/?$/i.test(current.baseUrl);
            return { ...old, [active]: { ...current, baseUrl: defaultEndpoint && region ? `https://${region}.stt.speech.microsoft.com` : current.baseUrl, options: { ...current.options, region } } };
          })}/><small>更改区域会同步默认接入地址；自定义 endpoint 会保持原样。</small></label>}
          {current.providerPresetId === 'speechace' && active === 'pronunciation' && <label>英语口音<select value={String(current.options.dialect ?? 'en-us')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, dialect: event.target.value } } }))}><option value="en-us">美式英语 en-us</option><option value="en-gb">英式英语 en-gb</option></select></label>}
          {current.providerPresetId === 'chivox' && active === 'pronunciation' && <label>英语口音<select value={String(current.options.accent ?? '3')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, accent: event.target.value } } }))}><option value="3">自动判断</option><option value="1">英式英语</option><option value="2">美式英语</option></select></label>}
          {credentialFields.length > 0 && <div className="fields credentials">{credentialFields.map(([key, label]) => <label key={key}>{label}<input type="password" autoComplete="new-password" value={credentials[active][key] ?? ''} onChange={(event) => setCredentials((old) => ({ ...old, [active]: { ...old[active], [key]: event.target.value } }))} placeholder={configs[active].credentialConfigured ? '已有凭据；留空保留已保存值' : `输入${label}`}/></label>)}</div>}
          {(active === 'tts' || active === 'pronunciation') && <label>{active === 'tts' ? '默认音色 ID' : '评测粒度'}<input value={String(current.options.voice ?? (active === 'pronunciation' ? 'phoneme' : ''))} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, [active === 'tts' ? 'voice' : 'granularity']: event.target.value } } }))} placeholder={active === 'tts' ? '使用平台默认音色' : 'phoneme / syllable / word'}/></label>}
          {current.providerPresetId === 'bailian' && (active === 'tts' || active === 'asr') && <label>百炼业务空间 ID<input value={String(current.options.workspaceId ?? '')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, workspaceId: event.target.value } } }))} placeholder="仅百炼语音 HTTP 接入需要"/></label>}
          {current.providerPresetId === 'bailian' && (active === 'tts' || active === 'asr') && <label>百炼地域<select value={String(current.options.regionHost ?? 'cn-beijing.maas.aliyuncs.com')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...old[active].options, regionHost: event.target.value } } }))}><option value="cn-beijing.maas.aliyuncs.com">华北 2（北京）</option><option value="ap-southeast-1.maas.aliyuncs.com">新加坡</option></select></label>}
          {current.providerPresetId === 'volcengine' && active === 'tts' && <label>语音资源 ID<input value={String(current.options.resourceId ?? 'seed-tts-2.0')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, resourceId: event.target.value } } }))} placeholder="平台控制台提供的资源 ID"/></label>}
          {current.providerPresetId === 'baidu-qianfan' && active === 'tts' && <label>音色 ID<input value={String(current.options.voiceId ?? '5003')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, voiceId: event.target.value } } }))}/></label>}
          <p className="helper">{active === 'pronunciation' ? '发音评测会将音频与目标文本一起发送。讯飞 ISE 需 16kHz 单声道音频；腾讯 SOE 使用签名 WebSocket；Azure 通过区域 Speech endpoint 评测。需先在对应控制台开通服务。' : active === 'asr' ? '此项只配置普通转写服务。音素级能力请在左侧单独配置。' : '填写平台账号凭据即可；接入地址可以编辑，以适应区域域名或供应商 API 地址变更。凭据在服务端使用 AES-256-GCM 加密后入库，页面不会回显已保存的密钥。'}</p>
          {(catalog.find((item) => item.id === current.providerPresetId)?.documentationUrls?.[active] ?? catalog.find((item) => item.id === current.providerPresetId)?.documentationUrl) && <a className="doclink" href={catalog.find((item) => item.id === current.providerPresetId)?.documentationUrls?.[active] ?? catalog.find((item) => item.id === current.providerPresetId)?.documentationUrl ?? ''} target="_blank" rel="noreferrer">打开此服务的官方接入文档 ↗</a>}
          <section className="benchmark">
            <h3>儿童专项 Benchmark</h3>
            <p className="helper">记录本服务的儿童英语样本评测结果。只有明确标记通过且样本数大于 0，真实模型才会接管调用；否则使用本地 Mock。</p>
            <div className="fields">
              <label>测试分数<input type="number" step="any" value={benchmarkScore} onChange={(event) => setBenchmarkScore(event.target.value)} placeholder="按测试集评分口径填写"/></label>
              <label>样本数<input type="number" min="1" step="1" value={benchmarkSamples} onChange={(event) => setBenchmarkSamples(event.target.value)} placeholder="实际测试样本数"/></label>
            </div>
            <label>测试说明<input value={benchmarkNotes} onChange={(event) => setBenchmarkNotes(event.target.value)} placeholder="年龄段、口音、测试集版本与结果摘要"/></label>
            <label className="switch"><input type="checkbox" checked={benchmarkPassed} onChange={(event) => setBenchmarkPassed(event.target.checked)}/><span>该模型通过本服务专项测试</span></label>
            <button className="secondary" disabled={!token || !current.modelAlias || !benchmarkScore || !benchmarkSamples || busy} onClick={() => void saveBenchmark()}>保存测试结果并刷新模型接入</button>
            <div className="benchmark-list">{benchmarks.flatMap((model) => model.benchmarks.map((entry) => <div className="helper" key={entry.id}>{model.modelAlias} · {entry.passed ? '通过' : '未通过'} · 分数 {entry.score} · 样本 {entry.sampleCount} · {new Date(entry.testedAt).toLocaleDateString()}</div>))}</div>
          </section>
        </>}
        <footer><span className="status">{message}</span><button disabled={!token || !current.providerPresetId || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存并应用'}</button></footer>
      </section></div>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">LEARNING SETTINGS</p><h2>教师风格与学习记忆</h2><p className="muted">安全底线固定，不可编辑；风格调整有版本历史，可回滚。</p></div></div>
      {!teacher ? <button className="secondary" disabled={!token} onClick={() => void loadLearningSettings().catch((error) => setMessage(error.message))}>读取人格配置</button> : <>
        <div className="fields">
          <label>教师风格<select value={teacher.style} onChange={(event) => setTeacher({ ...teacher, style: event.target.value as TeacherProfile['style'] })}><option value="patient_guide">耐心引导</option><option value="playful_companion">活泼伙伴</option><option value="calm_coach">沉稳教练</option></select></label>
          <label>语气<select value={teacher.adjustable.tone} onChange={(event) => setTeacher({ ...teacher, adjustable: { ...teacher.adjustable, tone: event.target.value as TeacherProfile['adjustable']['tone'] } })}><option value="gentle">温和</option><option value="lively">活泼</option><option value="calm">沉静</option></select></label>
          <label>鼓励频率<select value={teacher.adjustable.encouragement} onChange={(event) => setTeacher({ ...teacher, adjustable: { ...teacher.adjustable, encouragement: event.target.value as TeacherProfile['adjustable']['encouragement'] } })}><option value="light">简短</option><option value="balanced">适度</option><option value="frequent">频繁</option></select></label>
          <label>纠错方式<select value={teacher.adjustable.correctionStyle} onChange={(event) => setTeacher({ ...teacher, adjustable: { ...teacher.adjustable, correctionStyle: event.target.value as TeacherProfile['adjustable']['correctionStyle'] } })}><option value="model_first">先示范</option><option value="hint_first">先提示</option><option value="encourage_retry">先鼓励重试</option></select></label>
          <label>基础语速<input type="number" min="0.45" max="0.85" step="0.05" value={teacher.adjustable.speakingRate} onChange={(event) => setTeacher({ ...teacher, adjustable: { ...teacher.adjustable, speakingRate: Number(event.target.value) } })}/></label>
        </div>
        <label>调整原因<input value={teacherReason} onChange={(event) => setTeacherReason(event.target.value)} placeholder="记录为什么调整教师风格"/></label>
        <button disabled={!token || !teacherReason.trim() || busy} onClick={() => void saveTeacher()}>保存新版本</button>
        <h3>变更历史</h3><div className="benchmark-list">{personaHistory.map((entry) => <div className="helper" key={entry.id}>v{entry.version} · {entry.reason} · {new Date(entry.createdAt).toLocaleString()} {entry.changeContent.includes('"before"') && <button className="secondary" onClick={() => void rollbackPersona(entry.id).catch((error) => setMessage(error.message))}>回滚到此前配置</button>}</div>)}</div>
      </>}
      <h3>学习记忆</h3><div className="fields"><label>学习者 ID<input value={learnerId} onChange={(event) => setLearnerId(event.target.value)} placeholder="从学习者档案中复制 ID"/></label><button className="secondary" disabled={!token || !learnerId} onClick={() => void loadMemories().catch((error) => setMessage(error.message))}>读取学习记忆</button></div>
      <div className="benchmark-list">{memories.map((memory) => <div className="helper" key={memory.id}><strong>{memory.memoryType}</strong> · {memory.content} · 重要度 {memory.importance} · {memory.source}<button className="secondary" onClick={() => setEditingMemory({ ...memory })}>纠正</button><button className="secondary" onClick={() => void deleteMemory(memory.id).catch((error) => setMessage(error.message))}>删除</button></div>)}</div>
      {editingMemory && <div className="fields"><label>记忆内容<input value={editingMemory.content} onChange={(event) => setEditingMemory({ ...editingMemory, content: event.target.value })}/></label><label>记忆类型<select value={editingMemory.memoryType} onChange={(event) => setEditingMemory({ ...editingMemory, memoryType: event.target.value })}><option value="learning_preference">学习偏好</option><option value="encouragement_preference">鼓励偏好</option><option value="lesson_learning_summary">课堂学习摘要</option><option value="caregiver_note">照护者备注</option></select></label><button disabled={!editingMemory.content.trim()} onClick={() => void saveMemoryEdit().then(() => setMessage('记忆已纠正。')).catch((error) => setMessage(error.message))}>保存纠正</button><button className="secondary" onClick={() => setEditingMemory(null)}>取消</button></div>}
      <p className="helper">记忆编辑与删除目前由管理令牌保护；面向监护人的专用账号与授权仍待账户体系实现。</p>
    </section>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">MODEL ROUTING</p><h2>任务路由规则</h2><p className="muted">可编辑全部 LLM、TTS、ASR 和发音评测任务的主模型、备选模型、并发预算与升级信号。保存后后端立即重载。</p></div></div>
      {!routingJson ? <button className="secondary" disabled={!token} onClick={() => void loadRouting().catch((error) => setMessage(error.message))}>读取路由规则</button> : <>
        <textarea className="routing-editor" value={routingJson} onChange={(event) => setRoutingJson(event.target.value)} spellCheck={false} aria-label="任务路由 JSON" />
        <footer><span className="status">修改前请保留 taskRoute、serviceKind 前缀和 L0-L3 级别格式。</span><button disabled={!token || busy} onClick={() => void saveRouting()}>{busy ? '保存中…' : '保存并立即生效'}</button></footer>
      </>}
    </section>
  </main>;
}

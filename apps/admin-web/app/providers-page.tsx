'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminNav } from './admin-nav';

type ServiceKind = 'llm' | 'tts' | 'asr' | 'pronunciation' | 'embedding';
type PriceType = 'input_token' | 'output_token' | 'per_character' | 'per_second' | 'per_call';
type ModelPrice = { modelAlias: string; priceType: PriceType; unitPrice: number };
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
  id?: string;
  draftKey?: string;
  serviceKind: ServiceKind;
  providerPresetId: string;
  baseUrl: string;
  modelAlias: string;
  enabled: boolean;
  priority?: number;
  timeoutMs?: number;
  credentialConfigured?: boolean;
  options: Record<string, unknown>;
};
type RuntimeScore = {
  providerAlias: string;
  modelAlias: string;
  calls: number;
  averageLatencyMs: number;
  lastUsedAt: string;
  latencyScore: number;
  scoreLabel: string;
};
function apiRoot(): string {
  return '';
}
const services: Array<{ id: ServiceKind; title: string; help: string }> = [
  { id: 'llm', title: '文本模型 LLM', help: '教学对话、解释与学习计划' },
  { id: 'tts', title: '语音合成 TTS', help: '把教师文本合成为播放音频' },
  { id: 'asr', title: '普通语音识别 ASR', help: '只转写“说了什么”，不评判发音对错' },
  { id: 'pronunciation', title: '音素级发音评测', help: '对照目标文本评估单词、音节或音素发音；需要支持评测的专用服务' },
  { id: 'embedding', title: '向量 Embedding', help: '为交互记忆和课程知识库生成向量；当前仅配置接入，检索链路尚未启用' },
];
const priceFields: Record<ServiceKind, Array<{ type: PriceType; label: string }>> = {
  llm: [
    { type: 'input_token', label: '输入 Token 单价（元/Token）' },
    { type: 'output_token', label: '输出 Token 单价（元/Token）' },
  ],
  tts: [{ type: 'per_character', label: '合成字符单价（元/字符）' }],
  asr: [{ type: 'per_second', label: '识别时长单价（元/秒）' }],
  pronunciation: [{ type: 'per_call', label: '单次评测单价（元/次）' }],
  embedding: [{ type: 'input_token', label: '输入 Token 单价（元/Token）' }],
};
const credentialLabels: Record<string, Array<[string, string]>> = {
  bailian: [['apiKey', '百炼 API Key']],
  volcengine: [['apiKey', '火山 API Key']],
  'baidu-qianfan': [['apiKey', '百度 API Key'], ['secretKey', '百度 Secret Key']],
  'iflytek-spark': [['appId', '讯飞 AppID'], ['apiKey', '讯飞服务 API Key'], ['apiSecret', '讯飞 TTS/星火 API Secret']],
  minimax: [['apiKey', 'MiniMax API Key'], ['groupId', 'Group ID（如接口要求）']],
  siliconflow: [['apiKey', '硅基流动 API Key']],
  'tencent-cloud': [['secretId', '腾讯云 Secret ID'], ['secretKey', '腾讯云 Secret Key']],
  'tencent-hunyuan': [['apiKey', '腾讯云混元 API Key']],
  ollama: [],
  'openai-compatible': [['apiKey', 'API Key（可选）']],
  'tencent-soe': [['appId', '腾讯云 AppID'], ['secretId', 'Secret ID'], ['secretKey', 'Secret Key']],
  'azure-speech': [['subscriptionKey', 'Azure Speech 资源密钥']],
  speechace: [['apiKey', 'Speechace API Key']],
  chivox: [['apiKey', '驰声评测 API Key']],
};

function emptyConfig(serviceKind: ServiceKind): Config {
  return { serviceKind, providerPresetId: '', baseUrl: '', modelAlias: '', enabled: false, priority: 100, timeoutMs: 20000, options: {} };
}

export default function AdminPage() {
  const [catalog, setCatalog] = useState<Preset[]>([]);
  const [configs, setConfigs] = useState<Record<ServiceKind, Config[]>>({
    llm: [], tts: [], asr: [], pronunciation: [], embedding: [],
  });
  const [activeConfigIds, setActiveConfigIds] = useState<Partial<Record<ServiceKind, string>>>({});
  const [credentials, setCredentials] = useState<Record<ServiceKind, Record<string, string>>>({
    llm: {}, tts: {}, asr: {}, pronunciation: {}, embedding: {},
  });
  const [active, setActive] = useState<ServiceKind>('llm');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtimeScores, setRuntimeScores] = useState<RuntimeScore[]>([]);
  const [pricing, setPricing] = useState<Partial<Record<PriceType, string>>>({});
  const service = services.find((item) => item.id === active)!;
  const available = useMemo(() => catalog.filter((item) => item.services.includes(active)), [catalog, active]);
  const current = configs[active].find((item) => (item.id ?? item.draftKey) === activeConfigIds[active])
    ?? emptyConfig(active);
  const credentialFields = (credentialLabels[current.providerPresetId] ?? []).filter(([key]) => current.providerPresetId !== 'iflytek-spark' || active !== 'pronunciation' || key !== 'apiSecret');
  function updateCurrent(next: Config) {
    const key = activeConfigIds[active] ?? current.id ?? current.draftKey;
    setConfigs((old) => {
      const index = old[active].findIndex((item) => (item.id ?? item.draftKey) === key);
      return { ...old, [active]: index >= 0 ? old[active].map((item, i) => i === index ? next : item) : [...old[active], next] };
    });
  }

  useEffect(() => {
    void Promise.all([
      fetch(`${apiRoot()}/api/v1/admin/model-providers/catalog`).then(async (res) => {
        if (!res.ok) throw new Error(`读取供应商目录失败 (${res.status})`);
        return res.json() as Promise<Preset[]>;
      }),
      loadConfigs(),
    ]).then(([presets]) => setCatalog(presets))
      .catch((error) => setMessage(error instanceof Error ? error.message : '无法连接后端，请检查管理后台与 API 的访问地址。'));
  }, []);

  useEffect(() => {
    if (active === 'embedding') {
      setRuntimeScores([]);
      return;
    }
    void fetch(`${apiRoot()}/api/v1/admin/model-providers/runtime-scores?serviceKind=${active}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).message ?? `读取自动评分失败 (${res.status})`);
        return res.json();
      })
      .then(setRuntimeScores)
      .catch((error) => setMessage(error instanceof Error ? error.message : '读取自动评分失败'));
  }, [active]);

  useEffect(() => {
    void loadPrices().catch((error) => setMessage(error instanceof Error ? error.message : '读取单价失败'));
  }, [active, current.id]);

  async function loadConfigs() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/configs`);
    if (!res.ok) throw new Error((await res.json()).message ?? `读取失败 (${res.status})`);
    const rows: Config[] = await res.json();
    const grouped = Object.fromEntries(services.map(({ id }) => [id, rows.filter((row) => row.serviceKind === id)])) as Record<ServiceKind, Config[]>;
    setConfigs(grouped);
    setActiveConfigIds(Object.fromEntries(services.map(({ id }) => [id, grouped[id][0]?.id ?? grouped[id][0]?.draftKey]).filter(([, id]) => Boolean(id))) as Partial<Record<ServiceKind, string>>);
    setMessage('已读取现有配置。');
  }

  async function loadPrices() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/prices?serviceKind=${active}${current.id ? `&configId=${current.id}` : ''}`);
    if (!res.ok) throw new Error((await res.json()).message ?? `读取模型单价失败 (${res.status})`);
    const rows: ModelPrice[] = await res.json();
    setPricing(Object.fromEntries(rows.map((row) => [row.priceType, String(row.unitPrice)])));
  }

  async function savePrices() {
    setBusy(true);
    try {
      const prices = priceFields[active]
        .filter(({ type }) => pricing[type] !== undefined && pricing[type] !== '')
        .map(({ type }) => ({ priceType: type, unitPrice: Number(pricing[type]) }));
      const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/prices`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serviceKind: active, configId: current.id, modelAlias: current.modelAlias, prices }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `保存模型单价失败 (${res.status})`);
      setPricing(Object.fromEntries((body as ModelPrice[]).map((row) => [row.priceType, String(row.unitPrice)])));
      setMessage(active === 'embedding'
        ? 'Embedding 参考单价已保存；接入检索调用链后才能纳入实际成本核算。'
        : '模型单价已保存；后续用量将按实际 Token、字符或时长估算成本。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存模型单价失败');
    } finally {
      setBusy(false);
    }
  }

  function chooseProvider(id: string) {
    const preset = catalog.find((item) => item.id === id);
    const next = { ...current, providerPresetId: id, baseUrl: preset?.defaultBaseUrls[active] ?? '', modelAlias: id, options: id === 'azure-speech' ? { region: 'eastus' } : {} };
    updateCurrent(next);
    setCredentials((old) => ({ ...old, [active]: {} }));
  }

  async function save() {
    setBusy(true); setMessage(active === 'embedding' ? '正在保存 Embedding 配置…' : '正在保存并切换运行时模型…');
    try {
      const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/configs`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...current, serviceKind: active, credentials: credentials[active] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `保存失败 (${res.status})`);
      const key = activeConfigIds[active] ?? current.id ?? current.draftKey;
      setConfigs((old) => {
        const index = old[active].findIndex((item) => (item.id ?? item.draftKey) === key);
        return { ...old, [active]: index >= 0 ? old[active].map((item, i) => i === index ? body : item) : [...old[active], body] };
      });
      setActiveConfigIds((old) => ({ ...old, [active]: body.id }));
      setCredentials((old) => ({ ...old, [active]: {} }));
      setMessage(active === 'embedding'
        ? 'Embedding 配置已加密保存。当前尚未接入语义检索调用链，不会发送向量请求。'
        : '配置已加密保存并应用；后续调用会自动记录运行速度分。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }

  async function removeCurrentConfig() {
    if (!current.id) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/configs/${current.id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `删除失败 (${res.status})`);
      const remaining = configs[active].filter((item) => item.id !== current.id);
      setConfigs((old) => ({ ...old, [active]: remaining }));
      setActiveConfigIds((old) => ({ ...old, [active]: remaining[0]?.id ?? remaining[0]?.draftKey }));
      setMessage('当前供应商配置已删除。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return <main className="shell"><AdminNav />
    <header className="topbar"><div><p className="eyebrow">AI LANGUAGE GROWTH</p><h1>模型接入</h1></div><button className="secondary" onClick={() => void loadConfigs().catch((error) => setMessage(error.message))}>读取配置</button></header>
    <><section className="notice"><strong>{active === 'embedding' ? '语义检索模型配置' : '两类语音能力分开配置'}</strong><span>{active === 'embedding' ? 'Embedding 是 Mem0 语义记忆与课程 RAG 的基础能力。当前先保存服务商和模型配置，检索链路接入并验证前不会调用该模型。' : '普通 ASR 只返回转写文本；音素级发音评测会对照目标文本评估发音，不会用转写结果代替评分。启用配置后按优先级自动调用并故障切换。'}</span></section>
    <div className="workspace"><nav className="services">{services.map((item) => <button key={item.id} className={active === item.id ? 'service active' : 'service'} onClick={() => setActive(item.id)}><span>{item.title}</span><small>{item.help}</small><i>{configs[item.id].some((config) => config.enabled) ? item.id === 'embedding' ? '已配置' : '已启用' : '未启用'}</i></button>)}</nav>
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">{service.id.toUpperCase()}</p><h2>{service.title}</h2><p className="muted">{service.help}</p></div></div>
        <div className="benchmark-list" aria-label={`${service.title}供应商列表`}>
          {configs[active].map((item) => <button type="button" key={item.id ?? item.draftKey} className="secondary" aria-pressed={(item.id ?? item.draftKey) === activeConfigIds[active]} onClick={() => setActiveConfigIds((old) => ({ ...old, [active]: item.id ?? item.draftKey }))} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, width: '100%', marginTop: 8 }}>
            <span><strong>{item.providerPresetId ? catalog.find((preset) => preset.id === item.providerPresetId)?.name ?? item.providerPresetId : '未选择供应商'}</strong> · {item.modelAlias || '尚未填写模型名称'}</span>
            <span>{item.enabled ? '已启用' : '已停用'} · 优先级 {item.priority ?? 100}</span>
          </button>)}
          {!configs[active].length && <p className="helper">此服务目前还没有供应商配置。</p>}
        </div>
        <div className="fields" style={{ marginTop: 16 }}>
          <button className="secondary" type="button" onClick={() => {
            const next = { ...emptyConfig(active), draftKey: crypto.randomUUID() };
            setConfigs((old) => ({ ...old, [active]: [...old[active], next] }));
            setActiveConfigIds((old) => ({ ...old, [active]: next.draftKey }));
            setCredentials((old) => ({ ...old, [active]: {} }));
          }}>添加独立模型配置</button>
          {current.id && <button className="secondary" type="button" disabled={busy} onClick={() => void removeCurrentConfig()}>删除当前配置</button>}
        </div>
        <div className="panel-head" style={{ marginTop: 22 }}><div><p className="eyebrow">SELECTED CONFIGURATION</p><h3>编辑当前配置</h3></div><label className="switch"><input type="checkbox" checked={current.enabled} onChange={(event) => {
        const next = { ...current, enabled: event.target.checked };
        updateCurrent(next);
      }}/><span>{active === 'embedding' ? '设为默认配置' : '启用'}</span></label></div>
        <div className="fields"><label>优先级（数字越小越优先）<input type="number" min="1" value={String(current.priority ?? 100)} onChange={(event) => updateCurrent({ ...current, priority: Number(event.target.value) })}/></label><label>单家超时（毫秒）<input type="number" min="100" value={String(current.timeoutMs ?? 20000)} onChange={(event) => updateCurrent({ ...current, timeoutMs: Number(event.target.value) })}/></label></div>
        <label>预置平台<select value={current.providerPresetId} onChange={(event) => chooseProvider(event.target.value)}><option value="">请选择平台</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {current.providerPresetId && <>
          <div className="fields"><label>接入地址<input value={current.baseUrl} onChange={(event) => updateCurrent({ ...current, baseUrl: event.target.value })}/><small>已填平台默认地址，区域或自建部署不同时可调整。</small></label><label>{active === 'pronunciation' ? '评测服务/模型' : active === 'asr' ? 'ASR 模型' : active === 'tts' ? 'TTS 模型' : active === 'embedding' ? 'Embedding 模型' : '模型名称'}<input value={current.modelAlias} onChange={(event) => updateCurrent({ ...current, modelAlias: event.target.value })} placeholder="填写控制台中已开通的模型标识"/></label></div>
          {active === 'llm' && <label>模型用途<select value={String(current.options.role ?? 'main')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, role: event.target.value } })}><option value="main">主文本模型：教学对话与复杂生成</option><option value="small">小参数文本模型：记忆整理与课程素材预处理</option></select><small>小参数模型连接失败时会自动回退到主文本模型。</small></label>}
          {current.providerPresetId === 'azure-speech' && active === 'pronunciation' && <label>Azure Speech 区域<input value={String(current.options.region ?? 'eastus')} onChange={(event) => {
            const region = event.target.value.trim();
            const defaultEndpoint = /^https:\/\/[^/.]+\.stt\.speech\.microsoft\.com\/?$/i.test(current.baseUrl);
            updateCurrent({ ...current, baseUrl: defaultEndpoint && region ? `https://${region}.stt.speech.microsoft.com` : current.baseUrl, options: { ...current.options, region } });
          }}/><small>更改区域会同步默认接入地址；自定义 endpoint 会保持原样。</small></label>}
          {current.providerPresetId === 'speechace' && active === 'pronunciation' && <label>英语口音<select value={String(current.options.dialect ?? 'en-us')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, dialect: event.target.value } })}><option value="en-us">美式英语 en-us</option><option value="en-gb">英式英语 en-gb</option></select></label>}
          {current.providerPresetId === 'chivox' && active === 'pronunciation' && <label>英语口音<select value={String(current.options.accent ?? '3')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, accent: event.target.value } })}><option value="3">自动判断</option><option value="1">英式英语</option><option value="2">美式英语</option></select></label>}
          {credentialFields.length > 0 && <div className="fields credentials">{credentialFields.map(([key, label]) => <label key={key}>{label}<input type="password" autoComplete="new-password" value={credentials[active][key] ?? ''} onChange={(event) => setCredentials((old) => ({ ...old, [active]: { ...old[active], [key]: event.target.value } }))} placeholder={current.credentialConfigured ? '已有凭据；留空保留已保存值' : `输入${label}`}/></label>)}</div>}
          {(active === 'tts' || active === 'pronunciation') && <label>{active === 'tts' ? '默认音色 ID' : '评测粒度'}<input value={String(current.options.voice ?? (active === 'pronunciation' ? 'phoneme' : ''))} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, [active === 'tts' ? 'voice' : 'granularity']: event.target.value } })} placeholder={active === 'tts' ? '使用平台默认音色' : 'phoneme / syllable / word'}/></label>}
          {current.providerPresetId === 'bailian' && (active === 'tts' || active === 'asr') && <label>百炼业务空间 ID<input value={String(current.options.workspaceId ?? '')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, workspaceId: event.target.value } })} placeholder="仅百炼语音 HTTP 接入需要"/></label>}
          {current.providerPresetId === 'bailian' && (active === 'tts' || active === 'asr') && <label>百炼地域<select value={String(current.options.regionHost ?? 'cn-beijing.maas.aliyuncs.com')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, regionHost: event.target.value } })}><option value="cn-beijing.maas.aliyuncs.com">华北 2（北京）</option><option value="ap-southeast-1.maas.aliyuncs.com">新加坡</option></select></label>}
          {current.providerPresetId === 'volcengine' && active === 'tts' && <label>语音资源 ID<input value={String(current.options.resourceId ?? 'seed-tts-2.0')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, resourceId: event.target.value } })} placeholder="平台控制台提供的资源 ID"/></label>}
          {current.providerPresetId === 'volcengine' && active === 'asr' && <div className="fields"><label>语音资源 ID<input value={String(current.options.resourceId ?? 'volc.bigasr.auc_turbo')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, resourceId: event.target.value } })}/></label><label>识别模型<input value={String(current.options.modelName ?? 'bigmodel')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, modelName: event.target.value } })}/></label></div>}
          {current.providerPresetId === 'tencent-cloud' && <label>腾讯云地域<input value={String(current.options.region ?? 'ap-guangzhou')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, region: event.target.value } })} placeholder="例如 ap-guangzhou"/></label>}
          {current.providerPresetId === 'tencent-cloud' && active === 'asr' && <label>项目 ID<input type="number" min="0" value={String(current.options.projectId ?? 0)} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, projectId: Number(event.target.value) } })}/></label>}
          {current.providerPresetId === 'tencent-cloud' && active === 'tts' && <label>腾讯云音色编号<input type="number" min="1" value={String(current.options.voiceType ?? 101001)} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, voiceType: Number(event.target.value) } })}/></label>}
          {current.providerPresetId === 'ollama' && active === 'tts' && <p className="helper">选择已在 Ollama 安装的语音合成模型。音色由模型决定，可留空使用模型默认音色；本服务固定语速，教学慢速由手机播放器处理。</p>}
          {current.providerPresetId === 'ollama' && active === 'asr' && <p className="helper">模型名称填写已在 Ollama 安装的语音识别模型。后端容器必须能访问此地址；若 Ollama 运行在另一台设备，请修改 localhost 为该设备的内网地址。</p>}
          {current.providerPresetId === 'ollama' && active === 'embedding' && <p className="helper">模型名称填写已在 Ollama 安装的向量模型。后端容器必须能访问此地址；容器中的 localhost 指向容器自身。</p>}
          {current.providerPresetId === 'baidu-qianfan' && active === 'tts' && <label>音色 ID<input value={String(current.options.voiceId ?? '5003')} onChange={(event) => updateCurrent({ ...current, options: { ...current.options, voiceId: event.target.value } })}/></label>}
          <p className="helper">{active === 'pronunciation' ? '发音评测会将音频与目标文本一起发送。讯飞 ISE 需 16kHz 单声道音频；腾讯 SOE 使用签名 WebSocket；Azure 通过区域 Speech endpoint 评测。需先在对应控制台开通服务。' : active === 'asr' ? '此项只配置普通转写服务。音素级能力请在左侧单独配置。' : active === 'embedding' ? 'Embedding 用于后续的 Mem0 交互记忆语义检索和课程知识库 RAG。当前页面只保存平台、模型、接入点和密钥，尚未把未验证的向量检索结果用于教学决策。' : '填写平台账号凭据即可；接入地址可以编辑，以适应区域域名或供应商 API 地址变更。凭据在服务端使用 AES-256-GCM 加密后入库，页面不会回显已保存的密钥。'}</p>
          {(catalog.find((item) => item.id === current.providerPresetId)?.documentationUrls?.[active] ?? catalog.find((item) => item.id === current.providerPresetId)?.documentationUrl) && <a className="doclink" href={catalog.find((item) => item.id === current.providerPresetId)?.documentationUrls?.[active] ?? catalog.find((item) => item.id === current.providerPresetId)?.documentationUrl ?? ''} target="_blank" rel="noreferrer">打开此服务的官方接入文档 ↗</a>}
          {active !== 'embedding' && <section className="benchmark">
            <h3>自动运行评分</h3>
            <p className="helper">模型投入使用后自动按已完成调用统计速度分和平均响应时间。该指标反映线上运行表现；儿童教学效果仍需结合真实学习结果评估。</p>
            <div className="benchmark-list">{runtimeScores.map((item) => <div className="helper" key={`${item.providerAlias}-${item.modelAlias}`}>{item.providerAlias} · {item.modelAlias} · {item.scoreLabel} {item.latencyScore}/100 · 平均 {item.averageLatencyMs} ms · {item.calls} 次调用 · 最近 {new Date(item.lastUsedAt).toLocaleString()}</div>)}</div>
            {!runtimeScores.length && <p className="helper">尚无近 30 天调用数据；模型开始接收请求后会自动显示。</p>}
          </section>}
          <section className="benchmark">
            <h3>模型计价</h3>
            <p className="helper">按供应商账单填写人民币单价。空白表示尚未配置；明确免费的项目填 0。{active === 'embedding' ? 'Embedding 单价目前只作登记，语义检索链路接入后再纳入用量账本。' : 'Token 单价按每个 Token 填写，成本会写入用量账本。'}</p>
            <div className="fields">{priceFields[active].map(({ type, label }) => <label key={type}>{label}<input type="number" min="0" step="any" value={pricing[type] ?? ''} onChange={(event) => setPricing((old) => ({ ...old, [type]: event.target.value }))}/></label>)}</div>
            <button className="secondary" disabled={!current.modelAlias || busy} onClick={() => void savePrices()}>{busy ? '保存中…' : '保存模型单价'}</button>
          </section>
        </>}
        <footer><span className="status">{message}</span><button disabled={!current.providerPresetId || busy} onClick={() => void save()}>{busy ? '保存中…' : active === 'embedding' ? '保存配置' : '保存并应用'}</button></footer>
      </section></div></>
  </main>;
}

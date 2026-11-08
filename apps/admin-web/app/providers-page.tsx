'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminNav } from './admin-nav';

type ServiceKind = 'llm' | 'tts' | 'asr' | 'pronunciation';
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
const priceFields: Record<ServiceKind, Array<{ type: PriceType; label: string }>> = {
  llm: [
    { type: 'input_token', label: '输入 Token 单价（元/Token）' },
    { type: 'output_token', label: '输出 Token 单价（元/Token）' },
  ],
  tts: [{ type: 'per_character', label: '合成字符单价（元/字符）' }],
  asr: [{ type: 'per_second', label: '识别时长单价（元/秒）' }],
  pronunciation: [{ type: 'per_call', label: '单次评测单价（元/次）' }],
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
  const [pricing, setPricing] = useState<Partial<Record<PriceType, string>>>({});
  const [benchmarkScore, setBenchmarkScore] = useState('');
  const [benchmarkSamples, setBenchmarkSamples] = useState('');
  const [benchmarkPassed, setBenchmarkPassed] = useState(false);
  const [benchmarkNotes, setBenchmarkNotes] = useState('');
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

  useEffect(() => {
    if (!token) return;
    void loadPrices().catch((error) => setMessage(error instanceof Error ? error.message : '读取单价失败'));
  }, [active, token]);

  async function loadConfigs() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/configs`, { headers: { 'x-admin-token': token } });
    if (!res.ok) throw new Error((await res.json()).message ?? `读取失败 (${res.status})`);
    const rows: Config[] = await res.json();
    setConfigs((old) => ({ ...old, ...Object.fromEntries(rows.map((row) => [row.serviceKind, row])) }));
    await loadBenchmarks();
    setMessage('已读取现有配置。');
  }

  async function loadPrices() {
    const res = await fetch(`${apiRoot()}/api/v1/admin/model-providers/prices?serviceKind=${active}`, { headers: { 'x-admin-token': token } });
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
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ serviceKind: active, modelAlias: current.modelAlias, prices }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? `保存模型单价失败 (${res.status})`);
      setPricing(Object.fromEntries((body as ModelPrice[]).map((row) => [row.priceType, String(row.unitPrice)])));
      setMessage('模型单价已保存；后续用量将按实际 Token、字符或时长估算成本。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存模型单价失败');
    } finally {
      setBusy(false);
    }
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

  return <main className="shell"><AdminNav />
    <header className="topbar"><div><p className="eyebrow">AI LANGUAGE GROWTH</p><h1>模型接入</h1></div><div className="token"><label htmlFor="token">后台管理令牌</label><input id="token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ADMIN_CONFIG_TOKEN"/><button className="secondary" onClick={() => void loadConfigs().catch((error) => setMessage(error.message))}>读取配置</button></div></header>
    <><section className="notice"><strong>两类语音能力分开配置</strong><span>普通 ASR 只返回转写文本；音素级发音评测会对照目标文本评估发音，不会用转写结果代替评分。真实模型须先通过对应的儿童专项 Benchmark。</span></section>
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
          {current.providerPresetId === 'volcengine' && active === 'asr' && <div className="fields"><label>语音资源 ID<input value={String(current.options.resourceId ?? 'volc.bigasr.auc_turbo')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, resourceId: event.target.value } } }))}/></label><label>识别模型<input value={String(current.options.modelName ?? 'bigmodel')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, modelName: event.target.value } } }))}/></label></div>}
          {current.providerPresetId === 'tencent-cloud' && <label>腾讯云地域<input value={String(current.options.region ?? 'ap-guangzhou')} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, region: event.target.value } } }))} placeholder="例如 ap-guangzhou"/></label>}
          {current.providerPresetId === 'tencent-cloud' && active === 'asr' && <label>项目 ID<input type="number" min="0" value={String(current.options.projectId ?? 0)} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, projectId: Number(event.target.value) } } }))}/></label>}
          {current.providerPresetId === 'tencent-cloud' && active === 'tts' && <label>腾讯云音色编号<input type="number" min="1" value={String(current.options.voiceType ?? 101001)} onChange={(event) => setConfigs((old) => ({ ...old, [active]: { ...current, options: { ...current.options, voiceType: Number(event.target.value) } } }))}/></label>}
          {current.providerPresetId === 'ollama' && active === 'tts' && <p className="helper">选择已在 Ollama 安装的语音合成模型。音色由模型决定，可留空使用模型默认音色；本服务固定语速，教学慢速由手机播放器处理。</p>}
          {current.providerPresetId === 'ollama' && active === 'asr' && <p className="helper">模型名称填写已在 Ollama 安装的语音识别模型。后端容器必须能访问此地址；若 Ollama 运行在另一台设备，请修改 localhost 为该设备的内网地址。</p>}
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
          <section className="benchmark">
            <h3>模型计价</h3>
            <p className="helper">按供应商账单填写人民币单价。空白表示尚未配置；明确免费的项目填 0。Token 单价按每个 Token 填写，成本会写入用量账本。</p>
            <div className="fields">{priceFields[active].map(({ type, label }) => <label key={type}>{label}<input type="number" min="0" step="any" value={pricing[type] ?? ''} onChange={(event) => setPricing((old) => ({ ...old, [type]: event.target.value }))}/></label>)}</div>
            <button className="secondary" disabled={!token || !current.modelAlias || busy} onClick={() => void savePrices()}>{busy ? '保存中…' : '保存模型单价'}</button>
          </section>
        </>}
        <footer><span className="status">{message}</span><button disabled={!token || !current.providerPresetId || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存并应用'}</button></footer>
      </section></div></>
  </main>;
}

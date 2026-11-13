'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminNav } from './admin-nav';
import { AdminApiError, adminFetch } from './admin-auth';

type ServiceKind = 'llm' | 'tts' | 'asr' | 'pronunciation' | 'embedding';
type PriceType = 'input_token' | 'output_token' | 'per_1000_chars' | 'per_character' | 'per_second' | 'per_call';
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
  updatedAt?: string;
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
type FeedbackTone = 'info' | 'success' | 'error' | 'warn';
type Feedback = { tone: FeedbackTone; text: string };
type BenchmarkResult = {
  id: string;
  benchmarkType: string;
  score: number;
  sampleCount: number;
  passed: boolean;
  notes?: string | null;
  testedAt: string;
};
type BenchmarkModel = {
  modelAlias: string;
  level: string;
  enabled: boolean;
  benchmarks: BenchmarkResult[];
  latest: BenchmarkResult | null;
  productionReady: boolean;
};
type RouteReference = { taskRoute: string; role: 'primary' | 'fallback'; enabled: boolean };
type RoutingReferences = {
  configId: string;
  serviceKind: string;
  providerAlias: string;
  references: RouteReference[];
};
type DeletePrompt = {
  config: Config;
  label: string;
  serviceLabel: string;
  remainingEnabled: number;
  references: RouteReference[];
  referenceCheckOk: boolean;
  enabledPrimary: RouteReference[];
};
/**
 * 生成草稿主键。Web Crypto 的 UUID 生成接口只在安全上下文（HTTPS / localhost）可用，
 * 而管理端常以 http://<服务器IP>:3001 访问；此时直接调用会抛 TypeError，
 * 「新增模型配置」按钮点了毫无反应，正是「不能增」的直接根因。
 * 这里改为优先使用可选链安全取值，非安全上下文自动降级为时间戳 + 随机串。
 */
function newDraftKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  tts: [{ type: 'per_1000_chars', label: '合成字符单价（元/千字符）' }],
  asr: [{ type: 'per_second', label: '识别时长单价（元/秒）' }],
  pronunciation: [{ type: 'per_call', label: '单次评测单价（元/次）' }],
  embedding: [{ type: 'input_token', label: '输入 Token 单价（元/Token）' }],
};
const credentialLabels: Record<string, Array<[string, string]>> = {
  bailian: [['apiKey', '百炼 API Key']],
  volcengine: [['apiKey', '火山 API Key']],
  'baidu-qianfan': [['apiKey', '百度 API Key'], ['secretKey', '百度 Secret Key']],
  'iflytek-spark': [['appId', '讯飞 AppID'], ['apiKey', '讯飞服务 API Key'], ['apiSecret', '讯飞 API Secret']],
  minimax: [['apiKey', 'MiniMax API Key'], ['groupId', 'Group ID（如接口要求）']],
  siliconflow: [['apiKey', '硅基流动 API Key']],
  zhipu: [['apiKey', '智谱 API Key']],
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
  // serverConfigs 是服务端返回值快照：左侧启用徽标只读它，避免把本地「假启用」当成已生效。
  const [serverConfigs, setServerConfigs] = useState<Record<ServiceKind, Config[]>>({
    llm: [], tts: [], asr: [], pronunciation: [], embedding: [],
  });
  const [providerSwitched, setProviderSwitched] = useState<Partial<Record<ServiceKind, boolean>>>({});
  const [pendingDelete, setPendingDelete] = useState<DeletePrompt | null>(null);
  const [forceArmed, setForceArmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [backgroundError, setBackgroundError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [configLoadError, setConfigLoadError] = useState('');
  const [loadingConfigs, setLoadingConfigs] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runtimeScores, setRuntimeScores] = useState<RuntimeScore[]>([]);
  const [benchmarkModels, setBenchmarkModels] = useState<BenchmarkModel[]>([]);
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState('');
  const [pricing, setPricing] = useState<Partial<Record<PriceType, string>>>({});
  // 卸载后不再 setState；并发读取只认最后一次，避免旧响应覆盖新数据。
  const mountedRef = useRef(true);
  const configsRef = useRef(configs);
  const loadSeqRef = useRef(0);
  const configAbortRef = useRef<AbortController | null>(null);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const sessionExpiredRef = useRef(false);
  const service = services.find((item) => item.id === active)!;

  function notify(text: string, tone: FeedbackTone = 'info') {
    setFeedback({ text, tone });
  }
  const available = useMemo(() => catalog.filter((item) => item.services.includes(active)), [catalog, active]);
  const current = configs[active].find((item) => (item.id ?? item.draftKey) === activeConfigIds[active])
    ?? emptyConfig(active);
  const credentialFields = credentialLabels[current.providerPresetId] ?? [];
  const benchmarkModel = benchmarkModels.find((item) => item.modelAlias === current.modelAlias);
  const latestBenchmark = benchmarkModel?.latest ?? null;
  // 本地编辑与服务端快照的差异：启用开关等改动必须点「保存」才真正生效。
  const isDirty = useMemo(() => {
    const key = current.id ?? current.draftKey;
    if (!key) return false;
    if (!current.id) return true;
    const server = serverConfigs[active].find((item) => item.id === current.id);
    if (!server) return true;
    return (['providerPresetId', 'baseUrl', 'modelAlias', 'enabled', 'priority', 'timeoutMs'] as const)
      .some((field) => current[field] !== server[field])
      || JSON.stringify(current.options ?? {}) !== JSON.stringify(server.options ?? {});
  }, [current, serverConfigs, active]);
  /**
   * 编辑器必须始终绑定一条有稳定 key 的记录。
   * 旧实现在 activeConfigIds[active] 为空时，current 会退化成一次性的 emptyConfig()，
   * 编辑被追加成没有 id/draftKey 的「幽灵配置」：下拉框出现 value=""、React key 冲突，
   * 多条草稿时新增/编辑还会写错记录。这是「增 / 改」不可靠的根因之一。
   */
  function updateCurrent(next: Config) {
    const key = next.id ?? next.draftKey;
    if (!key) {
      const draftKey = newDraftKey();
      const materialized: Config = { ...next, draftKey };
      setConfigs((old) => ({ ...old, [active]: [...old[active], materialized] }));
      setActiveConfigIds((old) => ({ ...old, [active]: draftKey }));
      return;
    }
    setConfigs((old) => {
      const index = old[active].findIndex((item) => (item.id ?? item.draftKey) === key);
      return { ...old, [active]: index >= 0 ? old[active].map((item, i) => i === index ? next : item) : [...old[active], next] };
    });
    if (activeConfigIds[active] !== key) setActiveConfigIds((old) => ({ ...old, [active]: key }));
  }

  function addConfig() {
    const draftKey = newDraftKey();
    setConfigs((old) => ({ ...old, [active]: [...old[active], { ...emptyConfig(active), draftKey }] }));
    setActiveConfigIds((old) => ({ ...old, [active]: draftKey }));
    setCredentials((old) => ({ ...old, [active]: {} }));
    setProviderSwitched((old) => ({ ...old, [active]: false }));
    notify('已新建一条空白配置；填写后点击「保存并应用」即可创建，也可用下拉框切换回已有配置。', 'info');
  }

  // 草稿此前只能靠刷新页面丢弃，补一个明确的取消入口。
  function discardDraft() {
    const key = current.draftKey;
    if (!key || current.id) return;
    const remaining = configs[active].filter((item) => (item.id ?? item.draftKey) !== key);
    setConfigs((old) => ({ ...old, [active]: remaining }));
    setActiveConfigIds((old) => ({ ...old, [active]: remaining[0]?.id ?? remaining[0]?.draftKey }));
    setCredentials((old) => ({ ...old, [active]: {} }));
    setProviderSwitched((old) => ({ ...old, [active]: false }));
    notify('已取消这条未保存草稿。', 'info');
  }

  function selectConfig(value: string) {
    setActiveConfigIds((old) => ({ ...old, [active]: value }));
    // 凭据不会从服务端回显，切换配置时清空输入，避免把 A 配置的密钥误保存到 B。
    setCredentials((old) => ({ ...old, [active]: {} }));
    setProviderSwitched((old) => ({ ...old, [active]: false }));
  }

  const loadConfigs = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    configAbortRef.current?.abort();
    const controller = new AbortController();
    configAbortRef.current = controller;
    if (mountedRef.current) setLoadingConfigs(true);
    try {
      const body = await adminFetch<unknown>('/model-providers/configs', { signal: controller.signal });
      if (!mountedRef.current || seq !== loadSeqRef.current || controller.signal.aborted) return;
      const rows: Config[] = Array.isArray(body) ? body as Config[] : [];
      const grouped = Object.fromEntries(
        services.map(({ id }) => [id, rows.filter((row) => row.serviceKind === id)]),
      ) as Record<ServiceKind, Config[]>;
      // 手动刷新时保留尚未保存的本地草稿，避免把管理员正在填写的新配置冲掉。
      const previous = configsRef.current;
      const merged = { ...grouped };
      for (const { id } of services) {
        const drafts = (previous[id] ?? []).filter((item) => !item.id && item.draftKey);
        if (drafts.length) merged[id] = [...grouped[id], ...drafts];
      }
      setConfigs(merged);
      setServerConfigs(grouped);
      setPendingDelete(null);
      setProviderSwitched({});
      setActiveConfigIds((old) => {
        const next: Partial<Record<ServiceKind, string>> = {};
        for (const { id } of services) {
          const list = merged[id];
          const key = old[id];
          const stillSelected = Boolean(key && list.some((item) => (item.id ?? item.draftKey) === key));
          next[id] = stillSelected ? key : (list[0]?.id ?? list[0]?.draftKey);
        }
        return next;
      });
      sessionExpiredRef.current = false;
      setSessionExpired(false);
      setConfigLoadError('');
      setFeedback({ tone: 'success', text: rows.length
        ? `已自动读取 ${rows.length} 条已保存配置。`
        : '尚无已保存配置，可直接新增第一条模型配置。' });
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current || seq !== loadSeqRef.current) return;
      const text = error instanceof Error ? error.message : '读取配置失败';
      const expired = error instanceof AdminApiError
        ? error.status === 401 || error.status === 403
        : text.includes('登录已失效');
      sessionExpiredRef.current = expired;
      setSessionExpired(expired);
      setConfigLoadError(text);
      setFeedback({ tone: 'error', text });
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) setLoadingConfigs(false);
    }
  }, []);

  // 目录读取与配置读取彻底解耦：任一失败都不连坐另一条链路，各自有独立错误与重试。
  const loadCatalog = useCallback(async () => {
    catalogAbortRef.current?.abort();
    const controller = new AbortController();
    catalogAbortRef.current = controller;
    try {
      const presets = await adminFetch<Preset[]>('/model-providers/catalog', { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setCatalog(presets);
      setCatalogError('');
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setCatalogError(error instanceof Error ? error.message : '读取供应商目录失败');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      configAbortRef.current?.abort();
      catalogAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => { configsRef.current = configs; }, [configs]);

  useEffect(() => {
    // 进入页面即自动拉取；AdminAuthGate 在 /auth/me 确认登录后才会挂载本组件，
    // 因此「登录完成后」同样会触发这里，不需要再人工点「读取配置」。
    // 两条链路分别 await，任一失败不会连带丢弃另一个的结果。
    void loadConfigs();
    void loadCatalog();
  }, []);

  // 会话过期后重新登录或切回本页时自动重试，不再依赖人工点「读取配置」。
  useEffect(() => {
    const retryAfterReauth = () => {
      if (document.visibilityState !== 'hidden' && sessionExpiredRef.current) void loadConfigs();
    };
    window.addEventListener('focus', retryAfterReauth);
    document.addEventListener('visibilitychange', retryAfterReauth);
    return () => {
      window.removeEventListener('focus', retryAfterReauth);
      document.removeEventListener('visibilitychange', retryAfterReauth);
    };
  }, [loadConfigs]);

  useEffect(() => {
    if (active === 'embedding') {
      setRuntimeScores([]);
      return;
    }
    const controller = new AbortController();
    void adminFetch<RuntimeScore[]>(`/model-providers/runtime-scores?serviceKind=${active}`, { signal: controller.signal })
      .then((rows) => {
        if (mountedRef.current && !controller.signal.aborted) {
          setRuntimeScores(rows);
          setBackgroundError('');
        }
      })
      .catch((error) => {
        if (mountedRef.current && !controller.signal.aborted) {
          setBackgroundError(error instanceof Error ? error.message : '读取自动评分失败');
        }
      });
    return () => controller.abort();
  }, [active]);

  useEffect(() => {
    const controller = new AbortController();
    setPricing({});
    void loadPrices(controller.signal).catch((error) => {
      if (mountedRef.current && !controller.signal.aborted) {
        setBackgroundError(error instanceof Error ? error.message : '读取单价失败');
      }
    });
    return () => controller.abort();
  }, [active, activeConfigIds[active], current.id, current.modelAlias]);

  async function loadPrices(signal?: AbortSignal) {
    const body = await adminFetch<unknown>(
      `/model-providers/prices?serviceKind=${active}${current.id ? `&configId=${current.id}` : ''}`,
      { signal },
    );
    const rows: ModelPrice[] = Array.isArray(body) ? body as ModelPrice[] : [];
    if (signal?.aborted || !mountedRef.current) return;
    // 历史 per_character 价格换算成“元/千字符”展示，避免切换口径后丢失已有配置。
    const normalized = rows.map((row) => row.priceType === 'per_character' && active === 'tts'
      ? { ...row, priceType: 'per_1000_chars' as const, unitPrice: row.unitPrice * 1000 }
      : row);
    setPricing(Object.fromEntries(normalized.map((row) => [row.priceType, String(row.unitPrice)])));
    setBackgroundError('');
  }

  const loadBenchmarks = useCallback(async (signal?: AbortSignal) => {
    if (active === 'embedding' || !current.id) {
      if (!signal?.aborted && mountedRef.current) setBenchmarkModels([]);
      return;
    }
    const body = await adminFetch<BenchmarkModel[]>(
      `/model-providers/benchmarks?serviceKind=${active}&configId=${current.id}`,
      { signal },
    );
    if (signal?.aborted || !mountedRef.current) return;
    setBenchmarkModels(Array.isArray(body) ? body : []);
    setBenchmarkError('');
  }, [active, current.id]);

  async function runBenchmark() {
    if (!current.id || benchmarkBusy || busy) return;
    setBenchmarkBusy(true);
    setBenchmarkError('');
    try {
      const result = await adminFetch<BenchmarkResult>('/model-providers/benchmarks/run', {
        method: 'POST',
        body: JSON.stringify({ serviceKind: active, configId: current.id }),
      });
      await loadBenchmarks();
      notify(result.passed
        ? `Benchmark 通过：${result.score}/100，样本 ${result.sampleCount} 次。可用于生产准入。`
        : `Benchmark 未通过：${result.score}/100，样本 ${result.sampleCount} 次。请查看最近结果中的门槛说明。`,
      result.passed ? 'success' : 'warn');
    } catch (error) {
      const text = error instanceof Error ? error.message : '运行 Benchmark 失败';
      setBenchmarkError(text);
      notify(text, 'error');
      if (text.includes('登录已失效')) { sessionExpiredRef.current = true; setSessionExpired(true); }
    } finally {
      if (mountedRef.current) setBenchmarkBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setBenchmarkModels([]);
    setBenchmarkError('');
    void loadBenchmarks(controller.signal).catch((error) => {
      if (mountedRef.current && !controller.signal.aborted) {
        setBenchmarkError(error instanceof Error ? error.message : '读取 Benchmark 结果失败');
      }
    });
    return () => controller.abort();
  }, [active, current.id, loadBenchmarks]);

  async function savePrices() {
    setBusy(true);
    try {
      const prices = priceFields[active]
        .filter(({ type }) => pricing[type] !== undefined && pricing[type] !== '')
        .map(({ type }) => ({ priceType: type, unitPrice: Number(pricing[type]) }));
      const body = await adminFetch<ModelPrice[]>('/model-providers/prices', {
        method: 'PUT',
        body: JSON.stringify({ serviceKind: active, configId: current.id, modelAlias: current.modelAlias, prices }),
      });
      if (mountedRef.current) setPricing(Object.fromEntries((Array.isArray(body) ? body : []).map((row) => [row.priceType, String(row.unitPrice)])));
      notify(active === 'embedding'
        ? 'Embedding 参考单价已保存；接入检索调用链后才能纳入实际成本核算。'
        : '模型单价已保存；后续用量将按实际 Token、字符或时长估算成本。', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '保存模型单价失败', 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function chooseProvider(id: string) {
    const preset = catalog.find((item) => item.id === id);
    const switched = Boolean(current.providerPresetId && current.providerPresetId !== id);
    // 换平台后旧平台凭据不再适用：清除「已有凭据」标记，避免留空被误当成「保留原凭据」
    // 而静默产出一条没有密钥的配置。
    const next: Config = {
      ...current,
      providerPresetId: id,
      baseUrl: preset?.defaultBaseUrls[active] ?? '',
      modelAlias: id,
      credentialConfigured: false,
      options: id === 'azure-speech' ? { region: 'eastus' } : {},
    };
    updateCurrent(next);
    setCredentials((old) => ({ ...old, [active]: {} }));
    if (switched) setProviderSwitched((old) => ({ ...old, [active]: true }));
  }

  async function save() {
    if (busy || deleting) return;
    if (!current.providerPresetId) { notify('请先选择预置平台。', 'error'); return; }
    if (!current.baseUrl.trim()) { notify('请填写接入地址后再保存。', 'error'); return; }
    if (!current.modelAlias.trim()) { notify('请填写模型名称后再保存。', 'error'); return; }
    setBusy(true);
    notify(active === 'embedding' ? '正在保存 Embedding 配置…' : '正在保存并切换运行时模型…', 'info');
    try {
      const saved = await adminFetch<Config>('/model-providers/configs', {
        method: 'PUT',
        body: JSON.stringify({ ...current, serviceKind: active, credentials: credentials[active] }),
      });
      const key = current.id ?? current.draftKey ?? activeConfigIds[active];
      setConfigs((old) => {
        const index = old[active].findIndex((item) => (item.id ?? item.draftKey) === key);
        return { ...old, [active]: index >= 0 ? old[active].map((item, i) => i === index ? saved : item) : [...old[active], saved] };
      });
      setServerConfigs((old) => {
        const index = old[active].findIndex((item) => item.id === saved.id);
        return { ...old, [active]: index >= 0 ? old[active].map((item, i) => i === index ? saved : item) : [...old[active], saved] };
      });
      setActiveConfigIds((old) => ({ ...old, [active]: saved.id }));
      setCredentials((old) => ({ ...old, [active]: {} }));
      setProviderSwitched((old) => ({ ...old, [active]: false }));
      notify(current.id
        ? '已更新该模型配置；密钥留空时保留原有凭据。'
        : (active === 'embedding'
          ? '新配置已加密保存。当前尚未接入语义检索调用链，不会发送向量请求。'
          : '新配置已加密保存并应用；后续调用会自动记录运行速度分。'), 'success');
    } catch (error) {
      const text = error instanceof Error ? error.message : '保存失败';
      notify(text, 'error');
      if (text.includes('登录已失效')) {
        sessionExpiredRef.current = true;
        setSessionExpired(true);
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  // 第一次点击「删除当前配置」只打开二次确认面板；真正删除在 confirmDelete。
  async function prepareDelete() {
    if (!current.id || deleting || busy) return;
    const target = current;
    const presetName = catalog.find((item) => item.id === target.providerPresetId)?.name ?? target.providerPresetId;
    const label = `${presetName} · ${target.modelAlias || '未命名模型'}`;
    let references: RouteReference[] = [];
    let referenceCheckOk = false;
    try {
      const data = await adminFetch<RoutingReferences>(`/model-providers/configs/${target.id}/references`);
      references = Array.isArray(data.references) ? data.references : [];
      referenceCheckOk = true;
    } catch {
      referenceCheckOk = false;
    }
    const enabledPrimary = references.filter((item) => item.role === 'primary' && item.enabled);
    const remainingEnabled = serverConfigs[active].filter((item) => item.enabled && item.id !== target.id).length;
    setForceArmed(false);
    setPendingDelete({
      config: target,
      label,
      serviceLabel: service.title,
      remainingEnabled,
      references,
      referenceCheckOk,
      enabledPrimary,
    });
    if (enabledPrimary.length) {
      notify(`该配置仍是 ${enabledPrimary.length} 条已启用任务路由的首选模型；请先到「任务路由」改选其他模型。`, 'warn');
    }
  }

  // 「改为停用」替代动作：不删除记录，凭据仍在，避免误删正在使用的模型。
  async function disableInstead() {
    if (!pendingDelete || busy || deleting) return;
    const target = pendingDelete.config;
    if (!target.id) return;
    const force = Boolean(forceArmed && target.enabled && pendingDelete.remainingEnabled === 0);
    setBusy(true);
    try {
      const saved = await adminFetch<Config>('/model-providers/configs', {
        method: 'PUT',
        body: JSON.stringify({ ...target, serviceKind: active, enabled: false, credentials: {}, force }),
      });
      setConfigs((old) => ({ ...old, [active]: old[active].map((item) => item.id === target.id ? saved : item) }));
      setServerConfigs((old) => ({ ...old, [active]: old[active].map((item) => item.id === target.id ? saved : item) }));
      setCredentials((old) => ({ ...old, [active]: {} }));
      setPendingDelete(null);
      notify('已改为停用并保存；运行时会立即刷新，请确认该服务仍有其他启用配置。', 'success');
    } catch (error) {
      const text = error instanceof Error ? error.message : '停用失败';
      notify(text, 'error');
      if (text.includes('登录已失效')) { sessionExpiredRef.current = true; setSessionExpired(true); }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting || busy) return;
    const target = pendingDelete.config;
    if (!target.id) return;
    const hadReferences = pendingDelete.references.length > 0;
    const force = Boolean(forceArmed && target.enabled && pendingDelete.remainingEnabled === 0);
    setDeleting(true);
    setBusy(true);
    try {
      const id = target.id;
      await adminFetch<unknown>(`/model-providers/configs/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
      const remaining = configs[active].filter((item) => item.id !== id);
      setConfigs((old) => ({ ...old, [active]: remaining }));
      setServerConfigs((old) => ({ ...old, [active]: old[active].filter((item) => item.id !== id) }));
      setActiveConfigIds((old) => ({ ...old, [active]: remaining[0]?.id ?? remaining[0]?.draftKey }));
      setCredentials((old) => ({ ...old, [active]: {} }));
      setProviderSwitched((old) => ({ ...old, [active]: false }));
      setPendingDelete(null);
      notify(hadReferences
        ? '配置已删除；请到「任务路由」把曾引用它的规则改指向其他模型。'
        : '当前供应商配置已删除。', 'success');
    } catch (error) {
      const text = error instanceof Error ? error.message : '删除失败';
      notify(text, 'error');
      if (text.includes('登录已失效')) { sessionExpiredRef.current = true; setSessionExpired(true); }
    } finally {
      if (mountedRef.current) { setDeleting(false); setBusy(false); }
    }
  }

  return <main className="shell"><AdminNav />
    <header className="topbar">
      <div><p className="eyebrow">AI LANGUAGE GROWTH</p><h1>模型接入</h1><p className="muted">进入页面即自动读取已保存配置；可新增、切换编辑、删除单条配置。</p></div>
      <button className="secondary" type="button" disabled={loadingConfigs || busy || deleting} onClick={() => void loadConfigs()}>
        {loadingConfigs ? '读取中…' : '重新读取配置'}
      </button>
    </header>
    {sessionExpired && <div className="feedback error" role="alert">管理登录已失效，配置读取已暂停；重新登录后本页会自动重试。<button className="secondary" type="button" onClick={() => window.location.reload()}>重新登录</button></div>}
    {feedback && <div className={`feedback ${feedback.tone}`} role="status">{feedback.text}</div>}
    {backgroundError && <div className="feedback warn" role="status">辅助数据读取提示：{backgroundError}（不影响配置的新增、编辑与删除）</div>}
    {catalogError && <div className="feedback error" role="alert">供应商目录读取失败：{catalogError}<button className="secondary" type="button" onClick={() => void loadCatalog()}>重试读取目录</button></div>}
    {configLoadError && !loadingConfigs && <div className="feedback error" role="alert">模型配置读取失败：{configLoadError}<button className="secondary" type="button" onClick={() => void loadConfigs()}>重试读取配置</button>{sessionExpired && <button type="button" onClick={() => window.location.reload()}>重新登录</button>}</div>}
    {pendingDelete && <section className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-head"><div><p className="eyebrow">DELETE CONFIRMATION</p><h2>确认删除模型配置</h2><p className="muted">删除不可撤销，已加密保存的凭据会一并清除；保存 / 删除 / 停用都会立即刷新运行时 provider。</p></div></div>
      <div className="fields">
        <label>平台 · 模型<input readOnly value={pendingDelete.label} /></label>
        <label>服务类型<input readOnly value={pendingDelete.serviceLabel} /></label>
        <label>当前是否启用<input readOnly value={pendingDelete.config.enabled ? '已启用' : '已停用'} /></label>
        <label>删除后该服务剩余启用配置<input readOnly value={`${pendingDelete.remainingEnabled} 条`} /></label>
      </div>
      {pendingDelete.config.enabled && pendingDelete.remainingEnabled === 0 && <div className="feedback error" role="alert">这是该服务最后一个启用配置。删除或停用会使运行时回落 Mock，可能影响正在上课的儿童下一回合；建议先新增并启用替代配置，或选择「取消」。未勾选下方确认项时，后端会直接拒绝该操作。</div>}
      {pendingDelete.config.enabled && pendingDelete.remainingEnabled === 0 && <label className="switch" style={{ marginBottom: 12 }}><input type="checkbox" checked={forceArmed} onChange={(event) => setForceArmed(event.target.checked)} /><span>我已知晓这是最后一个启用配置，强制继续会影响在课会话</span></label>}
      {!!pendingDelete.enabledPrimary.length && <div className="feedback error" role="alert">该配置仍是 {pendingDelete.enabledPrimary.length} 条已启用任务路由的首选模型（{pendingDelete.enabledPrimary.map((item) => item.taskRoute).join('、')}），删除会留下悬空引用；请先到「任务路由」改选其他模型。</div>}
      {pendingDelete.references.length > 0 && <p className="helper">该配置仍被 {pendingDelete.references.length} 处任务路由引用：{pendingDelete.references.map((item) => `${item.taskRoute}（${item.role === 'primary' ? '首选' : '备用'}${item.enabled ? '' : '，路由已停用'}）`).join('；')}。删除后这些引用会悬空，请先到「任务路由」调整。</p>}
      {!pendingDelete.referenceCheckOk && <p className="helper">暂时无法核对任务路由引用情况；若该模型已被设为首选或备用，删除后相关路由可能失效，请先到「任务路由」确认。</p>}
      {pendingDelete.referenceCheckOk && !pendingDelete.references.length && <p className="helper">已确认该配置当前没有被任何任务路由设为首选或备用。</p>}
      <div className="row-actions" style={{ marginTop: 12 }}>
        <button className="secondary" type="button" onClick={() => { setPendingDelete(null); setForceArmed(false); }}>取消</button>
        <button className="secondary" type="button" disabled={busy || deleting} onClick={() => void disableInstead()}>{busy ? '处理中…' : '改为停用（推荐）'}</button>
        <button type="button" disabled={busy || deleting || pendingDelete.enabledPrimary.length > 0} onClick={() => void confirmDelete()}>{deleting ? '删除中…' : '确认删除'}</button>
      </div>
    </section>}
    <><section className="notice"><strong>{active === 'embedding' ? '语义检索模型配置' : '两类语音能力分开配置'}</strong><span>{active === 'embedding' ? 'Embedding 是 Mem0 语义记忆与课程 RAG 的基础能力。当前先保存服务商和模型配置，检索链路接入并验证前不会调用该模型。' : '普通 ASR 只返回转写文本；音素级发音评测会对照目标文本评估发音，不会用转写结果代替评分。启用配置后按优先级自动调用并故障切换。'}</span></section>
    <div className="workspace"><nav className="services">{services.map((item) => <button key={item.id} className={active === item.id ? 'service active' : 'service'} onClick={() => setActive(item.id)}><span>{item.title}</span><small>{item.help}</small><i>{serverConfigs[item.id].some((config) => config.enabled) ? item.id === 'embedding' ? '已配置' : '已启用' : '未启用'}</i></button>)}</nav>
      <section className="panel"><div className="panel-head"><div><p className="eyebrow">{service.id.toUpperCase()}</p><h2>{service.title}</h2><p className="muted">{service.help}</p></div></div>
        {loadingConfigs && <p className="status">正在读取已保存的模型配置…</p>}
        {!loadingConfigs && !configs[active].length && <p className="helper">该服务尚未保存任何模型配置。点击「新增模型配置」，或直接选择预置平台开始填写第一条记录。</p>}
        <div className="fields" style={{ marginTop: 16 }}>
          <label>编辑：选择具体配置记录
            <select value={activeConfigIds[active] ?? ''} onChange={(event) => selectConfig(event.target.value)}>
              {!configs[active].length && <option value="">尚无配置</option>}
              {configs[active].map((item) => <option key={item.id ?? item.draftKey} value={item.id ?? item.draftKey}>
                {item.providerPresetId ? catalog.find((preset) => preset.id === item.providerPresetId)?.name ?? item.providerPresetId : '未选择供应商'}
                {' · '}{item.modelAlias || '未命名模型'} · {item.enabled ? '已启用' : '已停用'} · 优先级 {item.priority ?? 100}{item.id ? '' : ' · 未保存'}
              </option>)}
            </select>
            <small>{configs[active].length ? `已配置 ${configs[active].length} 个模型；选中后下方编辑器即编辑该条记录，运行时按优先级自动切换。` : '添加第一个模型配置后即可设置服务商和密钥。'}</small>
          </label>
          <div className="row-actions" style={{ alignItems: 'flex-start' }}>
            <button className="secondary" type="button" disabled={busy || deleting} onClick={addConfig}>新增模型配置</button>
            {current.draftKey && !current.id && <button className="secondary" type="button" disabled={busy || deleting} onClick={discardDraft}>取消新增草稿</button>}
            {current.id && <button className="secondary" type="button" disabled={busy || deleting} onClick={() => void prepareDelete()}>{deleting ? '删除中…' : '删除当前配置'}</button>}
            <button className="secondary" type="button" disabled={loadingConfigs || busy || deleting} onClick={() => void loadConfigs()}>{loadingConfigs ? '读取中…' : '刷新配置'}</button>
          </div>
        </div>
        <div className="panel-head" style={{ marginTop: 22 }} key={`config-editor-${active}-${activeConfigIds[active] ?? 'new'}`}><div><p className="eyebrow">SELECTED CONFIGURATION</p><h3>编辑当前配置</h3></div><label className="switch"><input type="checkbox" checked={current.enabled} onChange={(event) => {
        const next = { ...current, enabled: event.target.checked };
        updateCurrent(next);
      }}/><span>{active === 'embedding' ? '设为默认配置' : '启用'}</span></label></div>
        {(current.id || isDirty) && <p className="helper">
          {current.id
            ? `已配置 · 最后同步 ${current.updatedAt ? new Date(current.updatedAt).toLocaleString() : '—'}`
            : '未保存草稿'}
          {isDirty ? ' · 有未保存修改（含启用开关），需点击「保存并应用」才生效' : ' · 与服务端一致'}
        </p>}
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
          {credentialFields.length > 0 && <div className="fields credentials">{credentialFields.map(([key, label]) => <label key={key}>{label}<input type="password" autoComplete="new-password" value={credentials[active][key] ?? ''} onChange={(event) => setCredentials((old) => ({ ...old, [active]: { ...old[active], [key]: event.target.value } }))} placeholder={providerSwitched[active] ? '更换平台需重新填写密钥' : current.credentialConfigured ? '已有凭据；留空保留已保存值' : `输入${label}`}/></label>)}</div>}
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
            <h3>运行准入 Benchmark</h3>
            <p className="helper">基于当前配置近 30 天真实账本评估运行可用性，不调用供应商、不伪造样本。门槛按服务类型检查调用次数、平均延迟和 P95；mock 模式只评估，生产模式（AI_GATEWAY_MODE=live）下最近一次未通过会禁止启用该配置和写入已启用路由。</p>
            <div className="row-actions">
              <button className="secondary" type="button" disabled={!current.id || benchmarkBusy || busy} onClick={() => void runBenchmark()}>{benchmarkBusy ? '运行中…' : '运行 Benchmark'}</button>
              {latestBenchmark && <span className={`status ${latestBenchmark.passed ? 'success' : 'error'}`}>最近一次：{latestBenchmark.passed ? '通过' : '未通过'} · {latestBenchmark.score}/100 · 样本 {latestBenchmark.sampleCount} 次</span>}
              {benchmarkModel?.productionReady && <span className="status success">生产准入已通过</span>}
            </div>
            {benchmarkError && <div className="feedback error" role="alert">{benchmarkError}</div>}
            {!current.id && <p className="helper">先保存配置，产生真实调用后再运行 Benchmark。</p>}
            {current.id && !latestBenchmark && <p className="helper">尚无 Benchmark 结果。首次运行若没有真实调用，会如实记录“样本不足”，不会伪造通过。</p>}
            {latestBenchmark && <div className="benchmark-list">
              <div className="helper">{new Date(latestBenchmark.testedAt).toLocaleString()} · {latestBenchmark.benchmarkType} · {latestBenchmark.passed ? '通过' : '未通过'}</div>
              <div className="helper">{latestBenchmark.notes}</div>
              {benchmarkModel && benchmarkModel.benchmarks.length > 1 && <div className="helper">更早结果：{benchmarkModel.benchmarks.slice(1, 4).map((item) => `${new Date(item.testedAt).toLocaleDateString()} ${item.passed ? '通过' : '未通过'} ${item.score}/100`).join('；')}</div>}
            </div>}
          </section>}
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
        <footer><span className={`status ${feedback?.tone ?? ''}`}>{feedback?.text ?? ''}</span><button type="button" disabled={!current.providerPresetId || busy || deleting} onClick={() => void save()}>{busy ? '保存中…' : active === 'embedding' ? '保存配置' : '保存并应用'}</button></footer>
      </section></div></>
  </main>;
}

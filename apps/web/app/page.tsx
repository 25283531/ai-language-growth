'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  API_BASE,
  buildTurnRequestBody,
  finishLesson,
  getAbilities,
  getEvidence,
  getGrowthArchive,
  getHealth,
  getUsage,
  isTurnResponse,
  newIdempotencyKey,
  sendTurn,
  startLesson,
  synthesize,
  stableStringify,
} from './api';
import type {
  AbilitiesResponse,
  DegradedTurnBody,
  EvidenceRow,
  GrowthArchiveResponse,
  HealthResponse,
  LessonFinishResponse,
  ResponseForm,
  SynthesizeResponse,
  TeachingDirective,
  TurnRequestBody,
  TurnResponse,
  UsageSummary,
  SpeechPayload,
} from './types';

const TOPICS = [
  { id: 'topic-greetings', label: '问候' },
  { id: 'topic-self-introduction', label: '自我介绍' },
  { id: 'topic-objects-around', label: '身边物品' },
];

const IMAGE_IDS = ['img-apple', 'img-ball', 'img-cat', 'img-dog', 'img-cup', 'img-hello', 'img-letter-a'];

/**
 * 真实 TTS 返回平台内音频路径，可直接播放；Mock 返回占位引用，不渲染播放器。
 * Web 只播放后端给出的音频，不自行合成、不改写教学文本。
 */
function playableAudioUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('/')) return ref;
  return null;
}

/**
 * 场景枚举参考：仅供 UI 展示对照，Web 不据此校验后端数据、不做任何教学判断。
 * 与 shared-contracts 的 EVIDENCE_SCENARIOS 对齐；旧的「媒体形式」场景值已废弃。
 */
const EVIDENCE_SCENARIOS = [
  'greeting_scene',
  'self_intro_scene',
  'object_pic_scene',
  'object_shop_scene',
  'free_chat_scene',
  'story_scene',
  'review_scene',
  'assessment_scene',
] as const;

const DEFAULT_FORM: ResponseForm = {
  text: '',
  audioRef: '',
  selectedImageId: '',
  freeUtterance: '',
  requestedRepeat: false,
  requestedSlower: false,
};

type LogKind = 'ok' | 'err' | 'info';
interface LogEntry {
  at: string;
  kind: LogKind;
  title: string;
  detail?: string;
}

function Badge({ tone = 'muted', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function KV({ rows }: { rows: Array<{ k: string; v: ReactNode }> }) {
  return (
    <div className="kv">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <span className="k">{r.k}</span>
          <span className="v">{r.v ?? <span className="hint">—</span>}</span>
        </div>
      ))}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        {right}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

function YesNo({ value }: { value: boolean }) {
  return <span className={value ? 'ok-text' : 'err-text'}>{value ? '是' : '否'}</span>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function fmtCost(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : String(n);
}

type ClassroomViewProps = {
  directive: TeachingDirective | null;
  speech: SpeechPayload | null;
  topicName: string | null;
  sessionId: string | null;
  busy: boolean;
  onStart: () => void;
  onReplay: () => void;
  onSubmit: (text: string) => void;
  onOpenWorkbench: () => void;
};

/** 面向儿童的真实课堂入口：先教，再听，再跟读，再进入下一步。 */
function ClassroomView({
  directive,
  speech,
  topicName,
  sessionId,
  busy,
  onStart,
  onReplay,
  onSubmit,
  onOpenWorkbench,
}: ClassroomViewProps) {
  const [step, setStep] = useState(0);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [showHint, setShowHint] = useState(false);
  const word = directive?.targetWords?.[0] ?? 'hello';
  const phonetic = word.toLowerCase() === 'hello' ? '/həˈləʊ/' : '跟着老师的声音读一读';
  const teacherText = directive?.teacherUtterance ?? '小朋友，今天我们来认识一个新单词。先听老师说一遍，然后在心里跟着说一遍。';
  const example = directive?.demonstrationText ?? 'Hello! Nice to meet you.';
  const steps = ['认识单词', '听一听', '跟着读', '用一用'];

  function startListening() {
    const SpeechRecognition = (window as typeof window & { webkitSpeechRecognition?: new () => { lang: string; start: () => void; onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void } }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setHeard('hello');
      setListening(false);
      onSubmit('hello');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript;
      setHeard(text);
      onSubmit(text);
    };
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  return (
    <main className="classroom-shell">
      <header className="classroom-header">
        <div className="classroom-brand"><span className="brand-mark">A</span><div><b>小小英语课堂</b><span>AI 陪你开口说英语</span></div></div>
        <div className="classroom-header-actions"><span className="lesson-pill">第 1 课 · {topicName ?? '问候语'}</span><button className="text-button" onClick={onOpenWorkbench}>开发者工作台</button></div>
      </header>
      <div className="lesson-progress"><div className="progress-label"><span>今天的课堂</span><b>{steps[step]}</b></div><div className="progress-track">{steps.map((item, index) => <button key={item} className={`progress-dot ${index <= step ? 'done' : ''} ${index === step ? 'current' : ''}`} onClick={() => setStep(index)}><span>{index + 1}</span>{item}</button>)}</div></div>
      {!sessionId ? (
        <section className="welcome-card">
          <div className="welcome-illustration" aria-hidden="true">👋</div>
          <div><p className="eyebrow">READY TO LEARN?</p><h1>你好！准备好和老师<br /><em>一起说英语</em>了吗？</h1><p>今天我们学习最常用的问候语，从第一个单词开始，听、说、用，一步一步学会它。</p><button className="start-class-btn" onClick={onStart} disabled={busy}>开始今天的课堂 <span>→</span></button></div>
        </section>
      ) : (
        <section className="lesson-layout">
          <div className="lesson-main-card">
            <div className="lesson-kicker"><span className="live-dot" /> 老师正在教你</div>
            <div className="word-stage"><div className="word-label">今天的单词</div><div className="hero-word">{word}</div><div className="phonetic">{phonetic}</div><button className="sound-button" onClick={onReplay} disabled={busy}><span>▶</span> 听老师读一遍</button></div>
            <div className="teacher-bubble"><div className="teacher-avatar">👩🏻‍🏫</div><div><b>老师说</b><p>{teacherText}</p></div></div>
            <div className="lesson-actions"><button className="primary-lesson-btn" onClick={startListening} disabled={busy || listening}><span>{listening ? '🎙️' : '🎤'}</span>{listening ? '正在听你说…' : '按住说一说'}</button><button className="secondary-lesson-btn" onClick={() => setStep(Math.min(step + 1, steps.length - 1))}>下一步 <span>→</span></button></div>
            {heard && <div className="heard-result">我听到你说：<b>{heard}</b> · 太棒了，再试一次也可以！</div>}
          </div>
          <aside className="lesson-side-card"><div className="side-title"><span>课堂小贴士</span><span className="sparkle">✦</span></div><div className="tip-visual">💬</div><h3>什么时候用 hello？</h3><p>见到别人、和别人打招呼的时候，就可以说 <b>hello</b>。它就像中文里的“你好”。</p><div className="example-card"><span>试着这样说</span><strong>{example}</strong><button onClick={onReplay}>▶ 再听一遍</button></div><button className="hint-button" onClick={() => setShowHint(!showHint)}>{showHint ? '收起发音提示' : '查看发音小窍门'} <span>＋</span></button>{showHint && <div className="pronunciation-hint">先轻轻呼气发 <b>h</b>，再说 <b>he</b>，最后嘴巴咧开说 <b>lo</b>。慢慢来，不着急。</div>}<div className="side-footer">完成这一步后，老师会带你学习短语和句子。</div></aside>
        </section>
      )}
      <footer className="classroom-footer"><span>每一次开口，都是一次进步 ✨</span><span>课堂会话：{sessionId ? '进行中' : '尚未开始'}</span></footer>
    </main>
  );
}

export default function WorkbenchPage() {
  const [learnerId, setLearnerId] = useState<string>('child-m1-demo');
  const [topicId, setTopicId] = useState<string>(TOPICS[0].id);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [topicName, setTopicName] = useState<string | null>(null);
  const [directive, setDirective] = useState<TeachingDirective | null>(null);
  const [speech, setSpeech] = useState<SpeechPayload | null>(null);
  // 单文件方案下 audioRef 即整轮完整音频；仅当 audioRef 缺失时才回退到 segments[0]
  // （回滚期旧服务端可能只给 segments）。speech.scope 等 additive 字段被 TS/JSON 忽略。
  const playableSpeechRef =
    speech?.audioRef ?? (speech as { segments?: Array<{ audioRef: string }> } | null)?.segments?.[0]?.audioRef ?? null;

  const [lastTurn, setLastTurn] = useState<TurnResponse | null>(null);
  const [lastTurnError, setLastTurnError] = useState<DegradedTurnBody | null>(null);
  const [finishResult, setFinishResult] = useState<LessonFinishResponse | null>(null);

  const [form, setForm] = useState<ResponseForm>(DEFAULT_FORM);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [lastBody, setLastBody] = useState<TurnRequestBody | null>(null);
  const [lastRaw, setLastRaw] = useState<string | null>(null);
  const [idempotentMatch, setIdempotentMatch] = useState<boolean | null>(null);

  const [replay, setReplay] = useState<SynthesizeResponse | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const [abilities, setAbilities] = useState<AbilitiesResponse | null>(null);
  const [abilitiesError, setAbilitiesError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [growthArchive, setGrowthArchive] = useState<GrowthArchiveResponse | null>(null);
  const [growthArchiveError, setGrowthArchiveError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [classroomMode, setClassroomMode] = useState(true);
  const isBusy = busy !== null;

  const pushLog = useCallback((kind: LogKind, title: string, detail?: string) => {
    setLogs((prev) =>
      [
        { at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), kind, title, detail },
        ...prev,
      ].slice(0, 60),
    );
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await getHealth());
      setHealthError(null);
    } catch (error) {
      setHealth(null);
      setHealthError((error as Error).message);
    }
  }, []);

  const refreshPanels = useCallback(async () => {
    const [a, e, g, u] = await Promise.allSettled([
      getAbilities(learnerId),
      getEvidence(learnerId),
      getGrowthArchive(learnerId),
      getUsage(sessionId),
    ]);
    if (a.status === 'fulfilled') {
      setAbilities(a.value);
      setAbilitiesError(null);
    } else {
      setAbilities(null);
      setAbilitiesError(String(a.reason));
    }
    if (e.status === 'fulfilled') {
      setEvidence(e.value);
      setEvidenceError(null);
    } else {
      setEvidence([]);
      setEvidenceError(String(e.reason));
    }
    if (g.status === 'fulfilled') {
      setGrowthArchive(g.value);
      setGrowthArchiveError(null);
    } else {
      setGrowthArchive(null);
      setGrowthArchiveError(String(g.reason));
    }
    if (u.status === 'fulfilled') {
      setUsage(u.value);
      setUsageError(null);
    } else {
      setUsage(null);
      setUsageError(String(u.reason));
    }
  }, [learnerId, sessionId]);

  useEffect(() => {
    void refreshHealth();
    void refreshPanels();
  }, [refreshHealth, refreshPanels]);

  function setField<K extends keyof ResponseForm>(key: K, value: ResponseForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const effectiveLearnerId = learnerId.trim() || 'child-m1-demo';

  const onRefreshHealth = async () => {
    setBusy('health');
    await refreshHealth();
    setBusy(null);
    pushLog('info', '已探测后端 /health');
  };

  const onRefreshPanels = async () => {
    setBusy('panels');
    await refreshPanels();
    setBusy(null);
    pushLog('info', '已刷新：能力档案 / 证据时间线 / 成本账本');
  };

  const onStart = async () => {
    setBusy('start');
    try {
      const r = await startLesson(effectiveLearnerId, topicId);
      setSessionId(r.lessonSessionId);
      setTopicName(r.topicName);
      setDirective(r.directive);
      setSpeech(r.speech);
      setLastTurn(null);
      setLastTurnError(null);
      setFinishResult(null);
      setLastKey(null);
      setLastBody(null);
      setLastRaw(null);
      setIdempotentMatch(null);
      setReplay(null);
      setReplayError(null);
      pushLog(
        'ok',
        '开课成功（POST /lessons/start）',
        `sessionId=${r.lessonSessionId} · 主题=${r.topicName} · directive.methodVariant=${r.directive.methodVariant}`,
      );
    } catch (error) {
      pushLog('err', '开课失败', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onTurn = async (reuse: boolean, textOverride?: string) => {
    if (!sessionId) {
      pushLog('err', '提交失败', '请先开课，拿到 lessonSessionId');
      return;
    }
    let body: TurnRequestBody;
    if (reuse) {
      if (!lastBody) {
        pushLog('err', '重放失败', '还没有可重放的上一轮请求');
        return;
      }
      // 关键：完全复用同一个请求体（含同一个 idempotencyKey），用于演示幂等
      body = lastBody;
    } else {
      body = buildTurnRequestBody(effectiveLearnerId, newIdempotencyKey(), textOverride === undefined ? form : { ...form, text: textOverride });
    }

    setBusy('turn');
    try {
      const raw = await sendTurn(sessionId, body);
      // 稳定序列化后再比较：后端幂等返回的是落库 JSON，字段顺序可能与首次不同
      const rawStr = stableStringify(raw);
      const match = reuse && lastRaw !== null ? lastRaw === rawStr : null;
      setIdempotentMatch(match);
      setLastKey(body.idempotencyKey);
      setLastBody(body);
      setLastRaw(rawStr);

      if (isTurnResponse(raw)) {
        setLastTurn(raw);
        setLastTurnError(null);
        setDirective(raw.directive);
        setSpeech(raw.speech);
        pushLog(
          'ok',
          reuse ? '重放上一轮（复用同一 idempotencyKey）' : '提交 turn 成功（POST /lessons/:id/turn）',
          `turnIndex=${raw.turnIndex} · intent=${raw.intent} · passed=${raw.assessment.passed} · evidence=${raw.evidence.length} · key=${body.idempotencyKey}`,
        );
        if (match === true) {
          pushLog('ok', '幂等命中：两次响应完全一致', '同一 key 未重复写证据、未重复计费');
        } else if (match === false) {
          pushLog('err', '幂等异常：两次响应不一致', '请检查后端对 idempotencyKey 的处理');
        }
      } else {
        const degraded = raw as DegradedTurnBody;
        setLastTurnError(degraded);
        setLastTurn(null);
        // 保留上一轮 / 开课的 directive，不把降级错误体当作教学指令渲染
        pushLog(
          'err',
          '后端返回降级错误体（HTTP 200，非 TurnResponse）',
          `${degraded.message ?? ''} · reason=${degraded.reason ?? ''} · offlineFallback=${String(degraded.offlineFallback ?? false)}`,
        );
      }
      await refreshPanels();
    } catch (error) {
      pushLog('err', 'turn 请求失败', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onReplaySpeech = async () => {
    if (!directive) return;
    const text =
      [directive.teacherUtterance, directive.demonstrationText].filter(Boolean).join(' ') || 'hello';
    setBusy('replay');
    try {
      const r = await synthesize(text, directive.voice);
      setReplay(r);
      setReplayError(null);
      pushLog(
        r.cached ? 'ok' : 'info',
        '重播语音（POST /speech/synthesize）',
        `cached=${String(r.cached ?? false)} · characters=${r.characters ?? '-'} · latencyMs=${r.latencyMs ?? '-'} · audioRef=${r.audioRef ?? '-'}`,
      );
    } catch (error) {
      setReplay(null);
      setReplayError((error as Error).message);
      pushLog('err', '重播语音失败', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onFinish = async () => {
    if (!sessionId) {
      pushLog('err', '结课失败', '请先开课');
      return;
    }
    setBusy('finish');
    try {
      const r = await finishLesson(sessionId, effectiveLearnerId);
      setFinishResult(r);
      pushLog(
        'ok',
        '结课成功（POST /lessons/:id/finish）',
        `turns=${r.turns} · completedGoals=${r.completedGoals.length} · totalCostCny=${r.totalCostCny} · calibrationStatus=${r.calibrationStatus}`,
      );
      await refreshPanels();
    } catch (error) {
      pushLog('err', '结课失败', (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const calibrationNotice =
    abilities?.calibrationNotice ??
    'M1 阈值来自原型示意值，尚未经真实儿童样本校准；状态仅供内部教学决策参考。';

  if (classroomMode) {
    return (
      <ClassroomView
        directive={directive}
        speech={speech}
        topicName={topicName}
        sessionId={sessionId}
        busy={isBusy}
        onStart={() => void onStart()}
        onReplay={() => void onReplaySpeech()}
        onSubmit={(text) => {
          setField('text', text);
          if (sessionId) void onTurn(false, text);
        }}
        onOpenWorkbench={() => setClassroomMode(false)}
      />
    );
  }

  return (
    <main className="app">
      <header>
        <nav className="account-nav"><button className="btn ghost sm" onClick={() => setClassroomMode(true)}>课堂联调预览</button><Link href="/account">账户中心</Link><Link href="/login">登录</Link><Link href="/register">注册</Link></nav>
        <div className="notice" role="status">
          <b>内部评估专用</b>：Web 不是孩子实际使用的学习端；正式学习在 Android 客户端完成。本页仅用于检查教学指令、证据与成本，不对外投放。
        </div>
        <h1>M1 教学评估台 · 成长型 AI 儿童英语语言习得平台</h1>
        <p className="brand-sub">
          教 / 听 / 评估 / 调整 / 记录 五动作闭环验证台 · 教学决策 100% 由后端返回，Web 只渲染 directive 与采集作答 ·
          后端 <span className="mono">{API_BASE}</span>
        </p>
      </header>

      {/* 顶部控制区 */}
      <div className="topbar">
        <div className="field grow" style={{ maxWidth: 210 }}>
          <label htmlFor="topic">主题 topicId</label>
          <select id="topic" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            {TOPICS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}（{t.id}）
              </option>
            ))}
          </select>
        </div>
        <div className="field grow" style={{ maxWidth: 230 }}>
          <label htmlFor="learner">学习者 learnerId</label>
          <input id="learner" value={learnerId} onChange={(e) => setLearnerId(e.target.value)} />
        </div>
        <div className="row-actions">
          <button className="btn primary" onClick={() => void onStart()} disabled={isBusy}>
            开课 /lessons/start
          </button>
          <button className="btn warn" onClick={() => void onFinish()} disabled={isBusy || !sessionId}>
            结课 /finish
          </button>
        </div>
        <div className="field grow">
          <label>后端健康状态（GET /health）</label>
          <div className="health">
            {health ? (
              <>
                <Badge tone="ok">状态 {health.status}</Badge>
                <Badge tone="info">网关 {health.gatewayMode}</Badge>
                <Badge tone="warn">校准 {health.calibrationStatus}</Badge>
                <span className="hint mono">{health.timestamp}</span>
              </>
            ) : healthError ? (
              <Badge tone="err">后端不可达：{healthError}</Badge>
            ) : (
              <Badge tone="muted">探测中…</Badge>
            )}
            <button className="btn ghost sm" onClick={() => void onRefreshHealth()} disabled={isBusy}>
              探测健康
            </button>
          </div>
        </div>
      </div>

      {/* calibrationNotice：显式、全局、醒目 */}
      <div className="notice">
        <div className="notice-title">
          阈值校准状态 · {health?.calibrationStatus ?? 'uncalibrated'}（未校准）· 内部原型状态 · 不代表掌握
        </div>
        <div className="notice-text">
          <b>calibrationNotice（后端返回全文）：</b>
          {calibrationNotice}
        </div>
        <div className="notice-text">
          本页所有能力状态均为<b>内部原型状态 · 未校准 · 不代表掌握</b>，来自未经真实儿童样本校准的原型阈值，仅供内部教学决策参考，<b>不得表述为「已掌握」</b>。
          {abilitiesError ? '（能力档案接口当前不可用，上方为平台固定说明）' : ''}
        </div>
      </div>

      <div className="session-bar">
        <span>
          课堂会话：<span className="mono">{sessionId ?? '未开课'}</span>
        </span>
        <span>主题：{topicName ?? '—'}</span>
        <span>
          当前轮次：<b>{lastTurn ? lastTurn.turnIndex : 0}</b>
        </span>
        <span>
          当前教法：<span className="mono">{directive?.methodVariant ?? '—'}</span>
        </span>
        <span>
          连续失败：<b>{directive?.consecutiveFailures ?? 0}</b>
        </span>
        {finishResult && <Badge tone="info">已结课 · {finishResult.turns} 轮</Badge>}
      </div>

      {/* 三列主体 */}
      <div className="grid3">
        {/* ————— 左：教 / 听 ————— */}
        <div className="col">
          <Panel
            title="① 教 · 当前教学指令"
            subtitle="TeachingDirective：完全由后端决定，Web 不判断对错、不决定下一个活动、不生成教学话术"
          >
            {!directive ? (
              <Empty>请先点击「开课」，后端会返回第一条 directive。</Empty>
            ) : (
              <>
                <div className="chips" style={{ marginBottom: 8 }}>
                  <Badge tone="info">taskType {directive.taskType}</Badge>
                  <Badge tone="muted">scenario {directive.scenario}</Badge>
                  <Badge tone="muted">期望 {directive.expectedResponse}</Badge>
                  <Badge tone={directive.allowRepeat ? 'ok' : 'warn'}>
                    允许重放 {directive.allowRepeat ? '是' : '否'}
                  </Badge>
                </div>
                <div className="hint" style={{ marginBottom: 10 }}>
                  scenario 预期为交际情境枚举（EVIDENCE_SCENARIOS）：
                  <span className="mono"> {EVIDENCE_SCENARIOS.join(' / ')}</span>。
                  旧「媒体形式」值（如 audio_prompt）已废弃，重新 seed 后后端返回上述枚举；Web 仍按字符串宽容渲染，不据此做教学判断。
                </div>
                <KV
                  rows={[
                    { k: '目标能力节点', v: <span className="mono">{directive.targetSkillNodeId}</span> },
                    { k: '教学模式', v: directive.isReview ? '间隔复习（无答案提示）' : '新内容 / 练习' },
                    { k: 'methodVariant', v: <span className="mono">{directive.methodVariant}</span> },
                    { k: 'consecutiveFailures', v: String(directive.consecutiveFailures) },
                  ]}
                />
                <Section title="老师要说的话 teacherUtterance">
                  <div className="quote">{directive.teacherUtterance}</div>
                </Section>
                <Section title="英文示范 demonstrationText">
                  {directive.demonstrationText ? (
                    <div className="quote">{directive.demonstrationText}</div>
                  ) : (
                    <Empty>本轮无示范文本</Empty>
                  )}
                </Section>
                <Section title="发音单位 pronunciationUnits（isFocus 高亮）">
                  {directive.pronunciationUnits.length === 0 ? (
                    <Empty>无</Empty>
                  ) : (
                    <div className="chips">
                      {directive.pronunciationUnits.map((u, i) => (
                        <span key={i} className={`chip ${u.isFocus ? 'focus' : ''}`}>
                          {u.text}（{u.kind}）{u.isFocus ? ' · 易错点' : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </Section>
                <Section title="目标词 targetWords">
                  {directive.targetWords.length === 0 ? (
                    <Empty>无</Empty>
                  ) : (
                    <div className="chips">
                      {directive.targetWords.map((w, i) => (
                        <span key={i} className="chip plain">
                          {w}
                        </span>
                      ))}
                    </div>
                  )}
                </Section>
                <Section title="老师人格提示 personaHint">
                  <div className="hint">{directive.personaHint ?? '—'}</div>
                </Section>
              </>
            )}
          </Panel>

          <Panel
            title="② 听 · 语音参数"
            subtitle="平台统一抽象参数，不含任何厂商原始 speed / 模型名"
            right={
              <button
                className="btn ghost sm"
                onClick={() => void onReplaySpeech()}
                disabled={isBusy || !directive}
              >
                重播 /speech/synthesize
              </button>
            }
          >
            {!directive ? (
              <Empty>开课后显示。</Empty>
            ) : (
              <>
                <div className="voice-grid">
                  <div className="voice-item">
                    <div className="voice-label">teacherSpeed（抽象语速）</div>
                    <div className="voice-value">{directive.voice.teacherSpeed}</div>
                  </div>
                  <div className="voice-item">
                    <div className="voice-label">voiceStyle（音色）</div>
                    <div className="voice-value">{directive.voice.voiceStyle}</div>
                  </div>
                  <div className="voice-item">
                    <div className="voice-label">pauseAfterSentenceMs（句后停顿 ms）</div>
                    <div className="voice-value">{directive.voice.pauseAfterSentenceMs}</div>
                  </div>
                  <div className="voice-item">
                    <div className="voice-label">pronunciationMode（发音模式）</div>
                    <div className="voice-value">{directive.voice.pronunciationMode}</div>
                  </div>
                </div>
                <Section title="本轮语音 speech（后端返回）">
                  <KV
                    rows={[
                      {
                        k: 'audioRef',
                        v: <span className="mono">{speech?.audioRef ?? '—'}</span>,
                      },
                      { k: 'cached（缓存命中）', v: speech ? <YesNo value={speech.cached} /> : '—' },
                    ]}
                  />
                </Section>
                {/* 单文件方案：speech.audioRef 即整轮完整音频。新增的 speech.scope /
                    speech.segments 是 additive 字段，TS / JSON 会忽略未知键，不会报错；
                    这里额外保留 segments[0] 兜底，只为回滚期旧服务端（N 段）三态兼容。 */}
                {playableAudioUrl(playableSpeechRef) && (
                  <div className="card" style={{ marginTop: 10 }}>
                    <div className="card-title">老师语音 · 真实合成音频</div>
                    <audio
                      controls
                      preload="none"
                      src={playableAudioUrl(playableSpeechRef) ?? undefined}
                      onLoadedMetadata={(event) => {
                        event.currentTarget.playbackRate = speech?.playbackRate ?? 1;
                      }}
                      style={{ width: '100%', marginTop: 8 }}
                    />
                    <div className="hint" style={{ marginTop: 6 }}>
                      {speech?.speedMode === 'playback'
                        ? `此模型不支持合成语速，播放器按 ${speech.playbackRate ?? 1} 倍速播放。`
                        : '音频由后端 TTS 适配器合成并落盘；当前模型在合成时应用语速。'}
                    </div>
                  </div>
                )}
                <div className="hint" style={{ marginTop: 8 }}>
                  重播按钮用当前 directive 的文本与同一组语音参数再调一次 /speech/synthesize；相同参数应命中缓存，不重复消耗 TTS 字符量。
                </div>
                {replayError && (
                  <div className="error-box" style={{ marginTop: 10 }}>
                    重播失败：{replayError}
                  </div>
                )}
                {replay && (
                  <div className="card" style={{ marginTop: 10 }}>
                    <div className="card-title">
                      重播结果 ·{' '}
                      {replay.cached ? (
                        <span className="ok-text">缓存命中（cached=true）</span>
                      ) : (
                        <span className="warn-text">未命中缓存（cached=false）</span>
                      )}
                    </div>
                    <KV
                      rows={[
                        { k: 'characters（本次计费字符量）', v: String(replay.characters ?? '—') },
                        { k: 'latencyMs', v: String(replay.latencyMs ?? '—') },
                        { k: 'audioRef', v: <span className="mono">{replay.audioRef ?? '—'}</span> },
                      ]}
                    />
                  </div>
                )}
              </>
            )}
          </Panel>
        </div>

        {/* ————— 中：作答 / 评估 ————— */}
        <div className="col">
          <Panel
            title="③ 学生作答"
            subtitle="Web 只采集回应并提交给后端；判定、打分、下一步教学全部由后端完成"
          >
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="text">文本回应 text</label>
              <textarea
                id="text"
                value={form.text}
                placeholder="例如：hello"
                onChange={(e) => setField('text', e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="audio">模拟语音引用 audioRef</label>
              <input
                id="audio"
                value={form.audioRef}
                placeholder="例如：mock-audio-hello（有音频时后端可能触发发音评估 / ASR）"
                onChange={(e) => setField('audioRef', e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="image">点选图片 id selectedImageId</label>
              <input
                id="image"
                value={form.selectedImageId}
                placeholder="可手填，或点下方模拟图片"
                onChange={(e) => setField('selectedImageId', e.target.value)}
              />
              <div className="img-picks" style={{ marginTop: 7 }}>
                {IMAGE_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`chip ${form.selectedImageId === id ? 'sel' : 'plain'}`}
                    onClick={() => setField('selectedImageId', form.selectedImageId === id ? '' : id)}
                  >
                    {id}
                  </button>
                ))}
                <button
                  type="button"
                  className="chip plain"
                  onClick={() => setField('selectedImageId', '')}
                >
                  清除
                </button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label htmlFor="free">自由发言 freeUtterance（触发意图识别）</label>
              <input
                id="free"
                value={form.freeUtterance}
                placeholder="例如：老师，这个单词怎么说？"
                onChange={(e) => setField('freeUtterance', e.target.value)}
              />
            </div>
            <div className="checkbox-row" style={{ marginBottom: 12 }}>
              <label>
                <input
                  type="checkbox"
                  checked={form.requestedRepeat}
                  onChange={(e) => setField('requestedRepeat', e.target.checked)}
                />
                请求重放 requestedRepeat
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.requestedSlower}
                  onChange={(e) => setField('requestedSlower', e.target.checked)}
                />
                请求慢一点 requestedSlower
              </label>
            </div>
            <div className="row-actions">
              <button className="btn primary" onClick={() => void onTurn(false)} disabled={isBusy || !sessionId}>
                提交 turn
              </button>
              <button className="btn ghost" onClick={() => void onTurn(true)} disabled={isBusy || !lastBody}>
                重放上一轮（复用同一 key）
              </button>
            </div>
            <div className="hint" style={{ marginTop: 10 }}>
              每次「提交 turn」都会生成唯一 <span className="mono">idempotencyKey</span>（crypto.randomUUID()）；「重放上一轮」复用完全相同的请求体与同一个 key，用于演示后端幂等：不重复写证据、不重复计费。
            </div>
            <div className="divider" />
            <KV
              rows={[
                {
                  k: '上一轮 idempotencyKey',
                  v: <span className="mono">{lastKey ?? '—'}</span>,
                },
              ]}
            />
            {idempotentMatch !== null && (
              <div className={idempotentMatch ? 'ok-text' : 'warn-text'} style={{ fontSize: 12, marginTop: 8 }}>
                {idempotentMatch
                  ? '幂等命中：复用同一 idempotencyKey，后端返回与首次完全一致的响应（未重复写证据 / 未重复计费）。'
                  : '两次响应不一致：请检查后端对该 idempotencyKey 的处理。'}
              </div>
            )}
          </Panel>

          <Panel
            title="④ 本轮评估"
            subtitle="TurnAssessment：直接展示后端结论，Web 不自行判断对错、不计算掌握状态"
          >
            {lastTurnError ? (
              <div className="error-box">
                <b>后端返回降级错误体（HTTP 200，并非 TurnResponse）</b>
                <div style={{ marginTop: 6 }}>
                  message：{lastTurnError.message ?? '—'}
                  <br />
                  reason：{lastTurnError.reason ?? '—'}
                  <br />
                  degraded：{String(lastTurnError.degraded ?? false)} · offlineFallback：
                  {String(lastTurnError.offlineFallback ?? false)}
                </div>
                <div style={{ marginTop: 6 }}>
                  该回合未被正常编排，因此没有 assessment / evidence / routing 数据。Web 保留上一轮 directive，不把错误体当作教学指令渲染。
                </div>
              </div>
            ) : !lastTurn ? (
              <Empty>提交一轮作答后，这里显示后端返回的 assessment。</Empty>
            ) : (
              <>
                <div className="chips" style={{ marginBottom: 10 }}>
                  <Badge tone="info">turnIndex {lastTurn.turnIndex}</Badge>
                  <Badge tone="muted">intent {lastTurn.intent}</Badge>
                  <Badge tone={lastTurn.lessonFinished ? 'warn' : 'ok'}>
                    结课 {lastTurn.lessonFinished ? '是' : '否'}
                  </Badge>
                </div>
                <KV
                  rows={[
                    { k: 'score（任务级得分）', v: lastTurn.assessment.score === null ? '—' : String(lastTurn.assessment.score) },
                    { k: 'passed（任务级通过，非掌握）', v: <YesNo value={lastTurn.assessment.passed} /> },
                    { k: '发音评估 performedPronunciationAssessment', v: <YesNo value={lastTurn.assessment.performedPronunciationAssessment} /> },
                    { k: 'ASR performedAsr', v: <YesNo value={lastTurn.assessment.performedAsr} /> },
                    { k: 'prompted（有提示）', v: <YesNo value={lastTurn.assessment.prompted} /> },
                    { k: 'independent（独立完成）', v: <YesNo value={lastTurn.assessment.independent} /> },
                    { k: 'thresholdVersion', v: <span className="mono">{lastTurn.assessment.thresholdVersion ?? '—'}</span> },
                    { k: 'summary', v: lastTurn.summary ?? '—' },
                  ]}
                />
                <Section title="出错发音单元 errorUnits">
                  {lastTurn.assessment.errorUnits.length === 0 ? (
                    <Empty>本轮无出错发音单元</Empty>
                  ) : (
                    <div className="chips">
                      {lastTurn.assessment.errorUnits.map((u, i) => (
                        <span key={i} className="chip focus">
                          {u.unit}（{u.kind}）{u.detail ? ` · ${u.detail}` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </Section>
                <div className="hint">
                  passed 仅为任务级通过与否，不等于掌握状态；掌握状态由后端规则引擎依据证据计算，且阈值未校准。
                </div>
              </>
            )}
          </Panel>
        </div>

        {/* ————— 右：调整与记录 ————— */}
        <div className="col">
          <Panel
            title="⑤ 调整与记录（本轮）"
            subtitle="methodVariant / evidence / stateChanges / routing / degradation / intent 均来自后端响应"
          >
            {!lastTurn ? (
              <Empty>提交 turn 后显示本轮的调整与记录数据。</Empty>
            ) : (
              <>
                <Section title="调整 · 教学方法（后端 L0 规则阶梯）">
                  <KV
                    rows={[
                      { k: 'methodVariant', v: <span className="mono">{lastTurn.directive.methodVariant}</span> },
                      { k: 'consecutiveFailures', v: String(lastTurn.directive.consecutiveFailures) },
                      { k: 'intent', v: <span className="mono">{lastTurn.intent}</span> },
                    ]}
                  />
                </Section>

                <Section title="记录 · 本轮 evidence 列表">
                  {lastTurn.evidence.length === 0 ? (
                    <Empty>本轮无证据事件</Empty>
                  ) : (
                    <div className="scroll">
                      {lastTurn.evidence.map((e) => (
                        <div className="card" key={e.evidenceId}>
                          <div className="card-title mono">{e.evidenceId}</div>
                          <KV
                            rows={[
                              { k: 'skillNodeId', v: <span className="mono">{e.skillNodeId}</span> },
                              { k: 'source', v: e.source },
                              { k: 'taskType / scenario', v: `${e.taskType} / ${e.scenario}` },
                              { k: 'credibility', v: String(e.credibility) },
                              { k: 'contributesToPromotion', v: <YesNo value={e.contributesToPromotion} /> },
                              { k: 'succeeded / score', v: `${e.succeeded ? '是' : '否'} / ${e.score ?? '—'}` },
                              { k: 'prompted / independent', v: `${e.prompted ? '是' : '否'} / ${e.independent ? '是' : '否'}` },
                            ]}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                <Section title="记录 · stateChanges（掌握状态变更）">
                  {lastTurn.stateChanges.length === 0 ? (
                    <Empty>本轮无状态变更</Empty>
                  ) : (
                    lastTurn.stateChanges.map((s, i) => (
                      <div className="card" key={i}>
                        <div className="card-title mono">{s.skillNodeId}</div>
                        <KV
                          rows={[
                            { k: '状态迁移', v: `${s.from} → ${s.to}` },
                            { k: 'calibrationStatus', v: <Badge tone="warn">{s.calibrationStatus}</Badge> },
                            { k: 'reason', v: s.reason },
                            { k: 'evidenceIds', v: <span className="mono">{s.evidenceIds.join(', ') || '—'}</span> },
                          ]}
                        />
                      </div>
                    ))
                  )}
                  <div className="hint">状态变更阈值 uncalibrated，均为内部原型状态 · 不代表掌握，不得表述为「已掌握」。</div>
                </Section>

                <Section title="调整 · routing（路由与成本）">
                  <KV
                    rows={[
                      { k: 'level（服务等级）', v: <Badge tone="info">{lastTurn.routing.level}</Badge> },
                      { k: 'providerAlias（配置别名）', v: <span className="mono">{lastTurn.routing.providerAlias}</span> },
                      { k: 'taskRoute', v: <span className="mono">{lastTurn.routing.taskRoute}</span> },
                      { k: 'strategy', v: <span className="mono">{lastTurn.routing.strategy}</span> },
                      { k: 'fellBack', v: lastTurn.routing.fellBack ? <Badge tone="warn">已回退</Badge> : <Badge tone="ok">未回退</Badge> },
                      { k: 'latencyMs', v: String(lastTurn.routing.latencyMs) },
                    ]}
                  />
                  <div className="chips" style={{ marginTop: 8 }}>
                    {lastTurn.routing.escalationSignals.length === 0 ? (
                      <span className="chip plain">escalationSignals：无</span>
                    ) : (
                      lastTurn.routing.escalationSignals.map((s, i) => (
                        <span key={i} className="chip focus">
                          {s}
                        </span>
                      ))
                    )}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <KV
                      rows={[
                        { k: 'llmInputTokens / llmOutputTokens', v: `${lastTurn.routing.cost.llmInputTokens} / ${lastTurn.routing.cost.llmOutputTokens}` },
                        { k: 'ttsCharacters', v: String(lastTurn.routing.cost.ttsCharacters) },
                        { k: 'asrSeconds', v: String(lastTurn.routing.cost.asrSeconds) },
                        { k: 'pronunciationCalls', v: String(lastTurn.routing.cost.pronunciationCalls) },
                        { k: 'estimatedCostCny', v: fmtCost(lastTurn.routing.cost.estimatedCostCny) },
                      ]}
                    />
                  </div>
                </Section>

                <Section title="degradation（降级，如实返回不掩盖）">
                  <div className="chips" style={{ marginBottom: 8 }}>
                    {lastTurn.degradation.degraded ? (
                      <Badge tone="err">已降级</Badge>
                    ) : (
                      <Badge tone="ok">未降级 · 正常</Badge>
                    )}
                    {lastTurn.degradation.offlineFallback ? (
                      <Badge tone="err">离线兜底</Badge>
                    ) : (
                      <Badge tone="ok">正常在线</Badge>
                    )}
                    <Badge tone="info">effectiveLevel {lastTurn.degradation.effectiveLevel}</Badge>
                  </div>
                  <KV
                    rows={[
                      { k: 'degraded', v: String(lastTurn.degradation.degraded) },
                      { k: 'offlineFallback', v: String(lastTurn.degradation.offlineFallback) },
                      { k: 'effectiveLevel', v: lastTurn.degradation.effectiveLevel },
                      { k: 'reasons', v: lastTurn.degradation.reasons.length ? lastTurn.degradation.reasons.join(', ') : '无' },
                    ]}
                  />
                </Section>
              </>
            )}
          </Panel>

          {finishResult && (
            <Panel title="结课结果 · POST /lessons/:id/finish" subtitle="calibrationStatus 仍为未校准">
              <KV
                rows={[
                  { k: 'lessonSessionId', v: <span className="mono">{finishResult.lessonSessionId}</span> },
                  { k: 'turns', v: String(finishResult.turns) },
                  { k: 'completedGoals', v: finishResult.completedGoals.join(', ') || '—' },
                  { k: 'totalCostCny', v: fmtCost(finishResult.totalCostCny) },
                  { k: 'effectiveTeachingCostCny', v: fmtCost(finishResult.effectiveTeachingCostCny) },
                  { k: 'stateChanges', v: String(finishResult.stateChanges.length) },
                  { k: 'reviewScheduled', v: String(finishResult.reviewScheduled.length) },
                  { k: 'calibrationStatus', v: <Badge tone="warn">{finishResult.calibrationStatus}</Badge> },
                  { k: 'summary', v: finishResult.summary },
                ]}
              />
            </Panel>
          )}
        </div>
      </div>

      {/* 底部三块 */}
      <div className="footer-grid">
        <Panel
          title="能力档案 · GET /learners/:id/abilities"
          subtitle="内部原型状态 · 未校准 · 不代表掌握"
          right={
            <button className="btn ghost sm" onClick={() => void onRefreshPanels()} disabled={isBusy}>
              刷新
            </button>
          }
        >
          <div className="notice" style={{ marginTop: 0, marginBottom: 10 }}>
            <div className="notice-title">内部原型状态 · 未校准 · 不代表掌握</div>
            <div className="notice-text">
              <b>calibrationNotice（后端返回全文）：</b>
              {calibrationNotice}
            </div>
            <div className="notice-text">
              下表 masteryState 为后端原始机读编码（如 mastered 仅是编码名），<b>不代表已掌握</b>；全部状态阈值 uncalibrated，仅供内部教学决策参考，不得表述为「已掌握」。
            </div>
          </div>
          {abilitiesError ? (
            <div className="error-box">
              接口不可用：{abilitiesError}
              <br />
              上方为平台固定未校准说明；状态表暂无法加载。
            </div>
          ) : !abilities ? (
            <Empty>加载中…</Empty>
          ) : abilities.states.length === 0 ? (
            <Empty>暂无能力状态记录（产生证据并由规则引擎重算后生成）</Empty>
          ) : (
            <div className="scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>能力节点</th>
                    <th>名称 / 类别</th>
                    <th>状态编码（原型 · 未校准）</th>
                    <th>校准状态</th>
                    <th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {abilities.states.map((s) => (
                    <tr key={s.skillNodeId}>
                      <td className="mono">{s.skillNodeId}</td>
                      <td>
                        {s.skillName || '—'}
                        <br />
                        <span className="hint">{s.abilityCategory}</span>
                      </td>
                      <td>
                        <span className="mono">{s.masteryState}</span>
                        <br />
                        <span className="hint">code {s.masteryCode} · 原型编码，非掌握结论</span>
                      </td>
                      <td>
                        <Badge tone="warn">{s.calibrationStatus}</Badge>
                      </td>
                      <td className="hint">{fmtTime(s.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="长期成长档案 · GET /learners/:id/growth"
          subtitle="每堂课结束时归档结构化证据摘要；不保存原始语音或对话文本"
        >
          {growthArchiveError ? (
            <div className="error-box">接口不可用：{growthArchiveError}</div>
          ) : !growthArchive ? (
            <Empty>加载中…</Empty>
          ) : (
            <>
              <div className="notice" style={{ marginTop: 0 }}>
                <div className="notice-title">学习档案说明</div>
                <div className="notice-text">{growthArchive.calibrationNotice}</div>
              </div>
              <Section title={`长期记忆（${growthArchive.memories.length}）`}>
                {growthArchive.memories.length === 0 ? (
                  <Empty>结课并产生证据后，会生成可追溯的结构化学习摘要。</Empty>
                ) : (
                  growthArchive.memories.map((memory) => (
                    <div className="card" key={memory.id}>
                      <div className="card-title">{memory.memoryType} · {fmtTime(memory.updatedAt)}</div>
                      <div>{memory.content}</div>
                      <div className="hint">重要度 {memory.importance.toFixed(2)} · 来源 {memory.source}</div>
                    </div>
                  ))
                )}
              </Section>
              <Section title={`课堂成长快照（${growthArchive.snapshots.length}）`}>
                {growthArchive.snapshots.length === 0 ? (
                  <Empty>暂无已归档课程。结课后可查看当时的证据、能力状态和待复习项。</Empty>
                ) : (
                  growthArchive.snapshots.map((entry) => (
                    <div className="card" key={entry.id}>
                      <div className="card-title">
                        {entry.snapshot.session?.topicId ?? '课堂'} · {fmtTime(entry.snapshot.session?.completedAt ?? entry.createdAt)}
                      </div>
                      <div className="hint">
                        {entry.snapshot.session?.turns ?? 0} 轮 · {entry.snapshot.session?.evidenceCount ?? 0} 条证据 · {entry.snapshot.evidenceBySkill?.length ?? 0} 项能力
                      </div>
                      {(entry.snapshot.evidenceBySkill ?? []).map((skill) => (
                        <div className="hint" key={skill.skillNodeId}>
                          {skill.skillName || skill.skillNodeId}：独立成功 {skill.independentSuccesses}，待练习 {skill.unsuccessfulAttempts}，不同场景 {skill.independentScenarios.length}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </Section>
              <Section title={`待复习（${growthArchive.upcomingReviews.length}）`}>
                {growthArchive.upcomingReviews.length === 0 ? (
                  <Empty>暂无待复习项</Empty>
                ) : (
                  growthArchive.upcomingReviews.slice(0, 8).map((review, index) => (
                    <div className="hint" key={`${review.skillNodeId}-${review.dueAt}-${index}`}>
                      {review.skillNodeId} · {fmtTime(review.dueAt)} · 间隔 {review.intervalDays} 天
                    </div>
                  ))
                )}
              </Section>
            </>
          )}
        </Panel>

        <Panel
          title="证据时间线 · GET /learners/:id/evidence"
          subtitle="learning_evidence 只 INSERT，可追溯到每条状态变更"
        >
          {evidenceError ? (
            <div className="error-box">{evidenceError}</div>
          ) : evidence.length === 0 ? (
            <Empty>暂无证据事件（提交 turn 后由后端写入）</Empty>
          ) : (
            <>
              <div className="hint" style={{ marginBottom: 8 }}>
                共 {evidence.length} 条，按 occurredAt 倒序
              </div>
              <div className="scroll">
                {evidence.map((e) => (
                  <div className="card" key={e.id}>
                    <div className="card-title">
                      <span className="mono">{fmtTime(e.occurredAt)}</span> · {e.source}
                    </div>
                    <KV
                      rows={[
                        { k: 'evidenceId', v: <span className="mono">{e.id}</span> },
                        { k: 'skillNodeId', v: <span className="mono">{e.skillNodeId}</span> },
                        { k: 'taskType / scenario', v: `${e.taskType} / ${e.scenario}` },
                        { k: 'succeeded / score', v: `${e.succeeded ? '是' : '否'} / ${e.score ?? '—'}` },
                        { k: 'credibility', v: String(e.credibility) },
                        { k: 'contributesToPromotion', v: <YesNo value={e.contributesToPromotion} /> },
                        { k: 'prompted / independent', v: `${e.prompted ? '是' : '否'} / ${e.independent ? '是' : '否'}` },
                        { k: 'thresholdVersion / ruleVersion', v: `${e.thresholdVersion ?? '—'} / ${e.ruleVersion ?? '—'}` },
                      ]}
                    />
                    {e.errorUnits.length > 0 && (
                      <div className="chips" style={{ marginTop: 6 }}>
                        {e.errorUnits.map((u, i) => (
                          <span key={i} className="chip focus">
                            {u.unit}（{u.kind}）
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="成本账本 · GET /usage/summary"
          subtitle="按服务 / 级别汇总，有效教学成本口径见后端 note"
        >
          {usageError ? (
            <div className="error-box">{usageError}</div>
          ) : !usage ? (
            <Empty>加载中…</Empty>
          ) : (
            <>
              <div className="stat-row">
                <div className="stat">
                  总成本（元）<b>{fmtCost(usage.totalCostCny)}</b>
                </div>
                <div className="stat">
                  服务类别数<b>{Object.keys(usage.byService).length}</b>
                </div>
                <div className="stat">
                  服务等级数<b>{Object.keys(usage.byLevel).length}</b>
                </div>
              </div>
              {usage.note && <div className="hint" style={{ marginTop: 8 }}>{usage.note}</div>}
              <Section title="按服务 byService">
                {Object.keys(usage.byService).length === 0 ? (
                  <Empty>暂无记录</Empty>
                ) : (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>serviceKind</th>
                        <th>调用次数</th>
                        <th>成本（元）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(usage.byService).map(([k, v]) => (
                        <tr key={k}>
                          <td className="mono">{k}</td>
                          <td>{v.calls}</td>
                          <td>{fmtCost(v.costCny)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>
              <Section title="按级别 byLevel">
                {Object.keys(usage.byLevel).length === 0 ? (
                  <Empty>暂无记录</Empty>
                ) : (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>level</th>
                        <th>调用次数</th>
                        <th>成本（元）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(usage.byLevel).map(([k, v]) => (
                        <tr key={k}>
                          <td className="mono">{k}</td>
                          <td>{v.calls}</td>
                          <td>{fmtCost(v.costCny)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>
            </>
          )}
        </Panel>
      </div>

      <div className="footer-grid" style={{ gridTemplateColumns: '1fr', marginTop: 14 }}>
        <Panel
          title="操作日志 / 请求记录"
          subtitle="便于 QA 追溯每一步请求、响应与幂等行为"
          right={
            <button className="btn ghost sm" onClick={() => setLogs([])}>
              清空
            </button>
          }
        >
          {logs.length === 0 ? (
            <Empty>暂无操作。可先探测健康、开课、提交一轮作答。</Empty>
          ) : (
            <div className="log">
              {logs.map((l, i) => (
                <div className="log-item" key={i}>
                  <span className="log-time">{l.at}</span>
                  <span className={`log-tag ${l.kind}`}>{l.kind.toUpperCase()}</span>
                  <span>
                    <span className="log-title">{l.title}</span>
                    {l.detail && <span className="log-detail"> · {l.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="divider" />
          <div className="row-actions">
            <button className="btn ghost sm" onClick={() => void onRefreshPanels()} disabled={isBusy}>
              刷新底部面板
            </button>
            <span className="hint">开课 / 提交 turn / 结课后会自动刷新三块面板</span>
          </div>
        </Panel>
      </div>

      <div className="footer-note">
        约束说明：① 教学决策 100% 在后端，本页只渲染 directive 与后端返回的 assessment / routing / degradation / evidence，不自行判断对错、不决定下一个活动、不计算掌握状态、不生成教学话术。
        ② 页面不出现任何厂商名或具体模型名；语音仅展示平台抽象参数 teacherSpeed / voiceStyle / pauseAfterSentenceMs / pronunciationMode；providerAlias 为后端返回的配置别名。
        ③ M1 全部阈值 uncalibrated，能力状态一律标注为「内部原型状态 · 未校准 · 不代表掌握」，完整展示 calibrationNotice 全文，禁止表述为「已掌握」。
        ④ 每个 turn 使用唯一 idempotencyKey，「重放上一轮」复用同一 key 演示幂等。
        ⑤ 场景标签预期值已对齐 EVIDENCE_SCENARIOS 交际情境枚举（
        <span className="mono">{EVIDENCE_SCENARIOS.join(' / ')}</span>
        ）；旧「媒体形式」值（audio_prompt 等）已废弃，重新 seed 后不再出现，Web 始终按后端返回值宽容渲染，不据此做教学判断。
        ⑥ 开课响应已对齐 LessonStartResponse 契约：嵌套 speech 对象 + learnerState.masteryStates（无多余 characters 字段）；Web 按契约字段渲染。
        <br />
        直连后端：<span className="mono">{API_BASE}</span>（可通过 NEXT_PUBLIC_API_BASE 覆盖）。
      </div>
    </main>
  );
}

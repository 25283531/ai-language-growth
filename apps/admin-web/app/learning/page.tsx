'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminNav } from '../admin-nav';
import { AdminApiError, adminFetch } from '../admin-auth';

type TeacherProfile = {
  id: string;
  style: 'patient_guide' | 'playful_companion' | 'calm_coach' | 'conversation_partner';
  adjustable: {
    tone: 'gentle' | 'lively' | 'calm';
    encouragement: 'light' | 'balanced' | 'frequent';
    correctionStyle: 'model_first' | 'hint_first' | 'encourage_retry';
    speakingRate: number;
  };
};

type PersonaHistory = {
  id: string;
  version: number;
  reason: string;
  createdAt: string;
  changeContent: string;
};

type Memory = {
  id: string;
  memoryType: string;
  content: string;
  importance: number;
  source: string;
  expiresAt: string | null;
};

type LoadState = 'loading' | 'ready' | 'error';
type Tone = 'info' | 'success' | 'error' | 'warn';

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function LearningPage() {
  const [teacher, setTeacher] = useState<TeacherProfile | null>(null);
  // 服务端快照：用于判断表单是否有未保存编辑，刷新不能静默丢弃。
  const [serverTeacher, setServerTeacher] = useState<TeacherProfile | null>(null);
  const [teacherReason, setTeacherReason] = useState('');
  const [personaHistory, setPersonaHistory] = useState<PersonaHistory[]>([]);
  const [learnerId, setLearnerId] = useState('');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<Tone>('info');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshArmed, setRefreshArmed] = useState(false);
  // 学习记忆是按 learnerId 搜索的交互，不是页面级的自动加载项。
  const [memorySearched, setMemorySearched] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  // 卸载后不再 setState；并发读取只认最后一次。
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const sessionExpiredRef = useRef(false);

  function notify(text: string, nextTone: Tone = 'info') {
    setMessage(text);
    setTone(nextTone);
    if (text.includes('登录已失效')) {
      sessionExpiredRef.current = true;
      setSessionExpired(true);
    }
  }

  const teacherDirty = Boolean(teacher && serverTeacher && (
    teacher.style !== serverTeacher.style
    || JSON.stringify(teacher.adjustable) !== JSON.stringify(serverTeacher.adjustable)
    || teacherReason.trim().length > 0
  ));

  /**
   * 进入页面（以及 AdminAuthGate 确认登录后重新挂载）即自动读取教师人格配置与版本历史，
   * 不再需要人工点「读取人格配置」。手动刷新按钮保留，但会拦住未保存编辑。
   */
  const loadLearningSettings = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (mountedRef.current) setLoadState('loading');
    try {
      const [profile, history] = await Promise.all([
        adminFetch<TeacherProfile>('/learning/teacher-profile'),
        adminFetch<PersonaHistory[]>('/learning/teacher-profile/history'),
      ]);
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      setTeacher(profile);
      setServerTeacher(profile);
      setPersonaHistory(Array.isArray(history) ? history : []);
      setTeacherReason('');
      setRefreshArmed(false);
      sessionExpiredRef.current = false;
      setSessionExpired(false);
      setLoadState('ready');
      notify('已自动读取教师人格配置与版本历史。', 'success');
    } catch (error) {
      if (!mountedRef.current || seq !== loadSeqRef.current) return;
      const text = readableError(error, '读取教师人格配置失败');
      const expired = error instanceof AdminApiError && (error.status === 401 || error.status === 403);
      sessionExpiredRef.current = expired;
      setSessionExpired(expired);
      setLoadState('error');
      notify(text, 'error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { void loadLearningSettings(); }, []);

  // 会话过期后重新登录或切回本页时自动重试，不留在旧表单上让人继续保存。
  useEffect(() => {
    const retryAfterReauth = () => {
      if (document.visibilityState !== 'hidden' && sessionExpiredRef.current) void loadLearningSettings();
    };
    window.addEventListener('focus', retryAfterReauth);
    document.addEventListener('visibilitychange', retryAfterReauth);
    return () => {
      window.removeEventListener('focus', retryAfterReauth);
      document.removeEventListener('visibilitychange', retryAfterReauth);
    };
  }, [loadLearningSettings]);

  function refreshSettings() {
    if (teacherDirty && !refreshArmed) {
      setRefreshArmed(true);
      notify('教师风格有未保存修改；再次点击「刷新」将放弃这些修改，或先点「保存新版本」。', 'warn');
      return;
    }
    setRefreshArmed(false);
    void loadLearningSettings();
  }

  async function saveTeacher() {
    if (!teacher || !teacherReason.trim() || busy) return;
    setBusy(true);
    try {
      const saved = await adminFetch<TeacherProfile>('/learning/teacher-profile', {
        method: 'PUT',
        body: JSON.stringify({
          adjustable: teacher.adjustable,
          style: teacher.style,
          reason: teacherReason.trim(),
        }),
      });
      if (mountedRef.current) {
        setTeacher(saved);
        setServerTeacher(saved);
        setTeacherReason('');
        setRefreshArmed(false);
        await loadLearningSettings();
        notify('教师风格已保存并记录版本。', 'success');
      }
    } catch (error) {
      notify(readableError(error, '保存教师风格失败'), 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function rollbackPersona(historyId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await adminFetch<unknown>(`/learning/teacher-profile/rollback/${encodeURIComponent(historyId)}`, { method: 'PUT' });
      await loadLearningSettings();
      notify('教师风格已回滚并生成新版本。', 'success');
    } catch (error) {
      notify(readableError(error, '回滚失败'), 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function loadMemories() {
    if (!learnerId.trim() || memoryLoading) return;
    setMemoryLoading(true);
    setMemoryError('');
    try {
      const body = await adminFetch<Memory[]>(
        `/learning/learners/${encodeURIComponent(learnerId.trim())}/memories`,
      );
      if (mountedRef.current) {
        setMemories(Array.isArray(body) ? body : []);
        setMemorySearched(true);
      }
    } catch (error) {
      if (mountedRef.current) {
        setMemoryError(readableError(error, '读取学习记忆失败'));
        setMemorySearched(true);
      }
    } finally {
      if (mountedRef.current) setMemoryLoading(false);
    }
  }

  async function deleteMemory(memoryId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await adminFetch<unknown>(
        `/learning/learners/${encodeURIComponent(learnerId.trim())}/memories/${encodeURIComponent(memoryId)}`,
        { method: 'DELETE' },
      );
      await loadMemories();
      notify('记忆已删除。', 'success');
    } catch (error) {
      notify(readableError(error, '删除失败'), 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function saveMemoryEdit() {
    if (!editingMemory || busy) return;
    setBusy(true);
    try {
      await adminFetch<unknown>(
        `/learning/learners/${encodeURIComponent(learnerId.trim())}/memories/${encodeURIComponent(editingMemory.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            memoryType: editingMemory.memoryType,
            content: editingMemory.content,
            importance: editingMemory.importance,
            expiresAt: editingMemory.expiresAt,
          }),
        },
      );
      if (mountedRef.current) setEditingMemory(null);
      await loadMemories();
      notify('记忆已纠正。', 'success');
    } catch (error) {
      notify(readableError(error, '保存失败'), 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <main className="shell">
      <AdminNav />
      <header className="topbar">
        <div>
          <p className="eyebrow">LEARNING SETTINGS</p>
          <h1>学习与记忆</h1>
          <p className="muted">教师风格、版本历史和学习者长期记忆分开管理。进入页面即自动读取教师人格配置。</p>
        </div>
        <button className="secondary" type="button" disabled={busy || loadState === 'loading'} onClick={refreshSettings}>
          {loadState === 'loading' ? '读取中…' : refreshArmed ? '确认放弃修改并刷新' : '重新读取人格配置'}
        </button>
      </header>

      {sessionExpired && <div className="feedback error" role="alert">管理登录已失效，请重新登录后再操作；重新登录后本页会自动重试。<button className="secondary" type="button" onClick={() => window.location.reload()}>重新登录</button></div>}
      {message && <div className={`feedback ${tone}`} role="status">{message}</div>}

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">TEACHER PERSONA</p>
            <h2>教师风格</h2>
            <p className="muted">安全底线固定，不可编辑；风格调整有版本历史，可回滚。启用或修改后需点击「保存新版本」才生效。</p>
          </div>
        </div>

        {loadState === 'loading' && <p className="status">正在读取教师人格配置与版本历史…</p>}
        {loadState === 'error' && <div className="panel"><p className="status error">{message || '读取教师人格配置失败'}</p><div className="row-actions" style={{ marginTop: 12 }}><button className="secondary" type="button" onClick={() => void loadLearningSettings()}>重试读取</button>{sessionExpired && <button type="button" onClick={() => window.location.reload()}>重新登录</button>}</div></div>}
        {loadState === 'ready' && !teacher && <p className="helper">尚无教师人格配置；请点击「重试读取」或先保存一个新版本。</p>}
        {loadState === 'ready' && teacher && (
          <>
            {teacherDirty && <p className="helper">有未保存修改；点击「保存新版本」后才会写入服务端。</p>}
            <div className="fields">
              <label>
                教师风格
                <select
                  value={teacher.style}
                  onChange={(event) => setTeacher({
                    ...teacher,
                    style: event.target.value as TeacherProfile['style'],
                  })}
                >
                  <option value="patient_guide">耐心引导</option>
                  <option value="playful_companion">活泼伙伴</option>
                  <option value="calm_coach">沉稳教练</option>
                  <option value="conversation_partner">英语交流伙伴</option>
                </select>
              </label>
              <label>
                语气
                <select
                  value={teacher.adjustable.tone}
                  onChange={(event) => setTeacher({
                    ...teacher,
                    adjustable: {
                      ...teacher.adjustable,
                      tone: event.target.value as TeacherProfile['adjustable']['tone'],
                    },
                  })}
                >
                  <option value="gentle">温和</option>
                  <option value="lively">活泼</option>
                  <option value="calm">沉静</option>
                </select>
              </label>
              <label>
                鼓励频率
                <select
                  value={teacher.adjustable.encouragement}
                  onChange={(event) => setTeacher({
                    ...teacher,
                    adjustable: {
                      ...teacher.adjustable,
                      encouragement: event.target.value as TeacherProfile['adjustable']['encouragement'],
                    },
                  })}
                >
                  <option value="light">简短</option>
                  <option value="balanced">适度</option>
                  <option value="frequent">频繁</option>
                </select>
              </label>
              <label>
                纠错方式
                <select
                  value={teacher.adjustable.correctionStyle}
                  onChange={(event) => setTeacher({
                    ...teacher,
                    adjustable: {
                      ...teacher.adjustable,
                      correctionStyle: event.target.value as TeacherProfile['adjustable']['correctionStyle'],
                    },
                  })}
                >
                  <option value="model_first">先示范</option>
                  <option value="hint_first">先提示</option>
                  <option value="encourage_retry">先鼓励重试</option>
                </select>
              </label>
              <label>
                基础语速
                <input
                  type="number"
                  min="0.45"
                  max="0.85"
                  step="0.05"
                  value={teacher.adjustable.speakingRate}
                  onChange={(event) => setTeacher({
                    ...teacher,
                    adjustable: { ...teacher.adjustable, speakingRate: Number(event.target.value) },
                  })}
                />
              </label>
            </div>
            <label>
              调整原因
              <input
                value={teacherReason}
                onChange={(event) => setTeacherReason(event.target.value)}
                placeholder="记录为什么调整教师风格"
              />
            </label>
            <div className="row-actions">
              <button type="button" disabled={!teacherReason.trim() || busy} onClick={() => void saveTeacher()}>保存新版本</button>
              <button className="secondary" type="button" disabled={busy} onClick={refreshSettings}>刷新配置</button>
            </div>
            <h3>变更历史</h3>
            {personaHistory.length === 0 && <p className="helper">尚无变更历史记录。</p>}
            <div className="benchmark-list">
              {personaHistory.map((entry) => (
                <div className="helper" key={entry.id}>
                  v{entry.version} · {entry.reason} · {new Date(entry.createdAt).toLocaleString()}
                  {entry.changeContent.includes('"before"') && (
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => void rollbackPersona(entry.id)}
                    >
                      回滚到此前配置
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <div>
            <p className="eyebrow">LEARNER MEMORY</p>
            <h2>学习记忆</h2>
            <p className="muted">按学习者 ID 搜索，仅管理端令牌可纠正或删除长期记忆。此区不会自动加载：输入学习者 ID 后点击「查询学习记忆」。</p>
          </div>
        </div>
        <div className="fields">
          <label>
            学习者 ID
            <input
              value={learnerId}
              onChange={(event) => { setLearnerId(event.target.value); setMemorySearched(false); }}
              placeholder="从学习者档案中复制 ID"
            />
            <small>输入学习者 ID 后查询；未输入并按查询前，下方空白不代表加载失败。</small>
          </label>
          <div className="row-actions" style={{ alignItems: 'flex-start' }}>
            <button className="secondary" type="button" disabled={!learnerId.trim() || memoryLoading} onClick={() => void loadMemories()}>
              {memoryLoading ? '查询中…' : '查询学习记忆'}
            </button>
          </div>
        </div>
        {memoryLoading && <p className="status">正在按学习者 ID 查询长期记忆…</p>}
        {!memoryLoading && memoryError && <div className="feedback error" role="alert">{memoryError}<button className="secondary" type="button" onClick={() => void loadMemories()}>重试查询</button></div>}
        {!memoryLoading && !memoryError && !memorySearched && <p className="helper">输入学习者 ID 后查询；此区为按 ID 的搜索型交互，不会随页面自动加载。</p>}
        {!memoryLoading && !memoryError && memorySearched && memories.length === 0 && <p className="helper">该学习者暂无长期记忆；这是查询后的空结果，不是加载失败。</p>}
        <div className="benchmark-list">
          {memories.map((memory) => (
            <div className="helper" key={memory.id}>
              <strong>{memory.memoryType}</strong> · {memory.content} · 重要度 {memory.importance} · {memory.source}
              <button className="secondary" type="button" onClick={() => setEditingMemory({ ...memory })}>纠正</button>
              <button className="secondary" type="button" disabled={busy} onClick={() => void deleteMemory(memory.id)}>删除</button>
            </div>
          ))}
        </div>
        {editingMemory && (
          <div className="fields">
            <label>
              记忆内容
              <input
                value={editingMemory.content}
                onChange={(event) => setEditingMemory({ ...editingMemory, content: event.target.value })}
              />
            </label>
            <label>
              记忆类型
              <select
                value={editingMemory.memoryType}
                onChange={(event) => setEditingMemory({ ...editingMemory, memoryType: event.target.value })}
              >
                <option value="learning_preference">学习偏好</option>
                <option value="encouragement_preference">鼓励偏好</option>
                <option value="lesson_learning_summary">课堂学习摘要</option>
                <option value="caregiver_note">照护者备注</option>
              </select>
            </label>
            <button type="button" disabled={!editingMemory.content.trim() || busy} onClick={() => void saveMemoryEdit()}>保存纠正</button>
            <button className="secondary" type="button" onClick={() => setEditingMemory(null)}>取消</button>
          </div>
        )}
        <p className="helper">面向监护人的专用账号与授权仍待账户体系实现。</p>
      </section>
    </main>
  );
}

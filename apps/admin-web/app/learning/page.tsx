'use client';

import { useState } from 'react';
import { AdminNav } from '../admin-nav';

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

type Memory = {
  id: string;
  memoryType: string;
  content: string;
  importance: number;
  source: string;
  expiresAt: string | null;
};

function apiRoot() {
  return '';
}

export default function LearningPage() {
  const [teacher, setTeacher] = useState<TeacherProfile | null>(null);
  const [teacherReason, setTeacherReason] = useState('');
  const [personaHistory, setPersonaHistory] = useState<Array<{
    id: string;
    version: number;
    reason: string;
    createdAt: string;
    changeContent: string;
  }>>([]);
  const [learnerId, setLearnerId] = useState('');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadLearningSettings() {
    const [profileRes, historyRes] = await Promise.all([
      fetch(`${apiRoot()}/api/v1/admin/learning/teacher-profile`),
      fetch(`${apiRoot()}/api/v1/admin/learning/teacher-profile/history`),
    ]);
    if (!profileRes.ok || !historyRes.ok) throw new Error('读取教师人格配置失败');
    setTeacher(await profileRes.json());
    setPersonaHistory(await historyRes.json());
  }

  async function saveTeacher() {
    if (!teacher || !teacherReason.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiRoot()}/api/v1/admin/learning/teacher-profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          adjustable: teacher.adjustable,
          style: teacher.style,
          reason: teacherReason.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? `保存失败 (${response.status})`);
      setTeacher(body);
      setTeacherReason('');
      await loadLearningSettings();
      setMessage('教师风格已保存并记录版本。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存教师风格失败');
    } finally {
      setBusy(false);
    }
  }

  async function rollbackPersona(historyId: string) {
    const response = await fetch(
      `${apiRoot()}/api/v1/admin/learning/teacher-profile/rollback/${encodeURIComponent(historyId)}`,
      { method: 'PUT' },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? `回滚失败 (${response.status})`);
    await loadLearningSettings();
    setMessage('教师风格已回滚并生成新版本。');
  }

  async function loadMemories() {
    const response = await fetch(
      `${apiRoot()}/api/v1/admin/learning/learners/${encodeURIComponent(learnerId)}/memories`,
      {},
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? `读取记忆失败 (${response.status})`);
    setMemories(body);
  }

  async function deleteMemory(memoryId: string) {
    const response = await fetch(
      `${apiRoot()}/api/v1/admin/learning/learners/${encodeURIComponent(learnerId)}/memories/${encodeURIComponent(memoryId)}`,
      { method: 'DELETE' },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? `删除失败 (${response.status})`);
    await loadMemories();
    setMessage('记忆已删除。');
  }

  async function saveMemoryEdit() {
    if (!editingMemory) return;
    const response = await fetch(
      `${apiRoot()}/api/v1/admin/learning/learners/${encodeURIComponent(learnerId)}/memories/${encodeURIComponent(editingMemory.id)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          memoryType: editingMemory.memoryType,
          content: editingMemory.content,
          importance: editingMemory.importance,
          expiresAt: editingMemory.expiresAt,
        }),
      },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? `保存失败 (${response.status})`);
    setEditingMemory(null);
    await loadMemories();
    setMessage('记忆已纠正。');
  }

  return (
    <main className="shell">
      <AdminNav />
      <header className="topbar">
        <div>
          <p className="eyebrow">LEARNING SETTINGS</p>
          <h1>学习与记忆</h1>
          <p className="muted">教师风格、版本历史和学习者长期记忆分开管理。</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">TEACHER PERSONA</p>
            <h2>教师风格</h2>
            <p className="muted">安全底线固定，不可编辑；风格调整有版本历史，可回滚。</p>
          </div>
          {!teacher && (
            <button
              className="secondary"
              onClick={() => void loadLearningSettings().catch((error) => setMessage(error.message))}
            >
              读取人格配置
            </button>
          )}
        </div>

        {teacher && (
          <>
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
            <button
              disabled={!teacherReason.trim() || busy}
              onClick={() => void saveTeacher()}
            >
              保存新版本
            </button>
            <h3>变更历史</h3>
            <div className="benchmark-list">
              {personaHistory.map((entry) => (
                <div className="helper" key={entry.id}>
                  v{entry.version} · {entry.reason} · {new Date(entry.createdAt).toLocaleString()}
                  {entry.changeContent.includes('"before"') && (
                    <button
                      className="secondary"
                      onClick={() => void rollbackPersona(entry.id).catch((error) => setMessage(error.message))}
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
            <p className="muted">仅管理端令牌可纠正或删除长期记忆。</p>
          </div>
        </div>
        <div className="fields">
          <label>
            学习者 ID
            <input
              value={learnerId}
              onChange={(event) => setLearnerId(event.target.value)}
              placeholder="从学习者档案中复制 ID"
            />
          </label>
          <button
            className="secondary"
            disabled={!learnerId}
            onClick={() => void loadMemories().catch((error) => setMessage(error.message))}
          >
            读取学习记忆
          </button>
        </div>
        <div className="benchmark-list">
          {memories.map((memory) => (
            <div className="helper" key={memory.id}>
              <strong>{memory.memoryType}</strong> · {memory.content} · 重要度 {memory.importance} · {memory.source}
              <button className="secondary" onClick={() => setEditingMemory({ ...memory })}>纠正</button>
              <button
                className="secondary"
                onClick={() => void deleteMemory(memory.id).catch((error) => setMessage(error.message))}
              >
                删除
              </button>
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
            <button
              disabled={!editingMemory.content.trim()}
              onClick={() => void saveMemoryEdit().catch((error) => setMessage(error.message))}
            >
              保存纠正
            </button>
            <button className="secondary" onClick={() => setEditingMemory(null)}>取消</button>
          </div>
        )}
        <p className="helper">面向监护人的专用账号与授权仍待账户体系实现。</p>
      </section>
      <p className="status">{message}</p>
    </main>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { AdminNav } from '../admin-nav';

type Textbook = {
  id: string;
  publisher: string;
  publicationYear: number;
  grade: string;
  title: string | null;
  edition: string | null;
  units: Array<{ id: string; unitCode: string; title: string }>;
};
type Draft = {
  id: string;
  title: string;
  level: string;
  status: string;
  wordList: string[];
  generatedContent: { objectives?: string[]; vocabulary?: Array<{ word: string }>; activities?: unknown[] } | null;
  textbook?: Textbook | null;
  textbookUnit?: { unitCode: string; title: string } | null;
  reviewNote?: string | null;
};

function apiRoot() {
  return '';
}

export default function CurriculumPage() {
  const [token, setToken] = useState('');
  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editingId, setEditingId] = useState('');
  const [contentText, setContentText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [textbook, setTextbook] = useState({ publisher: '', publicationYear: new Date().getFullYear(), grade: '', title: '', edition: '' });
  const [draft, setDraft] = useState({ title: '', level: 'pre-A', words: '', textbookId: '', textbookUnitId: '' });

  function headers() { return { 'x-admin-token': token }; }
  async function request(path: string, init?: RequestInit) {
    const response = await fetch(`${apiRoot()}${path}`, { ...init, headers: { ...headers(), ...(init?.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
    return body;
  }
  async function load() {
    const [books, items] = await Promise.all([
      request('/api/v1/admin/curriculum/textbooks'),
      request('/api/v1/admin/curriculum/drafts'),
    ]);
    setTextbooks(books);
    setDrafts(items);
  }
  useEffect(() => { if (token) void load().catch((error) => setMessage(error.message)); }, [token]);

  async function createTextbook() {
    setBusy(true);
    try {
      await request('/api/v1/admin/curriculum/textbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(textbook) });
      setTextbook({ publisher: '', publicationYear: new Date().getFullYear(), grade: '', title: '', edition: '' });
      await load(); setMessage('教材版本已保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); } finally { setBusy(false); }
  }
  async function createDraft() {
    setBusy(true);
    try {
      await request('/api/v1/admin/curriculum/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...draft, textbookId: draft.textbookId || undefined, textbookUnitId: draft.textbookUnitId || undefined }) });
      setDraft({ title: '', level: 'pre-A', words: '', textbookId: '', textbookUnitId: '' });
      await load(); setMessage('课程草稿已创建。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '创建失败'); } finally { setBusy(false); }
  }
  async function importPackage() {
    if (!packageFile) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', packageFile);
      const response = await fetch(`${apiRoot()}/api/v1/admin/curriculum/package/import`, {
        method: 'POST',
        headers: headers(),
        body: form,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || `导入失败 (${response.status})`);
      setPackageFile(null);
      const input = document.getElementById('curriculum-package-file') as HTMLInputElement | null;
      if (input) input.value = '';
      await load();
      setMessage(`课程包导入完成：新增 ${body.imported} 个单元，跳过 ${body.skipped} 个重复单元。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '课程包导入失败');
    } finally {
      setBusy(false);
    }
  }
  async function draftAction(id: string, action: 'generate' | 'submit' | 'approve' | 'reject' | 'publish') {
    setBusy(true);
    try {
      if (action === 'generate') await request(`/api/v1/admin/curriculum/drafts/${id}/generate`, { method: 'POST' });
      else if (action === 'publish') await request(`/api/v1/admin/curriculum/drafts/${id}/publish`, { method: 'POST' });
      else await request(`/api/v1/admin/curriculum/drafts/${id}/review`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, reviewer: 'admin-web', note: '' }) });
      await load(); setMessage('课程状态已更新。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); }
  }
  async function saveContent(item: Draft) {
    setBusy(true);
    try {
      const content = JSON.parse(contentText);
      await request(`/api/v1/admin/curriculum/drafts/${item.id}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(content) });
      await load(); setEditingId(''); setMessage('课程内容已保存为待审核草稿。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存课程内容失败'); } finally { setBusy(false); }
  }
  const selectedBook = textbooks.find((book) => book.id === draft.textbookId);

  return <main className="shell">
    <AdminNav />
    <header className="topbar">
      <div><p className="eyebrow">CURRICULUM STUDIO</p><h1>课程管理</h1><p className="muted">教材目录、AI 草稿、人工审核和发布分开管理。</p></div>
      <div className="token"><label htmlFor="curriculum-token">后台管理令牌</label><input id="curriculum-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ADMIN_CONFIG_TOKEN" /></div>
    </header>
    {!token && <div className="notice"><strong>先输入后台令牌</strong><span>课程生成和发布接口只接受服务端环境中的管理令牌。</span></div>}
    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">TEXTBOOK CATALOG</p><h2>教材版本</h2><p className="muted">按出版社、出版年份、年级归类，可继续扩展版本和单元。</p></div></div>
      <div className="fields">
        <label>出版社<input value={textbook.publisher} onChange={(e) => setTextbook({ ...textbook, publisher: e.target.value })} /></label>
        <label>出版年份<input type="number" value={textbook.publicationYear} onChange={(e) => setTextbook({ ...textbook, publicationYear: Number(e.target.value) })} /></label>
        <label>年级<input value={textbook.grade} onChange={(e) => setTextbook({ ...textbook, grade: e.target.value })} placeholder="三年级" /></label>
        <label>教材名称<input value={textbook.title} onChange={(e) => setTextbook({ ...textbook, title: e.target.value })} /></label>
        <label>版本<input value={textbook.edition} onChange={(e) => setTextbook({ ...textbook, edition: e.target.value })} placeholder="上册/修订版" /></label>
      </div>
      <button disabled={!token || busy || !textbook.publisher || !textbook.grade} onClick={() => void createTextbook()}>保存教材版本</button>
      <div className="benchmark-list">{textbooks.map((book) => <div className="helper" key={book.id}><strong>{book.publisher}</strong> · {book.publicationYear} · {book.grade} · {book.title || '未命名'} {book.edition || ''} · 单元 {book.units.length}</div>)}</div>
    </section>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">CEFR COURSE PACKAGE</p><h2>导入完整 CEFR 课程包</h2><p className="muted">支持 pre-A1、A1、A2、B1、B2、C1、C2。导入后每个单元进入待人工审核队列，不会自动发布。</p></div></div>
      <div className="fields">
        <label>课程包 ZIP 文件<input id="curriculum-package-file" type="file" accept=".zip,application/zip" onChange={(event) => setPackageFile(event.target.files?.[0] || null)} /></label>
        <div className="helper">课程包必须包含根目录文件 <strong>curriculum-package.json</strong>，等级顺序和结构由服务端校验。重复导入同一 packageId 与单元编码会自动跳过。</div>
      </div>
      <button disabled={!token || busy || !packageFile} onClick={() => void importPackage()}>导入课程包</button>
    </section>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">AI DRAFT</p><h2>按词表生成课程</h2><p className="muted">每行一个单词。AI 只生成待审核内容，不会直接修改孩子掌握状态。</p></div></div>
      <div className="fields">
        <label>课程标题<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
        <label>学习等级<select value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value })}><option>pre-A</option><option>A</option><option>B</option><option>C</option></select></label>
        <label>教材版本<select value={draft.textbookId} onChange={(e) => setDraft({ ...draft, textbookId: e.target.value, textbookUnitId: '' })}><option value="">不绑定教材</option>{textbooks.map((book) => <option key={book.id} value={book.id}>{book.publisher} · {book.publicationYear} · {book.grade} · {book.title || '教材'}</option>)}</select></label>
        <label>教材单元<select value={draft.textbookUnitId} onChange={(e) => setDraft({ ...draft, textbookUnitId: e.target.value })}><option value="">不绑定单元</option>{selectedBook?.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.unitCode} · {unit.title}</option>)}</select></label>
      </div>
      <label>词表<textarea className="routing-editor" style={{ minHeight: 150 }} value={draft.words} onChange={(e) => setDraft({ ...draft, words: e.target.value })} placeholder={'hello\napple\nbook'} /></label>
      <button disabled={!token || busy || !draft.title || !draft.words.trim()} onClick={() => void createDraft()}>创建课程草稿</button>
    </section>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">REVIEW QUEUE</p><h2>审核队列</h2></div></div>
      {drafts.map((item) => <div className="helper" key={item.id}>
        <strong>{item.title}</strong> · {item.level} · {item.status} · {item.wordList.length} 个词
        {item.generatedContent?.vocabulary && ` · 已生成 ${item.generatedContent.vocabulary.length} 个词条`}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {item.status === 'draft' && <button className="secondary" disabled={busy} onClick={() => void draftAction(item.id, 'generate')}>生成草稿</button>}
          {item.generatedContent && ['generated', 'rejected'].includes(item.status) && <button className="secondary" disabled={busy} onClick={() => { setEditingId(item.id); setContentText(JSON.stringify(item.generatedContent, null, 2)); }}>编辑课程</button>}
          {['generated', 'rejected'].includes(item.status) && <button className="secondary" disabled={busy} onClick={() => void draftAction(item.id, 'submit')}>提交审核</button>}
          {item.status === 'under_review' && <><button disabled={busy} onClick={() => void draftAction(item.id, 'approve')}>审核通过</button><button className="secondary" disabled={busy} onClick={() => void draftAction(item.id, 'reject')}>退回修改</button></>}
          {item.status === 'approved' && <button disabled={busy} onClick={() => void draftAction(item.id, 'publish')}>发布课程</button>}
        </div>
        {editingId === item.id && <div style={{ marginTop: 12 }}>
          <textarea className="routing-editor" style={{ minHeight: 280 }} value={contentText} onChange={(event) => setContentText(event.target.value)} aria-label="课程结构化内容" />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button disabled={busy} onClick={() => void saveContent(item)}>保存修改</button>
            <button className="secondary" onClick={() => setEditingId('')}>取消</button>
          </div>
        </div>}
      </div>)}
      {!drafts.length && <p className="muted">暂无课程草稿。</p>}
    </section>
    <p className="status">{message}</p>
  </main>;
}

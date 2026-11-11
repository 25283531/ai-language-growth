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
type EditableContent = {
  title: string;
  level: string;
  objectives: string[];
  vocabulary: Array<{
    word: string;
    phonetic?: string;
    meaningZh?: string;
    phrases?: string[];
    exampleSentences?: string[];
    image?: { url: string; license: string; attribution?: string };
  }>;
  activities: Array<Record<string, unknown>>;
  images: Array<{ url: string; license: string; attribution?: string }>;
};

function toEditableContent(value: Draft['generatedContent']): EditableContent {
  const content = (value ?? {}) as Partial<EditableContent>;
  return {
    title: content.title ?? '',
    level: content.level ?? '',
    objectives: Array.isArray(content.objectives) ? content.objectives : [],
    vocabulary: Array.isArray(content.vocabulary) ? content.vocabulary.map((word) => ({
      ...word,
      image: word.image ? { ...word.image } : undefined,
    })) : [],
    activities: Array.isArray(content.activities) ? content.activities as Array<Record<string, unknown>> : [],
    images: Array.isArray(content.images) ? content.images : [],
  };
}

function apiRoot() {
  return '';
}

export default function CurriculumPage() {
  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editingId, setEditingId] = useState('');
  const [editingContent, setEditingContent] = useState<EditableContent | null>(null);
  const [selectedDrafts, setSelectedDrafts] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [generationDescription, setGenerationDescription] = useState('');
  const [generatedPackage, setGeneratedPackage] = useState('');
  const [textbook, setTextbook] = useState({ publisher: '', publicationYear: new Date().getFullYear(), grade: '', title: '', edition: '' });
  const [draft, setDraft] = useState({ title: '', level: 'pre-A', outline: '', objectives: '', words: '', textbookId: '', textbookUnitId: '' });
  const [wordListText, setWordListText] = useState('');
  const [curriculumTitle, setCurriculumTitle] = useState('');
  const [curriculumLevel, setCurriculumLevel] = useState('pre-A1');
  const [generatedJson, setGeneratedJson] = useState('');
  const [generatedSummary, setGeneratedSummary] = useState('');
  const [presetSummary, setPresetSummary] = useState('');
  const [warmupLevel, setWarmupLevel] = useState('pre-A1');

  function headers() { return {}; }
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
    setSelectedDrafts((old) => old.filter((id) => items.some((item: Draft) => item.id === id)));
  }
  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, []);

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
      setDraft({ title: '', level: 'pre-A', outline: '', objectives: '', words: '', textbookId: '', textbookUnitId: '' });
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
  async function generatePackage() {
    setBusy(true);
    try {
      const result = await request('/api/v1/admin/curriculum/generator/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: draft.title,
          level: draft.level,
          words: draft.words,
          outline: draft.outline,
          objectives: draft.objectives,
          description: generationDescription,
          textbook: selectedBook ? {
            publisher: selectedBook.publisher,
            publicationYear: selectedBook.publicationYear,
            grade: selectedBook.grade,
            edition: selectedBook.edition || undefined,
          } : undefined,
        }),
      });
      setGeneratedPackage(result.packageId);
      setMessage('课程包已生成。请下载后导入审核队列，人工审核通过后再发布。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '课程包生成失败'); }
    finally { setBusy(false); }
  }
  async function generateFromWordList() {
    setBusy(true);
    try {
      const result = await request('/api/v1/admin/curriculum/textbook/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: curriculumTitle.trim() || `${curriculumLevel} 教材课程`,
          level: curriculumLevel,
          words: wordListText,
          unitSize: 6,
          useAi: true,
          persist: true,
        }),
      });
      setGeneratedJson(JSON.stringify(result.package, null, 2));
      setGeneratedSummary(`已生成 ${result.levels.map((item: { code: string; units: number; lessons: number }) => `${item.code} ${item.units} 单元/${item.lessons} 活动`).join('；')}；写入草稿 ${result.draftCount} 个${result.aiEnriched ? '，已用 AI 润色词义与例句' : '，AI 润色未启用或失败，已保留确定性结构'}。`);
      await load();
      setMessage('完整课程 JSON 已生成并写入审核队列。' + (result.aiEnriched ? '' : ' AI 润色未生效，可在审核时人工补齐音标/释义。'));
    } catch (error) { setMessage(error instanceof Error ? error.message : '词表生成失败'); }
    finally { setBusy(false); }
  }
  async function loadPresetJson() {
    setBusy(true);
    try {
      const preset = await request(`/api/v1/admin/curriculum/preset?level=${encodeURIComponent(curriculumLevel)}`);
      setGeneratedJson(JSON.stringify(preset, null, 2));
      setPresetSummary(preset.levels.map((level: { code: string; units: Array<{ lessons: unknown[] }> }) => `${level.code} · ${level.units.length} 单元 · ${level.units.reduce((sum, unit) => sum + unit.lessons.length, 0)} 活动`).join('；'));
      setMessage('已读取服务端预置 CEFR 纯 JSON 内容；未下载图片，也未合成语音。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '读取预置课程失败'); }
    finally { setBusy(false); }
  }
  async function importPreset() {
    setBusy(true);
    try {
      const result = await request('/api/v1/admin/curriculum/preset/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: curriculumLevel }),
      });
      await load();
      setMessage(`预置课程已导入：新增 ${result.created.length} 个草稿，跳过 ${result.skipped} 个重复单元。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '导入预置课程失败'); }
    finally { setBusy(false); }
  }
  async function warmLevelMedia() {
    setBusy(true);
    try {
      const result = await request('/api/v1/admin/curriculum/preset/warmup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: warmupLevel, maxImages: 24, maxSpeech: 30 }),
      });
      setMessage(`级别 ${result.level} 预热：图片 ${result.imagesResolved} 张 / 语音 ${result.speechGenerated} 条，跳过 ${result.speechSkipped} 条，失败 ${result.speechFailed} 条。${result.reason || ''}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '级别媒体预热失败'); }
    finally { setBusy(false); }
  }
  function downloadGeneratedJson() {
    if (!generatedJson) return;
    const blob = new Blob([generatedJson], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `curriculum-${curriculumLevel}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function draftAction(id: string, action: 'generate' | 'submit' | 'approve' | 'reject' | 'publish') {
    setPendingAction(`${id}:${action}`);
    setDraftErrors((old) => ({ ...old, [id]: '' }));
    try {
      if (action === 'generate') await request(`/api/v1/admin/curriculum/drafts/${id}/generate`, { method: 'POST' });
      else if (action === 'publish') await request(`/api/v1/admin/curriculum/drafts/${id}/publish`, { method: 'POST' });
      else await request(`/api/v1/admin/curriculum/drafts/${id}/review`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, reviewer: 'admin-web', note: '' }) });
      await load(); setMessage(action === 'publish' ? '课程已发布，可在课程目录中查看。' : '课程状态已更新。');
    } catch (error) {
      const detail = error instanceof Error ? error.message : '操作失败';
      setDraftErrors((old) => ({ ...old, [id]: detail }));
      setMessage(action === 'publish' ? `发布未完成：${detail}` : detail);
    } finally { setPendingAction(''); }
  }
  async function batchAction(action: 'approve' | 'reject' | 'publish') {
    if (!selectedDrafts.length) return;
    setBusy(true);
    try {
      await request('/api/v1/admin/curriculum/drafts/batch-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftIds: selectedDrafts, action, reviewer: 'admin-web' }),
      });
      setSelectedDrafts([]);
      await load();
      setMessage(`已批量${action === 'approve' ? '通过' : action === 'reject' ? '退回' : '发布'} ${selectedDrafts.length} 节课程。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '批量操作失败'); }
    finally { setBusy(false); }
  }
  async function batchDelete() {
    if (busy || pendingAction || !canBatchDelete) return;
    const ids = selectedStatus.map((item) => item.id);
    if (!window.confirm(`确定删除选中的 ${ids.length} 节已发布课程？课程将归档并停止用于后续学习，孩子的学习历史和审核记录会保留。`)) return;
    setBusy(true);
    try {
      const result = await request('/api/v1/admin/curriculum/drafts/batch-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftIds: ids, confirm: true }),
      });
      setSelectedDrafts([]);
      await load();
      setMessage(`已删除（归档）${result.count} 节已发布课程，学习历史和审核记录已保留。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '批量删除失败'); }
    finally { setBusy(false); }
  }
  async function saveContent(item: Draft) {
    setBusy(true);
    try {
      if (!editingContent) throw new Error('没有可保存的课程内容');
      await request(`/api/v1/admin/curriculum/drafts/${item.id}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editingContent) });
      await load(); setEditingId(''); setMessage('课程内容已保存为待审核草稿。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存课程内容失败'); } finally { setBusy(false); }
  }
  function updateVocabulary(index: number, patch: Partial<EditableContent['vocabulary'][number]>) {
    setEditingContent((old) => old ? { ...old, vocabulary: old.vocabulary.map((item, i) => i === index ? { ...item, ...patch } : item) } : old);
  }
  const selectedBook = textbooks.find((book) => book.id === draft.textbookId);
  const selectedStatus = drafts.filter((item) => selectedDrafts.includes(item.id));
  const canBatchReview = selectedStatus.length > 0 && selectedStatus.every((item) => item.status === 'under_review');
  const canBatchPublish = selectedStatus.length > 0 && selectedStatus.every((item) => item.status === 'approved');
  const canBatchDelete = selectedStatus.length > 0 && selectedStatus.every((item) => item.status === 'published');
  const allSelected = drafts.length > 0 && selectedStatus.length === drafts.length;
  const partiallySelected = selectedStatus.length > 0 && !allSelected;
  const hasGenerationInput = Boolean(draft.words.trim() || (draft.outline.trim() && draft.objectives.trim()));

  return <main className="shell">
    <AdminNav />
    <header className="topbar">
      <div><p className="eyebrow">CURRICULUM STUDIO</p><h1>课程管理</h1><p className="muted">教材目录、AI 草稿、人工审核和发布分开管理。</p></div>
      <button className="secondary" onClick={() => void load().catch((error) => setMessage(error.message))}>刷新课程数据</button>
    </header>
    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">WORDLIST → FULL CURRICULUM</p><h2>教材词表一键补全</h2><p className="muted">粘贴课本单词表，服务端生成完整 JSON（词汇、句型、逐词活动、评估规则、媒体需求），默认写入审核队列。图片与语音不在这一步生成。</p></div></div>
      <div className="fields">
        <label>课程标题<input value={curriculumTitle} onChange={(event) => setCurriculumTitle(event.target.value)} placeholder="例如：三年级上册 Unit 3" /></label>
        <label>目标等级<select value={curriculumLevel} onChange={(event) => setCurriculumLevel(event.target.value)}><option>pre-A1</option><option>A1</option><option>A2</option><option>B1</option><option>B2</option><option>C1</option><option>C2</option></select></label>
      </div>
      <label>课本单词表（每行一个，或用逗号分隔）<textarea className="routing-editor" style={{ minHeight: 110 }} value={wordListText} onChange={(event) => setWordListText(event.target.value)} placeholder={'apple\nbanana\norange'} /></label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button disabled={busy || !wordListText.trim()} onClick={() => void generateFromWordList()}>生成完整课程 JSON</button>
        <button className="secondary" disabled={busy} onClick={() => void loadPresetJson()}>查看服务端预置 CEFR JSON</button>
        <button className="secondary" disabled={busy} onClick={() => void importPreset()}>导入预置课程到审核队列</button>
        <button className="secondary" disabled={!generatedJson} onClick={downloadGeneratedJson}>下载当前 JSON</button>
      </div>
      {(generatedSummary || presetSummary) && <p className="helper">{generatedSummary || presetSummary}</p>}
      <div className="fields" style={{ marginTop: 14 }}>
        <label>到达级别媒体预热<select value={warmupLevel} onChange={(event) => setWarmupLevel(event.target.value)}><option>pre-A1</option><option>A1</option><option>A2</option><option>B1</option><option>B2</option><option>C1</option><option>C2</option></select></label>
        <div className="helper">只处理该级别已发布的课程：先解析并缓存图片，再按发布内容预生成公共语音。mock 模式会跳过语音，避免占位音频进入正式缓存。</div>
      </div>
      <button className="secondary" disabled={busy} onClick={() => void warmLevelMedia()}>预热该级别图片与语音</button>
    </section>
    <section className="panel">
      <div className="panel-head"><div><p className="eyebrow">TEXTBOOK CATALOG</p><h2>教材版本</h2><p className="muted">按出版社、出版年份、年级归类，可继续扩展版本和单元。</p></div></div>
      <div className="fields">
        <label>出版社<input value={textbook.publisher} onChange={(e) => setTextbook({ ...textbook, publisher: e.target.value })} /></label>
        <label>出版年份<input type="number" value={textbook.publicationYear} onChange={(e) => setTextbook({ ...textbook, publicationYear: Number(e.target.value) })} /></label>
        <label>年级<input value={textbook.grade} onChange={(e) => setTextbook({ ...textbook, grade: e.target.value })} placeholder="三年级" /></label>
        <label>教材名称<input value={textbook.title} onChange={(e) => setTextbook({ ...textbook, title: e.target.value })} /></label>
        <label>版本<input value={textbook.edition} onChange={(e) => setTextbook({ ...textbook, edition: e.target.value })} placeholder="上册/修订版" /></label>
      </div>
      <button disabled={busy || !textbook.publisher || !textbook.grade} onClick={() => void createTextbook()}>保存教材版本</button>
      <div className="benchmark-list">{textbooks.map((book) => <div className="helper" key={book.id}><strong>{book.publisher}</strong> · {book.publicationYear} · {book.grade} · {book.title || '未命名'} {book.edition || ''} · 单元 {book.units.length}</div>)}</div>
    </section>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">CEFR COURSE PACKAGE</p><h2>导入完整 CEFR 课程包</h2><p className="muted">支持 pre-A1、A1、A2、B1、B2、C1、C2。导入后每个单元进入待人工审核队列，不会自动发布。</p></div></div>
      <div className="fields">
        <label>课程包 ZIP 文件<input id="curriculum-package-file" type="file" accept=".zip,application/zip" onChange={(event) => setPackageFile(event.target.files?.[0] || null)} /></label>
        <div className="helper">课程包必须包含根目录文件 <strong>curriculum-package.json</strong>，等级顺序和结构由服务端校验。重复导入同一 packageId 与单元编码会自动跳过。</div>
      </div>
      <button disabled={busy || !packageFile} onClick={() => void importPackage()}>导入课程包</button>
    </section>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">AI DRAFT</p><h2>按大纲和教学目的补全课程</h2><p className="muted">提交课程大纲与教学目的，词表可选；也支持沿用词表生成。小参数模型整理语言素材，主文本模型补全课程和教学活动，结果须人工审核后发布。</p></div></div>
      <div className="fields">
        <label>课程标题<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
        <label>学习等级<select value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value })}><option>pre-A</option><option>A</option><option>B</option><option>C</option></select></label>
        <label>教材版本<select value={draft.textbookId} onChange={(e) => setDraft({ ...draft, textbookId: e.target.value, textbookUnitId: '' })}><option value="">不绑定教材</option>{textbooks.map((book) => <option key={book.id} value={book.id}>{book.publisher} · {book.publicationYear} · {book.grade} · {book.title || '教材'}</option>)}</select></label>
        <label>教材单元<select value={draft.textbookUnitId} onChange={(e) => setDraft({ ...draft, textbookUnitId: e.target.value })}><option value="">不绑定单元</option>{selectedBook?.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.unitCode} · {unit.title}</option>)}</select></label>
      </div>
      <label>课程大纲<textarea className="routing-editor" style={{ minHeight: 120 }} value={draft.outline} onChange={(event) => setDraft({ ...draft, outline: event.target.value })} placeholder="例如：从听懂问候、理解使用场景、跟读模仿，逐步过渡到主动打招呼和简短交流。" /></label>
      <label>教学目的<textarea className="routing-editor" style={{ minHeight: 90 }} value={draft.objectives} onChange={(event) => setDraft({ ...draft, objectives: event.target.value })} placeholder="例如：孩子能在真实见面场景中听懂并主动使用 hello，而非只会背诵单词。" /></label>
      <label>参考词表（可选，每行一个）<textarea className="routing-editor" style={{ minHeight: 100 }} value={draft.words} onChange={(e) => setDraft({ ...draft, words: e.target.value })} placeholder={'hello\nhi\ngoodbye'} /></label>
      <button disabled={busy || !draft.title.trim() || !hasGenerationInput} onClick={() => void createDraft()}>创建待补全草稿</button>
      <p className="muted">创建后点击队列中的“AI 补全课程”；补全不会自动发布或改变孩子掌握状态。</p>
      <label style={{ marginTop: 16 }}>自然语言课程要求<textarea className="routing-editor" style={{ minHeight: 120 }} value={generationDescription} onChange={(event) => setGenerationDescription(event.target.value)} placeholder="例如：面向零基础儿童，围绕校园用品设计由听辨、模仿到日常对话的七阶段课程；每阶段提供可判断掌握情况的活动。" /></label>
      <button className="secondary" disabled={busy || !draft.title.trim() || !hasGenerationInput} onClick={() => void generatePackage()}>生成并下载独立课程包</button>
      {generatedPackage && <a className="doclink" href={`/api/v1/admin/curriculum/generator/packages/${generatedPackage}/download`}>下载刚生成的课程 ZIP</a>}
    </section>
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-head"><div><p className="eyebrow">REVIEW QUEUE</p><h2>审核队列</h2></div></div>
      <div className="row-actions" style={{ marginBottom: 14 }}>
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" aria-label="全选当前列表课程" aria-checked={partiallySelected ? 'mixed' : allSelected} checked={allSelected} ref={(element) => { if (element) element.indeterminate = partiallySelected; }} disabled={!drafts.length || busy || Boolean(pendingAction)} onChange={(event) => setSelectedDrafts(event.target.checked ? drafts.map((item) => item.id) : [])} />
          全选当前列表
        </label>
        <button className="secondary" disabled={!canBatchReview || busy || Boolean(pendingAction)} onClick={() => void batchAction('approve')}>批量审核通过</button>
        <button className="secondary" disabled={!canBatchReview || busy || Boolean(pendingAction)} onClick={() => void batchAction('reject')}>批量退回</button>
        <button disabled={!canBatchPublish || busy || Boolean(pendingAction)} onClick={() => void batchAction('publish')}>批量发布</button>
        <button className="secondary" disabled={!canBatchDelete || busy || Boolean(pendingAction)} onClick={() => void batchDelete()}>批量删除已发布课程</button>
        <span className="status">已选择 {selectedDrafts.length} 节</span>
      </div>
      {drafts.map((item) => <div className="helper" key={item.id}>
        <label className="switch" style={{ display: 'inline-flex', marginRight: 8 }}><input type="checkbox" aria-label={`选择课程：${item.title}`} disabled={busy || Boolean(pendingAction)} checked={selectedDrafts.includes(item.id)} onChange={(event) => setSelectedDrafts((old) => event.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id))} /><span /></label>
        <strong>{item.title}</strong> · {item.level} · {item.status} · {item.wordList.length} 个词
        {item.generatedContent?.vocabulary && ` · 已生成 ${item.generatedContent.vocabulary.length} 个词条`}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {item.status === 'draft' && <button className="secondary" disabled={busy} onClick={() => void draftAction(item.id, 'generate')}>AI 补全课程</button>}
          {item.generatedContent && ['generated', 'rejected'].includes(item.status) && <button className="secondary" disabled={busy} onClick={() => { setEditingId(item.id); setEditingContent(toEditableContent(item.generatedContent)); }}>编辑课程</button>}
          {['generated', 'rejected'].includes(item.status) && <button className="secondary" disabled={busy} onClick={() => void draftAction(item.id, 'submit')}>提交审核</button>}
          {item.status === 'under_review' && <><button disabled={Boolean(pendingAction)} onClick={() => void draftAction(item.id, 'approve')}>{pendingAction === `${item.id}:approve` ? '处理中…' : '审核通过'}</button><button className="secondary" disabled={Boolean(pendingAction)} onClick={() => void draftAction(item.id, 'reject')}>{pendingAction === `${item.id}:reject` ? '处理中…' : '退回修改'}</button></>}
          {item.status === 'approved' && <button disabled={Boolean(pendingAction)} onClick={() => void draftAction(item.id, 'publish')}>{pendingAction === `${item.id}:publish` ? '正在发布…' : '发布课程'}</button>}
        </div>
        {draftErrors[item.id] && <p className="status" role="alert">操作失败：{draftErrors[item.id]}</p>}
        {editingId === item.id && editingContent && <div style={{ marginTop: 12 }}>
          <div className="fields">
            <label>课程标题<input value={editingContent.title} onChange={(event) => setEditingContent({ ...editingContent, title: event.target.value })} /></label>
            <label>学习等级<input value={editingContent.level} readOnly /></label>
          </div>
          <label>教学目标（每行一条）<textarea className="routing-editor" style={{ minHeight: 90 }} value={editingContent.objectives.join('\n')} onChange={(event) => setEditingContent({ ...editingContent, objectives: event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) })} /></label>
          <h3>词汇与图片</h3>
          {editingContent.vocabulary.map((word, index) => <div className="helper" key={`${word.word}-${index}`}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 10 }}>
              {word.image?.url && <img src={word.image.url} alt={word.word || '课程配图预览'} style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 6 }} />}
              <div><strong>{word.word || '新词汇'}</strong><div className="muted">{word.phonetic || '尚无音标'} · {word.meaningZh || '尚无释义'}</div></div>
            </div>
            <div className="fields">
              <label>单词<input value={word.word} onChange={(event) => updateVocabulary(index, { word: event.target.value })} /></label>
              <label>音标<input value={word.phonetic ?? ''} onChange={(event) => updateVocabulary(index, { phonetic: event.target.value })} placeholder="/.../" /></label>
              <label>中文释义<input value={word.meaningZh ?? ''} onChange={(event) => updateVocabulary(index, { meaningZh: event.target.value })} /></label>
              <label>配图网址<input value={word.image?.url ?? ''} onChange={(event) => updateVocabulary(index, { image: event.target.value ? { ...(word.image ?? { license: 'unknown' }), url: event.target.value } : undefined })} placeholder="https://..." /></label>
              <label>图片许可<input value={word.image?.license ?? ''} onChange={(event) => updateVocabulary(index, { image: word.image ? { ...word.image, license: event.target.value } : { url: '', license: event.target.value } })} /></label>
            </div>
            <button className="secondary" onClick={() => setEditingContent((old) => old ? { ...old, vocabulary: old.vocabulary.filter((_, i) => i !== index) } : old)}>删除词汇</button>
          </div>)}
          <button className="secondary" onClick={() => setEditingContent({ ...editingContent, vocabulary: [...editingContent.vocabulary, { word: '', phonetic: '', meaningZh: '' }] })}>新增词汇</button>
          <h3>教学活动预览与编辑</h3>
          {editingContent.activities.map((activity, index) => <div className="helper" key={`activity-${index}`}>
            <strong>第 {index + 1} 个活动 · {String(activity.taskType ?? '未命名活动')}</strong>
            <div className="fields">
              <label>教学情境<input value={String(activity.scenario ?? '')} onChange={(event) => setEditingContent({ ...editingContent, activities: editingContent.activities.map((item, i) => i === index ? { ...item, scenario: event.target.value } : item) })} /></label>
              <label>教师提示<input value={String(activity.teacherUtteranceZh ?? '')} onChange={(event) => setEditingContent({ ...editingContent, activities: editingContent.activities.map((item, i) => i === index ? { ...item, teacherUtteranceZh: event.target.value } : item) })} /></label>
              <label>示范文本<input value={String(activity.demonstrationText ?? '')} onChange={(event) => setEditingContent({ ...editingContent, activities: editingContent.activities.map((item, i) => i === index ? { ...item, demonstrationText: event.target.value } : item) })} /></label>
            </div>
          </div>)}
          <label style={{ marginTop: 14 }}>课程图片资源（每行 URL，默认许可可在下方补充）<textarea className="routing-editor" style={{ minHeight: 80 }} value={editingContent.images.map((image) => image.url).join('\n')} onChange={(event) => setEditingContent({ ...editingContent, images: event.target.value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean).map((url) => ({ url, license: 'admin-reviewed' })) })} /></label>
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

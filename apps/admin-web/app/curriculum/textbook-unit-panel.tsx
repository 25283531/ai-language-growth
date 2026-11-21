'use client';

import { useEffect, useState } from 'react';
import { AdminApiError, adminFetch } from '../admin-auth';
import {
  summarizeTextbookCoverage,
  type LexiconCoverage,
  type TextbookCoverageSummary,
} from './textbook-coverage';

type TextbookOption = {
  id: string;
  publisher: string;
  publicationYear: number;
  grade: string;
  title: string | null;
  edition: string | null;
};

type QcIssue = {
  code: string;
  path: string;
  message: string;
  severity?: 'error' | 'warning';
};

type QcReport = {
  checkedAt?: string;
  needsReview?: boolean;
  validation?: {
    ok?: boolean;
    errors?: QcIssue[];
    warnings?: QcIssue[];
    stats?: Record<string, number>;
    checks?: Record<string, string>;
  };
  [key: string]: unknown;
};

type TextbookSentence = {
  id: string;
  en: string;
  zh: string;
  keyWords?: string[];
  grammarIds?: string[];
  schoolModules?: string[];
  [key: string]: unknown;
};

type TextbookVocabulary = {
  word: string;
  phonetic?: string;
  meaningZh?: string;
  syllables?: string[];
  difficultPhonemes?: string[];
  phrases?: string[];
  exampleSentences?: Array<{ en: string; zh?: string }>;
  imageAsset?: { url: string; license: string; attribution?: string };
  [key: string]: unknown;
};

type TextbookActivity = {
  id?: string;
  taskType?: string;
  [key: string]: unknown;
};

type TextbookContent = {
  resourceType: 'textbook_unit';
  textbook?: { publisher: string; grade: string; volume: string; edition?: string };
  unit?: { code: string; title: string; order: number };
  objectives: string[];
  passage: {
    title: string;
    paragraphs: Array<{ sentences: TextbookSentence[] }>;
  };
  grammarPoints?: Array<Record<string, unknown>>;
  vocabulary: TextbookVocabulary[];
  activities: TextbookActivity[];
  schoolTrack?: { modules: string[]; activities: TextbookActivity[] };
  stageHint?: number;
  qcReport?: Record<string, unknown>;
  [key: string]: unknown;
};

type TextbookUnit = {
  id: string;
  textbookId: string;
  unitCode: string;
  title: string;
  order: number;
  passageSource: string | null;
  passage: { title: string; paragraphs: Array<{ sentences: TextbookSentence[] }> };
  sentences: TextbookSentence[];
  objectives: string[];
  grammarFocus: string[];
  words: string[];
  schoolModules: string[];
  autoPublish: boolean;
  content: TextbookContent | null;
  qcReport: QcReport | null;
  publishedUnitId: string | null;
  currentVersion: number | null;
  contentVersion: string | null;
  availability: string | null;
  reviewStatus: string | null;
  humanEditedAt?: string | null;
  humanEditedBy?: string | null;
  textbook: (TextbookOption & { volume?: string }) | null;
};

type SkillNodeOption = {
  id: string;
  name: string;
  track: string;
  growthStage: number;
};

type TextbookMapping = {
  id: string;
  textbookId: string;
  unitCode: string;
  skillNodeIds: string[];
  domains: string[];
  schoolModules: string[];
  stageHint: number | null;
  source: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
};

type TextbookMappingResponse = {
  unitId: string;
  textbookId: string;
  unitCode: string;
  stored: TextbookMapping | null;
  effective: {
    skillNodeIds: string[];
    domains: string[];
    schoolModules: string[];
    stageHint: number | null;
    source: string;
    origin: 'stored' | 'inferred';
    version: number;
  };
  skillNodeOptions: SkillNodeOption[];
};

type MappingForm = {
  skillNodeIds: string;
  domains: string;
  schoolModules: string;
  stageHint: string;
  source: string;
};

type IssueTarget =
  | { kind: 'sentence'; paragraph: number; sentence: number }
  | { kind: 'vocabulary'; index: number }
  | { kind: 'activity'; index: number }
  | { kind: 'schoolActivity'; index: number }
  | { kind: 'grammar'; index: number }
  | { kind: 'other' };

type EntryForm = {
  textbookId: string;
  unitCode: string;
  title: string;
  order: string;
  passage: string;
  words: string;
  grammarFocus: string;
  objectives: string;
  schoolModules: string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function splitComma(value: string): string[] {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function issueTarget(path: string): IssueTarget {
  const sentence = path.match(/^passage\.paragraphs\.(\d+)\.sentences\.(\d+)/);
  if (sentence) return { kind: 'sentence', paragraph: Number(sentence[1]), sentence: Number(sentence[2]) };
  const vocabulary = path.match(/^vocabulary\.(\d+)/);
  if (vocabulary) return { kind: 'vocabulary', index: Number(vocabulary[1]) };
  const activity = path.match(/^activities\.(\d+)/);
  if (activity) return { kind: 'activity', index: Number(activity[1]) };
  const schoolActivity = path.match(/^schoolTrack\.activities\.(\d+)/);
  if (schoolActivity) return { kind: 'schoolActivity', index: Number(schoolActivity[1]) };
  const grammar = path.match(/^grammarPoints\.(\d+)/);
  if (grammar) return { kind: 'grammar', index: Number(grammar[1]) };
  return { kind: 'other' };
}

function sameTarget(left: IssueTarget, right: IssueTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'sentence' && right.kind === 'sentence') {
    return left.paragraph === right.paragraph && left.sentence === right.sentence;
  }
  if (left.kind === 'vocabulary' && right.kind === 'vocabulary') return left.index === right.index;
  if (left.kind === 'activity' && right.kind === 'activity') return left.index === right.index;
  if (left.kind === 'schoolActivity' && right.kind === 'schoolActivity') return left.index === right.index;
  if (left.kind === 'grammar' && right.kind === 'grammar') return left.index === right.index;
  return left.kind === 'other';
}

function issuesFromReport(report: QcReport | null | undefined): { errors: QcIssue[]; warnings: QcIssue[] } {
  const validation = report?.validation;
  const errors = (validation?.errors ?? []).map((issue) => ({ ...issue, severity: 'error' as const }));
  const warnings = (validation?.warnings ?? []).map((issue) => ({ ...issue, severity: 'warning' as const }));
  if (errors.length || warnings.length) return { errors, warnings };
  const all = Array.isArray(report?.issues) ? report.issues as QcIssue[] : [];
  return {
    errors: all.filter((issue) => issue.severity !== 'warning').map((issue) => ({ ...issue, severity: 'error' as const })),
    warnings: all.filter((issue) => issue.severity === 'warning').map((issue) => ({ ...issue, severity: 'warning' as const })),
  };
}

function defaultEditor(unit: TextbookUnit): TextbookContent | null {
  if (!unit.content) return null;
  const content = clone(unit.content);
  if (!content.passage) {
    content.passage = { title: content.unit?.title ?? unit.title, paragraphs: [] };
  }
  return content;
}

function passageTextFromContent(content: TextbookContent): string {
  return (content.passage?.paragraphs ?? [])
    .flatMap((paragraph) => (paragraph.sentences ?? []).map((sentence) => sentence.en))
    .join(' ')
    .trim();
}

function errorBody(error: unknown): { issues?: QcIssue[]; warnings?: QcIssue[]; qcReport?: QcReport } | null {
  return error instanceof AdminApiError && error.body && typeof error.body === 'object'
    ? error.body as { issues?: QcIssue[]; warnings?: QcIssue[]; qcReport?: QcReport }
    : null;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function TextbookUnitPanel({
  textbooks,
  onMessage,
}: {
  textbooks: TextbookOption[];
  onMessage?: (message: string) => void;
}) {
  const [entry, setEntry] = useState<EntryForm>({
    textbookId: '',
    unitCode: '',
    title: '',
    order: '1',
    passage: '',
    words: '',
    grammarFocus: '',
    objectives: '',
    schoolModules: 'A',
  });
  const [units, setUnits] = useState<TextbookUnit[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState('');
  const [unit, setUnit] = useState<TextbookUnit | null>(null);
  const [mappingInfo, setMappingInfo] = useState<TextbookMappingResponse | null>(null);
  const [mappingForm, setMappingForm] = useState<MappingForm>({
    skillNodeIds: '',
    domains: '',
    schoolModules: '',
    stageHint: '',
    source: 'editorial',
  });
  const [mappingError, setMappingError] = useState('');
  const [mappingLoading, setMappingLoading] = useState(false);
  const [editor, setEditor] = useState<TextbookContent | null>(null);
  const [errors, setErrors] = useState<QcIssue[]>([]);
  const [warnings, setWarnings] = useState<QcIssue[]>([]);
  const [qcReport, setQcReport] = useState<QcReport | null>(null);
  const [coverage, setCoverage] = useState<LexiconCoverage | null>(null);
  const [coverageError, setCoverageError] = useState('');
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [textbookCoverage, setTextbookCoverage] = useState<TextbookCoverageSummary | null>(null);
  const [textbookCoverageError, setTextbookCoverageError] = useState('');
  const [textbookCoverageLoading, setTextbookCoverageLoading] = useState(false);
  const [textbookCoverageReload, setTextbookCoverageReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pick, setPick] = useState({ publisher: '', year: '', grade: '', edition: '' });
  const pickBook = textbooks.find((book) =>
    book.publisher === pick.publisher &&
    String(book.publicationYear) === pick.year &&
    book.grade === pick.grade &&
    (book.edition || '') === pick.edition);

  useEffect(() => {
    if (pickBook && entry.textbookId !== pickBook.id) {
      setEntry((old) => ({ ...old, textbookId: pickBook.id }));
    }
  }, [pickBook, entry.textbookId]);

  function notify(text: string) {
    setMessage(text);
    onMessage?.(text);
  }

  function applyError(error: unknown, fallback: string) {
    const body = errorBody(error);
    const reportIssues = issuesFromReport(body?.qcReport);
    setErrors(body?.issues?.length
      ? body.issues.map((issue) => ({ ...issue, severity: 'error' as const }))
      : reportIssues.errors);
    setWarnings(body?.warnings?.length
      ? body.warnings.map((issue) => ({ ...issue, severity: 'warning' as const }))
      : reportIssues.warnings);
    if (body?.qcReport) setQcReport(body.qcReport);
    notify(error instanceof Error ? error.message : fallback);
    window.setTimeout(() => {
      document.querySelector<HTMLElement>('.unit-sentence.has-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  }

  function applyReport(report: QcReport | null) {
    setQcReport(report);
    const next = issuesFromReport(report);
    setErrors(next.errors);
    setWarnings(next.warnings);
  }

  async function loadUnit(unitId: string, preserveIssues = false) {
    const detail = await adminFetch<TextbookUnit>(`/curriculum/textbook/units/${unitId}`);
    setUnit(detail);
    setEditor(defaultEditor(detail));
    if (!preserveIssues) applyReport(detail.qcReport);
  }

  function applyMapping(response: TextbookMappingResponse) {
    setMappingInfo(response);
    const current = response.stored ?? response.effective;
    setMappingForm({
      skillNodeIds: current.skillNodeIds.join(', '),
      domains: current.domains.join(', '),
      schoolModules: current.schoolModules.join(', '),
      stageHint: current.stageHint === null ? '' : String(current.stageHint),
      source: response.stored?.source ?? response.effective.source,
    });
  }

  async function loadMapping(unitId: string) {
    if (!unitId) {
      setMappingInfo(null);
      setMappingError('');
      return;
    }
    setMappingLoading(true);
    setMappingError('');
    try {
      applyMapping(await adminFetch<TextbookMappingResponse>(`/curriculum/textbook/units/${unitId}/mapping`));
    } catch (error) {
      setMappingInfo(null);
      setMappingError(error instanceof Error ? error.message : '读取教材映射失败');
    } finally {
      setMappingLoading(false);
    }
  }

  async function saveMapping() {
    if (!unit) return;
    setBusy(true);
    setMappingError('');
    try {
      const response = await adminFetch<TextbookMappingResponse>(`/curriculum/textbook/units/${unit.id}/mapping`, {
        method: 'PUT',
        body: JSON.stringify({
          skillNodeIds: splitComma(mappingForm.skillNodeIds),
          domains: splitComma(mappingForm.domains),
          schoolModules: splitComma(mappingForm.schoolModules).map((module) => module.toUpperCase()),
          stageHint: mappingForm.stageHint.trim() ? Number(mappingForm.stageHint) : null,
          source: mappingForm.source,
        }),
      });
      applyMapping(response);
      notify(`教材映射已保存：v${response.stored?.version ?? '—'}；重新生成资源包后生效。`);
    } catch (error) {
      setMappingError(error instanceof Error ? error.message : '保存教材映射失败');
    } finally {
      setBusy(false);
    }
  }

  async function clearMapping() {
    if (!unit) return;
    setBusy(true);
    setMappingError('');
    try {
      const response = await adminFetch<TextbookMappingResponse>(`/curriculum/textbook/units/${unit.id}/mapping`, {
        method: 'DELETE',
      });
      applyMapping(response);
      notify('已删除显式映射，后续生成按单元信息自动推断。');
    } catch (error) {
      setMappingError(error instanceof Error ? error.message : '删除教材映射失败');
    } finally {
      setBusy(false);
    }
  }

  async function loadCoverage(unitId: string) {
    if (!unitId) {
      setCoverage(null);
      setCoverageError('');
      return;
    }
    setCoverageLoading(true);
    setCoverageError('');
    try {
      setCoverage(await adminFetch<LexiconCoverage>(`/curriculum/textbook/units/${unitId}/lexicon-coverage`));
    } catch (error) {
      setCoverage(null);
      setCoverageError(error instanceof Error ? error.message : '读取词库覆盖率失败');
    } finally {
      setCoverageLoading(false);
    }
  }

  async function refreshUnits(bookId: string) {
    const list = await adminFetch<TextbookUnit[]>(`/curriculum/textbook/units?textbookId=${encodeURIComponent(bookId)}&limit=200`);
    setUnits(list);
    setSelectedUnitId((current) => list.some((item) => item.id === current) ? current : (list[0]?.id ?? ''));
  }

  useEffect(() => {
    if (!entry.textbookId && textbooks[0]) {
      setEntry((old) => ({ ...old, textbookId: textbooks[0]!.id }));
    }
  }, [entry.textbookId, textbooks]);

  useEffect(() => {
    if (!entry.textbookId) {
      setUnits([]);
      setSelectedUnitId('');
      return;
    }
    let cancelled = false;
    void adminFetch<TextbookUnit[]>(`/curriculum/textbook/units?textbookId=${encodeURIComponent(entry.textbookId)}&limit=200`)
      .then((list) => {
        if (cancelled) return;
        setUnits(list);
        setSelectedUnitId((current) => list.some((item) => item.id === current) ? current : (list[0]?.id ?? ''));
      })
      .catch((error) => {
        if (!cancelled) notify(error instanceof Error ? error.message : '读取教材单元失败');
      });
    return () => { cancelled = true; };
  }, [entry.textbookId]);

  useEffect(() => {
    if (!entry.textbookId) {
      setTextbookCoverage(null);
      setTextbookCoverageError('');
      setTextbookCoverageLoading(false);
      return;
    }
    const bookUnits = units.filter((item) => item.textbookId === entry.textbookId);
    if (!bookUnits.length) {
      setTextbookCoverage(null);
      setTextbookCoverageError('');
      setTextbookCoverageLoading(false);
      return;
    }
    let cancelled = false;
    setTextbookCoverage(null);
    setTextbookCoverageLoading(true);
    setTextbookCoverageError('');
    void Promise.all(bookUnits.map(async (item) => ({
      unit: item,
      coverage: await adminFetch<LexiconCoverage>(`/curriculum/textbook/units/${item.id}/lexicon-coverage`),
    })))
      .then((entries) => {
        if (!cancelled) setTextbookCoverage(summarizeTextbookCoverage(entries, entry.textbookId));
      })
      .catch((error) => {
        if (cancelled) return;
        setTextbookCoverage(null);
        setTextbookCoverageError(error instanceof Error ? error.message : '读取整册词库覆盖失败');
      })
      .finally(() => {
        if (!cancelled) setTextbookCoverageLoading(false);
      });
    return () => { cancelled = true; };
  }, [entry.textbookId, units, textbookCoverageReload]);

  useEffect(() => {
    if (!selectedUnitId) {
      setUnit(null);
      setEditor(null);
      setErrors([]);
      setWarnings([]);
      setQcReport(null);
      setCoverage(null);
      setCoverageError('');
      setMappingInfo(null);
      setMappingError('');
      return;
    }
    let cancelled = false;
    setMessage('');
    void adminFetch<TextbookUnit>(`/curriculum/textbook/units/${selectedUnitId}`)
      .then((detail) => {
        if (cancelled) return;
        setUnit(detail);
        setEditor(defaultEditor(detail));
        applyReport(detail.qcReport);
      })
      .catch((error) => {
        if (!cancelled) notify(error instanceof Error ? error.message : '读取单元详情失败');
      });
    return () => { cancelled = true; };
  }, [selectedUnitId]);

  useEffect(() => {
    if (!selectedUnitId) return;
    void loadMapping(selectedUnitId);
  }, [selectedUnitId]);

  useEffect(() => {
    if (!selectedUnitId) return;
    let cancelled = false;
    setCoverage(null);
    setCoverageLoading(true);
    setCoverageError('');
    void adminFetch<LexiconCoverage>(`/curriculum/textbook/units/${selectedUnitId}/lexicon-coverage`)
      .then((result) => {
        if (!cancelled) setCoverage(result);
      })
      .catch((error) => {
        if (cancelled) return;
        setCoverage(null);
        setCoverageError(error instanceof Error ? error.message : '读取词库覆盖率失败');
      })
      .finally(() => {
        if (!cancelled) setCoverageLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedUnitId]);

  useEffect(() => {
    if (!unit) return;
    setEntry((old) => ({
      ...old,
      textbookId: unit.textbookId,
      unitCode: unit.unitCode,
      title: unit.title,
      order: String(unit.order),
      passage: unit.passageSource ?? '',
      words: unit.words.join('\n'),
      grammarFocus: unit.grammarFocus.join('\n'),
      objectives: unit.objectives.join('\n'),
      schoolModules: unit.schoolModules.join(','),
    }));
  }, [unit?.id]);

  async function saveEntry() {
    if (!entry.textbookId) return notify('请先选择教材版本');
    if (!entry.unitCode.trim() || !entry.title.trim() || !entry.passage.trim()) {
      return notify('请填写单元编码、标题和课文原文');
    }
    setBusy(true);
    try {
      const saved = await adminFetch<TextbookUnit>('/curriculum/textbook/units', {
        method: 'POST',
        body: JSON.stringify({
          textbookId: entry.textbookId,
          unit: {
            code: entry.unitCode.trim(),
            title: entry.title.trim(),
            order: Number(entry.order) || 1,
          },
          passage: entry.passage.trim(),
          words: splitLines(entry.words),
          grammarFocus: splitLines(entry.grammarFocus),
          objectives: splitLines(entry.objectives),
          schoolModules: splitComma(entry.schoolModules),
          autoPublish: true,
        }),
      });
      await refreshUnits(entry.textbookId);
      setSelectedUnitId(saved.id);
      await loadUnit(saved.id);
      void loadCoverage(saved.id);
      notify('教材单元已保存；可以生成资源包，或直接逐句编辑已有内容。');
    } catch (error) {
      applyError(error, '保存教材单元失败');
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!unit) return;
    setBusy(true);
    try {
      const result = await adminFetch<{
        activation?: { activated?: boolean; version?: number; validation?: QcReport['validation'] };
        needsReview?: boolean;
        qcReport?: QcReport;
      }>(`/curriculum/textbook/units/${unit.id}/generate`, { method: 'POST' });
      applyReport(result.qcReport ?? null);
      await refreshUnits(unit.textbookId);
      await loadUnit(unit.id);
      void loadCoverage(unit.id);
      if (result.activation?.activated) {
        notify(`资源包已生成并直接启用：版本 ${result.activation.version ?? '—'}。`);
      } else {
        notify('资源包已生成，但自动校验未通过；请按下方质检定位修正。');
      }
    } catch (error) {
      applyError(error, '生成资源包失败');
      await loadUnit(unit.id, true).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function saveEditor() {
    if (!editor || !unit) return;
    setBusy(true);
    try {
      if (unit.publishedUnitId && unit.currentVersion !== null) {
        const result = await adminFetch<{ version?: number; needsReview?: boolean; validation?: QcReport['validation'] }>(
          `/curriculum/units/${unit.publishedUnitId}/content`,
          {
            method: 'PUT',
            body: JSON.stringify({ ...editor, expectedVersion: unit.currentVersion }),
          },
        );
        await refreshUnits(unit.textbookId);
        await loadUnit(unit.id);
        void loadCoverage(unit.id);
        notify(`已保存并生效：版本 ${result.version ?? '—'}，下一节课读取新内容。`);
        return;
      }

      await adminFetch<TextbookUnit>('/curriculum/textbook/units', {
        method: 'POST',
        body: JSON.stringify({
          textbookId: unit.textbookId,
          unit: {
            code: editor.unit?.code ?? unit.unitCode,
            title: editor.unit?.title ?? unit.title,
            order: editor.unit?.order ?? unit.order,
          },
          passage: unit.passageSource || passageTextFromContent(editor),
          words: (editor.vocabulary ?? []).map((item) => item.word),
          objectives: editor.objectives ?? [],
          grammarFocus: unit.grammarFocus,
          schoolModules: unit.schoolModules,
          content: editor,
        }),
      });
      await refreshUnits(unit.textbookId);
      await loadUnit(unit.id);
      void loadCoverage(unit.id);
      notify('资源包已保存到教材单元；尚未启用，请重新生成或修正后启用。');
    } catch (error) {
      applyError(error, '保存资源包失败');
    } finally {
      setBusy(false);
    }
  }

  function updateSentence(paragraphIndex: number, sentenceIndex: number, patch: Partial<TextbookSentence>) {
    setEditor((old) => {
      if (!old) return old;
      const paragraphs = old.passage.paragraphs.map((paragraph, pIndex) => pIndex !== paragraphIndex
        ? paragraph
        : {
          ...paragraph,
          sentences: paragraph.sentences.map((sentence, sIndex) => sIndex === sentenceIndex
            ? { ...sentence, ...patch }
            : sentence),
        });
      return { ...old, passage: { ...old.passage, paragraphs } };
    });
  }

  function updateVocabulary(index: number, patch: Partial<TextbookVocabulary>) {
    setEditor((old) => old ? {
      ...old,
      vocabulary: old.vocabulary.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    } : old);
  }

  function issuesAt(target: IssueTarget): QcIssue[] {
    return [...errors, ...warnings].filter((issue) => sameTarget(issueTarget(issue.path), target));
  }

  const qcStats = qcReport?.validation?.stats;
  const selectedTextbook = textbooks.find((book) => book.id === entry.textbookId) ?? null;
  const selectedTextbookLabel = selectedTextbook
    ? `${selectedTextbook.publisher} · ${selectedTextbook.grade} · ${selectedTextbook.title || '教材'} ${selectedTextbook.edition || ''}`.trim()
    : '';
  const rowIssues = (target: IssueTarget) => issuesAt(target).map((issue) => (
    <p className={`qc-issue${issue.severity === 'warning' ? ' warning' : ''}`} key={`${issue.code}-${issue.path}-${issue.message}`}>
      <strong>{issue.severity === 'warning' ? '警告' : '阻断'}</strong>
      <span>{issue.message}</span>
      <code>{issue.path}</code>
    </p>
  ));

  return <section className="panel" style={{ marginTop: 24 }}>
    <div className="panel-head">
      <div>
        <p className="eyebrow">TEXTBOOK UNIT STUDIO</p>
        <h2>教材单元录入与逐句编辑</h2>
        <p className="muted">粘贴课文后先生成资源包；校验通过直接启用。错误会按 JSON path 定位到具体句子、词条或活动行。</p>
      </div>
      <button className="secondary" disabled={busy || !entry.textbookId} onClick={() => void refreshUnits(entry.textbookId)}>刷新单元</button>
    </div>

    <div className="fields">
      <label>出版社<select value={pick.publisher} onChange={(event) => setPick({ publisher: event.target.value, year: '', grade: '', edition: '' })}><option value="">请选择</option>{Array.from(new Set(textbooks.map((book) => book.publisher))).map((publisher) => <option key={publisher} value={publisher}>{publisher}</option>)}</select></label>
      <label>出版年份<select value={pick.year} disabled={!pick.publisher} onChange={(event) => setPick({ ...pick, year: event.target.value, grade: '', edition: '' })}><option value="">请选择</option>{Array.from(new Set(textbooks.filter((book) => book.publisher === pick.publisher).map((book) => book.publicationYear))).map((year) => <option key={year} value={String(year)}>{year}</option>)}</select></label>
      <label>年级<select value={pick.grade} disabled={!pick.year} onChange={(event) => setPick({ ...pick, grade: event.target.value, edition: '' })}><option value="">请选择</option>{Array.from(new Set(textbooks.filter((book) => book.publisher === pick.publisher && String(book.publicationYear) === pick.year).map((book) => book.grade))).map((grade) => <option key={grade} value={grade}>{grade}</option>)}</select></label>
      <label>版本<select value={pick.edition} disabled={!pick.grade} onChange={(event) => setPick({ ...pick, edition: event.target.value })}><option value="">请选择</option>{Array.from(new Set(textbooks.filter((book) => book.publisher === pick.publisher && String(book.publicationYear) === pick.year && book.grade === pick.grade).map((book) => book.edition || ''))).map((edition) => <option key={edition} value={edition}>{edition || '未标注版本'}</option>)}</select></label>
      {pick.grade && !pickBook && <span className="status warn">该组合还没有教材版本，请先在上方“教材版本”中创建。</span>}
      <label>已有单元<select value={selectedUnitId} onChange={(event) => setSelectedUnitId(event.target.value)}>
        <option value="">选择单元</option>
        {units.map((item) => <option key={item.id} value={item.id}>{item.unitCode} · {item.title} · {item.availability || '未启用'} · v{item.currentVersion ?? '—'}</option>)}
      </select></label>
    </div>

    {unit && <p className="muted">教材映射由系统自动推断（学校轨 {mappingInfo?.effective.schoolModules.join('/') || '无'}），无需人工维护。</p>}

    {entry.textbookId && <div className="coverage-card textbook-coverage-card">
      <div className="coverage-head">
        <div>
          <p className="eyebrow">TEXTBOOK COVERAGE</p>
          <h3>{selectedTextbookLabel || '整册词库覆盖'}</h3>
        </div>
        <button className="secondary" disabled={textbookCoverageLoading} onClick={() => setTextbookCoverageReload((value) => value + 1)}>
          {textbookCoverageLoading ? '汇总中…' : '重新统计'}
        </button>
      </div>
      {textbookCoverageError && <p className="status error" role="status">{textbookCoverageError}</p>}
      {textbookCoverageLoading && <p className="muted">正在逐单元汇总整册词库覆盖…</p>}
      {!textbookCoverageLoading && !textbookCoverageError && textbookCoverage && textbookCoverage.unitCount === 0 && <p className="muted">该教材版本还没有可统计的单元。</p>}
      {!textbookCoverageLoading && !textbookCoverageError && textbookCoverage && textbookCoverage.unitCount > 0 && <>
        <div className="coverage-stats">
          <div className="coverage-stat">
            <span>单元数</span>
            <strong>{textbookCoverage.unitCount}</strong>
            <small>参与汇总</small>
          </div>
          <div className="coverage-stat">
            <span>去重词数</span>
            <strong>{textbookCoverage.totalWords}</strong>
            <small>跨单元按词去重</small>
          </div>
          <div className="coverage-stat">
            <span>命中率</span>
            <strong>{percent(textbookCoverage.hitRate)}</strong>
            <small>{textbookCoverage.coveredWords}/{textbookCoverage.totalWords} 个词条</small>
          </div>
          <div className={`coverage-stat${textbookCoverage.gaps.length ? ' warn' : ''}`}>
            <span>缺口词</span>
            <strong>{textbookCoverage.gaps.length}</strong>
            <small>涉及 {textbookCoverage.gapUnitCount} 个单元</small>
          </div>
        </div>
        <div className="coverage-list" style={{ marginTop: 13 }}>
          <strong>整册缺口词清单 {textbookCoverage.gaps.length}</strong>
          {textbookCoverage.gaps.length
            ? <div className="coverage-gap-list">
              {textbookCoverage.gaps.map((item) => <span
                className="coverage-word gap"
                key={item.word}
                title={`出现于 ${item.unitCodes.join('、')}`}
              >{item.word}</span>)}
            </div>
            : <p className="muted">无缺口</p>}
        </div>
        <p className="muted coverage-note">
          口径：逐单元复用现有 lexicon-coverage 接口，按词去重；同一词在任一单元命中即算覆盖，所有单元都未命中才进入缺口清单。只读汇总，不写入词库。
        </p>
      </>}
      {!textbookCoverageLoading && !textbookCoverageError && !textbookCoverage && <p className="muted">选择包含单元的教材版本后汇总。</p>}
    </div>}

    <div className="fields">
      <label>单元序号<input value={entry.unitCode} onChange={(event) => setEntry({ ...entry, unitCode: event.target.value })} placeholder="3" /></label>
      <label>单元标题<input value={entry.title} onChange={(event) => setEntry({ ...entry, title: event.target.value })} placeholder="My Family" /></label>
      <label>顺序<input type="number" min={0} value={entry.order} onChange={(event) => setEntry({ ...entry, order: event.target.value })} /></label>
      <label>学校模块（逗号分隔）<input value={entry.schoolModules} onChange={(event) => setEntry({ ...entry, schoolModules: event.target.value })} placeholder="A,B" /></label>
    </div>
    <label>课文原文<textarea className="routing-editor" style={{ minHeight: 110 }} value={entry.passage} onChange={(event) => setEntry({ ...entry, passage: event.target.value })} placeholder="This is my family. This is my mother." /></label>
    <div className="fields">
      <label>课本单词表（每行一个）<textarea className="routing-editor" style={{ minHeight: 90 }} value={entry.words} onChange={(event) => setEntry({ ...entry, words: event.target.value })} placeholder={'family\nmother'} /></label>
      <label>语法重点（每行一条）<textarea className="routing-editor" style={{ minHeight: 90 }} value={entry.grammarFocus} onChange={(event) => setEntry({ ...entry, grammarFocus: event.target.value })} placeholder="This is my ..." /></label>
    </div>
    <label>教学目标（每行一条）<textarea className="routing-editor" style={{ minHeight: 70 }} value={entry.objectives} onChange={(event) => setEntry({ ...entry, objectives: event.target.value })} placeholder="能听懂并朗读课文" /></label>
    <div className="row-actions">
      <button disabled={busy || !entry.textbookId} onClick={() => void saveEntry()}>保存教材单元</button>
      <button className="secondary" disabled={busy || !unit} onClick={() => void generate()}>生成资源包并自动校验</button>
    </div>

    {!unit && <p className="muted" style={{ marginTop: 14 }}>选择或保存一个教材单元后，可生成资源包并逐句编辑。</p>}

    {unit && <div style={{ marginTop: 20 }}>
      <div className="panel-head">
        <div>
          <p className="eyebrow">RESOURCE PACKAGE</p>
          <h3>{unit.unitCode} · {unit.title}</h3>
          <p className="muted">
            {unit.availability ? `availability=${unit.availability}` : '尚未启用'}
            {unit.currentVersion !== null ? ` · currentVersion=${unit.currentVersion}` : ''}
            {unit.contentVersion ? ` · contentVersion=${unit.contentVersion.slice(0, 8)}` : ''}
            {unit.reviewStatus ? ` · reviewStatus=${unit.reviewStatus}` : ''}
            {unit.humanEditedAt ? ` · 人工已编辑（${unit.humanEditedBy ?? 'admin'} ${unit.humanEditedAt.slice(0, 10)}）` : ''}
            {qcReport?.needsReview ? ' · needsReview' : ''}
          </p>
        </div>
        <span className={`status ${errors.length ? 'error' : warnings.length ? 'warn' : qcReport ? 'success' : ''}`}>
          {errors.length ? `${errors.length} 个阻断项` : warnings.length ? `${warnings.length} 个警告` : qcReport ? '自动校验通过' : '尚未质检'}
        </span>
      </div>

      <div className="coverage-card">
        <div className="coverage-head">
          <div>
            <p className="eyebrow">LEXICON COVERAGE</p>
            <h3>词库覆盖率</h3>
          </div>
          <button className="secondary" disabled={coverageLoading || !unit.id} onClick={() => void loadCoverage(unit.id)}>
            {coverageLoading ? '统计中…' : '重新统计'}
          </button>
        </div>
        {coverageError && <p className="status error" role="status">{coverageError}</p>}
        {coverageLoading && !coverage && !coverageError && <p className="muted">正在统计词库覆盖…</p>}
        {!coverageError && coverage && <>
          <div className="coverage-stats">
            <div className="coverage-stat">
              <span>词表词数</span>
              <strong>{coverage.counts.total}</strong>
              <small>去重后的教材词条</small>
            </div>
            <div className="coverage-stat">
              <span>命中率</span>
              <strong>{percent(coverage.hitRate)}</strong>
              <small>{coverage.counts.covered}/{coverage.counts.total} 个词表词条</small>
            </div>
            <div className="coverage-stat">
              <span>新词</span>
              <strong>{coverage.counts.newWords}</strong>
              <small>更早单元未出现</small>
            </div>
            <div className="coverage-stat">
              <span>复用</span>
              <strong>{coverage.counts.reusedWords}</strong>
              <small>更早单元已出现</small>
            </div>
            <div className={`coverage-stat${coverage.counts.gaps ? ' warn' : ''}`}>
              <span>缺口</span>
              <strong>{coverage.counts.gaps}</strong>
              <small>未被 lexicon_entries 收录</small>
            </div>
            <div className="coverage-stat">
              <span>核心词</span>
              <strong>{percent(coverage.coreRate)}</strong>
              <small>{coverage.coreWords}/{coverage.counts.total} 个词条</small>
            </div>
          </div>
          <div className="coverage-lists">
            <div className="coverage-list">
              <strong>新词 {coverage.counts.newWords}</strong>
              <p>{coverage.newWords.length
                ? coverage.newWords.map((item) => <span className="coverage-word" key={item.word}>{item.word}</span>)
                : <span className="muted">无</span>}</p>
            </div>
            <div className="coverage-list">
              <strong>复用 {coverage.counts.reusedWords}</strong>
              <p>{coverage.reusedWords.length
                ? coverage.reusedWords.map((item) => <span
                  className="coverage-word reused"
                  key={item.word}
                  title={item.priorUnitCodes.length ? `复用自 ${item.priorUnitCodes.join('、')}` : undefined}
                >{item.word}</span>)
                : <span className="muted">无</span>}</p>
            </div>
            <div className="coverage-list">
              <strong>缺口 {coverage.counts.gaps}</strong>
              <p>{coverage.gaps.length
                ? coverage.gaps.map((word) => <span className="coverage-word gap" key={word}>{word}</span>)
                : <span className="muted">无</span>}</p>
            </div>
          </div>
          <p className="muted coverage-note">
            口径：word/variants 命中 lexicon_entries 才算覆盖；复用按同教材更早 {coverage.method.priorUnitCount} 个单元判断；教材 metadata 自带释义不算词库命中。
            命中词条中音标 {coverage.fieldCoverage.phonetic}/{coverage.counts.covered}（{percent(coverage.fieldCoverage.phoneticRate)}），中文释义 {coverage.fieldCoverage.meaningZh}/{coverage.counts.covered}（{percent(coverage.fieldCoverage.meaningZhRate)}）。
          </p>
        </>}
      </div>

      {(qcReport || errors.length > 0 || warnings.length > 0) && <div className="helper">
        <strong>自动质检</strong>
        {qcReport?.checkedAt && <span className="muted"> · {new Date(qcReport.checkedAt).toLocaleString()}</span>}
        {qcStats && <div className="muted" style={{ marginTop: 6 }}>
          句子 {qcStats.sentences ?? '—'} · 已翻译 {qcStats.translatedSentences ?? '—'} · 词条 {qcStats.vocabulary ?? '—'} · 音标 {qcStats.phonetic ?? '—'} · 释义 {qcStats.meaning ?? '—'} · 活动 {qcStats.activities ?? '—'} · 语法 {qcStats.grammarPoints ?? '—'}
        </div>}
        {[...errors, ...warnings].map((issue) => <p className={`qc-issue${issue.severity === 'warning' ? ' warning' : ''}`} key={`${issue.code}-${issue.path}-${issue.message}`}>
          <strong>{issue.severity === 'warning' ? '警告' : '阻断'}</strong>
          <span>{issue.message}</span>
          <code>{issue.path}</code>
        </p>)}
      </div>}

      {!editor && <p className="helper">当前单元还没有资源包。点击“生成资源包并自动校验”，或先保存已有内容。</p>}

      {editor && <div>
        <div className="row-actions" style={{ marginBottom: 10 }}>
          <button disabled={busy} onClick={() => void saveEditor()}>
            {unit.publishedUnitId ? `保存并生效（expectedVersion=${unit.currentVersion ?? '—'}）` : '保存资源包到教材单元'}
          </button>
          <button className="secondary" disabled={busy || !selectedUnitId} onClick={() => void loadUnit(selectedUnitId)}>重新加载详情</button>
          <span className="status">保存时会校验版本；若已被其他管理员修改，会提示刷新。</span>
        </div>

        {(editor.passage?.paragraphs ?? []).map((paragraph, paragraphIndex) => <div key={`paragraph-${paragraphIndex}`} style={{ marginTop: 12 }}>
          <p className="eyebrow">PARAGRAPH {paragraphIndex + 1}</p>
          {(paragraph.sentences ?? []).map((sentence, sentenceIndex) => {
            const target = { kind: 'sentence' as const, paragraph: paragraphIndex, sentence: sentenceIndex };
            const row = issuesAt(target);
            return <div className={`unit-sentence${row.some((issue) => issue.severity !== 'warning') ? ' has-error' : ''}`} key={sentence.id || `${paragraphIndex}-${sentenceIndex}`}>
              <div className="fields">
                <label>句子 ID<input value={sentence.id} readOnly /></label>
                <label>关键词（逗号分隔）<input value={(sentence.keyWords ?? []).join(', ')} onChange={(event) => updateSentence(paragraphIndex, sentenceIndex, { keyWords: splitComma(event.target.value) })} /></label>
              </div>
              <label>英文<textarea className="routing-editor" style={{ minHeight: 58 }} value={sentence.en} onChange={(event) => updateSentence(paragraphIndex, sentenceIndex, { en: event.target.value })} /></label>
              <label>中文<textarea className="routing-editor" style={{ minHeight: 58 }} value={sentence.zh} onChange={(event) => updateSentence(paragraphIndex, sentenceIndex, { zh: event.target.value })} /></label>
              {rowIssues(target)}
            </div>;
          })}
        </div>)}

        <h3 style={{ marginTop: 20 }}>重点词与音标</h3>
        {(editor.vocabulary ?? []).map((word, index) => {
          const target = { kind: 'vocabulary' as const, index };
          const row = issuesAt(target);
          return <div className={`unit-sentence${row.some((issue) => issue.severity !== 'warning') ? ' has-error' : ''}`} key={`${word.word}-${index}`}>
            <div className="fields">
              <label>单词<input value={word.word} onChange={(event) => updateVocabulary(index, { word: event.target.value })} /></label>
              <label>音标<input value={word.phonetic ?? ''} onChange={(event) => updateVocabulary(index, { phonetic: event.target.value })} placeholder="/.../" /></label>
              <label>中文释义<input value={word.meaningZh ?? ''} onChange={(event) => updateVocabulary(index, { meaningZh: event.target.value })} /></label>
              <label>音节（逗号分隔）<input value={(word.syllables ?? []).join(', ')} onChange={(event) => updateVocabulary(index, { syllables: splitComma(event.target.value) })} /></label>
            </div>
            {rowIssues(target)}
          </div>;
        })}

        <h3 style={{ marginTop: 20 }}>活动质检</h3>
        {(editor.activities ?? []).map((activity, index) => {
          const target = { kind: 'activity' as const, index };
          return <div className="helper" key={`activity-${index}`}>
            <strong>第 {index + 1} 个活动</strong> · {String(activity.taskType ?? '未命名')} · {String(activity.id ?? '')}
            {rowIssues(target)}
          </div>;
        })}
      </div>}
    </div>}

    {message && <p className="status" role="status" style={{ marginTop: 14 }}>{message}</p>}
  </section>;
}

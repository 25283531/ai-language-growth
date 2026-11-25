/**
 * 教师用教案导出（P4-05）。
 *
 * 从已启用的教材单元资源包生成一份确定性的 Markdown / JSON 教案，供管理员
 * 下载、打印或交给教研复核。这里不调用模型、不读取学习者数据，也不改变
 * 任何课程状态：同一份 content 在任意时刻导出的正文完全一致，只有导出时间
 * 与版本字段来自数据库。
 *
 * 教案必须包含任务书 §7.1 要求的目标、课时、重点句与易错点；额外附上活动
 * 流程、学校英语轨与课后练习建议，方便老师直接照此上课。
 */
import type {
  CefrLesson,
  TextbookUnitContent,
} from '@alg/shared-contracts';

export const LESSON_PLAN_SESSION_MINUTES = 15;

export type LessonPlanSource = {
  unitId: string;
  content: TextbookUnitContent;
  currentVersion?: number | null;
  contentVersion?: string | null;
  availability?: string | null;
  generatedAt?: Date;
};

export type LessonPlanSentence = {
  id: string;
  en: string;
  zh: string;
  keyWords: string[];
};

export type LessonPlanWord = {
  word: string;
  phonetic: string;
  meaningZh: string;
  syllables: string[];
  difficultPhonemes: string[];
  examples: Array<{ en: string; zh: string }>;
};

export type LessonPlanGrammar = {
  id: string;
  titleZh: string;
  pattern: string;
  explanationZh: string;
  commonErrorZh: string;
  examples: Array<{ en: string; zh: string }>;
};

export type LessonPlanActivity = {
  id: string;
  track: 'language' | 'school';
  schoolModule: string | null;
  title: string;
  taskType: string;
  evidenceKind: string;
  targetWords: string[];
  teacherUtteranceZh: string;
  demonstrationText: string;
};

export type LessonPlanCommonError = {
  kind: 'grammar' | 'pronunciation';
  target: string;
  detail: string;
};

export type LessonPlan = {
  unitId: string;
  textbook: TextbookUnitContent['textbook'];
  unit: TextbookUnitContent['unit'];
  generatedAt: string;
  sessionMinutes: number;
  suggestedSessions: number;
  currentVersion: number | null;
  contentVersion: string | null;
  availability: string | null;
  objectives: string[];
  keySentences: LessonPlanSentence[];
  focusWords: LessonPlanWord[];
  grammarPoints: LessonPlanGrammar[];
  activities: LessonPlanActivity[];
  commonErrors: LessonPlanCommonError[];
  homePractice: string[];
  qc: {
    ok: boolean | null;
    errors: number;
    warnings: number;
    needsReview: boolean;
  };
};

export type LessonPlanExport = {
  unitId: string;
  filename: string;
  plan: LessonPlan;
  markdown: string;
};

/**
 * 估算课时。
 *
 * 任务书按每天约 15 分钟设计，这里沿用 15 分钟/课时；每课时最多覆盖 8 句
 * 课文或 6 个活动，取二者较大值并封顶 6 课时。它是排课参考，不是学习门槛。
 */
export function estimateSessions(content: TextbookUnitContent): number {
  const sentenceCount = content.passage.paragraphs
    .reduce((total, paragraph) => total + paragraph.sentences.length, 0);
  const activityCount = content.activities.length + (content.schoolTrack?.activities.length ?? 0);
  const blocks = Math.max(
    Math.ceil(sentenceCount / 8),
    Math.ceil(activityCount / 6),
    1,
  );
  return Math.min(6, blocks);
}

export function buildLessonPlan(source: LessonPlanSource): LessonPlan {
  const { content } = source;
  const generatedAt = (source.generatedAt ?? new Date()).toISOString();
  const keySentences = content.passage.paragraphs.flatMap((paragraph) => paragraph.sentences)
    .map((sentence) => ({
      id: sentence.id,
      en: sentence.en,
      zh: sentence.zh,
      keyWords: sentence.keyWords ?? [],
    }));

  const focusWords = content.vocabulary.map((entry) => ({
    word: entry.word,
    phonetic: entry.phonetic ?? '',
    meaningZh: entry.meaningZh ?? '',
    syllables: entry.syllables ?? [],
    difficultPhonemes: entry.difficultPhonemes ?? [],
    examples: (entry.exampleSentences ?? []).map((example) => ({
      en: example.en,
      zh: example.zh ?? '',
    })),
  }));

  const grammarPoints = content.grammarPoints.map((point) => ({
    id: point.id,
    titleZh: point.titleZh,
    pattern: point.pattern,
    explanationZh: point.explanationZh,
    commonErrorZh: point.commonErrorZh ?? '',
    examples: point.examples.map((example) => ({ en: example.en, zh: example.zh ?? '' })),
  }));

  const commonErrors: LessonPlanCommonError[] = [
    ...grammarPoints
      .filter((point) => point.commonErrorZh.trim())
      .map((point) => ({
        kind: 'grammar' as const,
        target: point.pattern,
        detail: point.commonErrorZh,
      })),
    ...focusWords.flatMap((word) => word.difficultPhonemes.map((phoneme) => ({
      kind: 'pronunciation' as const,
      target: `${word.word} ${phoneme}`.trim(),
      detail: `发音时重点练 ${phoneme}，先拆到音节再合成整词。`,
    }))),
  ];

  const activities = [
    ...content.activities.map((activity) => toPlanActivity(activity, 'language')),
    ...(content.schoolTrack?.activities ?? []).map((activity) => toPlanActivity(activity, 'school')),
  ];

  const qc = readQc(content.qcReport);
  const homePractice = buildHomePractice(content, keySentences, focusWords, grammarPoints);

  return {
    unitId: source.unitId,
    textbook: content.textbook,
    unit: content.unit,
    generatedAt,
    sessionMinutes: LESSON_PLAN_SESSION_MINUTES,
    suggestedSessions: estimateSessions(content),
    currentVersion: source.currentVersion ?? null,
    contentVersion: source.contentVersion ?? null,
    availability: source.availability ?? null,
    objectives: content.objectives,
    keySentences,
    focusWords,
    grammarPoints,
    activities,
    commonErrors,
    homePractice,
    qc,
  };
}

export function buildLessonPlanExport(source: LessonPlanSource): LessonPlanExport {
  const plan = buildLessonPlan(source);
  return {
    unitId: plan.unitId,
    filename: lessonPlanFilename(plan),
    plan,
    markdown: renderLessonPlanMarkdown(plan),
  };
}

export function lessonPlanFilename(plan: LessonPlan): string {
  const raw = [
    '教案',
    plan.textbook.publisher,
    `${plan.textbook.grade}${plan.textbook.volume}`,
    plan.unit.code,
    plan.unit.title,
  ].filter((part) => String(part).trim()).join('-');
  const safe = raw
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return `${safe || 'lesson-plan'}.md`;
}

export function renderLessonPlanMarkdown(plan: LessonPlan): string {
  const lines: string[] = [];
  const heading = `${plan.unit.code} · ${plan.unit.title}`;
  lines.push(`# 教案：${heading}`);
  lines.push('');
  lines.push(`- 教材：${plan.textbook.publisher} · ${plan.textbook.grade} · ${plan.textbook.volume}${plan.textbook.edition ? ` · ${plan.textbook.edition}` : ''}`);
  lines.push(`- 建议课时：${plan.suggestedSessions} 课时（每课时约 ${plan.sessionMinutes} 分钟，按课文句数与活动数估算）`);
  lines.push(`- 版本：currentVersion=${plan.currentVersion ?? '—'} · contentVersion=${plan.contentVersion ?? '—'} · availability=${plan.availability ?? '—'}`);
  lines.push(`- 导出时间：${plan.generatedAt}`);
  lines.push('');

  lines.push('## 一、教学目标');
  lines.push('');
  if (plan.objectives.length) {
    plan.objectives.forEach((objective, index) => lines.push(`${index + 1}. ${objective}`));
  } else {
    lines.push('（未设置教学目标）');
  }
  lines.push('');

  lines.push('## 二、重点句');
  lines.push('');
  if (plan.keySentences.length) {
    lines.push('| # | 英文 | 中文 | 关键词 |');
    lines.push('|---|---|---|---|');
    plan.keySentences.forEach((sentence, index) => {
      lines.push(`| ${index + 1} | ${cell(sentence.en)} | ${cell(sentence.zh)} | ${cell(sentence.keyWords.join('、') || '—')} |`);
    });
  } else {
    lines.push('（课文暂无句子）');
  }
  lines.push('');

  lines.push('## 三、重点词汇');
  lines.push('');
  if (plan.focusWords.length) {
    for (const word of plan.focusWords) {
      lines.push(`### ${word.word}${word.phonetic ? ` ${word.phonetic}` : ''}`);
      lines.push('');
      lines.push(`- 中文：${word.meaningZh || '—'}`);
      if (word.syllables.length) lines.push(`- 音节：${word.syllables.join(' · ')}`);
      if (word.difficultPhonemes.length) lines.push(`- 易错音：${word.difficultPhonemes.join('、')}`);
      if (word.examples.length) {
        for (const example of word.examples.slice(0, 3)) {
          lines.push(`- 例句：${example.en}${example.zh ? ` ${example.zh}` : ''}`);
        }
      }
      lines.push('');
    }
  } else {
    lines.push('（本单元未关联重点词）');
    lines.push('');
  }

  lines.push('## 四、语法点');
  lines.push('');
  if (plan.grammarPoints.length) {
    plan.grammarPoints.forEach((point, index) => {
      lines.push(`### ${index + 1}. ${point.titleZh}（${point.pattern}）`);
      lines.push('');
      lines.push(`- 讲解：${point.explanationZh}`);
      point.examples.forEach((example) => {
        lines.push(`- 例句：${example.en}${example.zh ? ` ${example.zh}` : ''}`);
      });
      if (point.commonErrorZh) lines.push(`- 常见错误：${point.commonErrorZh}`);
      lines.push('');
    });
  } else {
    lines.push('（本单元没有语法点）');
    lines.push('');
  }

  lines.push('## 五、课堂活动');
  lines.push('');
  const languageActivities = plan.activities.filter((activity) => activity.track === 'language');
  if (languageActivities.length) {
    languageActivities.forEach((activity, index) => {
      lines.push(`${index + 1}. ${activity.title}（${activity.taskType} · 证据 ${activity.evidenceKind}）`);
      if (activity.targetWords.length) lines.push(`   - 目标词：${activity.targetWords.join('、')}`);
      lines.push(`   - 教师话语：${activity.teacherUtteranceZh}`);
      if (activity.demonstrationText) lines.push(`   - 示范：${activity.demonstrationText}`);
    });
  } else {
    lines.push('（没有语言习得轨活动）');
  }
  lines.push('');

  lines.push('## 六、学校英语轨');
  lines.push('');
  const schoolActivities = plan.activities.filter((activity) => activity.track === 'school');
  if (schoolActivities.length) {
    schoolActivities.forEach((activity, index) => {
      lines.push(`${index + 1}. [${activity.schoolModule ?? '—'}] ${activity.title}（${activity.taskType} · 证据 ${activity.evidenceKind}）`);
      lines.push(`   - 教师话语：${activity.teacherUtteranceZh}`);
      if (activity.demonstrationText) lines.push(`   - 示范：${activity.demonstrationText}`);
    });
  } else {
    lines.push('（本单元未生成学校英语轨活动）');
  }
  lines.push('');

  lines.push('## 七、易错点');
  lines.push('');
  if (plan.commonErrors.length) {
    for (const error of plan.commonErrors) {
      lines.push(`- ${error.kind === 'grammar' ? '语法' : '发音'}｜${error.target}：${error.detail}`);
    }
  } else {
    lines.push('（暂无显式易错点，按课堂观察补充）');
  }
  lines.push('');

  lines.push('## 八、课后练习建议');
  lines.push('');
  if (plan.homePractice.length) {
    plan.homePractice.forEach((item) => lines.push(`- ${item}`));
  } else {
    lines.push('- 朗读课文并跟读重点词。');
  }
  lines.push('');

  lines.push('## 九、自动质检摘要');
  lines.push('');
  lines.push(`- 结论：${plan.qc.ok === null ? '未记录' : plan.qc.ok ? '通过' : '存在阻断项'}`);
  lines.push(`- 阻断项：${plan.qc.errors}`);
  lines.push(`- 警告：${plan.qc.warnings}`);
  lines.push(`- needsReview：${plan.qc.needsReview ? '是' : '否'}`);
  lines.push('');

  return lines.join('\n');
}

function toPlanActivity(activity: CefrLesson, track: 'language' | 'school'): LessonPlanActivity {
  return {
    id: activity.id,
    track,
    schoolModule: activity.schoolModule ?? null,
    title: activity.title,
    taskType: activity.taskType,
    evidenceKind: activity.evidenceKind ?? 'none',
    targetWords: activity.targetWords,
    teacherUtteranceZh: activity.teacherUtteranceZh,
    demonstrationText: activity.demonstrationText,
  };
}

function buildHomePractice(
  content: TextbookUnitContent,
  sentences: LessonPlanSentence[],
  words: LessonPlanWord[],
  grammar: LessonPlanGrammar[],
): string[] {
  const items: string[] = [];
  if (sentences.length) {
    items.push(`朗读课文《${content.passage.title}》一遍，重点跟读：${sentences[0]!.en}`);
    if (sentences.length > 1) {
      items.push(`再任选一句读给家长听：${sentences[Math.min(1, sentences.length - 1)]!.en}`);
    }
  }
  const safeWords = words.filter((word) => word.word.trim()).slice(0, 4).map((word) => word.word);
  if (safeWords.length) {
    items.push(`跟读重点词各 3 遍：${safeWords.join('、')}；读不准时先拆音节再合成整词。`);
  }
  const pattern = grammar[0]?.pattern;
  if (pattern) {
    items.push(`用句型“${pattern}”说一句自己的话，不要求写下来。`);
  }
  if (!items.length) {
    items.push('听课文音频一遍，能指出听到的单词即可。');
  }
  return items;
}

function readQc(report: Record<string, unknown> | undefined): LessonPlan['qc'] {
  const root = asRecord(report);
  const validation = asRecord(root.validation);
  const errors = Array.isArray(validation.errors) ? validation.errors.length : 0;
  const warnings = Array.isArray(validation.warnings) ? validation.warnings.length : 0;
  return {
    ok: typeof validation.ok === 'boolean' ? validation.ok : null,
    errors,
    warnings,
    needsReview: root.needsReview === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';
}
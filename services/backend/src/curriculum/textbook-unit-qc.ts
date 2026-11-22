import {
  textbookUnitContentSchema,
  type TextbookUnitContent,
} from '@alg/shared-contracts';

/**
 * 教材单元自动校验。
 *
 * 这里是“无人审核门禁”的唯一硬门：所有可机器判定的规则都在写入
 * curriculum_units 之前执行。返回的 path 使用 JSON 路径，方便管理端直接
 * 定位到句子、词条或活动；错误阻止 active，警告只进入质检报告。
 *
 * 不在这里做数据库查询：能力节点、音素库存、单元编码唯一性由
 * TextbookUnitPublisherService 补充上下文后传入，保持本模块可单测。
 */

export type TextbookUnitQcSeverity = 'error' | 'warning';

export type TextbookUnitQcIssue = {
  code: string;
  path: string;
  message: string;
  severity: TextbookUnitQcSeverity;
  source?: 'content' | 'generation';
};

export type TextbookUnitQcStats = {
  sentences: number;
  translatedSentences: number;
  vocabulary: number;
  phonetic: number;
  meaning: number;
  activities: number;
  grammarPoints: number;
  schoolActivities: number;
};

export type TextbookUnitQcResult = {
  ok: boolean;
  checkedAt: string;
  errors: TextbookUnitQcIssue[];
  warnings: TextbookUnitQcIssue[];
  issues: TextbookUnitQcIssue[];
  stats: TextbookUnitQcStats;
  checks: Record<string, 'pass' | 'fail' | 'warn'>;
};

export type TextbookUnitQcContext = {
  /** 录入的语法重点；有值时必须至少生成一个语法点。 */
  grammarFocus?: string[];
  /** skill_nodes 中实际存在的 id/code；提供时校验每个能力节点。 */
  knownSkillCodes?: Set<string>;
  /** phoneme_items 中的音素；提供时对 IPA 做符号级对照（只告警）。 */
  phonemeSymbols?: Set<string>;
  /** 生成阶段写入 qcReport.issues 的问题；作为警告保留可追溯性。 */
  generationIssues?: Array<{ code?: unknown; path?: unknown; message?: unknown }>;
  /** 指定时用于错误文案；默认从 content.unit.code 读取。 */
  unitCode?: string;
};

const CJK_RE = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
const HAN_RE = /[\u3400-\u9fff]/;
const PLACEHOLDER_RE = /待补充|待翻译|译文待|TODO|TBD|第\s*\d+\s*句译文/i;
const ALLOWED_EVIDENCE_KINDS = new Set([
  'listening_comprehension',
  'reading_comprehension',
  'production',
  'pronunciation',
  'transfer',
  'none',
]);
const SENSITIVE_TERMS = [
  'suicide', 'self-harm', 'self harm', 'kill yourself', 'porn', 'pornography',
  'rape', 'nigger', 'fuck', 'shit', 'bitch', 'terrorist', 'terrorism',
  'bomb', 'cocaine', 'heroin', 'methamphetamine', 'nazi', 'sexual',
  '自杀', '色情', '毒品', '炸弹', '恐怖袭击', '枪支', '赌博', '裸体', '暴力',
];

export function validateTextbookUnitContent(
  content: TextbookUnitContent,
  context: TextbookUnitQcContext = {},
): TextbookUnitQcResult {
  const errors: TextbookUnitQcIssue[] = [];
  const warnings: TextbookUnitQcIssue[] = [];
  const checks: Record<string, 'pass' | 'fail' | 'warn'> = {};
  const add = (
    severity: TextbookUnitQcSeverity,
    code: string,
    path: string,
    message: string,
    source: 'content' | 'generation' = 'content',
  ) => {
    const issue: TextbookUnitQcIssue = { code, path, message, severity, source };
    (severity === 'error' ? errors : warnings).push(issue);
  };
  const mark = (name: string, issueCount: number, warningCount = 0) => {
    checks[name] = issueCount > 0 ? 'fail' : warningCount > 0 ? 'warn' : 'pass';
  };

  const parsed = textbookUnitContentSchema.safeParse(content);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      add('error', 'schema_invalid', issue.path.join('.'), issue.message);
    }
    mark('schema', errors.length);
    return result(errors, warnings, checks, emptyStats());
  }
  const data = parsed.data;
  // 句中人名/地名等专有名词：首字母大写且不在句首；无音标时豁免覆盖率硬门槛。
  const properNouns = new Set<string>();
  for (const paragraph of data.passage.paragraphs) {
    for (const sentence of paragraph.sentences) {
      for (const match of sentence.en.matchAll(/\b[A-Z][A-Za-z'’-]{1,}\b/g)) {
        const index = match.index ?? 0;
        const prefix = sentence.en.slice(0, index).trimEnd();
        if (prefix && !/[.!?]$/.test(prefix)) properNouns.add(match[0].toLowerCase());
      }
    }
  }

  // 1. 句子 ID 与中文译文
  const paragraphSentences = data.passage.paragraphs.flatMap((paragraph, paragraphIndex) =>
    paragraph.sentences.map((sentence, sentenceIndex) => ({
      sentence,
      path: `passage.paragraphs.${paragraphIndex}.sentences.${sentenceIndex}`,
    })),
  );
  const seenSentenceIds = new Map<string, string>();
  let translatedSentences = 0;
  for (const { sentence, path } of paragraphSentences) {
    if (seenSentenceIds.has(sentence.id)) {
      add('error', 'sentence_id_duplicate', `${path}.id`, `句子 ID ${sentence.id} 重复，必须唯一。`);
    } else {
      seenSentenceIds.set(sentence.id, path);
    }
    if (!sentence.en.trim()) {
      add('error', 'sentence_en_empty', `${path}.en`, `句子 ${sentence.id} 的英文不能为空。`);
    }
    const zh = sentence.zh.trim();
    if (!zh) {
      add('error', 'sentence_zh_empty', `${path}.zh`, `句子 ${sentence.id} 缺少中文译文。`);
      continue;
    }
    if (PLACEHOLDER_RE.test(zh)) {
      add('error', 'sentence_zh_placeholder', `${path}.zh`, `句子 ${sentence.id} 的中文仍是占位文本，不能启用。`);
      continue;
    }
    if (!HAN_RE.test(zh)) {
      add('error', 'sentence_zh_not_chinese', `${path}.zh`, `句子 ${sentence.id} 的中文栏没有汉字，疑似仍是英文。`);
      continue;
    }
    if (normalizeText(zh) === normalizeText(sentence.en)) {
      add('error', 'sentence_zh_equals_en', `${path}.zh`, `句子 ${sentence.id} 的中文与英文相同。`);
      continue;
    }
    const hanCount = Array.from(zh).filter((char) => HAN_RE.test(char)).length;
    const latinWords = zh.match(/[A-Za-z]{2,}/g)?.length ?? 0;
    if (latinWords >= 3 && hanCount < latinWords) {
      add('error', 'sentence_zh_mostly_english', `${path}.zh`, `句子 ${sentence.id} 的中文栏以英文单词为主，不能启用。`);
      continue;
    }
    translatedSentences += 1;
  }
  mark('sentence_ids', errors.filter((issue) => issue.code === 'sentence_id_duplicate').length);
  mark('sentence_translations', errors.filter((issue) => issue.code.startsWith('sentence_zh') || issue.code === 'sentence_en_empty').length);

  // 2. 词条音标/释义与图片
  const seenWords = new Set<string>();
  let phoneticCount = 0;
  let meaningCount = 0;
  for (const [index, item] of data.vocabulary.entries()) {
    const path = `vocabulary.${index}`;
    const wordKey = item.word.trim().toLowerCase();
    if (seenWords.has(wordKey)) {
      add('error', 'vocabulary_word_duplicate', `${path}.word`, `词条 ${item.word} 重复。`);
    }
    seenWords.add(wordKey);
    const phonetic = item.phonetic.trim();
    const properNounExempt = !phonetic && properNouns.has(wordKey);
    if (phonetic) {
      phoneticCount += 1;
      if (!/^\/.+\/$|^\[.+\]$/.test(phonetic)) {
        add('warning', 'phonetic_format', `${path}.phonetic`, `词条 ${item.word} 的音标未使用 /.../ 或 [...] 定界。`);
      }
    } else if (properNounExempt) {
      add('warning', 'proper_noun_phonetic_exempt', `${path}.phonetic`, `专有名词 ${item.word} 未匹配到音标，已按专名豁免音标覆盖校验。`);
    }
    if (!item.meaningZh.trim()) {
      add('error', 'vocabulary_meaning_empty', `${path}.meaningZh`, `词条 ${item.word} 缺少中文释义。`);
    } else if (!HAN_RE.test(item.meaningZh)) {
      add('error', 'vocabulary_meaning_not_chinese', `${path}.meaningZh`, `词条 ${item.word} 的中文释义没有汉字。`);
    } else {
      meaningCount += 1;
    }
    if (item.imageAsset) {
      if (!/^https:\/\//i.test(item.imageAsset.url)) {
        add('error', 'image_url_not_https', `${path}.imageAsset.url`, `词条 ${item.word} 的图片必须使用 HTTPS URL。`);
      }
      if (!item.imageAsset.license.trim()) {
        add('error', 'image_license_missing', `${path}.imageAsset.license`, `词条 ${item.word} 的图片缺少 license。`);
      }
    }
  }
  const phoneticBase = data.vocabulary.filter((item) => item.phonetic.trim() || !properNouns.has(item.word.trim().toLowerCase())).length;
  const phoneticRate = phoneticBase ? phoneticCount / phoneticBase : 1;
  if (phoneticBase && phoneticRate < 0.98) {
    add(
      'error',
      'phonetic_coverage_low',
      'vocabulary',
      `音标覆盖率 ${(phoneticRate * 100).toFixed(1)}% 低于 98%（${phoneticCount}/${phoneticBase}，专名已豁免）。`,
    );
  }
  if (data.vocabulary.length && meaningCount !== data.vocabulary.length) {
    add(
      'error',
      'meaning_coverage_low',
      'vocabulary',
      `中文释义覆盖率 ${meaningCount}/${data.vocabulary.length}，要求 100%。`,
    );
  }
  mark('vocabulary_phonetic', phoneticRate < 0.98 ? 1 : 0, data.vocabulary.length - phoneticCount > 0 ? 1 : 0);  mark('vocabulary_meaning', meaningCount === data.vocabulary.length ? 0 : 1);
  mark('images', errors.filter((issue) => issue.code.startsWith('image_')).length);

  // 3. 活动：语音上限、证据类型、评估规则、能力节点
  const passageTexts = paragraphSentences.map(({ sentence }) => normalizeText(sentence.en));
  const passActivityChecks = (
    activity: TextbookUnitContent['activities'][number],
    path: string,
    options: { school?: boolean } = {},
  ) => {
    const speech = [activity.teacherUtteranceZh, activity.demonstrationText].filter(Boolean).join(' ');
    const speechLimit = speechLimitMessage(speech);
    if (speechLimit) {
      add('error', 'activity_speech_too_long', `${path}.teacherUtteranceZh`, `活动 ${activity.id} ${speechLimit}`);
    }
    const mediaSpeechLimit = speechLimitMessage(activity.media.speechText);
    if (mediaSpeechLimit) {
      add('error', 'activity_media_speech_too_long', `${path}.media.speechText`, `活动 ${activity.id} 的 media.speechText ${mediaSpeechLimit}`);
    }
    if (!activity.skillNodeIds.length) {
      add('error', 'activity_skill_node_missing', `${path}.skillNodeIds`, `活动 ${activity.id} 没有绑定能力节点。`);
    }
    if (context.knownSkillCodes) {
      for (const [nodeIndex, skillNodeId] of activity.skillNodeIds.entries()) {
        if (!context.knownSkillCodes.has(skillNodeId)) {
          add('error', 'activity_skill_node_unknown', `${path}.skillNodeIds.${nodeIndex}`, `活动 ${activity.id} 绑定了不存在的能力节点 ${skillNodeId}。`);
        }
      }
    }
    if (!activity.evidenceKind) {
      add('error', 'activity_evidence_kind_missing', `${path}.evidenceKind`, `活动 ${activity.id} 未声明 evidenceKind。`);
    } else if (!ALLOWED_EVIDENCE_KINDS.has(activity.evidenceKind)) {
      add('error', 'activity_evidence_kind_invalid', `${path}.evidenceKind`, `活动 ${activity.id} 的 evidenceKind 无效。`);
    }
    if (!hasJudgeableAssessment(activity)) {
      add(
        'error',
        'activity_assessment_unjudgeable',
        `${path}.assessment`,
        `活动 ${activity.id} 缺少可判定评估规则；请配置答案/语音评估，或显式设置 passiveReading=true。`,
      );
    }
    if (activity.passiveReading === true && activity.evidenceKind && activity.evidenceKind !== 'none') {
      add('warning', 'passive_reading_with_evidence', `${path}.evidenceKind`, `活动 ${activity.id} 标记为被动听读，但 evidenceKind 不是 none。`);
    }
    if (activity.evidenceKind === 'none' && activity.passiveReading !== true) {
      add('warning', 'no_evidence_without_passive', `${path}.passiveReading`, `活动 ${activity.id} 的 evidenceKind=none，但未标记 passiveReading。`);
    }
    if (options.school) {
      if (!activity.schoolModule) {
        add('error', 'school_activity_module_missing', `${path}.schoolModule`, `学校轨活动 ${activity.id} 未声明 schoolModule。`);
      }
      if (!activity.skillNodeIds.some((id) => id.startsWith('SE.'))) {
        add('warning', 'school_activity_no_school_node', `${path}.skillNodeIds`, `学校轨活动 ${activity.id} 没有学校能力节点（SE.*）。`);
      }
    }
  };

  const seenActivityIds = new Set<string>();
  for (const [index, activity] of data.activities.entries()) {
    const path = `activities.${index}`;
    if (seenActivityIds.has(activity.id)) {
      add('error', 'activity_id_duplicate', `${path}.id`, `活动 ID ${activity.id} 重复。`);
    }
    seenActivityIds.add(activity.id);
    passActivityChecks(activity, path);
  }

  const passageActivity = data.activities.some((activity) => {
    if (activity.taskType === 'reading_story') return true;
    const demonstration = normalizeText(activity.demonstrationText);
    return Boolean(demonstration) && passageTexts.some((text) => text === demonstration || text.includes(demonstration));
  });
  if (!passageActivity) {
    add('error', 'passage_activity_missing', 'activities', '至少需要 1 个课文活动（reading_story 或使用课文原句的活动）。');
  }
  mark('activities', errors.filter((issue) => issue.path.startsWith('activities')).length,
    warnings.filter((issue) => issue.path.startsWith('activities')).length);

  // 4. 语法点
  const seenGrammarIds = new Set<string>();
  for (const [index, point] of data.grammarPoints.entries()) {
    const path = `grammarPoints.${index}`;
    if (seenGrammarIds.has(point.id)) {
      add('error', 'grammar_id_duplicate', `${path}.id`, `语法点 ID ${point.id} 重复。`);
    }
    seenGrammarIds.add(point.id);
    if (!point.examples.length) {
      add('error', 'grammar_example_missing', `${path}.examples`, `语法点 ${point.id} 没有例句。`);
    }
    for (const [sentenceIndex, sentenceId] of point.sentenceIds.entries()) {
      if (!seenSentenceIds.has(sentenceId)) {
        add('error', 'grammar_sentence_unknown', `${path}.sentenceIds.${sentenceIndex}`, `语法点 ${point.id} 引用了不存在的句子 ${sentenceId}。`);
      }
    }
  }
  if (context.grammarFocus?.length && !data.grammarPoints.length) {
    add('error', 'grammar_point_missing', 'grammarPoints', '已录入语法重点，但生成结果没有语法点。');
  }
  mark('grammar', errors.filter((issue) => issue.path.startsWith('grammar')).length);

  // 5. 学校轨
  if (data.schoolTrack) {
    const declaredModules = new Set(data.schoolTrack.modules);
    if (!data.schoolTrack.modules.length) {
      add('error', 'school_modules_missing', 'schoolTrack.modules', '学校轨已声明，但没有模块。');
    }
    if (!data.schoolTrack.activities.length) {
      add('error', 'school_activities_missing', 'schoolTrack.activities', '学校轨已声明，但没有活动。');
    }
    const representedModules = new Set<string>();
    for (const [index, activity] of data.schoolTrack.activities.entries()) {
      const path = `schoolTrack.activities.${index}`;
      if (seenActivityIds.has(activity.id)) {
        add('error', 'activity_id_duplicate', `${path}.id`, `活动 ID ${activity.id} 与语言轨重复。`);
      }
      seenActivityIds.add(activity.id);
      passActivityChecks(activity, path, { school: true });
      if (activity.schoolModule && declaredModules.has(activity.schoolModule)) {
        representedModules.add(activity.schoolModule);
      } else if (activity.schoolModule) {
        add('error', 'school_module_unknown', `${path}.schoolModule`, `学校轨活动 ${activity.id} 的模块 ${activity.schoolModule} 未在 schoolTrack.modules 声明。`);
      }
    }
    for (const [index, module] of data.schoolTrack.modules.entries()) {
      if (!representedModules.has(module)) {
        add('error', 'school_module_no_activity', `schoolTrack.modules.${index}`, `学校轨模块 ${module} 没有对应活动。`);
      }
    }
  }
  mark('school_track', errors.filter((issue) => issue.path.startsWith('schoolTrack')).length);

  // 6. IPA 与音素库存对照（只告警，缺库存时不误判）
  if (context.phonemeSymbols?.size) {
    const allowed = new Set(
      [...context.phonemeSymbols]
        .map((item) => item.trim().replace(/^[/\[]/, '').replace(/[/\]]$/, ''))
        .filter(Boolean),
    );
    for (const [index, item] of data.vocabulary.entries()) {
      const ipa = item.phonetic.trim().replace(/^[/\[]/, '').replace(/[/\]]$/, '');
      if (!ipa) continue;
      const symbols = Array.from(ipa).filter((char) => !/[\sˌˈːˑ.()\-]/.test(char));
      const unknown = [...new Set(symbols.filter((char) => !allowed.has(char)))];
      if (unknown.length) {
        add('warning', 'ipa_symbol_unknown', `vocabulary.${index}.phonetic`, `词条 ${item.word} 的音标包含 phoneme_items 未收录的符号：${unknown.join(' ')}。`);
      }
    }
  }

  // 7. 敏感内容过滤（确定性兜底；外部内容安全能力可在同一入口替换）
  const sensitiveTexts: Array<{ path: string; text: string }> = [
    ...paragraphSentences.flatMap(({ sentence, path }) => [
      { path: `${path}.en`, text: sentence.en },
      { path: `${path}.zh`, text: sentence.zh },
    ]),
    ...data.objectives.map((text, index) => ({ path: `objectives.${index}`, text })),
    ...data.vocabulary.flatMap((item, index) => [
      { path: `vocabulary.${index}.word`, text: item.word },
      { path: `vocabulary.${index}.meaningZh`, text: item.meaningZh },
      ...item.exampleSentences.flatMap((example, exampleIndex) => [
        { path: `vocabulary.${index}.exampleSentences.${exampleIndex}.en`, text: example.en },
        { path: `vocabulary.${index}.exampleSentences.${exampleIndex}.zh`, text: example.zh },
      ]),
    ]),
    ...data.grammarPoints.flatMap((point, index) => [
      { path: `grammarPoints.${index}.pattern`, text: point.pattern },
      { path: `grammarPoints.${index}.explanationZh`, text: point.explanationZh },
      ...point.examples.map((example, exampleIndex) => ({ path: `grammarPoints.${index}.examples.${exampleIndex}.en`, text: example.en })),
    ]),
    ...data.activities.flatMap((activity, index) => [
      { path: `activities.${index}.title`, text: activity.title },
      { path: `activities.${index}.teacherUtteranceZh`, text: activity.teacherUtteranceZh },
      { path: `activities.${index}.demonstrationText`, text: activity.demonstrationText },
    ]),
    ...(data.schoolTrack?.activities ?? []).flatMap((activity, index) => [
      { path: `schoolTrack.activities.${index}.title`, text: activity.title },
      { path: `schoolTrack.activities.${index}.teacherUtteranceZh`, text: activity.teacherUtteranceZh },
      { path: `schoolTrack.activities.${index}.demonstrationText`, text: activity.demonstrationText },
    ]),
  ];
  for (const { path, text } of sensitiveTexts) {
    const hit = findSensitiveTerm(text);
    if (hit) {
      add('error', 'sensitive_content', path, `内容包含儿童不宜词条“${hit}”，不能启用。`);
      break;
    }
  }
  mark('sensitive_content', errors.filter((issue) => issue.code === 'sensitive_content').length);

  // 8. 生成阶段问题作为警告保留，确保不会“静默通过”
  const seenGenerationIssues = new Set<string>();
  for (const issue of context.generationIssues ?? []) {
    const code = typeof issue.code === 'string' ? issue.code : 'generation_issue';
    const path = typeof issue.path === 'string' ? issue.path : 'qcReport';
    const message = typeof issue.message === 'string' ? issue.message : code;
    const key = `${code}:${path}:${message}`;
    if (seenGenerationIssues.has(key)) continue;
    seenGenerationIssues.add(key);
    add('warning', `generation_${code}`, path, message, 'generation');
  }

  const stats: TextbookUnitQcStats = {
    sentences: paragraphSentences.length,
    translatedSentences,
    vocabulary: data.vocabulary.length,
    phonetic: phoneticCount,
    meaning: meaningCount,
    activities: data.activities.length,
    grammarPoints: data.grammarPoints.length,
    schoolActivities: data.schoolTrack?.activities.length ?? 0,
  };
  return result(errors, warnings, checks, stats);
}

export function hasJudgeableAssessment(activity: TextbookUnitContent['activities'][number]): boolean {
  if (activity.passiveReading === true) return true;
  const assessment = activity.assessment;
  const hasTextAnswerRule = Boolean(
    assessment?.acceptedTexts?.length ||
    assessment?.requiredPhrases?.length ||
    assessment?.openResponse,
  );
  if (activity.taskType === 'image_identification') {
    return Boolean(assessment?.acceptedImageIds?.length);
  }
  if (activity.taskType === 'listening_comprehension' || activity.taskType === 'reading_story') {
    // 理解题必须有答案规则；纯听读必须显式 passiveReading=true，
    // 不能因为“没有开 ASR”就默认它产生了理解证据。
    return Boolean(
      hasTextAnswerRule ||
      assessment?.acceptedImageIds?.length,
    );
  }
  return Boolean(
    hasTextAnswerRule ||
    activity.requiresPronunciationAssessment,
  );
}

export function speechLimitMessage(text: string): string | null {
  const codePoints = Array.from(text);
  const cjkCount = codePoints.filter((char) => CJK_RE.test(char)).length;
  if (cjkCount > 150 || codePoints.length > 500) {
    return `整轮教师话语超出单次 TTS 合成上限（汉字/全角=${cjkCount}/150，字符=${codePoints.length}/500）。`;
  }
  return null;
}

export function findSensitiveTerm(text: string): string | null {
  const lower = text.toLowerCase();
  for (const term of SENSITIVE_TERMS) {
    if (/^[a-z -]+$/.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(lower)) return term;
    } else if (lower.includes(term)) {
      return term;
    }
  }
  return null;
}

function result(
  errors: TextbookUnitQcIssue[],
  warnings: TextbookUnitQcIssue[],
  checks: Record<string, 'pass' | 'fail' | 'warn'>,
  stats: TextbookUnitQcStats,
): TextbookUnitQcResult {
  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    errors,
    warnings,
    issues: [...errors, ...warnings],
    stats,
    checks,
  };
}

function emptyStats(): TextbookUnitQcStats {
  return {
    sentences: 0,
    translatedSentences: 0,
    vocabulary: 0,
    phonetic: 0,
    meaning: 0,
    activities: 0,
    grammarPoints: 0,
    schoolActivities: 0,
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[“”"'’‘]/g, '').replace(/\s+/g, ' ').trim();
}


/**
 * P0-2 / P0-4：教材单元发布时派生“可下发”的教学活动。
 *
 * 只做纯计算：不读库、不调模型。生成的条目与人工活动一起写入 learning_items，
 * 保证课文型主题在客户端可下发类型过滤后仍有候选活动（不会回退到预置词）。
 *
 * 顺序固定为：逐句跟读 → 重点词发音 → 人工活动。
 * 逐句跟读放最前，是因为课文课的第一屏就是整篇朗读与跟读；
 * planner 用 order 作为同难度下的次序依据。
 */
import type { TextbookUnitContent } from '@alg/shared-contracts';
import { selectFocusWords } from './curriculum-audio-plan';
import type { PublishableActivity } from './curriculum-publish';

type ExistingActivity = { skillNodeIds?: string[]; taskType?: string };

/** 与句子 id 使用同一套单元编码归一化（空格转连字符、去特殊字符）。 */
function unitKey(code: string): string {
  return (code.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.-]/g, '') || 'unit').slice(0, 100);
}

function firstSkill(existing: ReadonlyArray<ExistingActivity>): string {
  return existing
    .flatMap((activity) => activity.skillNodeIds ?? [])
    .find((id): id is string => Boolean(id)) ?? 'LA.SPEAK.simple_sentences';
}

/** 逐句跟读：一句一个活动，目标文本就是这句话。 */
export function buildPassageSentenceActivities(
  content: TextbookUnitContent,
  existing: ReadonlyArray<ExistingActivity>,
): PublishableActivity[] {
  const sentences = (content.passage?.paragraphs ?? []).flatMap((paragraph) => paragraph.sentences);
  if (!sentences.length) return [];
  const skill = firstSkill(existing);
  return sentences.map((sentence, index) => ({
    id: `${unitKey(content.unit.code)}-s${String(index + 1).padStart(2, '0')}`,
    title: `跟读：${sentence.en.slice(0, 40)}`,
    taskType: 'word_mimicry',
    scenario: 'story_scene',
    difficulty: 1,
    // 复习轮保留原句，让孩子照着读；不能按无提示回忆清空目标文本。
    reviewMode: 'read_aloud' as const,
    skillNodeIds: [skill],
    targetWords: [sentence.en],
    teacherUtteranceZh: index === 0 ? '先听这一句，再跟着读一遍。' : '跟着读这一句。',
    demonstrationText: sentence.en,
    requiresPronunciationAssessment: true,
    requiresAsr: true,
    assessment: {
      openResponse: false,
      acceptedTexts: [sentence.en],
      requiredPhrases: [],
      acceptedImageIds: [],
    },
  }));
}

/**
 * 重点词发音：复用课文音频计划里的选词规则（复现次数 / 多音节 / 难音 / keyWords）。
 * 与课文音频、客户端重点词卡使用同一份选词结果，避免“卡上有、计划里没有”。
 */
export function buildFocusWordActivities(
  content: TextbookUnitContent,
  existing: ReadonlyArray<ExistingActivity>,
): PublishableActivity[] {
  const words = selectFocusWords({
    passage: content.passage,
    vocabulary: content.vocabulary,
    activities: content.activities,
  });
  if (!words.length) return [];
  const skill = firstSkill(existing);
  return words.map((focus, index) => ({
    id: `${unitKey(content.unit.code)}-w${String(index + 1).padStart(2, '0')}`,
    title: `重点词：${focus.word}`,
    taskType: 'pronunciation_drill',
    scenario: 'story_scene',
    difficulty: 1,
    // P4-06：与原场景的同一重点词配对，供跨场景迁移证据使用。
    transferScenarioKey: wordTransferKey(focus.word),
    reviewMode: 'read_aloud' as const,
    skillNodeIds: [skill],
    targetWords: [focus.word],
    teacherUtteranceZh: `重点词 ${focus.word}，先听整词，再跟读一遍。`,
    demonstrationText: focus.word,
    requiresPronunciationAssessment: true,
    requiresAsr: true,
    assessment: {
      openResponse: false,
      acceptedTexts: [focus.word],
      requiredPhrases: [],
      acceptedImageIds: [],
    },
  }));
}

/** 发布时统一追加：逐句跟读在前，重点词在后。 */
export function derivedTextbookActivities(
  content: TextbookUnitContent,
  existing: ReadonlyArray<ExistingActivity>,
): PublishableActivity[] {
  const focusActivities = buildFocusWordActivities(content, existing);
  return [
    ...buildPassageSentenceActivities(content, existing),
    ...focusActivities,
    ...buildTransferActivities(content, [...existing, ...focusActivities]),
  ];
}

function wordTransferKey(word: string): string {
  return `tw-${word.trim().toLowerCase()}`.slice(0, 80);
}

/**
 * P4-06：跨场景迁移变体。
 *
 * 掌握规则 R4 要求同一关键项在「至少两个不同场景」独立使用；如果教材单元
 * 的所有跟读都落在 story_scene，孩子即使每次都读对，也永远拿不到迁移证据。
 *
 * 这里只补两个场景变体，不新增词、不改变原活动：
 *  - 重点词换到图片场景再读一次（word_mimicry）；
 *  - 首个语法点换到商店场景再用一次（sentence_pattern）。
 *
 * 变体与原文共享 `transferScenarioKey`，场景不同、目标词不变；目标文本仍来自
 * 本单元课文/词表，模型不参与编词。
 */
export function buildTransferActivities(
  content: TextbookUnitContent,
  existing: ReadonlyArray<ExistingActivity>,
): PublishableActivity[] {
  const focusWords = selectFocusWords({
    passage: content.passage,
    vocabulary: content.vocabulary,
    activities: content.activities,
  }).slice(0, 2);
  if (!focusWords.length) return [];

  const unitKeyValue = unitKey(content.unit.code);
  const wordSkills = existing.find((activity) => activity.taskType === 'pronunciation_drill')?.skillNodeIds
    ?? [firstSkill(existing)];
  const patternSkills = existing.find((activity) => activity.taskType === 'sentence_pattern')?.skillNodeIds
    ?? [firstSkill(existing)];
  const activities: PublishableActivity[] = [];

  const grammar = content.grammarPoints[0];
  if (grammar) {
    const example = grammar.examples[0]?.en?.trim() || content.passage.paragraphs[0]?.sentences[0]?.en || '';
    // 没有例句就没有可判定的目标文本，宁可不生成，也不下发空卡。
    if (example) {
      const teacher = `在商店里看到 ${focusWords[0]!.word}，试着用“${grammar.pattern.slice(0, 80)}”说一句。`;
      activities.push({
        id: `${unitKeyValue}-x01`,
        title: `换个场景说：${grammar.titleZh}`,
        taskType: 'sentence_pattern',
        scenario: 'object_shop_scene',
        difficulty: 2,
        transferScenarioKey: `tp-${grammar.id}`.slice(0, 80),
        skillNodeIds: patternSkills,
        targetWords: [focusWords[0]!.word],
        teacherUtteranceZh: teacher,
        demonstrationText: example,
        requiresPronunciationAssessment: false,
        requiresAsr: true,
        evidenceKind: 'transfer',
        assessment: {
          openResponse: false,
          acceptedTexts: [example],
          requiredPhrases: [],
          acceptedImageIds: [],
        },
      });
    }
  }

  focusWords.forEach((focus, index) => {
    const teacher = `在图片里看到 ${focus.word}，再读一遍。`;
    activities.push({
      id: `${unitKeyValue}-x${String(index + 2).padStart(2, '0')}`,
      title: `换个场景读：${focus.word}`,
      taskType: 'word_mimicry',
      scenario: 'object_pic_scene',
      difficulty: 1,
      transferScenarioKey: wordTransferKey(focus.word),
      skillNodeIds: wordSkills,
      targetWords: [focus.word],
      teacherUtteranceZh: teacher,
      demonstrationText: focus.word,
      requiresPronunciationAssessment: true,
      requiresAsr: true,
      evidenceKind: 'transfer',
      assessment: {
        openResponse: false,
        acceptedTexts: [focus.word],
        requiredPhrases: [],
        acceptedImageIds: [],
      },
    });
  });

  return activities;
}

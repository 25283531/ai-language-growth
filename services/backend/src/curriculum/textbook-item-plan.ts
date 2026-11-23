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

type ExistingActivity = { skillNodeIds?: string[] };

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
  return [
    ...buildPassageSentenceActivities(content, existing),
    ...buildFocusWordActivities(content, existing),
  ];
}

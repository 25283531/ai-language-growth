/**
 * 开课主题选择顺序（纯函数，便于回归）。
 *
 * 1. 客户端显式传入（0.0.24+ 按所选教材单元带上 topicId）；
 * 2. 学习者档案的一次性指定（家/运营指定下一节课主题，开课即消费）；
 * 3. 教材映射解析出的主题（旧客户端没带 topicId 时的兜底，保证「选了什么教材就开什么单元」）；
 * 4. 上一节课主题（保持连续性）；
 * 5. 最终兜底。
 *
 * 空串、纯空格、字符串 "null" 一律视为未提供。
 */
export type LessonTopicCandidates = {
  requested?: string | null;
  profile?: string | null;
  textbook?: string | null;
  previous?: string | null;
  fallback: string;
};

function usable(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed;
}

export function selectLessonTopic(candidates: LessonTopicCandidates): string {
  return usable(candidates.requested)
    ?? usable(candidates.profile)
    ?? usable(candidates.textbook)
    ?? usable(candidates.previous)
    ?? candidates.fallback;
}

export interface WordPronunciationActivity {
  taskType: string;
  targetWords: string[];
  requiresPronunciationAssessment: boolean;
}

export interface WordPronunciationResponse {
  audioRef?: string | null;
  selectedImageId?: string | null;
}

/**
 * 当前客户端把单词练习统一渲染成跟读卡片。
 * 识图/听辨活动没有可点选的图片时，孩子说出的单个目标词也必须进入发音评估，
 * 否则录音会被当成空回合，既不评测也不累计跟读次数。
 */
export function shouldAssessWordPronunciationForActivity(input: {
  activity: WordPronunciationActivity | null | undefined;
  response: WordPronunciationResponse;
}): boolean {
  if (!input.response.audioRef || input.response.selectedImageId) return false;
  if (!input.activity) return false;
  if (input.activity.requiresPronunciationAssessment) return true;
  if (input.activity.targetWords.filter((word) => word.trim()).length !== 1) return false;
  return ['word_mimicry', 'pronunciation_drill', 'image_identification', 'listening_comprehension'].includes(
    input.activity.taskType,
  );
}

/**
 * 发音判定使用的阈值任务类型。
 * 图片/听辨活动只是承载单词练习的界面，不能借用图片任务的通过线；
 * 只要本轮进入单词发音评估，就统一按 word_mimicry 的发音阈值。
 */
export function wordPronunciationThresholdTaskType(input: {
  activity: WordPronunciationActivity;
  response: WordPronunciationResponse;
}): string {
  return shouldAssessWordPronunciationForActivity(input) ? 'word_mimicry' : input.activity.taskType;
}

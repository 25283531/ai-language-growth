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

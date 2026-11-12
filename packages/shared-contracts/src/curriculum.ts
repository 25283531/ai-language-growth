import { z } from 'zod';
import { EVIDENCE_SCENARIOS, TASK_TYPES } from './evidence';

/**
 * CEFR 全量课程 JSON 契约（schemaVersion 2）。
 *
 * 这一层只描述“教什么、怎么教、需要哪些媒体”，不包含图片 URL、音频地址或
 * 学习者数据。图片与语音在课程到达对应级别后由服务端预热，避免一次生成
 * 全部媒体造成不可控的下载量和 TTS 费用。
 */
export const CEFR_CURRICULUM_LEVELS = ['pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export const cefrCurriculumLevelSchema = z.enum(CEFR_CURRICULUM_LEVELS);
export type CefrCurriculumLevel = z.infer<typeof cefrCurriculumLevelSchema>;

export const cefrImageRequirementSchema = z.object({
  /** 稳定的图片需求键，用于跨版本去重；不是图片 URL。 */
  key: z.string().trim().min(1).max(160),
  /** word=单词配图；phrase=短句配图；scene=情境配图。 */
  kind: z.enum(['word', 'phrase', 'scene']).default('word'),
  /** 单词配图的目标词；短句/场景可为空。 */
  targetWord: z.string().trim().min(1).max(100).optional(),
  /** 需要被图片表达的目标文本（单词、短句或场景描述）。 */
  targetText: z.string().trim().min(1).max(500).optional(),
  /** 给图片搜索/生成服务的英文查询词。 */
  query: z.string().trim().min(1).max(300),
  alt: z.string().trim().min(1).max(300),
});
export type CefrImageRequirement = z.infer<typeof cefrImageRequirementSchema>;

export const cefrVocabularyEntrySchema = z.object({
  word: z.string().trim().min(1).max(100),
  phonetic: z.string().max(100).default(''),
  meaningZh: z.string().max(200).default(''),
  syllables: z.array(z.string().max(100)).max(30).default([]),
  difficultPhonemes: z.array(z.string().max(100)).max(30).default([]),
  phrases: z.array(z.string().max(300)).max(30).default([]),
  exampleSentences: z.array(z.object({
    en: z.string().trim().min(1).max(500),
    zh: z.string().max(500).default(''),
  })).max(20).default([]),
  image: cefrImageRequirementSchema.optional(),
});
export type CefrVocabularyEntry = z.infer<typeof cefrVocabularyEntrySchema>;

export const cefrLessonSchema = z.object({
  /** 稳定课程活动键：`<unitCode>:<index>`；也是 TTS 公共缓存 contentId。 */
  id: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(200),
  taskType: z.enum(TASK_TYPES),
  scenario: z.enum(EVIDENCE_SCENARIOS),
  skillNodeIds: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  targetWords: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  teacherUtteranceZh: z.string().trim().min(1).max(500),
  demonstrationText: z.string().max(500),
  requiresPronunciationAssessment: z.boolean(),
  requiresAsr: z.boolean(),
  assessment: z.object({
    acceptedImageIds: z.array(z.string().max(200)).max(100).default([]),
    acceptedTexts: z.array(z.string().max(1000)).max(100).default([]),
    requiredPhrases: z.array(z.string().max(1000)).max(100).default([]),
    openResponse: z.boolean().default(false),
  }),
  difficulty: z.number().int().min(1).max(5),
  /** 本活动需要的图片；单词图、短句图、场景图分开描述。 */
  imageRequirements: z.array(cefrImageRequirementSchema).max(10).default([]),
  media: z.object({
    /** 语音预热键；与 lesson.id 一致，便于按课程回填。 */
    speechKey: z.string().trim().min(1).max(160),
    /** 整轮合成文本（教师话语 + 示范），不得超过 500 字符 / 150 汉字。 */
    speechText: z.string().trim().min(1).max(500),
    imageKeys: z.array(z.string().max(160)).max(10).default([]),
  }),
});
export type CefrLesson = z.infer<typeof cefrLessonSchema>;

export const cefrUnitSchema = z.object({
  code: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  order: z.number().int().min(0).max(10000),
  objectives: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
  vocabulary: z.array(cefrVocabularyEntrySchema).min(1).max(100),
  patterns: z.array(z.object({
    en: z.string().trim().min(1).max(300),
    zh: z.string().max(300).default(''),
  })).max(30).default([]),
  lessons: z.array(cefrLessonSchema).min(1).max(100),
});
export type CefrUnit = z.infer<typeof cefrUnitSchema>;

export const cefrCurriculumLevelContentSchema = z.object({
  code: cefrCurriculumLevelSchema,
  nameZh: z.string().trim().min(1).max(80),
  canDo: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
  units: z.array(cefrUnitSchema).min(1).max(100),
});
export type CefrCurriculumLevelContent = z.infer<typeof cefrCurriculumLevelContentSchema>;

export const cefrCurriculumPackageSchema = z.object({
  schemaVersion: z.literal(2),
  packageId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  source: z.enum(['preset', 'textbook', 'package']),
  generatedAt: z.string().datetime(),
  levels: z.array(cefrCurriculumLevelContentSchema).min(1).max(7),
}).superRefine((curriculum, ctx) => {
  const seenLevels = new Set<string>();
  for (const [levelIndex, level] of curriculum.levels.entries()) {
    if (seenLevels.has(level.code)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['levels', levelIndex, 'code'], message: '课程等级不能重复' });
    }
    seenLevels.add(level.code);
    const seenUnits = new Set<string>();
    for (const [unitIndex, unit] of level.units.entries()) {
      if (seenUnits.has(unit.code)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['levels', levelIndex, 'units', unitIndex, 'code'], message: '单元编码不能重复' });
      }
      seenUnits.add(unit.code);
      for (const [lessonIndex, lesson] of unit.lessons.entries()) {
        const codePoints = Array.from(lesson.media.speechText);
        const cjk = codePoints.filter((char) => /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char)).length;
        if (cjk > 150 || codePoints.length > 500) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['levels', levelIndex, 'units', unitIndex, 'lessons', lessonIndex, 'media', 'speechText'],
            message: `第 ${lessonIndex + 1} 个活动语音超限（汉字/全角=${cjk}/150，字符=${codePoints.length}/500）`,
          });
        }
      }
    }
  }
});
export type CefrCurriculumPackage = z.infer<typeof cefrCurriculumPackageSchema>;

export const curriculumWordListRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  level: z.string().trim().min(1).max(24),
  words: z.union([
    z.string().max(50000),
    z.array(z.string().trim().min(1).max(100)).max(1000),
  ]),
  unitSize: z.number().int().min(3).max(20).default(6),
  useAi: z.boolean().default(true),
  persist: z.boolean().default(true),
});
export type CurriculumWordListRequest = z.infer<typeof curriculumWordListRequestSchema>;

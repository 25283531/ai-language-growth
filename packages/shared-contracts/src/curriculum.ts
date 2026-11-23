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

/** 活动可产生的证据类型；翻译/被动听读只能是 none。 */
export const ACTIVITY_EVIDENCE_KINDS = [
  'listening_comprehension',
  'reading_comprehension',
  'production',
  'pronunciation',
  'transfer',
  'none',
] as const;
export type ActivityEvidenceKind = (typeof ACTIVITY_EVIDENCE_KINDS)[number];

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
  /** 需要预热的图片需求（不是实际 URL）。 */
  image: cefrImageRequirementSchema.optional(),
  /** 已解析的图片资产；存在时必须带 HTTPS URL 与 license。 */
  imageAsset: z.object({
    url: z.string().url().max(2048),
    // 结构层允许空值，由自动校验给出可定位的 license_missing；
    // 这样不会把“缺授权”笼统报成 schema_invalid。
    license: z.string().trim().max(300).default(''),
    attribution: z.string().trim().max(500).optional(),
  }).optional(),
});
export type CefrVocabularyEntry = z.infer<typeof cefrVocabularyEntrySchema>;

/** 学校英语轨模块；A/B 偏字母与识读，C/D 偏阅读与语法，E 偏综合运用。 */
export const TEXTBOOK_MODULES = ['A', 'B', 'C', 'D', 'E'] as const;
export const textbookModuleSchema = z.enum(TEXTBOOK_MODULES);
export type TextbookModule = z.infer<typeof textbookModuleSchema>;

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
  /** 本活动声明的掌握证据类型；无证据的被动听读必须为 none。 */
  evidenceKind: z.enum(ACTIVITY_EVIDENCE_KINDS).optional(),
  /** 显式声明纯被动听读：允许没有可判定答案，但不得产生掌握证据。 */
  passiveReading: z.boolean().optional(),
  /** 学校轨活动所属模块；语言轨活动不设置。 */
  schoolModule: textbookModuleSchema.optional(),
  /**
   * 复习形态。
   *
   * `read_aloud`：课文原句/重点词跟读。复习轮保留目标文本（孩子照着读），
   * 不按“无提示回忆”清空 targetWords，否则客户端会只剩空卡片。
   */
  reviewMode: z.enum(['read_aloud']).optional(),
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

/**
 * 课文逐句契约。
 *
 * id 由单元编码与序号生成（如 `u03-s01`）；超长句二次切分时，派生句通过
 * splitFrom 指向保留原 id 的首句，避免编辑后无法追溯来源。
 */
export const passageSentenceSchema = z.object({
  id: z.string().trim().min(1).max(80),
  en: z.string().trim().min(1).max(500),
  zh: z.string().trim().min(1).max(500),
  /** 整句音标（P1）；能逐词查到音标时才拼，查不全时为空，客户端不展示。 */
  phonetic: z.string().max(400).optional(),
  /** 本句对应的教材 learning_items 行主键；无对应条目时不下发。 */
  learningItemId: z.string().trim().min(1).max(160).optional(),
  keyWords: z.array(z.string().trim().min(1).max(100)).max(12).default([]),
  grammarIds: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
  schoolModules: z.array(textbookModuleSchema).max(5).default([]),
  audio: z.object({
    /** 正常语速（1.0）片段的稳定键，不含课程版本。 */
    normalKey: z.string().trim().min(1).max(160).optional(),
    /** 慢速（0.65）片段的稳定键，不含课程版本。 */
    slowKey: z.string().trim().min(1).max(160).optional(),
    /** 正常语速音频地址；预热完成前为空，客户端应按需合成兜底。 */
    normalRef: z.string().max(2048).optional(),
    /** 慢速音频地址；预热完成前为空。 */
    slowRef: z.string().max(2048).optional(),
    normalSpeed: z.number().min(0.25).max(4).optional(),
    slowSpeed: z.number().min(0.25).max(4).optional(),
    durationMs: z.number().int().positive().optional(),
    normalDurationMs: z.number().int().positive().optional(),
    slowDurationMs: z.number().int().positive().optional(),
  }).optional(),
  /** 超长句被切分时，指向原句 id；普通句不设置。 */
  splitFrom: z.string().trim().min(1).max(80).optional(),
});
export type PassageSentence = z.infer<typeof passageSentenceSchema>;

export const grammarPointSchema = z.object({
  id: z.string().trim().min(1).max(80),
  pattern: z.string().trim().min(1).max(300),
  titleZh: z.string().trim().min(1).max(200),
  explanationZh: z.string().trim().min(1).max(1000),
  examples: z.array(z.object({
    en: z.string().trim().min(1).max(500),
    zh: z.string().trim().max(500).default(''),
  })).min(1).max(10),
  commonErrorZh: z.string().trim().max(500).default(''),
  sentenceIds: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  /** 建议阶段，仅用于内容提示，不是解锁条件。 */
  stage: z.number().int().min(0).max(6).optional(),
  schoolModule: textbookModuleSchema.optional(),
});
export type GrammarPoint = z.infer<typeof grammarPointSchema>;

export const passageSchema = z.object({
  title: z.string().trim().min(1).max(200),
  paragraphs: z.array(z.object({
    sentences: z.array(passageSentenceSchema).min(1).max(30),
  })).min(1).max(20),
});
export type Passage = z.infer<typeof passageSchema>;

/** 重点词拆读片段种类，顺序即教学顺序：整词 → 音节 → 音素 → 合成 → 自然语速。 */
export const FOCUS_WORD_CLIP_KINDS = ['word', 'syllable', 'phoneme', 'blend', 'natural'] as const;
export type FocusWordClipKind = (typeof FOCUS_WORD_CLIP_KINDS)[number];

/** 双速音频档位；extra_slow 只用于音素级拆读。 */
export const AUDIO_SPEED_TIERS = ['normal', 'slow', 'extra_slow'] as const;
export type AudioSpeedTier = (typeof AUDIO_SPEED_TIERS)[number];

/** 一个可直接播放的重点词拆读片段。 */
export const focusWordClipSchema = z.object({
  key: z.string().trim().min(1).max(160),
  kind: z.enum(FOCUS_WORD_CLIP_KINDS),
  /** 同一 kind 内的序号；音节/音素按此排序。 */
  partIndex: z.number().int().min(0).default(0),
  /** 播放顺序；从 0 开始。 */
  position: z.number().int().min(0).default(0),
  speedTier: z.enum(AUDIO_SPEED_TIERS),
  speed: z.number().min(0.25).max(4),
  text: z.string().min(1).max(500),
  audioRef: z.string().max(2048).nullable().default(null),
  durationMs: z.number().int().positive().nullable().default(null),
  status: z.enum(['ready', 'failed', 'stale']).default('ready'),
});
export type FocusWordClip = z.infer<typeof focusWordClipSchema>;

/** 重点词慢速拆读包：客户端按 clips 顺序播放并高亮当前单位。 */
export const focusWordAudioSchema = z.object({
  word: z.string().trim().min(1).max(100),
  phonetic: z.string().max(100).default(''),
  /** P2 词性（来自词库）；单元词条无词性时为空。 */
  pos: z.string().max(40).default(''),
  meaningZh: z.string().max(200).default(''),
  /** P2 例句：优先取单元词条自带的中英对照，最多 3 条。 */
  examples: z.array(z.object({ en: z.string().max(300), zh: z.string().max(300).default('') })).max(3).default([]),
  /** 变形（复数/过去式等）；词库无记录时为空。 */
  forms: z.array(z.string().max(60)).max(6).default([]),
  /** 中文语音讲解稿（词性 + 含义 + 变形规则 + 例句），客户端合成后播放。 */
  explanation: z.string().max(600).default(''),
  syllables: z.array(z.string().max(100)).max(30).default([]),
  difficultPhonemes: z.array(z.string().max(100)).max(30).default([]),
  /** 为什么选这个词（课文复现/多音节/困难音素），供管理端解释。 */
  reason: z.string().max(200).default(''),
  /** 本词对应的教材 learning_items 行主键；无对应条目时不下发。 */
  learningItemId: z.string().trim().min(1).max(160).optional(),
  clips: z.array(focusWordClipSchema).max(80).default([]),
});
export type FocusWordAudio = z.infer<typeof focusWordAudioSchema>;

/**
 * 开课下发的课文教学包。
 *
 * 在课文契约上追加音频地址与重点词拆读；旧客户端可完全忽略该字段，
 * 仍按原活动播放示范文本（P2-04 兼容要求）。
 */
export const curriculumPassageSchema = passageSchema.extend({
  unitId: z.string().min(1).max(160),
  topicId: z.string().min(1).max(160),
  contentVersion: z.string().min(1).max(128),
  /** 是否至少有一句已经完成双速预热；未完成不影响文本下发。 */
  audioReady: z.boolean().default(false),
  focusWords: z.array(focusWordAudioSchema).max(4).default([]),
  /** 语法讲解：用课文例句讲本单元的语法点。 */
  grammar: z.array(z.object({
    id: z.string().max(80).default(''),
    title: z.string().max(200).default(''),
    pattern: z.string().max(300).default(''),
    explanation: z.string().max(1000).default(''),
    commonError: z.string().max(500).default(''),
    examples: z.array(z.object({ en: z.string().max(300), zh: z.string().max(300).default('') })).max(3).default([]),
  })).max(3).default([]),
});
export type CurriculumPassage = z.infer<typeof curriculumPassageSchema>;

/** 教材单元资源包；活动仍复用现有 CefrLesson 契约。 */
export const textbookUnitContentSchema = z.object({
  resourceType: z.literal('textbook_unit'),
  textbook: z.object({
    publisher: z.string().trim().min(1).max(100),
    grade: z.string().trim().min(1).max(50),
    volume: z.string().trim().min(1).max(50),
    edition: z.string().trim().max(50).optional(),
  }),
  unit: z.object({
    code: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(200),
    order: z.number().int().min(0),
  }),
  objectives: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  passage: passageSchema,
  grammarPoints: z.array(grammarPointSchema).max(6).default([]),
  vocabulary: z.array(cefrVocabularyEntrySchema).max(60).default([]),
  activities: z.array(cefrLessonSchema).min(1).max(60),
  schoolTrack: z.object({
    modules: z.array(textbookModuleSchema).default([]),
    activities: z.array(cefrLessonSchema).max(30).default([]),
  }).optional(),
  stageHint: z.number().int().min(0).max(6).optional(),
  qcReport: z.record(z.unknown()).optional(),
});
export type TextbookUnitContent = z.infer<typeof textbookUnitContentSchema>;

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

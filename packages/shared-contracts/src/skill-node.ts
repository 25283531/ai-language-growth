/**
 * 能力节点契约。
 *
 * 依据：D-006「学习者智能引擎：核心资产，自主开发」；
 *      任务书第 4 章「能力结构」与「能力之间有依赖关系」。
 *
 * skill_nodes 是全平台最重要的数据资产之一：它描述「能力是什么及其前置知识」。
 * 编码一经发布即视为稳定契约，M2 只增不改。
 */
import { z } from 'zod';
import { EVIDENCE_SCENARIOS } from './evidence';
import { ABILITY_CATEGORIES, DEPENDENCY_TYPES, GROWTH_STAGES, VOCABULARY_DIMENSIONS } from './learner';

/**
 * 能力节点编码规则：`<track>.<DOMAIN>.<slug>`。
 *
 * 例：`LA.LISTEN.greeting_core`（语言习得轨 · 听力 · 问候核心）
 *     `SE.SCHOOL.phonics`（学校英语轨 · 自然拼读）
 *
 * 采用三段式而非「category.skill」两段式，理由：
 *  1. 轨（LA/SE）必须显式可见 —— D-002 要求双轨并行且进度独立，
 *     编码里能直接看出一个能力属于哪条轨，便于审计「双轨被混为一谈」。
 *  2. 域段（LISTEN/PRON/VOCAB/GRAM/SPEAK/COMM/SCHOOL）与
 *     ABILITY_CATEGORIES 一一对应，可在不改 slug 的前提下扩展域内能力。
 *  3. slug 段可自由命名，不影响前两段的稳定性。
 *
 * 编码一经发布即视为稳定契约，M2 只增不改。
 */
export const skillNodeCodeSchema = z
  .string()
  .regex(
    /^(LA|SE)\.(LISTEN|PRON|VOCAB|GRAM|SPEAK|COMM|SCHOOL)\.[a-z0-9_]+$/,
    '能力节点编码格式应为 <LA|SE>.<DOMAIN>.<slug>',
  );

export type SkillNodeCode = z.infer<typeof skillNodeCodeSchema>;


/** 能力节点定义。落库表：skill_nodes。 */
export const skillNodeSchema = z.object({
  id: z.string(),
  code: skillNodeCodeSchema,
  name: z.string(),
  abilityCategory: z.enum(ABILITY_CATEGORIES),
  /** 该节点所处的成长阶段 */
  growthStage: z.number().int().min(0).max(6),
  /** 双轨归属 */
  track: z.enum(['language_acquisition', 'school_english']),
  /** 该能力可评估的维度（词汇类能力有五层，其余单一维度） */
  dimensions: z.array(z.enum(VOCABULARY_DIMENSIONS)).default([]),
  /** 教学目标描述 */
  objective: z.string(),
  /** 达成的判定说明（引用 mastery 规则） */
  masteryCriteria: z.string(),
  /** 是否属于 M1 首批交付范围 */
  m1Scope: z.boolean().default(false),
});

export type SkillNode = z.infer<typeof skillNodeSchema>;

/** 能力依赖关系。落库表：skill_dependencies。 */
export const skillDependencySchema = z.object({
  id: z.string(),
  /** 依赖方（后者） */
  skillNodeId: z.string(),
  /** 被依赖方（前者） */
  dependsOnSkillNodeId: z.string(),
  dependencyType: z.enum(DEPENDENCY_TYPES),
  /** 依赖权重：required 表示未达成会阻塞教学，optional 表示仅参考 */
  required: z.boolean().default(true),
});

export type SkillDependency = z.infer<typeof skillDependencySchema>;

/** 课程主题。 */
export const topicSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  /** 主题涉及的能力节点 */
  skillNodeIds: z.array(z.string()),
  /** 建议起始阶段 */
  growthStage: z.number().int().min(0).max(6),
  /** 是否属于 M1 三主题 */
  m1Scope: z.boolean().default(false),
});

export type Topic = z.infer<typeof topicSchema>;

/** 词汇知识条目。知识层结构化数据（任务书第 10 章）。 */
export const vocabularyItemSchema = z.object({
  id: z.string(),
  /** 所属主题 */
  topicId: z.string(),
  word: z.string(),
  /** 国际音标 */
  phonetic: z.string(),
  /** 音节切分 */
  syllables: z.array(z.string()).min(1),
  /** 中文释义 */
  meaningZh: z.string(),
  /** 图片资源引用 */
  imageRef: z.string().nullable().default(null),
  /** 常见搭配 */
  collocations: z.array(z.string()).default([]),
  /** 简单例句 */
  exampleSentences: z.array(
    z.object({
      en: z.string(),
      zh: z.string(),
    }),
  ),
  /** 发音难点音素 */
  difficultPhonemes: z.array(z.string()).default([]),
  /** 关联能力节点 */
  skillNodeIds: z.array(z.string()).default([]),
  /** 相关词汇 */
  relatedWords: z.array(z.string()).default([]),
});

export type VocabularyItem = z.infer<typeof vocabularyItemSchema>;

/** 句型知识条目。 */
export const sentencePatternSchema = z.object({
  id: z.string(),
  topicId: z.string(),
  pattern: z.string(),
  zh: z.string(),
  examples: z.array(
    z.object({
      en: z.string(),
      zh: z.string(),
    }),
  ),
  skillNodeIds: z.array(z.string()).default([]),
});

export type SentencePattern = z.infer<typeof sentencePatternSchema>;

/** 教学活动定义：教学层数据。 */
export const teachingActivitySchema = z.object({
  id: z.string(),
  topicId: z.string(),
  /** 任务类型 */
  taskType: z.enum([
    'image_identification',
    'listening_comprehension',
    'word_mimicry',
    'pronunciation_drill',
    'phrase_assembly',
    'sentence_pattern',
    'situational_dialogue',
    'reading_story',
    'free_response',
  ]),
  /**
   * 场景：交际情境，而非媒体形式。
   *
   * 与证据契约 EVIDENCE_SCENARIOS 共用同一枚举 —— 教学活动的场景会直接写入
   * learning_evidence.scenario（该列有外键指向 scenarios.code）。
   * 早期版本用 audio_prompt / image_prompt 等「媒体形式」值，
   * 既无法通过外键，也无法支撑「两个不同场景独立使用」的迁移判定。
   */
  scenario: z.enum(EVIDENCE_SCENARIOS),
  /** 目标能力节点 */
  skillNodeIds: z.array(z.string()).min(1),
  /** 涉及的目标词 */
  targetWords: z.array(z.string()).default([]),
  /** 已发布课程图片的缓存引用；缓存完成后通过服务端地址跨用户复用。 */
  imageAssets: z.array(z.object({
    id: z.string(),
    ref: z.string(),
    sourceUrl: z.string().url().optional(),
    targetWord: z.string().optional(),
  })).optional(),
  /** 英文示范文本 */
  demonstrationText: z.string().nullable().default(null),
  /** 中文引导语 */
  teacherUtteranceZh: z.string(),
  /** 是否需要语音评估 */
  requiresPronunciationAssessment: z.boolean().default(false),
  /** 是否需要 ASR */
  requiresAsr: z.boolean().default(false),
  /**
   * 任务答案配置。课程内容由 AI 辅助生成时可以先保存草稿，
   * 只有配置了可验证答案并通过人工审核后，活动才应发布。
   */
  assessment: z.object({
    /** 点选题允许的图片资源 id；通常第一项是题目要求的正确选项。 */
    acceptedImageIds: z.array(z.string().trim().min(1)).default([]),
    /** 文字/ASR 题允许的完整答案（大小写、标点由服务端归一化）。 */
    acceptedTexts: z.array(z.string().trim().min(1)).default([]),
    /** 文字/ASR 题必须出现的词组；适合句型填充和开放句型。 */
    requiredPhrases: z.array(z.string().trim().min(1)).default([]),
    /** 是否允许任意非空表达；只用于 free_response 等确实没有固定答案的活动。 */
    openResponse: z.boolean().default(false),
  }).default({
    acceptedImageIds: [],
    acceptedTexts: [],
    requiredPhrases: [],
    openResponse: false,
  }),
  /** 难度 1-3 */
  difficulty: z.number().int().min(1).max(3).default(1),
  /** 该活动的顺序权重 */
  order: z.number().int().min(0).default(0),
  /** 是否属于 M1 首批交付 */
  m1Scope: z.boolean().default(false),
});

export type TeachingActivity = z.infer<typeof teachingActivitySchema>;

export { GROWTH_STAGES, ABILITY_CATEGORIES, DEPENDENCY_TYPES };

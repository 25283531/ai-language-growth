/**
 * 发音评估的音素级反馈契约。
 *
 * 依据：DECISIONS.md D-013 追加条款、D-004 追加条款（音素先行）、D-008（语音 API 管音频事实）。
 *
 * 现状说明：讯飞 ISE 适配器（packages/ai-provider-sdk/src/iflytek-ise.ts）已经把
 * 返回结果解析成 word / syllable / phoneme 三级单元，每个单元带 score、correct、
 * detail（错读、漏读、增读等判定）。本契约把这层结构化事实固定下来，
 * 供教师编排器生成「具体哪一环扣分」的反馈，也供证据层记录 errorUnits。
 *
 * ⚠️ 阈值（通过分、音节/音素合格线）一律不进本文件，仍由 assessment_thresholds 表决定，
 *    且维持当前未标定状态（见「尚未决定事项」）。
 */
import { z } from 'zod';

/** 评估粒度。与评测请求的 granularity 对应。 */
export const PRONUNCIATION_GRANULARITIES = ['word', 'syllable', 'phoneme'] as const;
export type PronunciationGranularity = (typeof PRONUNCIATION_GRANULARITIES)[number];

/** 单元类型。pitch/rhythm 为超音段问题，不参与音素最小对立对分析。 */
export const PRONUNCIATION_UNIT_KINDS = ['word', 'syllable', 'phoneme', 'pitch', 'rhythm'] as const;
export type PronunciationUnitKind = (typeof PRONUNCIATION_UNIT_KINDS)[number];

/**
 * 单元级错误原因（与供应商 dp_message 语义对齐的中性枚举）。
 * unknown 用于供应商未给出可识别原因的情况，不得据此编造原因。
 */
export const PRONUNCIATION_ERROR_REASONS = [
  'mispronounced', // 错读
  'omitted', // 漏读
  'inserted', // 增读
  'unclear', // 含糊/不清晰
  'unknown', // 供应商未给出原因
] as const;
export type PronunciationErrorReason = (typeof PRONUNCIATION_ERROR_REASONS)[number];

/** 一个被评估的单元。 */
export const pronunciationUnitSchema = z.object({
  /** 单元文本：词、音节或音素（如 'hello' / 'loʊ' / 'l'） */
  text: z.string(),
  kind: z.enum(PRONUNCIATION_UNIT_KINDS),
  /** 0–100 */
  score: z.number().min(0).max(100).nullable().default(null),
  correct: z.boolean(),
  /** 供应商细项（错读/漏读/增读等），无可识别原因时为 null */
  detail: z.string().nullable().default(null),
  /** 归一化原因；无法判定时为 unknown */
  reason: z.enum(PRONUNCIATION_ERROR_REASONS).default('unknown'),
  /** 该音素在词中的位置（从 0 开始），非音素单元为 null */
  phonemeIndex: z.number().int().min(0).nullable().default(null),
});

export type PronunciationUnit = z.infer<typeof pronunciationUnitSchema>;

/**
 * 最小对立对（minimal pair）目标。
 *
 * 例：/l/-/r/、/θ/-/s/、/æ/-/e/。它服务于「音素先行」阶段，
 * 让反馈说清「错在哪个音、和哪个音混了」，而不只是给一个总分。
 */
export const minimalPairTargetSchema = z.object({
  /** 目标音素，IPA */
  target: z.string(),
  /** 易混音素，IPA */
  contrast: z.string(),
  /** 示例词对：[目标音词, 对比音词] */
  exampleWords: z.tuple([z.string(), z.string()]),
  /** 中文提示，供教师口语化解释时使用（不是给孩子直接念 IPA） */
  hintZh: z.string().nullable().default(null),
});

export type MinimalPairTarget = z.infer<typeof minimalPairTargetSchema>;

/** 一次评测的完整结构化结果。 */
export const pronunciationAssessmentSchema = z.object({
  /** 总分 0–100 */
  score: z.number().min(0).max(100).nullable().default(null),
  /** 是否被供应商判为无效录音（如静音、噪音） */
  rejected: z.boolean().default(false),
  /** 三级单元明细，未通过的子集用于生成反馈与证据 */
  units: z.array(pronunciationUnitSchema).default([]),
  /** 命中的最小对立对（若该目标词配置了音素教学点） */
  minimalPairs: z.array(minimalPairTargetSchema).default([]),
  /** 供应商与模型标识，便于追溯（不含密钥） */
  providerAlias: z.string().nullable().default(null),
  latencyMs: z.number().int().min(0).nullable().default(null),
});

export type PronunciationAssessment = z.infer<typeof pronunciationAssessmentSchema>;

/**
 * 给孩子听的口头反馈契约。
 *
 * 由文本模型基于上面的结构化事实生成；模型不可用时回退到确定性文案，
 * 两种情况都不得编造未发生的进步（见 D-005 与 pronunciation-coach 服务）。
 */
export const pronunciationCoachingSchema = z.object({
  /** 比上一次进步了什么；首次尝试时为本次表现描述 */
  progress: z.string(),
  /** 这次具体改哪里、怎么改 */
  advice: z.string(),
  /** 鼓励与再次邀请 */
  encouragement: z.string(),
  /** 客户端朗读与展示的合并文本 */
  displayText: z.string(),
  /** 是否来自文本模型 */
  fromModel: z.boolean(),
});

export type PronunciationCoaching = z.infer<typeof pronunciationCoachingSchema>;

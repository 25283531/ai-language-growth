/**
 * 每日重听与巩固（Replay / Consolidation）契约。
 *
 * 依据：DECISIONS.md D-031（每日重听机制）、D-007（七步闭环）、D-005（次日证据）、
 * 研究依据：Raviv et al., Science 2026, DOI 10.1126/science.aeh9311
 * ——「每天结束时重听一小部分最近几天的语音」是母语习得模型能切出音素单位并
 *    认出反复出现词的必要条件；本项目只借鉴「重听」这一机制，不照搬量级。
 *
 * ⚠️ 本文件是 M0 契约骨架：只定义结构与不变量，不包含选取/排序算法实现。
 *    重听队列的选取逻辑必须留在后端（D-024 约束一），客户端只负责播放与采集。
 */
import { z } from 'zod';
import { TASK_TYPES } from './evidence';

/**
 * 重听出现在一堂课的哪个位置。
 *
 * - lesson_open：上一节课开头，重听「昨天/最近几天」的新词与语音（听 + 轻跟读）
 * - lesson_close：本课结尾，重听当天新词并做快速回忆，作为课后记忆写入前的巩固
 */
export const REPLAY_SLOTS = ['lesson_open', 'lesson_close'] as const;
export type ReplaySlot = (typeof REPLAY_SLOTS)[number];

/**
 * 重听条目的来源。选取顺序由后端决定，客户端不得自行挑选内容。
 */
export const REPLAY_SOURCES = [
  'yesterday_new_item', // 昨天新学、尚未跨天回忆
  'recent_failed_item', // 最近没读准、需要再暴露
  'recent_new_item', // 最近几天新学（密度补足）
  'today_new_item', // 当天新学（课尾巩固）
] as const;
export type ReplaySource = (typeof REPLAY_SOURCES)[number];

/** 轻量回忆的形态：先重听（呈现同样输入），再回忆，不是一上来就考试。 */
export const RECALL_MODES = [
  'listen_only', // 只重听，不要求作答
  'listen_repeat', // 重听 + 跟读（发音评估可选）
  'listen_recall', // 重听遮住后回忆：听音选图 / 说出该词
] as const;
export type RecallMode = (typeof RECALL_MODES)[number];

/** 回忆结果。只记录事实，不改掌握状态（状态由 evidence + 规则决定）。 */
export const RECALL_OUTCOMES = ['recalled', 'partially_recalled', 'not_recalled', 'skipped'] as const;
export type RecallOutcome = (typeof RECALL_OUTCOMES)[number];

/** 单个重听条目。 */
export const replayItemSchema = z.object({
  /** 稳定的重听条目 id，用于幂等与结果回填 */
  id: z.string(),
  learningItemId: z.string(),
  /** 目标文本（词/短语），客户端只读展示与播放 */
  targetText: z.string(),
  /** 关联的能力节点，用于把回忆结果写成证据 */
  skillNodeId: z.string(),
  source: z.enum(REPLAY_SOURCES),
  recallMode: z.enum(RECALL_MODES),
  /** 建议播放次数；0 表示仅回忆不播放 */
  listenTimes: z.number().int().min(0).max(5).default(1),
  /** 该项已获得的重听次数（跨课累计），用于控制暴露密度 */
  exposureCount: z.number().int().min(0).default(0),
  /** 首次学习时间（ISO），用于计算「隔天」是否成立 */
  firstLearnedAt: z.string().datetime().nullable().default(null),
  /** 是否具备次日证据资格：只有隔天回忆成功才可支撑状态晋级（D-005 追加条款） */
  countsForNextDayPromotion: z.boolean().default(false),
});

export type ReplayItem = z.infer<typeof replayItemSchema>;

/** 一次重听队列。 */
export const replayQueueSchema = z.object({
  learnerId: z.string(),
  lessonSessionId: z.string(),
  slot: z.enum(REPLAY_SLOTS),
  /** 队列条目，顺序由后端定，客户端按序执行 */
  items: z.array(replayItemSchema),
  /** 本次队列允许的总时长上限（秒），由学习者重听量参数决定 */
  budgetSeconds: z.number().int().min(0).max(600),
  /** 队列生成所用规则版本，便于事后复算 */
  ruleVersion: z.string(),
  createdAt: z.string().datetime(),
});

export type ReplayQueue = z.infer<typeof replayQueueSchema>;

/** 客户端回填的单条重听结果。 */
export const replayResultSchema = z.object({
  replayItemId: z.string(),
  outcome: z.enum(RECALL_OUTCOMES),
  /** 回忆环节的作答任务类型；listen_only 时为 null */
  taskType: z.enum(TASK_TYPES).nullable().default(null),
  /** 发音得分（若该项带跟读评估） */
  score: z.number().min(0).max(100).nullable().default(null),
  /** 是否在无提示条件下完成 */
  independent: z.boolean().default(false),
  /** 客户端本地时间，服务端以服务端时间为准落库 */
  answeredAt: z.string().datetime(),
});

export type ReplayResult = z.infer<typeof replayResultSchema>;

/**
 * 重听 → 巩固的产出。
 *
 * consolidationApplied 为 true 时才允许把「课后批量写入交互记忆」当作已完成，
 * 保证 D-031 的「写入前先执行一次当日重听巩固」不可被跳过。
 */
export const consolidationOutcomeSchema = z.object({
  lessonSessionId: z.string(),
  slot: z.enum(REPLAY_SLOTS),
  /** 覆盖的条目数 */
  itemCount: z.number().int().min(0),
  /** 其中成功的条数（含 partially） */
  recalledCount: z.number().int().min(0),
  /** 本次新增的次日证据候选 id（并非直接改状态） */
  nextDayEvidenceIds: z.array(z.string()).default([]),
  /** 是否允许继续课后记忆写入 */
  consolidationApplied: z.boolean(),
  completedAt: z.string().datetime(),
});

export type ConsolidationOutcome = z.infer<typeof consolidationOutcomeSchema>;

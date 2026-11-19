/**
 * 七领域阶段画像契约。
 *
 * 依据：任务书 §10.1「阶段不是关卡」、§10.4「阶段画像按领域独立计算」。
 *
 * 关键约束：
 *  1. 阶段只用于展示与规划参考，不是访问控制。
 *  2. 听力、发音、词汇、语法、口语、交流、学校英语七条线分别计算；
 *     一条线低不得拉低其他线。
 *  3. 每个领域优先取 `masteryCode >= forming` 的最高节点阶段；
 *     若没有形成中的节点，才回退到 `encountered`；都没有则为 0。
 */
import { z } from 'zod';
import type { AbilityCategory } from './learner';

export const STAGE_PROFILE_DOMAINS = [
  'listening',
  'pronunciation',
  'vocabulary',
  'grammar',
  'speaking',
  'communication',
  'schoolEnglish',
] as const;

export type StageProfileDomain = (typeof STAGE_PROFILE_DOMAINS)[number];

export const STAGE_PROFILE_DOMAIN_LABELS: Record<StageProfileDomain, string> = {
  listening: '听力',
  pronunciation: '发音',
  vocabulary: '词汇',
  grammar: '语法',
  speaking: '口语',
  communication: '交流',
  schoolEnglish: '学校英语',
};

/**
 * 能力分类 → 阶段画像领域。
 *
 * 学校英语单列，避免把 SE.SCHOOL.* 的学习进度混进语言习得轨。
 */
export const ABILITY_CATEGORY_TO_STAGE_DOMAIN: Record<AbilityCategory, StageProfileDomain> = {
  listening: 'listening',
  pronunciation: 'pronunciation',
  vocabulary: 'vocabulary',
  grammar: 'grammar',
  speaking: 'speaking',
  communication: 'communication',
  school_english: 'schoolEnglish',
};

const stageValueSchema = z.number().int().min(0).max(6);

export const stageProfileSchema = z.object({
  learnerId: z.string().min(1),
  stages: z.object({
    listening: stageValueSchema,
    pronunciation: stageValueSchema,
    vocabulary: stageValueSchema,
    grammar: stageValueSchema,
    speaking: stageValueSchema,
    communication: stageValueSchema,
    schoolEnglish: stageValueSchema,
  }),
  /**
   * 当前展示阶段上各领域的节点数。用于解释「阶段 2 / 8 个节点」，
   * 不代表该领域只有这些节点。
   */
  stageNodeCounts: z.record(z.number().int().min(0)),
  /** 各领域累计证据条数（只读聚合，不用于晋级判定）。 */
  evidenceCounts: z.record(z.number().int().min(0)),
  computedAt: z.string().datetime(),
});

export type StageProfile = z.infer<typeof stageProfileSchema>;

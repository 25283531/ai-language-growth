/**
 * CEFR 参考档位与头像解锁契约 —— 由后端确定性推导，客户端只展示。
 *
 * 依据：
 *  - DECISIONS.md D-003：CEFR Pre-A1 为零基础起点，A1 为第一阶段综合能力参照；
 *    档位是能力参照，不是固定月份的考试等级或时间承诺。
 *  - DECISIONS.md D-024 约束一：教学逻辑与客户端分离。档位 / 解锁数由后端计算后在
 *    dashboard 返回；Web / Android 不得自行推导，也不得在客户端保存解锁状态。
 *  - DECISIONS.md D-005 / D-010 与 evidence.ts：本模块**不修改** mastery 判定、
 *    不写 learning_evidence、不写库、不改阈值；只读 dashboard 已有的 abilities 与
 *    append-only 证据做展示层派生。
 *
 * 【映射规则（唯一权威）】
 *  CATEGORIES = ABILITY_CATEGORIES 的 7 项；缺失类别按 stage=0 补齐。
 *  S          = Σ clamp(stage_i, 0, 4)                       // S ∈ [0, 28]
 *  currentTier= clamp(floor(S / 2), 0, 14)
 *  level      = CEFR_BUCKETS[tier]  // 档位 0-2 Pre-A1 | 3-5 A1 | 6-8 A2 | 9-11 B1 | 12-14 B2
 *  extrasUnlocked = min(2 * ceil(tier / 3), 10)
 *  unlockedCount  = 24 + extrasUnlocked
 *  头像总数 TOTAL = 34：24 个基础头像（b00..b23）从档位 0 起全部可用，
 *  10 个 3D 头像（d00..d09）每 3 档解锁 2 个，5 步解锁完。
 *  分段锚点：tier 0 → 24；1–3 → 26；4–6 → 28；7–9 → 30；10–12 → 32；13–14 → 34。
 *
 * 【单调保护（必须）】
 *  learning_evidence 是 append-only，只累计 succeeded 证据；按 EVIDENCE_PER_STAGE
 *  把每类累计成功证据折算成 0–4 的历史阶段，得到 historicalS，再按同一 floor(S/2)
 *  规则得到 historicalTier。
 *  avatarTier = max(currentTier, historicalTier)。
 *  由于证据只增不减，historicalTier 单调不减；能力状态回落时不会重新锁定已解锁头像。
 *  客户端不存任何解锁状态，纯推导、幂等。
 *
 * 【是否要求 calibrated】
 *  **不要求**，且这是刻意的。后端所有阈值写入均为 `uncalibrated`
 *  （seed.ts 固定 m1_provisional / uncalibrated；learner-model.service.ts 用
 *  input.threshold.calibrationStatus；orchestrator / speech 多处字面量 uncalibrated），
 *  dashboard 的 `calibrated` 实际恒为 false。若把它作为解锁开关，一个头像都解锁不了。
 *  calibrated 只用于 `provisional` / `displayLabel` 的展示措辞，不参与档位或解锁判定。
 *  未校准时展示「参考档位 · 未校准 · 不代表掌握」，禁止「已掌握」「等级达成」类表述。
 *  未来阈值校准完成后如需提高门槛，应新增版本化规则，不在本轮改动判定。
 *
 * 【边界处理】
 *  - 未知 / 重复类别：未知忽略；重复取 stage 最大值、calibrated 取或值；缺失补 0。
 *  - stage 越界 / NaN / ±Infinity / 小数 / 字符串：转数值后向下取整并夹到 [0,4]；非法值归 0。
 *  - 空 abilities / 空 evidence：全 0 → tier 0 / Pre-A1 / unlocked 24（基础头像全开）。
 *  - tier 14（最高）：next 为 null、progress=1、unlockedCount=34（10 个 3D 头像全部解锁）。
 *  - 档位表单调：S 只增不减时 tier 不回退（有单测保证）。
 *  - 整个模块是纯函数：同输入恒同输出，无 Date / Math.random / IO / DB / 网络。
 *
 * 【avatarUrl 契约】
 *  本地头像使用 `preset://` 资源标识（不满足通用 .url() 校验），外链使用 http(s)://。
 *  isValidAvatarUrl 供后端 PUT /user/profile 复用的字段名仍是 avatarUrl，
 *  不改数据库 schema、不加 migration。
 */
import { z } from 'zod';
import { ABILITY_CATEGORIES } from './learner';

/** CEFR 参考档位全集；当前 tier 0–14 只映射到前 5 档，C1/C2 不在本轮映射范围。 */
export const CEFR_LEVELS = ['pre_a1', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];
export const cefrLevelSchema = z.enum(CEFR_LEVELS);

export const CEFR_LEVEL_LABELS: Record<CefrLevel, string> = {
  pre_a1: 'Pre-A1',
  a1: 'A1',
  a2: 'A2',
  b1: 'B1',
  b2: 'B2',
  c1: 'C1',
  c2: 'C2',
};

/**
 * 头像库规模与解锁曲线（用户裁定：24 个基础头像可随意选择，10 个 3D 升级后解锁）。
 *   AVATAR_BASE_COUNT = 24   b00..b23，tier 0 起全部可用
 *   AVATAR_EXTRA_COUNT = 10  d00..d09，每 3 档解锁 2 个，5 步解锁完
 *   extrasUnlocked = min(2 * ceil(tier / 3), 10)
 *   unlockedCount  = 24 + extrasUnlocked
 */
export const AVATAR_BASE_COUNT = 24;
export const AVATAR_EXTRA_COUNT = 10;
export const AVATAR_TOTAL = AVATAR_BASE_COUNT + AVATAR_EXTRA_COUNT; // 34
/** tier 0 起基础头像全部可用，不再有「初始只开 8 个」的旧曲线。 */
export const AVATAR_BASE_UNLOCKED = AVATAR_BASE_COUNT; // 24
/** 每 AVATAR_TIER_PER_STEP 档解锁 AVATAR_EXTRA_PER_STEP 个 3D 头像。 */
export const AVATAR_EXTRA_PER_STEP = 2;
export const AVATAR_TIER_PER_STEP = 3;
/** 3D 头像解锁所需步数：10 / 2 = 5。 */
export const AVATAR_EXTRA_STEPS = AVATAR_EXTRA_COUNT / AVATAR_EXTRA_PER_STEP;
export const AVATAR_TIER_MAX = 14;

/**
 * 34 个头像的稳定顺序（与设计侧 AvatarCatalog 一致）：
 * [preset://b00..b23, preset://d00..d09]，3D 排在最后作为高阶奖励。
 * unlockedCount 表示前 N 个可用；历史长写法 preset://avatar/basic_NN 等仍可被
 * isValidAvatarUrl 接受，并已由客户端做兼容映射，但不作为本契约的规范顺序。
 */
export const AVATAR_ORDER: readonly string[] = Object.freeze([
  ...Array.from({ length: AVATAR_BASE_COUNT }, (_, index) =>
    `preset://b${String(index).padStart(2, '0')}`),
  ...Array.from({ length: AVATAR_EXTRA_COUNT }, (_, index) =>
    `preset://d${String(index).padStart(2, '0')}`),
]);

/** tier → CEFR 档位：0-2 Pre-A1 | 3-5 A1 | 6-8 A2 | 9-11 B1 | 12-14 B2。 */
export const CEFR_BUCKETS: readonly CefrLevel[] = Object.freeze([
  'pre_a1', 'pre_a1', 'pre_a1',
  'a1', 'a1', 'a1',
  'a2', 'a2', 'a2',
  'b1', 'b1', 'b1',
  'b2', 'b2', 'b2',
]);

/** 历史累计折算：每类每 6 条成功证据折算 1 个阶段（0–4）。 */
export const EVIDENCE_PER_STAGE = 6;

/** 恒定的免责说明；客户端展示档位时必须原样可见。 */
export const CEFR_LEVEL_NOTICE =
  '参考档位由服务端按能力阶段推导；能力阈值未经真实儿童样本校准，仅供教学参考，不代表掌握，也不是官方 CEFR 认证或考试等级。客户端不得把参考档位表述为掌握结论或等级达成结论。';

/** 未校准时的档位展示措辞（禁止写成掌握 / 达成）。 */
export const CEFR_DISPLAY_UNCALIBRATED = '参考档位 · 未校准 · 不代表掌握';
export const CEFR_DISPLAY_CALIBRATED = '参考档位';

const HTTP_AVATAR_URL_PATTERN = /^https?:\/\/\S+$/i;
const PRESET_AVATAR_URL_PATTERN = /^preset:\/\/[a-z0-9][a-z0-9/_-]{0,200}$/i;

/** avatarUrl 允许 http(s):// 外链或 preset:// 本地资源标识；空值不允许。 */
export function isValidAvatarUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (HTTP_AVATAR_URL_PATTERN.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return PRESET_AVATAR_URL_PATTERN.test(trimmed);
}

/** 推导输入：dashboard.abilities 元素的最小子集（多余字段忽略）。 */
export interface CefrAbilityInput {
  category: string;
  stage: number;
  calibrated?: boolean;
}

/** 历史累计输入：learning_evidence 行的最小子集。 */
export interface CefrEvidenceInput {
  abilityCategory?: string | null;
  succeeded?: boolean | null;
}

export interface AvatarNextTier {
  tier: number | null;
  level: CefrLevel | null;
  label: string | null;
  unlockedCount: number | null;
  /** 升到「下一档」时新增的头像数：新曲线下为 0 或 2。 */
  additionalUnlocks: number;
  /** 下一个真正会新增头像的档位；全部解锁后为 null。 */
  unlockAhead: { tier: number; inTiers: number; additional: number } | null;
  /** 0–1，按「达到下一档所需 S」的达成比例。 */
  progress: number;
  progressPercent: number;
  requirements: { requiredSumStage: number; missingSumStage: number } | null;
  condition: string;
  reward: { type: 'avatar_unlock'; count: number } | null;
}

export interface AvatarLevelProgress {
  current: CefrLevel;
  label: string;
  /** 客户端展示档位时必须使用的措辞。 */
  displayLabel: string;
  levelIndex: number;
  avatarTier: number;
  currentTier: number;
  historicalTier: number;
  /** 恒为 true：avatarTier 取两者最大值，降级不重新锁定。 */
  monotonic: true;
  unlockedCount: number;
  totalCount: number;
  /** 基础头像数（tier 0 起全部可用）：24。 */
  baseUnlockedCount: number;
  /** 已解锁的 3D 头像数：0–10。 */
  extrasUnlocked: number;
  /** 3D 头像总数：10。 */
  extrasTotal: number;
  /** 每 AVATAR_TIER_PER_STEP 档新增 AVATAR_EXTRA_PER_STEP 个 3D 头像：2 / 3。 */
  extrasPerStep: number;
  tierPerStep: number;
  /** 阈值未校准（任一类别未校准即为 true）。 */
  provisional: boolean;
  basis: {
    categoryCount: number;
    sumStage: number;
    maxSumStage: number;
    historicalSumStage: number;
    effectiveSumStage: number;
    calibratedCategories: number;
    succeededEvidenceCount: number;
  };
  next: AvatarNextTier;
  notice: string;
}

export interface AvatarLevelResult {
  /** dashboard 顶层 level：CEFR 字符串，仅展示。 */
  level: CefrLevel;
  /** dashboard 顶层 avatarTier：整数 0–14，解锁计数。 */
  avatarTier: number;
  /** dashboard 顶层 unlockedCount：8–34。 */
  unlockedCount: number;
  /** dashboard 顶层 levelProgress：下一档条件 / 进度 / 依据 / 免责说明。 */
  progress: AvatarLevelProgress;
}

const KNOWN_CATEGORIES = new Set<string>(ABILITY_CATEGORIES);
const MAX_STAGE = 4;

function clampStage(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(MAX_STAGE, Math.max(0, Math.floor(numeric)));
}

function clampTier(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(AVATAR_TIER_MAX, Math.max(0, Math.floor(value)));
}

/** 新曲线：每 AVATAR_TIER_PER_STEP 档解锁 AVATAR_EXTRA_PER_STEP 个 3D 头像，封顶 10。 */
function extrasForTier(tier: number): number {
  const steps = Math.ceil(Math.max(0, tier) / AVATAR_TIER_PER_STEP);
  return Math.min(AVATAR_EXTRA_PER_STEP * steps, AVATAR_EXTRA_COUNT);
}

/** 下一个真正会新增头像的档位（严格大于当前档位）；3D 头像全部解锁后返回 null。 */
function nextUnlockAhead(
  tier: number,
): { tier: number; inTiers: number; additional: number } | null {
  const current = extrasForTier(tier);
  for (let candidate = tier + 1; candidate <= AVATAR_TIER_MAX; candidate += 1) {
    const extras = extrasForTier(candidate);
    if (extras > current) {
      return { tier: candidate, inTiers: candidate - tier, additional: extras - current };
    }
  }
  return null;
}

/**
 * 纯函数：由 dashboard 的 abilities 与 append-only learning_evidence 推导
 * CEFR 参考档位、头像解锁档位与下一档进度。零 DB / 零网络 / 零时间依赖，不修改入参。
 */
export function deriveAvatarLevel(
  abilities: readonly CefrAbilityInput[] | null | undefined,
  evidence: readonly CefrEvidenceInput[] | null | undefined = [],
): AvatarLevelResult {
  const byCategory = new Map<string, { stage: number; calibrated: boolean }>();
  for (const category of ABILITY_CATEGORIES) byCategory.set(category, { stage: 0, calibrated: false });

  for (const ability of abilities ?? []) {
    if (!ability || typeof ability.category !== 'string' || !KNOWN_CATEGORIES.has(ability.category)) continue;
    const stage = clampStage(ability.stage);
    const existing = byCategory.get(ability.category)!;
    byCategory.set(ability.category, {
      stage: Math.max(existing.stage, stage),
      calibrated: existing.calibrated || ability.calibrated === true,
    });
  }

  const normalized = [...byCategory.values()];
  const categoryCount = normalized.length;
  const sumStage = normalized.reduce((sum, item) => sum + item.stage, 0);
  const maxSumStage = categoryCount * MAX_STAGE;
  const calibratedCategories = normalized.filter((item) => item.calibrated).length;

  // 历史累计：learning_evidence 只 INSERT，成功证据数单调不减。
  const evidenceCounts = new Map<string, number>();
  let succeededEvidenceCount = 0;
  for (const row of evidence ?? []) {
    if (!row || row.succeeded !== true) continue;
    const category = typeof row.abilityCategory === 'string' ? row.abilityCategory : '';
    if (!KNOWN_CATEGORIES.has(category)) continue;
    succeededEvidenceCount += 1;
    evidenceCounts.set(category, (evidenceCounts.get(category) ?? 0) + 1);
  }
  const historicalSumStage = ABILITY_CATEGORIES.reduce((sum, category) => {
    const count = evidenceCounts.get(category) ?? 0;
    return sum + clampStage(Math.floor(count / EVIDENCE_PER_STAGE));
  }, 0);

  const currentTier = clampTier(sumStage / 2);
  const historicalTier = clampTier(historicalSumStage / 2);
  const avatarTier = Math.max(currentTier, historicalTier);
  const effectiveSumStage = Math.max(sumStage, historicalSumStage);
  const level = CEFR_BUCKETS[avatarTier] ?? 'pre_a1';
  const extrasUnlocked = extrasForTier(avatarTier);
  const unlockedCount = AVATAR_BASE_UNLOCKED + extrasUnlocked;
  const provisional = calibratedCategories < categoryCount;

  const nextTier = avatarTier < AVATAR_TIER_MAX ? avatarTier + 1 : null;
  let next: AvatarNextTier;
  if (nextTier === null) {
    next = {
      tier: null,
      level: null,
      label: null,
      unlockedCount: null,
      additionalUnlocks: 0,
      unlockAhead: null,
      progress: 1,
      progressPercent: 100,
      requirements: null,
      condition: '已达最高参考档位，暂无下一档；34 个头像已全部解锁。',
      reward: null,
    };
  } else {
    const requiredSumStage = nextTier * 2;
    const missingSumStage = Math.max(0, requiredSumStage - effectiveSumStage);
    const progress = Math.max(0, Math.min(1, effectiveSumStage / requiredSumStage));
    const nextLevel = CEFR_BUCKETS[nextTier] ?? 'pre_a1';
    const nextUnlocked = AVATAR_BASE_UNLOCKED + extrasForTier(nextTier);
    const additionalUnlocks = Math.max(0, nextUnlocked - unlockedCount);
    // 新曲线下并非每档都新增头像（每 3 档才 +2），因此额外给出下一个真正解锁的档位。
    const ahead = nextUnlockAhead(avatarTier);
    const label = CEFR_LEVEL_LABELS[nextLevel];
    const requirementText = `再升一级到档位 ${nextTier}（${label}）需：7 类能力阶段合计达到 ${requiredSumStage}（当前 ${effectiveSumStage}，还差 ${missingSumStage}）`;
    const condition = additionalUnlocks > 0
      ? `${requirementText}，可再解锁 ${additionalUnlocks} 个头像。`
      : ahead
        ? `${requirementText}；本档不新增头像，再升 ${ahead.inTiers} 档（档位 ${ahead.tier}）可解锁 ${ahead.additional} 个头像。`
        : `${requirementText}；3D 头像已全部解锁。`;
    next = {
      tier: nextTier,
      level: nextLevel,
      label,
      unlockedCount: nextUnlocked,
      additionalUnlocks,
      unlockAhead: ahead,
      progress,
      progressPercent: Math.round(progress * 100),
      requirements: { requiredSumStage, missingSumStage },
      condition,
      reward: additionalUnlocks > 0 ? { type: 'avatar_unlock', count: additionalUnlocks } : null,
    };
  }

  return {
    level,
    avatarTier,
    unlockedCount,
    progress: {
      current: level,
      label: CEFR_LEVEL_LABELS[level],
      displayLabel: provisional ? CEFR_DISPLAY_UNCALIBRATED : CEFR_DISPLAY_CALIBRATED,
      levelIndex: CEFR_LEVELS.indexOf(level),
      avatarTier,
      currentTier,
      historicalTier,
      monotonic: true,
      unlockedCount,
      totalCount: AVATAR_TOTAL,
      baseUnlockedCount: AVATAR_BASE_UNLOCKED,
      extrasUnlocked,
      extrasTotal: AVATAR_EXTRA_COUNT,
      extrasPerStep: AVATAR_EXTRA_PER_STEP,
      tierPerStep: AVATAR_TIER_PER_STEP,
      provisional,
      basis: {
        categoryCount,
        sumStage,
        maxSumStage,
        historicalSumStage,
        effectiveSumStage,
        calibratedCategories,
        succeededEvidenceCount,
      },
      next,
      notice: CEFR_LEVEL_NOTICE,
    },
  };
}

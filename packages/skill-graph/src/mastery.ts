/**
 * 掌握状态判定规则（规则引擎版）。
 *
 * 依据：DECISIONS.md D-005「掌握状态：五种状态，必须有证据」；
 *      V1.1 任务书第 4 章「掌握判定的硬规则」。
 *
 * 规则编号 R1–R7（评审确定，M0 定版）：
 *  R1 单次证据不得跨两级晋级（首条证据最多到 encountered）
 *  R2 独立成功计独立样本；提示下的成功计入 forming，不计独立样本
 *  R3 至少 N 条独立成功证据方可到达 mastered
 *  R4 至少 2 个不同场景独立成功 + 跨天（≥24h）无提示回忆方可到达 transferred
 *  R5 llm_judgement 来源证据不得单独构成晋级依据，且可信度上限 0.4
 *  R6 回归封顶：跌破 mastered 后，同场景独立成功上限为 forming，
 *     须补齐 ≥2 个不同场景且含 ≥1 次跨天无提示回忆才能回到 mastered
 *  R7 不做自动遗忘衰减；遗忘通过 review_schedules 复习调度处理
 *
 * ⚠️ 所有阈值来自 assessment_thresholds 表（M1 全部 uncalibrated），
 *    代码中不得硬编码业务阈值。
 */
import {
  MASTERY_RANK,
  MASTERY_STATE_BY_CODE,
  MASTERY_STATE_CODES,
  type AssessmentThreshold,
  type LearningEvidence,
  type MasteryState,
} from '@alg/shared-contracts';

/** 能力状态的内存表示。 */
export interface MasteryStateView {
  masteryState: MasteryState;
  evidenceIds: string[];
  independentScenarios: string[];
  lastUnpromptedRecallAt: string | null;
  lastIndependentUseAt: string | null;
  updatedAt: string;
}

/** 判定输入：能力状态 + 证据流 + 阈值。 */
export interface MasteryEvaluationInput {
  currentState: MasteryState;
  /** 该能力节点的全部历史证据，按时间升序 */
  evidence: LearningEvidence[];
  /** 阈值配置 */
  threshold: AssessmentThreshold;
  /** 评估时刻 */
  now?: Date;
}

export interface MasteryEvaluationResult {
  state: MasteryState;
  /** 本次评估导致的迁移（无迁移则为 null） */
  transition: {
    from: MasteryState;
    to: MasteryState;
    evidenceIds: string[];
    reason: string;
  } | null;
  /** 判定依据说明，用于审计与可解释性 */
  rationale: string[];
}

/** 证据是否「独立完成」。与 prompted 严格区分：答错时 independent 为 false。 */
export function isIndependent(evidence: LearningEvidence): boolean {
  return !evidence.prompted && evidence.succeeded;
}

/**
 * 证据是否构成「无提示回忆」。
 * 复习场次与评估场次不计入，避免重复练习造成的假阳性。
 */
export function isUnpromptedRecall(evidence: LearningEvidence): boolean {
  return (
    isIndependent(evidence) &&
    evidence.scenario !== 'review_scene' &&
    evidence.scenario !== 'assessment_scene'
  );
}

/**
 * 证据是否具备推高状态的资格。
 * R5：llm_judgement 来源不得单独构成晋级依据。
 */
export function canPromote(evidence: LearningEvidence): boolean {
  return evidence.contributesToPromotion && evidence.source !== 'llm_judgement';
}

/** 状态编码转换。 */
export function toCode(state: MasteryState): 0 | 1 | 2 | 3 | 4 {
  return MASTERY_STATE_CODES[state];
}

export function fromCode(code: number): MasteryState {
  return MASTERY_STATE_BY_CODE[code as 0 | 1 | 2 | 3 | 4] ?? 'not_exposed';
}

/**
 * 掌握状态判定主函数。
 *
 * 纯函数、无副作用，可对历史证据重放。
 * 评估规则升级后用历史证据重新计算状态，不丢失记录（D-005）。
 */
export function evaluateMastery(input: MasteryEvaluationInput): MasteryEvaluationResult {
  const { currentState, threshold } = input;
  const rationale: string[] = [];

  const successful = input.evidence
    .filter((e) => e.succeeded)
    .filter((e) => e.contributesToPromotion)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  if (successful.length === 0) {
    rationale.push('无有效成功证据，状态维持');
    return { state: currentState, transition: null, rationale };
  }

  const independent = successful.filter(isIndependent);
  const independentScenarios = Array.from(new Set(independent.map((e) => e.scenario)));

  // —— 计算「已达成的最高等级」——
  let candidate: MasteryState = 'not_exposed';
  let evidenceIds: string[] = [];

  // R1：单次证据最多到 encountered
  const firstSuccessful = successful[0];
  if (firstSuccessful) {
    candidate = 'encountered';
    evidenceIds = [firstSuccessful.id];
    rationale.push(`R1：已有 ${successful.length} 条成功证据，进入 encountered`);
  }

  // R2 + forming 判定：含提示的成功也可计入 forming
  if (successful.length >= threshold.minSamplesForming) {
    candidate = 'forming';
    evidenceIds = successful.slice(0, threshold.minSamplesForming).map((e) => e.id);
    rationale.push(`R2：成功证据 ${successful.length} ≥ ${threshold.minSamplesForming}，进入 forming`);
  }

  // R3：mastered 需要至少 N 条独立成功证据
  const masterCandidates = independent.filter((e) => canPromote(e));
  if (masterCandidates.length >= threshold.minSamplesMastered) {
    candidate = 'mastered';
    evidenceIds = masterCandidates.slice(0, threshold.minSamplesMastered).map((e) => e.id);
    rationale.push(
      `R3：独立成功 ${masterCandidates.length} ≥ ${threshold.minSamplesMastered}，进入 mastered`,
    );
  }

  // R4：transferred 需要 ≥2 个不同场景独立成功 + 跨天无提示回忆。
  //
  // 跨天间隔必须从「第 N 个不同场景首次成立」开始计算，而不是从历史第一条
  // 证据开始。否则一个几周前就有旧证据的学习者，今天只要在新场景回忆一次，
  // 就会仅凭旧证据的时间差被误判为 transferred。
  const scenarioFirstAt = new Map<string, number>();
  for (const item of masterCandidates) {
    const at = new Date(item.occurredAt).getTime();
    if (!Number.isFinite(at)) continue;
    const previous = scenarioFirstAt.get(item.scenario);
    if (previous === undefined || at < previous) scenarioFirstAt.set(item.scenario, at);
  }
  const scenarioReadyTimes = Array.from(scenarioFirstAt.values()).sort((a, b) => a - b);
  const transferReadyAt = scenarioReadyTimes.length >= threshold.minScenariosTransferred
    ? scenarioReadyTimes[threshold.minScenariosTransferred - 1]!
    : null;
  const transferScenarios = new Set(masterCandidates.map((e) => e.scenario));
  const recalls = successful
    .filter(isUnpromptedRecall)
    .filter((e) => canPromote(e))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const transferRecall = transferReadyAt === null
    ? undefined
    : recalls.find((item) => {
        const recallAt = new Date(item.occurredAt).getTime();
        return Number.isFinite(recallAt)
          && recallAt - transferReadyAt >= threshold.minIntervalTransferredMs;
      });

  if (transferReadyAt !== null && transferRecall) {
    candidate = 'transferred';
    evidenceIds = [
      ...masterCandidates.map((e) => e.id),
      transferRecall.id,
    ];
    rationale.push(
      `R4：${transferScenarios.size} 个不同场景独立使用；第 ${threshold.minScenariosTransferred} 个场景成立后 ` +
        `${Math.round((new Date(transferRecall.occurredAt).getTime() - transferReadyAt) / 86400000)} 天出现无提示回忆，进入 transferred`,
    );
  } else if (transferReadyAt !== null) {
    rationale.push(
      `R4：场景数 ${transferScenarios.size} 达标，但尚未出现「第 ${threshold.minScenariosTransferred} 个场景成立后 ` +
        `${threshold.minIntervalTransferredMs / 3600000} 小时」的无提示回忆，暂不进入 transferred`,
    );
  } else {
    rationale.push(
      `R4：独立场景 ${transferScenarios.size} < ${threshold.minScenariosTransferred}，或无跨天无提示回忆`,
    );
  }

  // —— R6：回归封顶 ——
  // 只有「最近一次失败晚于最近一次独立成功」才算跌破；不能因为历史证据
  // 集中在单一场景就把一个没有回归的 mastered 学习者降级。
  // 回归后：同场景独立成功上限为 forming；须补齐 ≥ N 个不同场景，且在第 N 个
  // 场景成立后出现 ≥1 次跨天无提示回忆，才允许回到 mastered/transferred。
  const orderedIndependent = [...masterCandidates]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const masteryEstablished = orderedIndependent[threshold.minSamplesMastered - 1];
  const latestFailure = [...input.evidence]
    .filter((item) => !item.succeeded)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .at(-1);
  // 只有失败发生在「首次达到 mastered 所需独立样本」之后，才算回归；
  // 失败后哪怕很快又成功一次，只要还没补齐多场景 + 跨天回忆，也不能立刻恢复。
  const regressed = Boolean(latestFailure && masteryEstablished) && (
    new Date(latestFailure!.occurredAt).getTime() > new Date(masteryEstablished!.occurredAt).getTime()
  );

  if (regressed && MASTERY_RANK[currentState] >= MASTERY_RANK.mastered) {
    const failureAt = new Date(latestFailure!.occurredAt).getTime();
    const postFailure = masterCandidates.filter(
      (item) => new Date(item.occurredAt).getTime() > failureAt,
    );
    const postFailureFirstAt = new Map<string, number>();
    for (const item of postFailure) {
      const at = new Date(item.occurredAt).getTime();
      if (!Number.isFinite(at)) continue;
      const previous = postFailureFirstAt.get(item.scenario);
      if (previous === undefined || at < previous) postFailureFirstAt.set(item.scenario, at);
    }
    const postFailureReadyTimes = Array.from(postFailureFirstAt.values()).sort((a, b) => a - b);
    const postFailureReadyAt = postFailureReadyTimes.length >= threshold.minScenariosTransferred
      ? postFailureReadyTimes[threshold.minScenariosTransferred - 1]!
      : null;
    const postFailureRecall = postFailureReadyAt === null
      ? undefined
      : recalls.find((item) => {
          const recallAt = new Date(item.occurredAt).getTime();
          return recallAt > failureAt
            && recallAt - postFailureReadyAt >= threshold.minIntervalTransferredMs;
        });

    if (!postFailureRecall) {
      candidate = 'forming';
      evidenceIds = postFailure.map((item) => item.id);
      rationale.push(
        `R6：最近一次失败后仅有 ${postFailureFirstAt.size} 个场景的独立成功，` +
          '且缺少跨天无提示回忆，封顶为 forming',
      );
    }
  }

  // R7：不做自动遗忘衰减（状态仅可因新证据上升或因 R6 封顶回落）
  const ranked = MASTERY_RANK[candidate];
  const currentRank = MASTERY_RANK[currentState];

  let finalState: MasteryState = currentState;
  if (ranked > currentRank) {
    finalState = candidate;
  } else if (candidate === 'forming' && currentState === 'mastered') {
    finalState = 'forming';
  }

  const transition =
    finalState === currentState
      ? null
      : {
          from: currentState,
          to: finalState,
          evidenceIds: Array.from(new Set(evidenceIds)),
          reason: rationale.join('；'),
        };

  return { state: finalState, transition, rationale };
}

/**
 * 快速路径：判定单条新证据能否立即推高状态。
 * 用于编排器避免每轮重放全量证据。
 */
export function canAdvanceOnEvidence(
  evidence: LearningEvidence,
  currentState: MasteryState,
  threshold: AssessmentThreshold,
): boolean {
  if (!evidence.succeeded) return false;
  if (!canPromote(evidence)) return false; // R5

  const currentRank = MASTERY_RANK[currentState];

  // R1：单条证据最多到 encountered
  if (currentRank >= MASTERY_RANK['encountered']) return false;

  // R2：有提示只能支撑到 forming
  if (evidence.prompted) {
    return currentRank < MASTERY_RANK['forming'];
  }
  return true;
}

export { MASTERY_STATES } from '@alg/shared-contracts';
export type { MasteryState };

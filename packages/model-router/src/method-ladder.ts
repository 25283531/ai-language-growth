/**
 * 教学方法阶梯（L0 确定性规则）。
 *
 * 依据：D-010「慢速耐心教学：产品差异化核心」——
 *      「孩子连续读错时，老师要换方法——换示范词、单独练困难音、调整速度、
 *        给口型提示——并允许多轮耐心陪练，而不是机械重复同一句话。」
 *
 * 关键设计（验收红线第三项：老师是否会真的会换方法）：
 *  - 换方法必须由本地规则驱动，**不允许 LLM 自由裁量**。
 *    否则无法客观验证「老师真的换了方法」，也无法回归测试。
 *  - 阶梯逐级加码，同一方法连续使用不超过 maxAttempts 次。
 *  - 最多陪练 5 轮；达到上限后不催促、不跳过，转入「示范并等待」，
 *    并把失败记录提交给 L2/L3 分析（升级信号 method_already_changed）。
 */
import { METHOD_LADDER, type MethodVariant } from '@alg/shared-contracts';

export { METHOD_LADDER };
export type { MethodVariant };

/** 阶梯配置。 */
export interface MethodLadderConfig {
  /** 同一方法最多连续使用次数 */
  maxAttemptsPerMethod: number;
  /** 最多陪练轮数（超过则停止催促，转入等待与升级） */
  maxPatienceRounds: number;
  /** 各方法的语速系数（乘以 teacher_speed） */
  speedFactor: Record<MethodVariant, number>;
  /** 各方法是否需要只练错误单元 */
  focusOnErrorOnly: Record<MethodVariant, boolean>;
}

export const DEFAULT_METHOD_LADDER_CONFIG: MethodLadderConfig = {
  maxAttemptsPerMethod: 2,
  maxPatienceRounds: 5,
  speedFactor: {
    method_slow_clear: 0.8,
    method_syllable_split: 0.7,
    method_phoneme_focus: 0.6,
    method_easy_exemplar: 0.9,
    method_lip_mouth_cue: 0.85,
    method_model_and_wait: 1.0,
  },
  focusOnErrorOnly: {
    method_slow_clear: false,
    method_syllable_split: true,
    method_phoneme_focus: true,
    method_easy_exemplar: false,
    method_lip_mouth_cue: false,
    method_model_and_wait: false,
  },
};

/** 阶梯状态。 */
export interface MethodLadderState {
  /** 当前使用的方法 */
  current: MethodVariant;
  /** 当前方法已连续使用次数 */
  attempts: number;
  /** 连续失败轮数 */
  consecutiveFailures: number;
  /** 已用过的方法序列 */
  history: MethodVariant[];
}

/** 初始状态。 */
export function initialMethodLadderState(): MethodLadderState {
  return {
    current: 'method_slow_clear',
    attempts: 0,
    consecutiveFailures: 0,
    history: [],
  };
}

/**
 * 根据本轮结果推进方法阶梯。
 *
 * @param passed 本轮是否达标（按任务级阈值判定）
 * @param errorUnits 本轮出错单元（用于定向练习）
 * @param state 当前阶梯状态
 */
export function advanceMethodLadder(input: {
  passed: boolean;
  state: MethodLadderState;
  config?: MethodLadderConfig;
}): {
  state: MethodLadderState;
  /** 本轮是否升级到 L2/L3 分析（连续失败超限） */
  needsEscalation: boolean;
  /** 是否已到耐心上限 */
  reachedPatienceLimit: boolean;
} {
  const config = input.config ?? DEFAULT_METHOD_LADDER_CONFIG;
  const state = input.state;

  if (input.passed) {
    // 达标：重置连续失败计数，方法回退到第一级（下次仍从慢速开始）
    return {
      state: {
        current: 'method_slow_clear',
        attempts: 0,
        consecutiveFailures: 0,
        history: [...state.history, state.current],
      },
      needsEscalation: false,
      reachedPatienceLimit: false,
    };
  }

  // 未达标
  const nextAttempts = state.attempts + 1;
  const consecutiveFailures = state.consecutiveFailures + 1;

  // 耐心上限：不催促、不跳过，停在最温和的方法上等待
  if (consecutiveFailures > config.maxPatienceRounds) {
    return {
      state: {
        current: 'method_model_and_wait',
        attempts: nextAttempts,
        consecutiveFailures,
        history: [...state.history, state.current],
      },
      needsEscalation: true,
      reachedPatienceLimit: true,
    };
  }

  // 同一方法用满次数 → 升到阶梯下一级
  if (nextAttempts >= config.maxAttemptsPerMethod) {
    const idx = METHOD_LADDER.indexOf(state.current);
    const lastIndex = METHOD_LADDER.length - 1;
    const nextMethod = METHOD_LADDER[Math.min(idx + 1, lastIndex)] ?? state.current;
    return {
      state: {
        current: nextMethod,
        attempts: 0,
        consecutiveFailures,
        history: [...state.history, state.current],
      },
      needsEscalation: false,
      reachedPatienceLimit: false,
    };
  }

  // 同一方法继续使用
  return {
    state: {
      current: state.current,
      attempts: nextAttempts,
      consecutiveFailures,
      history: [...state.history, state.current],
    },
    needsEscalation: false,
    reachedPatienceLimit: false,
  };
}

/**
 * 依据方法计算实际语速。
 * 语速始终以 teacher_speed 为基准乘以方法系数，不暴露厂商参数（D-014）。
 */
export function resolveTeacherSpeed(
  baseSpeed: number,
  method: MethodVariant,
  config: MethodLadderConfig = DEFAULT_METHOD_LADDER_CONFIG,
): number {
  const factor = config.speedFactor[method];
  return Math.max(0.25, Math.min(4, Number((baseSpeed * factor).toFixed(2))));
}

/**
 * 依据方法决定示范内容。
 * 定向练习方法只练出错的音节/音素，不要求整词盲目重读（D-010）。
 */
export function resolveDemonstration(input: {
  method: MethodVariant;
  /** 完整目标词 */
  targetWord: string;
  /** 该词的音节切分 */
  syllables: string[];
  /** 本轮出错的单元 */
  errorUnits: Array<{ unit: string; kind: string }>;
  config?: MethodLadderConfig;
}): {
  /** 实际示范文本 */
  demonstrationText: string;
  /** 需要高亮显示的单元 */
  focusUnits: string[];
  /** 是否只练错误部分 */
  focusOnErrorOnly: boolean;
} {
  const config = input.config ?? DEFAULT_METHOD_LADDER_CONFIG;
  const focusOnErrorOnly = config.focusOnErrorOnly[input.method];

  if (focusOnErrorOnly && input.errorUnits.length > 0) {
    const errorNames = input.errorUnits.map((u) => u.unit);
    // 只示范出错的音节/音素
    const focused = input.syllables.filter((s) => errorNames.some((n) => s.includes(n) || n.includes(s)));
    const demonstration = focused.length > 0 ? focused.join('-') : errorNames.join('-');
    return {
      demonstrationText: demonstration,
      focusUnits: errorNames,
      focusOnErrorOnly: true,
    };
  }

  if (input.method === 'method_syllable_split') {
    return {
      demonstrationText: input.syllables.join('-'),
      focusUnits: [],
      focusOnErrorOnly: false,
    };
  }

  return {
    demonstrationText: input.targetWord,
    focusUnits: [],
    focusOnErrorOnly: false,
  };
}

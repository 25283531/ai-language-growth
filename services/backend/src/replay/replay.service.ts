/**
 * 每日重听与巩固（Replay / Consolidation）模块 —— M0 骨架。
 *
 * 依据：DECISIONS.md D-031、D-007 追加条款；
 * 研究依据：Raviv et al., Science 2026, DOI 10.1126/science.aeh9311。
 *
 * 职责边界（硬约束）：
 *  - 选取哪些内容重听、按什么顺序、给几次暴露，全部由后端决定（D-024 约束一）。
 *  - 客户端只做三件事：播放、采集、把结果回填。
 *  - 重听结果不是「考试」，写成证据事件后仍由证据规则决定是否晋级（D-005）。
 *
 * 本文件只有接口与占位实现，M1 才接入学习者引擎与课程库。
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  ConsolidationOutcome,
  LearnerLearningParams,
  ReplayQueue,
  ReplayResult,
  ReplaySlot,
} from '@alg/shared-contracts';

export interface BuildReplayQueueInput {
  learnerId: string;
  lessonSessionId: string;
  slot: ReplaySlot;
  /** 学习者个性化节奏参数；缺省时使用未标定占位值 */
  params?: Pick<LearnerLearningParams, 'replayLoadPerNight'> | null;
  /** 当前课时已用时长（秒），用于课尾预算裁剪 */
  elapsedSeconds?: number;
}

export interface RecordReplayResultInput {
  learnerId: string;
  lessonSessionId: string;
  slot: ReplaySlot;
  results: ReplayResult[];
}

/**
 * 重听队列与巩固结果的服务端入口。
 *
 * ⚠️ M0 stub：所有方法只返回空结构并记录日志，不查库、不写证据、不改状态。
 */
@Injectable()
export class ReplayService {
  private readonly logger = new Logger(ReplayService.name);

  /**
   * 生成重听队列。
   *
   * M1 待实现的选取顺序（仅为约定，不是已实现逻辑）：
   *  1. yesterday_new_item：昨天新学、还没有跨天回忆记录的词
   *  2. recent_failed_item：最近 3 天发音未通过的词（含音素级未通过单元）
   *  3. recent_new_item：最近 2–3 天新学但暴露次数不足的词（密度补足）
   *  4. today_new_item：仅课尾使用，当天新学的词
   * 数量上限取 params.replayLoadPerNight，并按预算裁剪。
   */
  async buildQueue(input: BuildReplayQueueInput): Promise<ReplayQueue> {
    this.logger.debug(`[stub] buildQueue learner=${input.learnerId} slot=${input.slot}`);
    return {
      learnerId: input.learnerId,
      lessonSessionId: input.lessonSessionId,
      slot: input.slot,
      items: [],
      budgetSeconds: 0,
      ruleVersion: 'm0-stub',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 回填重听结果并产出巩固结果。
   *
   * M1 待实现：把每条结果写成 learning_evidence（facet=form，crossDay 由首次学习时间计算），
   * 课尾巩固完成前不允许执行课后交互记忆批量写入。
   */
  async recordResults(input: RecordReplayResultInput): Promise<ConsolidationOutcome> {
    this.logger.debug(
      `[stub] recordResults learner=${input.learnerId} slot=${input.slot} results=${input.results.length}`,
    );
    return {
      lessonSessionId: input.lessonSessionId,
      slot: input.slot,
      itemCount: input.results.length,
      recalledCount: 0,
      nextDayEvidenceIds: [],
      consolidationApplied: false,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * 课后记忆写入的前置检查。
   *
   * M0 恒为 false：巩固尚未实现，因此任何「已巩固」的断言都不成立，
   * 调用方必须据此保持课后记忆写入处于未启用状态（D-031）。
   */
  async isConsolidationApplied(lessonSessionId: string): Promise<boolean> {
    this.logger.debug(`[stub] isConsolidationApplied lessonSessionId=${lessonSessionId}`);
    return false;
  }
}

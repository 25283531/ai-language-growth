/**
 * ReplayModule —— 每日重听与巩固（M0 骨架，未接入教学闭环）。
 *
 * 依据：DECISIONS.md D-031；研究依据 Raviv et al., Science 2026, DOI 10.1126/science.aeh9311。
 *
 * 当前只导出 ReplayService（stub）。M1 接入时需要补齐：
 *  - 依赖 LearnerEngineService 读取最近学习项与发音未通过单元
 *  - 依赖 PrismaService 写 replay_sessions / learning_evidence
 *  - 在 OrchestratorService 的课程开始（lesson_open）与课程结束（lesson_close）
 *    两个位置插入队列执行，再把结果写回证据
 */
import { Module } from '@nestjs/common';
import { ReplayService } from './replay.service';

@Module({
  providers: [ReplayService],
  exports: [ReplayService],
})
export class ReplayModule {}

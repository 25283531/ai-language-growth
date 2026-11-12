/**
 * P1-3 家长周报聚合单测。
 *
 * 只测纯函数，不连数据库：
 *   - 空周仍然返回可渲染结构；
 *   - Asia/Shanghai 周一 00:00 的周边界；
 *   - 独立成功、待巩固、到期复习与下周建议；
 *   - 响应不携带原始音频、转写、供应商、成本或内部 id。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  buildWeeklyReport,
  ParentReportService,
  resolveReportWeek,
  type WeeklyReportSource,
} from '../src/reports/parent-report.service.ts';

const NOW = new Date('2026-11-12T04:00:00.000Z'); // 周四 12:00 Asia/Shanghai

function emptySource(): WeeklyReportSource {
  const week = resolveReportWeek(NOW);
  return {
    weekStart: week.weekStart,
    weekEnd: week.weekEndExclusive,
    now: NOW,
    sessions: [],
    evidence: [],
    priorIndependentSkillIds: new Set(),
    reviews: [],
    topicNames: {},
  };
}

describe('P1-3 周报聚合', () => {
  it('空周：返回零值、说明与可执行建议，不伪造内容', () => {
    const report = buildWeeklyReport(emptySource());
    assert.equal(report.hasData, false);
    assert.equal(report.weekStart, '2026-11-09');
    assert.equal(report.weekEnd, '2026-11-15');
    assert.equal(report.timezone, 'Asia/Shanghai');
    assert.deepEqual(report.summary, {
      sessions: 0,
      unfinishedSessions: 0,
      learningMinutes: 0,
      activeDays: 0,
      independentSuccesses: 0,
      coveredSkills: 0,
      durationKind: 'session_wall_clock',
    });
    assert.deepEqual(report.highlights, []);
    assert.deepEqual(report.needsPractice, []);
    assert.equal(report.reviews.dueCount, 0);
    assert.equal(report.reviews.nextDueAt, null);
    assert.ok(report.nextWeek.suggestions.some((item) => item.includes('还没有足够')));
    assert.match(report.calibrationNotice, /不构成能力结论/);
  });

  it('正常周：去重独立成功、封顶单节时长、聚合错音并给出待巩固项', () => {
    const week = resolveReportWeek(NOW);
    const report = buildWeeklyReport({
      ...emptySource(),
      weekStart: week.weekStart,
      weekEnd: week.weekEndExclusive,
      sessions: [
        {
          id: 's1',
          topicId: 'topic-farm',
          status: 'finished',
          startedAt: new Date('2026-11-09T01:00:00.000Z'),
          finishedAt: new Date('2026-11-09T01:12:00.000Z'),
        },
        {
          id: 's2',
          topicId: 'topic-school',
          status: 'finished',
          startedAt: new Date('2026-11-10T02:00:00.000Z'),
          finishedAt: new Date('2026-11-10T03:30:00.000Z'),
        },
        {
          id: 's3',
          topicId: 'topic-farm',
          status: 'active',
          startedAt: new Date('2026-11-11T02:00:00.000Z'),
          finishedAt: null,
        },
      ],
      evidence: [
        {
          id: 'e1',
          skillNodeId: 'skill-1',
          skillName: '音节拼读',
          abilityCategory: 'pronunciation',
          succeeded: true,
          independent: true,
          contributesToPromotion: true,
          source: 'classroom',
          errorUnits: [],
          occurredAt: new Date('2026-11-09T01:05:00.000Z'),
        },
        {
          id: 'e2',
          skillNodeId: 'skill-1',
          skillName: '音节拼读',
          abilityCategory: 'pronunciation',
          succeeded: true,
          independent: true,
          contributesToPromotion: true,
          source: 'classroom',
          errorUnits: [],
          occurredAt: new Date('2026-11-10T02:10:00.000Z'),
        },
        {
          id: 'e3',
          skillNodeId: 'skill-1',
          skillName: '音节拼读',
          abilityCategory: 'pronunciation',
          succeeded: true,
          independent: false,
          contributesToPromotion: true,
          source: 'classroom',
          errorUnits: [],
          occurredAt: new Date('2026-11-10T02:20:00.000Z'),
        },
        {
          id: 'e4',
          skillNodeId: 'skill-1',
          skillName: '音节拼读',
          abilityCategory: 'pronunciation',
          succeeded: false,
          independent: false,
          contributesToPromotion: true,
          source: 'classroom',
          errorUnits: [
            { unit: 'syllable', kind: 'syllable', detail: '重音位置' },
            { unit: 'syllable', kind: 'syllable', detail: '尾音' },
            { unit: 'phoneme', kind: 'phoneme', detail: '/θ/' },
          ],
          occurredAt: new Date('2026-11-10T02:30:00.000Z'),
        },
        {
          id: 'e5',
          skillNodeId: 'skill-2',
          skillName: '单词发音',
          abilityCategory: 'vocabulary',
          succeeded: false,
          independent: false,
          contributesToPromotion: true,
          source: 'classroom',
          errorUnits: [{ unit: 'word', kind: 'word', detail: 'apple' }],
          occurredAt: new Date('2026-11-11T02:30:00.000Z'),
        },
        {
          id: 'e6',
          skillNodeId: 'skill-3',
          skillName: '听力选择',
          abilityCategory: 'listening',
          succeeded: true,
          independent: true,
          contributesToPromotion: true,
          source: 'llm_judgement',
          errorUnits: [],
          occurredAt: new Date('2026-11-11T02:40:00.000Z'),
        },
      ],
      priorIndependentSkillIds: new Set(['skill-2']),
      reviews: [
        {
          skillNodeId: 'skill-2',
          skillName: '单词发音',
          dueAt: new Date('2026-11-10T01:00:00.000Z'),
          completedAt: null,
          intervalDays: 3,
        },
        {
          skillNodeId: 'skill-1',
          skillName: '音节拼读',
          dueAt: new Date('2026-11-20T01:00:00.000Z'),
          completedAt: null,
          intervalDays: 7,
        },
        {
          skillNodeId: 'skill-3',
          skillName: '听力选择',
          dueAt: new Date('2026-11-11T01:00:00.000Z'),
          completedAt: new Date('2026-11-11T02:00:00.000Z'),
          intervalDays: 3,
        },
      ],
      topicNames: { 'topic-farm': '农场动物', 'topic-school': '学校生活' },
    });

    assert.equal(report.hasData, true);
    assert.deepEqual(report.summary, {
      sessions: 2,
      unfinishedSessions: 1,
      learningMinutes: 72, // 12 分钟 + 90 分钟封顶 60 分钟
      activeDays: 2,
      independentSuccesses: 2, // 只计独立、非 llm_judgement 的成功
      coveredSkills: 3,
      durationKind: 'session_wall_clock',
    });
    assert.deepEqual(report.topics, [
      { name: '农场动物', sessions: 1 },
      { name: '学校生活', sessions: 1 },
    ]);
    assert.deepEqual(report.highlights, [
      { skillName: '音节拼读', abilityLabel: '发音', independentSuccesses: 2 },
    ]);

    const syllable = report.needsPractice.find((item) => item.skillName === '音节拼读');
    const word = report.needsPractice.find((item) => item.skillName === '单词发音');
    assert.ok(syllable);
    assert.equal(syllable.priorIndependentSuccess, false);
    assert.deepEqual(syllable.errorUnits, [
      { unit: 'syllable', count: 2 },
      { unit: 'phoneme', count: 1 },
    ]);
    assert.ok(word);
    assert.equal(word.priorIndependentSuccess, true);

    assert.equal(report.reviews.dueCount, 1);
    assert.equal(report.reviews.overdueCount, 1);
    assert.equal(report.reviews.nextDueAt, '2026-11-10T01:00:00.000Z');
    assert.deepEqual(report.reviews.items, [
      { skillName: '单词发音', dueAt: '2026-11-10T01:00:00.000Z' },
    ]);
    assert.ok(report.nextWeek.suggestions.some((item) => item.includes('先复习熟悉的例子')));
    assert.ok(report.nextWeek.suggestions.some((item) => item.includes('到期复习项')));
  });

  it('边界：Asia/Shanghai 周一 00:00 起算，周二/未来/过旧周被拒绝', () => {
    const mondayNow = new Date('2026-11-09T00:00:00+08:00');
    const week = resolveReportWeek(mondayNow);
    assert.equal(week.weekStart.toISOString(), '2026-11-08T16:00:00.000Z');
    assert.equal(week.weekEndExclusive.toISOString(), '2026-11-15T16:00:00.000Z');
    assert.equal(week.weekStartLabel, '2026-11-09');
    assert.equal(week.weekEndLabel, '2026-11-15');

    const requested = resolveReportWeek(NOW, '2026-11-09');
    assert.equal(requested.weekStart.toISOString(), week.weekStart.toISOString());
    assert.equal(
      resolveReportWeek(NOW, '2026-09-21').weekStartLabel,
      '2026-09-21',
      '最近第 8 周仍可查看',
    );

    for (const invalid of ['2026-11-10', '2026-09-14', '2026-11-16', '2026-02-31', 'not-a-date']) {
      assert.throws(
        () => resolveReportWeek(NOW, invalid),
        (error) => error instanceof BadRequestException && error.getStatus() === 400,
        `${invalid} 应被拒绝`,
      );
    }
  });

  it('隐私：不返回原始音频、转写、供应商、成本或内部 id', () => {
    const report = buildWeeklyReport(emptySource());
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      '"learnerId"',
      '"skillNodeId"',
      '"audioRef"',
      '"transcript"',
      '"providerAlias"',
      '"costCny"',
      '"masteryCode"',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `响应不得包含 ${forbidden}`);
    }
    assert.deepEqual(report.privacy, {
      includesRawAudio: false,
      includesTranscript: false,
      includesProviderData: false,
      includesInternalCost: false,
    });
  });
});

describe('P1-3 周报查询装配', () => {
  it('按学习者与自然周查询；空数据也返回可渲染结构', async () => {
    const calls: Array<{ table: string; args: any }> = [];
    const record = (table: string, rows: unknown[] = []) => async (args: unknown) => {
      calls.push({ table, args });
      return rows;
    };
    const prisma = {
      lesson_sessions: { findMany: record('lesson_sessions') },
      learning_evidence: { findMany: record('learning_evidence') },
      review_schedules: { findMany: record('review_schedules') },
      curriculum_units: { findMany: record('curriculum_units') },
      skill_nodes: { findMany: record('skill_nodes') },
    };
    const service = new ParentReportService(prisma as never);

    const report = await service.weekly('learner-1');

    assert.equal(report.hasData, false);
    assert.equal(report.timezone, 'Asia/Shanghai');
    const sessionCall = calls.find((call) => call.table === 'lesson_sessions');
    assert.ok(sessionCall);
    assert.equal(sessionCall.args.where.learnerId, 'learner-1');
    assert.ok(sessionCall.args.where.startedAt.gte instanceof Date);
    const evidenceCalls = calls.filter((call) => call.table === 'learning_evidence');
    assert.equal(evidenceCalls.length, 2, '本周证据 + 前 30 天独立成功基线');
    assert.ok(evidenceCalls.every((call) => call.args.where.learnerId === 'learner-1'));
    assert.ok(evidenceCalls.some((call) => call.args.where.source?.not === 'llm_judgement'));
  });
});

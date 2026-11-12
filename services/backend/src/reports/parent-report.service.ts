import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Curriculum } from '@alg/curriculum';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MAX_REPORT_WEEKS = 8;
const MAX_SESSION_MINUTES = 60;

const CALIBRATION_NOTICE =
  '周报只汇总课堂与练习记录，帮助家长了解本周学习节奏；它只是学习记录，不构成能力结论，也不替代老师对孩子真实水平的判断。';

const ABILITY_LABELS: Record<string, string> = {
  listening: '听力',
  pronunciation: '发音',
  vocabulary: '词汇',
  grammar: '语法',
  speaking: '口语',
  communication: '交流',
  school_english: '学校英语',
  reading: '阅读',
  writing: '书写',
};

type SessionInput = {
  id: string;
  topicId: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
};

type EvidenceInput = {
  id: string;
  skillNodeId: string;
  skillName: string;
  abilityCategory: string;
  succeeded: boolean;
  independent: boolean;
  contributesToPromotion: boolean;
  source: string;
  errorUnits: unknown;
  occurredAt: Date;
};

type ReviewInput = {
  skillNodeId: string;
  skillName: string;
  dueAt: Date;
  completedAt: Date | null;
  intervalDays: number;
};

export type WeeklyReportSource = {
  weekStart: Date;
  weekEnd: Date;
  now: Date;
  sessions: SessionInput[];
  evidence: EvidenceInput[];
  priorIndependentSkillIds: Set<string>;
  reviews: ReviewInput[];
  topicNames: Record<string, string>;
};

type Highlight = {
  skillName: string;
  abilityLabel: string;
  independentSuccesses: number;
};

type NeedsPractice = {
  skillName: string;
  abilityLabel: string;
  unsuccessfulAttempts: number;
  priorIndependentSuccess: boolean;
  errorUnits: Array<{ unit: string; count: number }>;
};

type ReviewItem = {
  skillName: string;
  dueAt: string;
};

export type WeeklyReport = {
  weekStart: string;
  weekEnd: string;
  timezone: 'Asia/Shanghai';
  hasData: boolean;
  summary: {
    sessions: number;
    unfinishedSessions: number;
    learningMinutes: number;
    activeDays: number;
    independentSuccesses: number;
    coveredSkills: number;
    durationKind: 'session_wall_clock';
  };
  topics: Array<{ name: string; sessions: number }>;
  highlights: Highlight[];
  needsPractice: NeedsPractice[];
  reviews: {
    dueCount: number;
    overdueCount: number;
    nextDueAt: string | null;
    items: ReviewItem[];
  };
  nextWeek: { suggestions: string[] };
  privacy: {
    includesRawAudio: false;
    includesTranscript: false;
    includesProviderData: false;
    includesInternalCost: false;
  };
  calibrationNotice: string;
};

type ResolvedWeek = {
  weekStart: Date;
  weekEndExclusive: Date;
  weekStartLabel: string;
  weekEndLabel: string;
  timezone: 'Asia/Shanghai';
};

function localDateKey(value: Date): string {
  return new Date(value.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function localWeekLabel(localMidnightMs: number): string {
  return new Date(localMidnightMs).toISOString().slice(0, 10);
}

function makeWeek(localMondayMs: number): ResolvedWeek {
  return {
    weekStart: new Date(localMondayMs - SHANGHAI_OFFSET_MS),
    weekEndExclusive: new Date(localMondayMs + 7 * DAY_MS - SHANGHAI_OFFSET_MS),
    weekStartLabel: localWeekLabel(localMondayMs),
    weekEndLabel: localWeekLabel(localMondayMs + 6 * DAY_MS),
    timezone: 'Asia/Shanghai',
  };
}

function currentWeek(now: Date): ResolvedWeek {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const dayOfWeek = new Date(Date.UTC(year, month, day)).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return makeWeek(Date.UTC(year, month, day - daysSinceMonday));
}

/**
 * 解析家长要查看的周。固定使用 Asia/Shanghai 时区、周一开始，
 * 默认本周，只允许最近 8 个自然周（含本周），避免翻出过旧记录。
 */
export function resolveReportWeek(now: Date, requestedWeekStart?: string): ResolvedWeek {
  const current = currentWeek(now);
  if (!requestedWeekStart?.trim()) return current;

  const value = requestedWeekStart.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BadRequestException('weekStart 必须为 YYYY-MM-DD 格式的周一');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localMidnight = Date.UTC(year, month - 1, day);
  const parsed = new Date(localMidnight);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new BadRequestException('weekStart 不是有效日期');
  }
  if (parsed.getUTCDay() !== 1) {
    throw new BadRequestException('weekStart 必须是周一');
  }

  const requested = makeWeek(localMidnight);
  if (requested.weekStart.getTime() > current.weekStart.getTime()) {
    throw new BadRequestException('不能查看未来周报');
  }
  const earliest = current.weekStart.getTime() - (MAX_REPORT_WEEKS - 1) * 7 * DAY_MS;
  if (requested.weekStart.getTime() < earliest) {
    throw new BadRequestException(`只能查看最近 ${MAX_REPORT_WEEKS} 周`);
  }
  return requested;
}

function abilityLabel(category: string): string {
  return ABILITY_LABELS[category] ?? '综合能力';
}

function isIndependentSuccess(row: EvidenceInput): boolean {
  return (
    row.succeeded &&
    row.independent &&
    row.contributesToPromotion &&
    row.source !== 'llm_judgement'
  );
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function readErrorUnits(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const units: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const unit = (entry as { unit?: unknown }).unit;
    if (typeof unit === 'string' && unit.trim()) units.push(unit.trim());
  }
  return units;
}

/**
 * 纯聚合函数：不访问数据库，便于单测覆盖空周、边界和隐私字段。
 */
export function buildWeeklyReport(input: WeeklyReportSource): WeeklyReport {
  const finishedSessions = input.sessions.filter(
    (session) => session.status === 'finished' && session.finishedAt !== null,
  );

  let learningMinutes = 0;
  for (const session of finishedSessions) {
    const elapsed = (session.finishedAt as Date).getTime() - session.startedAt.getTime();
    const minutes = Math.max(0, Math.floor(elapsed / 60000));
    learningMinutes += Math.min(MAX_SESSION_MINUTES, minutes);
  }

  const activeDays = new Set(finishedSessions.map((session) => localDateKey(session.startedAt)));
  const independentRows = input.evidence.filter(isIndependentSuccess);

  const highlightGroups = new Map<string, { skillName: string; abilityLabel: string; count: number }>();
  for (const row of independentRows) {
    const current = highlightGroups.get(row.skillNodeId);
    if (current) {
      current.count += 1;
    } else {
      highlightGroups.set(row.skillNodeId, {
        skillName: row.skillName,
        abilityLabel: abilityLabel(row.abilityCategory),
        count: 1,
      });
    }
  }
  const highlights = [...highlightGroups.values()]
    .sort((a, b) => b.count - a.count || a.skillName.localeCompare(b.skillName, 'zh-CN'))
    .slice(0, 3)
    .map((item) => ({
      skillName: item.skillName,
      abilityLabel: item.abilityLabel,
      independentSuccesses: item.count,
    }));

  const practiceGroups = new Map<
    string,
    { skillName: string; abilityLabel: string; count: number; errors: Map<string, number> }
  >();
  for (const row of input.evidence) {
    if (row.succeeded) continue;
    const current = practiceGroups.get(row.skillNodeId) ?? {
      skillName: row.skillName,
      abilityLabel: abilityLabel(row.abilityCategory),
      count: 0,
      errors: new Map<string, number>(),
    };
    current.count += 1;
    for (const unit of readErrorUnits(row.errorUnits)) increment(current.errors, unit);
    practiceGroups.set(row.skillNodeId, current);
  }
  const needsPractice = [...practiceGroups.entries()]
    .map(([skillNodeId, item]) => ({
      skillName: item.skillName,
      abilityLabel: item.abilityLabel,
      unsuccessfulAttempts: item.count,
      priorIndependentSuccess: input.priorIndependentSkillIds.has(skillNodeId),
      errorUnits: [...item.errors.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
        .slice(0, 3)
        .map(([unit, count]) => ({ unit, count })),
    }))
    .sort(
      (a, b) =>
        b.unsuccessfulAttempts - a.unsuccessfulAttempts ||
        a.skillName.localeCompare(b.skillName, 'zh-CN'),
    )
    .slice(0, 3);

  const openReviews = input.reviews
    .filter((review) => review.completedAt === null)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const dueReviews = openReviews.filter((review) => review.dueAt.getTime() <= input.weekEnd.getTime());
  const overdueReviews = dueReviews.filter((review) => review.dueAt.getTime() < input.now.getTime());

  const topicGroups = new Map<string, number>();
  for (const session of finishedSessions) increment(topicGroups, session.topicId);
  const topics = [...topicGroups.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([topicId, sessions]) => ({
      name: input.topicNames[topicId] ?? '课程练习',
      sessions,
    }));

  const hasData = finishedSessions.length > 0 || input.evidence.length > 0;
  const suggestions: string[] = [];
  const pushSuggestion = (value: string) => {
    if (suggestions.length < 3 && !suggestions.includes(value)) suggestions.push(value);
  };

  for (const item of needsPractice.slice(0, 2)) {
    if (item.priorIndependentSuccess) {
      pushSuggestion(
        `「${item.skillName}」之前独立完成过，这周又开始需要帮助；下周先复习熟悉的例子，再尝试新内容。`,
      );
    } else {
      pushSuggestion(`下周给「${item.skillName}」安排 2 次短练习，每次 5 分钟，先复习再尝试新内容。`);
    }
  }
  if (dueReviews.length > 0) {
    pushSuggestion(`先完成 ${dueReviews.length} 个到期复习项，再开始新的课程内容。`);
  }
  if (!hasData) {
    pushSuggestion('本周还没有足够的课堂记录；完成一次课堂后，周报会自动生成。');
  }
  pushSuggestion('每次练习控制在 10 分钟内，以鼓励和重复为主；不比较、不测试，保持轻松。');

  return {
    weekStart: localDateKey(input.weekStart),
    weekEnd: localDateKey(new Date(input.weekEnd.getTime() - 1)),
    timezone: 'Asia/Shanghai',
    hasData,
    summary: {
      sessions: finishedSessions.length,
      unfinishedSessions: input.sessions.length - finishedSessions.length,
      learningMinutes,
      activeDays: activeDays.size,
      independentSuccesses: independentRows.length,
      coveredSkills: new Set(input.evidence.map((row) => row.skillNodeId)).size,
      durationKind: 'session_wall_clock',
    },
    topics,
    highlights,
    needsPractice,
    reviews: {
      dueCount: dueReviews.length,
      overdueCount: overdueReviews.length,
      nextDueAt: openReviews[0]?.dueAt.toISOString() ?? null,
      items: dueReviews.slice(0, 3).map((review) => ({
        skillName: review.skillName,
        dueAt: review.dueAt.toISOString(),
      })),
    },
    nextWeek: { suggestions: suggestions.slice(0, 3) },
    privacy: {
      includesRawAudio: false,
      includesTranscript: false,
      includesProviderData: false,
      includesInternalCost: false,
    },
    calibrationNotice: CALIBRATION_NOTICE,
  };
}

@Injectable()
export class ParentReportService {
  private readonly curriculum = new Curriculum();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async weekly(learnerId: string, requestedWeekStart?: string): Promise<WeeklyReport> {
    const now = new Date();
    const week = resolveReportWeek(now, requestedWeekStart);
    const priorStart = new Date(week.weekStart.getTime() - 30 * DAY_MS);

    const [sessions, evidence, priorEvidence, reviews] = await Promise.all([
      this.prisma.lesson_sessions.findMany({
        where: {
          learnerId,
          startedAt: { gte: week.weekStart, lt: week.weekEndExclusive },
        },
        select: { id: true, topicId: true, status: true, startedAt: true, finishedAt: true },
        orderBy: { startedAt: 'asc' },
      }),
      this.prisma.learning_evidence.findMany({
        where: {
          learnerId,
          occurredAt: { gte: week.weekStart, lt: week.weekEndExclusive },
        },
        select: {
          id: true,
          skillNodeId: true,
          succeeded: true,
          independent: true,
          contributesToPromotion: true,
          source: true,
          errorUnits: true,
          occurredAt: true,
          skillNode: { select: { name: true, abilityCategory: true } },
        },
        orderBy: { occurredAt: 'asc' },
      }),
      this.prisma.learning_evidence.findMany({
        where: {
          learnerId,
          occurredAt: { gte: priorStart, lt: week.weekStart },
          succeeded: true,
          independent: true,
          contributesToPromotion: true,
          source: { not: 'llm_judgement' },
        },
        select: { skillNodeId: true },
        distinct: ['skillNodeId'],
      }),
      this.prisma.review_schedules.findMany({
        where: { learnerId, completedAt: null },
        select: { skillNodeId: true, dueAt: true, completedAt: true, intervalDays: true },
        orderBy: { dueAt: 'asc' },
        take: 100,
      }),
    ]);

    const topicIds = [...new Set(sessions.map((session) => session.topicId))];
    const reviewSkillIds = [...new Set(reviews.map((review) => review.skillNodeId))];

    const [units, reviewSkills] = await Promise.all([
      topicIds.length
        ? this.prisma.curriculum_units.findMany({
            where: { topicId: { in: topicIds } },
            select: { topicId: true, title: true },
            orderBy: { order: 'asc' },
          })
        : Promise.resolve([]),
      reviewSkillIds.length
        ? this.prisma.skill_nodes.findMany({
            where: { id: { in: reviewSkillIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    const topicNames: Record<string, string> = {};
    for (const unit of units) {
      if (!topicNames[unit.topicId]) topicNames[unit.topicId] = unit.title;
    }
    for (const topicId of topicIds) {
      if (!topicNames[topicId]) topicNames[topicId] = this.curriculum.getTopic(topicId)?.name ?? '课程练习';
    }

    const reviewNames = new Map(reviewSkills.map((skill) => [skill.id, skill.name]));

    return buildWeeklyReport({
      weekStart: week.weekStart,
      weekEnd: week.weekEndExclusive,
      now,
      sessions,
      evidence: evidence.map((row) => ({
        id: row.id,
        skillNodeId: row.skillNodeId,
        skillName: row.skillNode.name,
        abilityCategory: row.skillNode.abilityCategory,
        succeeded: row.succeeded,
        independent: row.independent,
        contributesToPromotion: row.contributesToPromotion,
        source: row.source,
        errorUnits: row.errorUnits,
        occurredAt: row.occurredAt,
      })),
      priorIndependentSkillIds: new Set(priorEvidence.map((row) => row.skillNodeId)),
      reviews: reviews.map((review) => ({
        skillNodeId: review.skillNodeId,
        skillName: reviewNames.get(review.skillNodeId) ?? '复习内容',
        dueAt: review.dueAt,
        completedAt: review.completedAt,
        intervalDays: review.intervalDays,
      })),
      topicNames,
    });
  }
}

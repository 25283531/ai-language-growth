import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.module';

/**
 * L1 工作记忆：当前在教什么、刚说过什么、孩子现在要回答什么。
 *
 * 设计边界（D-019）：
 *  - Redis 只做短时会话上下文，不是学习记忆，也不写能力状态；
 *  - PostgreSQL 仍是唯一权威档案；Redis 缺失、超时或不可用时静默回落数据库；
 *  - 不保存儿童音频、原始录音或供应商凭据，只保存可朗读文本与教学指令。
 */
export interface WorkingMemoryTurn {
  at: string;
  intent: string;
  childText: string;
  teacherText: string;
}

export interface LessonWorkingMemory {
  version: 1;
  lessonSessionId: string;
  learnerId: string;
  topicId: string;
  turnCount: number;
  currentActivityId: string | null;
  currentReviewScheduleId: string | null;
  currentDirective: unknown | null;
  recentTurns: WorkingMemoryTurn[];
  updatedAt: string;
}

const KEY_PREFIX = 'alg:l1:lesson:';
const MAX_RECENT_TURNS = 8;
const MAX_TURN_TEXT = 240;

/**
 * 单轮文本裁剪。工作记忆只保存“刚说过什么”，不保存完整课堂转写；
 * 截断发生在写入前，避免 Redis 成为第二份长期对话档案。
 */
export function trimWorkingMemoryText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TURN_TEXT);
}

/** 追加一条最近对话，保留最近 MAX_RECENT_TURNS 条。 */
export function appendWorkingMemoryTurn(
  turns: WorkingMemoryTurn[],
  turn: WorkingMemoryTurn,
): WorkingMemoryTurn[] {
  return [...turns, {
    ...turn,
    childText: trimWorkingMemoryText(turn.childText),
    teacherText: trimWorkingMemoryText(turn.teacherText),
  }].slice(-MAX_RECENT_TURNS);
}

@Injectable()
export class WorkingMemoryService {
  private readonly logger = new Logger(WorkingMemoryService.name);
  private client: Redis | null = null;
  private state: 'uninitialized' | 'ready' | 'unavailable' = 'uninitialized';
  private retryAt = 0;
  private lastErrorLogAt = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  /** 是否配置了 Redis。未配置时调用方应直接走数据库路径。 */
  isConfigured(): boolean {
    return Boolean(this.config.redisUrl);
  }

  async get(lessonSessionId: string): Promise<LessonWorkingMemory | null> {
    const redis = await this.getClient();
    if (!redis) return null;
    try {
      const raw = await redis.get(this.key(lessonSessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<LessonWorkingMemory> | null;
      if (!parsed || typeof parsed !== 'object') return null;
      if (
        parsed.version !== 1 ||
        parsed.lessonSessionId !== lessonSessionId ||
        typeof parsed.learnerId !== 'string' ||
        typeof parsed.topicId !== 'string'
      ) {
        return null;
      }
      return {
        version: 1,
        lessonSessionId,
        learnerId: parsed.learnerId,
        topicId: parsed.topicId,
        turnCount: Number.isFinite(parsed.turnCount) ? Number(parsed.turnCount) : 0,
        currentActivityId: typeof parsed.currentActivityId === 'string' ? parsed.currentActivityId : null,
        currentReviewScheduleId: typeof parsed.currentReviewScheduleId === 'string' ? parsed.currentReviewScheduleId : null,
        currentDirective: parsed.currentDirective ?? null,
        recentTurns: Array.isArray(parsed.recentTurns)
          ? parsed.recentTurns.filter((turn): turn is WorkingMemoryTurn =>
              Boolean(turn) &&
              typeof turn === 'object' &&
              typeof (turn as WorkingMemoryTurn).childText === 'string' &&
              typeof (turn as WorkingMemoryTurn).teacherText === 'string',
            ).map((turn) => ({
              ...turn,
              childText: trimWorkingMemoryText(turn.childText),
              teacherText: trimWorkingMemoryText(turn.teacherText),
            })).slice(-MAX_RECENT_TURNS)
          : [],
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      };
    } catch (error) {
      this.noteFailure(error);
      return null;
    }
  }

  async save(memory: LessonWorkingMemory): Promise<boolean> {
    const redis = await this.getClient();
    if (!redis) return false;
    try {
      await redis.set(
        this.key(memory.lessonSessionId),
        JSON.stringify({
          ...memory,
          recentTurns: memory.recentTurns.slice(-MAX_RECENT_TURNS).map((turn) => ({
            ...turn,
            childText: trimWorkingMemoryText(turn.childText),
            teacherText: trimWorkingMemoryText(turn.teacherText),
          })),
          updatedAt: memory.updatedAt || new Date().toISOString(),
        }),
        'EX',
        this.ttlSeconds(),
      );
      return true;
    } catch (error) {
      this.noteFailure(error);
      return false;
    }
  }

  /** 开课时建立工作记忆；失败不阻断开课。 */
  async rememberLessonStart(input: {
    lessonSessionId: string;
    learnerId: string;
    topicId: string;
    currentActivityId: string | null;
    currentReviewScheduleId: string | null;
    currentDirective: unknown;
  }): Promise<void> {
    await this.save({
      version: 1,
      lessonSessionId: input.lessonSessionId,
      learnerId: input.learnerId,
      topicId: input.topicId,
      turnCount: 0,
      currentActivityId: input.currentActivityId,
      currentReviewScheduleId: input.currentReviewScheduleId,
      currentDirective: input.currentDirective,
      recentTurns: [],
      updatedAt: new Date().toISOString(),
    });
  }

  /** 回合结束后更新工作记忆；在 Redis 不可用时静默跳过。 */
  async rememberTurn(input: {
    lessonSessionId: string;
    learnerId: string;
    topicId: string;
    turnCount: number;
    currentActivityId: string | null;
    currentReviewScheduleId: string | null;
    currentDirective: unknown;
    intent: string;
    childText: string;
    teacherText: string;
  }): Promise<void> {
    const existing = await this.get(input.lessonSessionId);
    const recentTurns = appendWorkingMemoryTurn(existing?.recentTurns ?? [], {
      at: new Date().toISOString(),
      intent: input.intent,
      childText: input.childText,
      teacherText: input.teacherText,
    });
    await this.save({
      version: 1,
      lessonSessionId: input.lessonSessionId,
      learnerId: input.learnerId,
      topicId: input.topicId,
      turnCount: input.turnCount,
      currentActivityId: input.currentActivityId,
      currentReviewScheduleId: input.currentReviewScheduleId,
      currentDirective: input.currentDirective,
      recentTurns,
      updatedAt: new Date().toISOString(),
    });
  }

  /** 结课后清理短时上下文；数据库中的课堂记录不受影响。 */
  async clear(lessonSessionId: string): Promise<void> {
    const redis = await this.getClient();
    if (!redis) return;
    try {
      await redis.del(this.key(lessonSessionId));
    } catch (error) {
      this.noteFailure(error);
    }
  }

  /** 健康检查只读，供管理端确认 L1 是否真正可用。 */
  async health(): Promise<{ configured: boolean; reachable: boolean; ttlSeconds: number }> {
    const configured = this.isConfigured();
    if (!configured) return { configured, reachable: false, ttlSeconds: this.ttlSeconds() };
    const redis = await this.getClient();
    if (!redis) return { configured, reachable: false, ttlSeconds: this.ttlSeconds() };
    try {
      const pong = await redis.ping();
      return { configured, reachable: pong === 'PONG', ttlSeconds: this.ttlSeconds() };
    } catch (error) {
      this.noteFailure(error);
      return { configured, reachable: false, ttlSeconds: this.ttlSeconds() };
    }
  }

  private key(lessonSessionId: string): string {
    return `${KEY_PREFIX}${lessonSessionId}`;
  }

  private ttlSeconds(): number {
    const value = this.config.workingMemoryTtlSeconds;
    return Number.isFinite(value) && value >= 60 ? Math.floor(value) : 21600;
  }

  private async getClient(): Promise<Redis | null> {
    if (!this.config.redisUrl) return null;
    if (this.state === 'unavailable' && Date.now() < this.retryAt) return null;
    if (!this.client) {
      this.client = new Redis(this.config.redisUrl, {
        lazyConnect: true,
        connectTimeout: 800,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      this.client.on('error', (error) => this.noteFailure(error));
    }
    try {
      if (this.client.status === 'wait' || this.client.status === 'end') {
        await this.client.connect();
      }
      this.state = 'ready';
      return this.client;
    } catch (error) {
      this.noteFailure(error);
      return null;
    }
  }

  private noteFailure(error: unknown): void {
    this.state = 'unavailable';
    // 短暂故障后重试，避免一次网络抖动让整个进程永久放弃 Redis。
    this.retryAt = Date.now() + 30_000;
    if (Date.now() - this.lastErrorLogAt > 60_000) {
      this.lastErrorLogAt = Date.now();
      this.logger.warn(`L1 工作记忆不可用，回落到数据库会话：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { lookup } from 'node:dns/promises';
import { APP_CONFIG, type AppConfig } from '../config/config.module';

export const IMAGE_CACHE_QUEUE = 'image-cache';
export const IMAGE_CACHE_SCHEDULER = 'image-cache-reconcile-v1';
export const IMAGE_CACHE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 100 },
  removeOnFail: { age: 604800, count: 100 },
};

function redisEndpoint(value: string): URL {
  try {
    const url = new URL(value);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname ||
      url.search || url.hash || !/^\/(?:\d+)?$/.test(url.pathname || '/') ||
      !Number.isSafeInteger(Number(url.pathname.slice(1) || 0))) throw new Error();
    return url;
  } catch {
    throw new Error('QUEUE_REDIS_URL 配置无效');
  }
}

function normalizedHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host) ? 'loopback' : host;
}

export function queueConnectionOptions(queueUrl: string, cacheUrl: string):
  { producer: RedisOptions; worker: RedisOptions } | undefined {
  if (!queueUrl.trim()) return undefined;
  const queue = redisEndpoint(queueUrl);
  if (cacheUrl) {
    const cache = redisEndpoint(cacheUrl);
    if (normalizedHost(queue) === normalizedHost(cache) && (queue.port || '6379') === (cache.port || '6379')) {
      throw new Error('QUEUE_REDIS_URL 必须使用独立 Redis server');
    }
  }
  const common: RedisOptions = {
    host: queue.hostname.replace(/^\[|\]$/g, ''),
    port: Number(queue.port || 6379),
    db: Number(queue.pathname.slice(1) || 0),
    username: queue.username ? decodeURIComponent(queue.username) : undefined,
    password: queue.password ? decodeURIComponent(queue.password) : undefined,
    ...(queue.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: 3000,
  };
  return {
    producer: { ...common, maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 3000, retryStrategy: () => null },
    worker: { ...common, maxRetriesPerRequest: null, retryStrategy: (times) => Math.min(times * 250, 5000) },
  };
}

export const QUEUE_DEPENDENCIES = 'QUEUE_DEPENDENCIES';
export interface QueueDependencies {
  createQueue: (connection: RedisOptions) => Queue;
  createWorker: (processor: (job: Job) => Promise<void>, connection: RedisOptions) => Worker;
  resolve: (host: string) => Promise<Array<{ address: string }>>;
}
const dependencies: QueueDependencies = {
  createQueue: (connection) => new Queue(IMAGE_CACHE_QUEUE, { connection }),
  createWorker: (processor, connection) => new Worker(IMAGE_CACHE_QUEUE, processor, { connection, concurrency: 1, autorun: false }),
  resolve: (host) => lookup(host, { all: true }),
};

async function deadline<T>(operation: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('队列操作超时')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

@Injectable()
export class QueueRuntimeService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueRuntimeService.name);
  private worker?: Worker;
  private producer?: Queue;
  private closing = false;
  private scheduling = false;
  private initialization?: Promise<void>;
  private setup?: Promise<void>;

  private retryTimer?: NodeJS.Timeout;
  private scheduleTimer?: NodeJS.Timeout;
  private schedulePending = false;
  private processor?: (job: Job<{ assetId?: string }>) => Promise<void>;
  private readonly abort = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(QUEUE_DEPENDENCIES) private readonly deps: QueueDependencies = dependencies,
  ) {}

  startImageCache(processor: (job: Job<{ assetId?: string }>) => Promise<void>): void {
    if (this.initialization || this.closing) return;
    this.processor = processor;
    this.initialization = this.initialize(processor).catch(() => {
      this.logger.error('图片缓存队列配置或初始化失败；后台任务停用，不回退定时器');
    });
  }

  private async initialize(processor: (job: Job<{ assetId?: string }>) => Promise<void>): Promise<void> {
    const options = queueConnectionOptions(this.config.queueRedisUrl, this.config.redisUrl);
    if (!options) {
      this.logger.warn('未配置 QUEUE_REDIS_URL；图片后台缓存已禁用');
      return;
    }
    if (this.config.nodeEnv === 'production' && normalizedHost(redisEndpoint(this.config.queueRedisUrl)) === 'loopback') {
      throw new Error('生产队列不允许 loopback 地址');
    }
    // DNS aliases must not bypass the distinct-server boundary. No cache Redis commands are sent.
    try {
      if (this.config.nodeEnv === 'production') {
        const addresses = await deadline(this.deps.resolve(options.worker.host!));
        if (addresses.some(({ address }) => address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'))) {
          this.logger.error('生产队列 DNS 不允许 loopback 地址；后台任务停用');
          return;
        }
      }
      if (this.config.redisUrl) {
        const cache = redisEndpoint(this.config.redisUrl);
        if ((cache.port || '6379') === String(options.worker.port)) {
          const [queueAddresses, cacheAddresses] = await deadline(Promise.all([
            this.deps.resolve(options.worker.host!),
            this.deps.resolve(cache.hostname.replace(/^\[|\]$/g, '')),
          ]));
          if (queueAddresses.some((queue) => cacheAddresses.some((entry) => entry.address === queue.address))) {
            this.logger.error('队列与缓存DNS解析到同一server；后台任务停用');
            return;
          }
        }
      }
    } catch {
      this.logger.warn('队列隔离DNS校验暂不可用；保持后台暂停并稍后复核');
      this.deferInitialization();
      return;
    }
    if (this.closing) return;
    const worker = this.deps.createWorker(async (job) => {
      if (job.name !== IMAGE_CACHE_SCHEDULER) throw new Error('未知图片缓存任务');
      try {
        await processor(job);
      } catch {
        throw new Error('图片缓存处理失败');
      }
    }, options.worker);
    this.worker = worker;
    worker.on('error', () => this.logger.warn('图片缓存队列连接或运行异常；等待队列恢复'));
    worker.on('failed', () => this.logger.warn('图片缓存任务失败；按有限退避重试或等待数据库对账'));
    worker.on('ready', () => this.requestSchedule(options.producer));
  }

  private deferInitialization(): void {
    if (this.closing || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.closing && this.processor) {
        this.initialization = this.initialize(this.processor).catch(() => this.logger.error('图片队列初始化失败'));
      }
    }, 30000);
    this.retryTimer.unref();
  }

  private requestSchedule(connection: RedisOptions): void {
    if (this.closing) return;
    if (this.scheduling) { this.schedulePending = true; return; }
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = undefined;
    this.setup = this.schedule(connection).catch(() => {
      this.logger.error('图片缓存调度初始化失败；未启用本地定时器');
      this.deferSchedule(connection);
    });
  }

  private deferSchedule(connection: RedisOptions): void {
    if (this.closing || this.scheduleTimer) return;
    // Control-plane repair only: never performs image processing outside BullMQ.
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = undefined;
      this.requestSchedule(connection);
    }, 30000);
    this.scheduleTimer.unref();
  }

  private async schedule(connection: RedisOptions): Promise<void> {
    this.scheduling = true;
    try {
      // Re-checks are fail-closed: pause new claims before reading policy. BullMQ
      // pause() does not cancel an active job; it only prevents further claims.
      if (this.worker && typeof (this.worker as Worker & { pause?: (doNotWaitActive?: boolean) => Promise<void> }).pause === 'function') {
        await (this.worker as Worker & { pause: (doNotWaitActive?: boolean) => Promise<void> }).pause(true);
      }
      // Finite setup retries, never an in-process image processing fallback.
      for (let attempt = 0; attempt < 3 && !this.closing; attempt += 1) {
        const queue = this.deps.createQueue(connection);
        this.producer = queue;
        queue.on('error', () => this.logger.warn('图片缓存调度连接异常'));
        try {
          // Await the finite producer connection before issuing commands with offline queue disabled.
          await deadline(queue.waitUntilReady());
          // v5.81.5 ioredis adapter forwards raw commands not included in IRedisClient.
          const client = await queue.client as unknown as { config(command: 'GET', key: string): Promise<string[]> };
          try {
            const policy = await client.config('GET', 'maxmemory-policy');
            const aof = await client.config('GET', 'appendonly');
            if (policy[1] !== 'noeviction' || aof[1] !== 'yes') {
              this.logger.error('队列 Redis 策略必须为 noeviction 且启用 AOF；后台任务暂停');
              this.deferSchedule(connection);
              return;
            }
          } catch {
            this.logger.warn('队列 Redis CONFIG 暂不可读取；持久化和淘汰策略未验证，后台任务暂停并等待控制面复核');
            this.deferSchedule(connection);
            return;
          }
          await queue.setGlobalConcurrency(1);
          await queue.upsertJobScheduler(IMAGE_CACHE_SCHEDULER, { every: 60000 }, {
            name: IMAGE_CACHE_SCHEDULER, data: {}, opts: IMAGE_CACHE_JOB_OPTIONS,
          });
          if (!this.closing && this.worker && typeof (this.worker as Worker & { resume?: () => Promise<void> }).resume === 'function') {
            await (this.worker as Worker & { resume: () => Promise<void> }).resume();
          }
          if (!this.closing && this.worker && !this.worker.isRunning()) {
            void this.worker.run().catch(() => this.logger.error('图片缓存 worker 已停止；需检查队列状态'));
          }
          this.logger.log('图片缓存队列调度已注册');
          return;
        } catch {
          this.logger.warn('图片缓存队列调度注册失败；有限重试，不回退定时器');
          if (attempt < 2 && !this.closing) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 250 * (attempt + 1));
              this.abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
            });
          }
        } finally {
          await this.releaseQueue(queue);
          if (this.producer === queue) this.producer = undefined;
        }
      }
      this.deferSchedule(connection);
    } finally {
      this.scheduling = false;
      if (this.schedulePending) {
        this.schedulePending = false;
        this.deferSchedule(connection);
      }
    }
  }

  private async releaseQueue(queue: Queue): Promise<void> {
    try { await deadline(queue.close()); }
    catch {
      this.logger.warn('图片缓存 producer 正常关闭失败；强制断开连接');
      try { await deadline(queue.disconnect()); } catch { this.logger.error('图片缓存 producer 连接释放未确认'); }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.abort.abort();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    try { await deadline(this.initialization ?? Promise.resolve()); } catch { this.logger.warn('队列初始化关闭等待超时'); }
    try { await deadline(this.worker?.close() ?? Promise.resolve(), 20000); }
    catch {
      this.logger.warn('图片缓存 worker 正常关闭失败；强制释放');
      try { await deadline(this.worker?.disconnect() ?? Promise.resolve()); } catch { this.logger.error('worker 普通连接释放未确认'); }
      // close() reuses its pending promise; do not pretend close(true) cancels it.
      this.logger.error('worker 阻塞连接和活动任务释放未确认；需进程管理器终止');
    }
    try { await deadline(this.setup ?? Promise.resolve(), 5000); } catch { this.logger.warn('调度关闭等待未完成'); }
    if (this.producer) await this.releaseQueue(this.producer);
  }
}

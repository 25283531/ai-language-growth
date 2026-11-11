import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueConnectionOptions, IMAGE_CACHE_JOB_OPTIONS, QueueRuntimeService } from '../src/queue/queue-runtime.service';
import { loadConfig } from '../src/config/config.module';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import type { QueueDependencies } from '../src/queue/queue-runtime.service';

test('enabled runtime awaits producer ready, checks policy, dedupes initialization and drains worker', async () => {
  const worker = new EventEmitter() as any;
  const calls: string[] = [];
  worker.isRunning = () => calls.includes('run');
  worker.pause = async (doNotWaitActive?: boolean) => { assert.equal(doNotWaitActive, true); calls.push('pause'); };
  worker.resume = async () => { calls.push('resume'); };
  worker.run = async () => { calls.push('run'); };
  worker.close = async () => { calls.push('worker-close'); };
  const queue = new EventEmitter() as any;
  queue.waitUntilReady = async () => { calls.push('ready'); };
  queue.client = Promise.resolve({ config: async (_get: string, name: string) => [name, name === 'appendonly' ? 'yes' : 'noeviction'] });
  queue.setGlobalConcurrency = async (n: number) => { assert.equal(n, 1); calls.push('global'); };
  queue.upsertJobScheduler = async (id: string, repeat: any, template: any) => {
    assert.equal(id, 'image-cache-reconcile-v1');
    assert.equal(repeat.every, 60000);
    assert.deepEqual(template.data, {});
    calls.push('scheduler');
  };
  queue.close = async () => { calls.push('producer-close'); };
  let created = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    createWorker: () => { created += 1; return worker; }, createQueue: () => queue,
    resolve: async () => [],
  } as QueueDependencies);
  runtime.startImageCache(async () => {});
  runtime.startImageCache(async () => {});
  await delay(0);
  worker.emit('ready');
  await delay(10);
  await runtime.onModuleDestroy();
  assert.equal(created, 1);
  assert.deepEqual(calls.slice(0, 7), ['pause', 'ready', 'global', 'scheduler', 'resume', 'run', 'producer-close']);
  assert.ok(calls.includes('worker-close'));
});

test('disabled runtime never calls processor and closes cleanly', async () => {
  let calls = 0;
  const runtime = new QueueRuntimeService(loadConfig({}));
  runtime.startImageCache(async () => { calls += 1; });
  await runtime.onModuleDestroy();
  assert.equal(calls, 0);
});

test('offline worker does not block caller, process jobs, or prevent shutdown', { timeout: 10000 }, async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: `redis://127.0.0.1:${port}` }));
  let calls = 0;
  assert.equal(runtime.startImageCache(async () => { calls += 1; }), undefined);
  await delay(200);
  await runtime.onModuleDestroy();
  assert.equal(calls, 0);
});

test('producer setup retries connection failure and still releases resources', async () => {
  const worker = new EventEmitter() as any;
  worker.close = async () => { throw new Error('synthetic shutdown failure'); };
  worker.disconnect = async () => {};
  worker.isRunning = () => false;
  let ran = false;
  worker.run = async () => { ran = true; };
  let creates = 0;
  let disconnected = 0;
  let scheduled = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    createWorker: () => worker,
    resolve: async () => [],
    createQueue: () => {
      creates += 1;
      const attempt = creates;
      const queue = new EventEmitter() as any;
      queue.waitUntilReady = async () => { if (attempt === 1) throw new Error('connection unavailable'); };
      queue.client = Promise.resolve({ config: async (_get: string, name: string) => [name, name === 'appendonly' ? 'yes' : 'noeviction'] });
      queue.setGlobalConcurrency = async () => {};
      queue.upsertJobScheduler = async () => { scheduled += 1; };
      queue.close = async () => { throw new Error('close unavailable'); };
      queue.disconnect = async () => { disconnected += 1; };
      return queue;
    },
  });
  runtime.startImageCache(async () => {});
  await delay(0);
  worker.emit('ready');
  await delay(400);
  await runtime.onModuleDestroy();
  assert.equal(creates, 2);
  assert.equal(scheduled, 1);
  assert.equal(disconnected, 2);
  assert.equal(ran, true);
});

test('initial CONFIG NOPERM is retried and recovery resumes worker after scheduler registration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let n = 0; n < 10; n += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const worker = new EventEmitter() as any; let running = false; const calls: string[] = [];
  worker.pause = async (doNotWaitActive?: boolean) => { assert.equal(doNotWaitActive, true); calls.push('pause'); };
  worker.resume = async () => { calls.push('resume'); };
  worker.isRunning = () => running; worker.run = async () => { calls.push('run'); running = true; };
  worker.close = async () => {};
  let configs = 0; let scheduled = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    createWorker: () => worker, resolve: async () => [],
    createQueue: () => {
      const queue = new EventEmitter() as any; queue.waitUntilReady = async () => {};
      queue.client = Promise.resolve({ config: async (_get: string, key: string) => { configs += 1; if (configs === 1) throw new Error('NOPERM'); return [key, key === 'appendonly' ? 'yes' : 'noeviction']; } });
      queue.setGlobalConcurrency = async () => {}; queue.upsertJobScheduler = async () => { scheduled += 1; }; queue.close = async () => {};
      return queue;
    },
  });
  try {
    runtime.startImageCache(async () => {}); await flush(); worker.emit('ready'); await flush();
    assert.deepEqual(calls, ['pause']);
    t.mock.timers.tick(30000); await flush();
    assert.deepEqual(calls, ['pause', 'pause', 'resume', 'run']); assert.equal(scheduled, 1);
  } finally { await runtime.onModuleDestroy(); t.mock.timers.reset(); }
});

test('unverifiable Redis policy never starts worker or scheduler', async () => {
  const worker = new EventEmitter() as any;
  worker.close = async () => {};
  let ran = false;
  worker.run = async () => { ran = true; };
  const queue = new EventEmitter() as any;
  queue.waitUntilReady = async () => {};
  queue.client = Promise.resolve({ config: async () => { throw new Error('NOPERM'); } });
  queue.close = async () => {};
  queue.setGlobalConcurrency = async () => { throw new Error('must not schedule'); };
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    createWorker: () => worker, createQueue: () => queue, resolve: async () => [],
  });
  runtime.startImageCache(async () => {});
  await delay(0);
  worker.emit('ready');
  await delay(10);
  await runtime.onModuleDestroy();
  assert.equal(ran, false);
});

test('noncompliant Redis policy does not consume jobs', async () => {
  for (const denied of ['maxmemory-policy', 'appendonly']) {
    const worker = new EventEmitter() as any; worker.close = async () => {};
    let ran = false; worker.run = async () => { ran = true; };
    const queue = new EventEmitter() as any;
    queue.waitUntilReady = async () => {};
    queue.client = Promise.resolve({ config: async (_get: string, key: string) => [key, key === denied ? 'invalid' : key === 'appendonly' ? 'yes' : 'noeviction'] });
    queue.close = async () => {};
    queue.setGlobalConcurrency = async () => { throw new Error('must not schedule'); };
    const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
      createWorker: () => worker, createQueue: () => queue, resolve: async () => [],
    });
    runtime.startImageCache(async () => {}); await delay(0); worker.emit('ready'); await delay(10);
    await runtime.onModuleDestroy(); assert.equal(ran, false);
  }
});

test('ready recheck pauses consumption when policy becomes noncompliant or unreadable, then resumes after recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let n = 0; n < 10; n += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const worker = new EventEmitter() as any; const calls: string[] = []; let running = false; let invalid: 'ok' | 'policy' | 'config' = 'ok';
  worker.pause = async (doNotWaitActive?: boolean) => { assert.equal(doNotWaitActive, true); calls.push('pause'); };
  worker.resume = async () => { calls.push('resume'); };
  worker.isRunning = () => running; worker.run = async () => { running = true; calls.push('run'); }; worker.close = async () => {};
  let scheduled = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    createWorker: () => worker, resolve: async () => [], createQueue: () => {
      const queue = new EventEmitter() as any; queue.waitUntilReady = async () => {};
      queue.client = Promise.resolve({ config: async (_get: string, key: string) => { if (invalid === 'config') throw new Error('NOPERM'); return [key, key === 'appendonly' ? 'yes' : invalid === 'policy' ? 'volatile-lru' : 'noeviction']; } });
      queue.setGlobalConcurrency = async () => {}; queue.upsertJobScheduler = async () => { scheduled += 1; }; queue.close = async () => {};
      return queue;
    },
  });
  try {
    runtime.startImageCache(async () => {}); await flush(); worker.emit('ready'); await flush();
    assert.deepEqual(calls, ['pause', 'resume', 'run']);
    invalid = 'policy'; worker.emit('ready'); await flush();
    assert.deepEqual(calls, ['pause', 'resume', 'run', 'pause']);
    invalid = 'config'; t.mock.timers.tick(30000); await flush();
    assert.deepEqual(calls, ['pause', 'resume', 'run', 'pause', 'pause']);
    invalid = 'ok'; t.mock.timers.tick(30000); await flush();
    assert.deepEqual(calls, ['pause', 'resume', 'run', 'pause', 'pause', 'pause', 'resume']); assert.equal(scheduled, 2);
  } finally { await runtime.onModuleDestroy(); t.mock.timers.reset(); }
});

test('graceful shutdown waits for active processor close while setup close errors remain isolated', async () => {
  const worker = new EventEmitter() as any;
  let finish!: () => void;
  let drained = false;
  worker.close = () => new Promise<void>((resolve) => { finish = () => { drained = true; resolve(); }; });
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    createWorker: () => worker, createQueue: () => { throw new Error(); }, resolve: async () => [],
  });
  runtime.startImageCache(async () => {}); await delay(0);
  let closed = false;
  const closing = runtime.onModuleDestroy().then(() => { closed = true; });
  await delay(0); assert.equal(closed, false); finish(); await closing;
  assert.equal(drained, true); assert.equal(closed, true);
});

test('production loopback and DNS alias reuse create no worker', async () => {
  for (const config of [
    loadConfig({ NODE_ENV: 'production', QUEUE_REDIS_URL: 'redis://127.0.0.1:6381' }),
    loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6379', REDIS_URL: 'redis://cache:6379' }),
  ]) {
    let created = 0;
    const runtime = new QueueRuntimeService(config, {
      createWorker: () => { created += 1; throw new Error('unexpected'); },
      createQueue: () => { throw new Error('unexpected'); },
      resolve: async () => [{ address: '192.0.2.1' }],
    });
    runtime.startImageCache(async () => {});
    await delay(0);
    await runtime.onModuleDestroy();
    assert.equal(created, 0);
  }
});

test('DNS failure is paused and retry timer is canceled by shutdown', async () => {
  let created = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue', REDIS_URL: 'redis://cache' }), {
    createWorker: () => { created += 1; throw new Error(); }, createQueue: () => { throw new Error(); },
    resolve: async () => { throw new Error('synthetic DNS failure'); },
  });
  runtime.startImageCache(async () => {});
  await delay(0);
  await runtime.onModuleDestroy();
  assert.equal(created, 0);
});

test('queue is explicitly disabled without QUEUE_REDIS_URL', () => {
  assert.equal(queueConnectionOptions('', 'redis://cache:6379'), undefined);
});

test('queue rejects invalid URLs without echoing credentials', () => {
  for (const url of ['https://user:secret@queue', 'not-a-url', 'redis://queue/invalid', 'redis://queue/0?password=secret']) {
    assert.throws(() => queueConnectionOptions(url, ''), (error: Error) => {
      assert.equal(error.message, 'QUEUE_REDIS_URL 配置无效');
      return true;
    });
  }
});

test('logical DB, credentials, protocol and host casing do not isolate the same Redis server', () => {
  for (const url of ['redis://CACHE:6379/1', 'rediss://user:secret@cache/2', 'redis://cache/0']) {
    assert.throws(() => queueConnectionOptions(url, 'redis://cache:6379/0'), /必须使用独立 Redis server/);
  }
  assert.throws(() => queueConnectionOptions('redis://127.0.0.1:6379', 'redis://localhost:6379'), /必须使用独立 Redis server/);
});

test('separate queue server produces bounded producer and recoverable worker options', () => {
  const options = queueConnectionOptions('rediss://user:secret@queue:6380/2', 'redis://cache:6379');
  assert.ok(options);
  assert.equal(options.producer.host, 'queue');
  assert.equal(options.producer.port, 6380);
  assert.equal(options.producer.db, 2);
  assert.equal(options.producer.enableOfflineQueue, false);
  assert.equal(options.producer.maxRetriesPerRequest, 1);
  assert.equal(options.producer.commandTimeout, 3000);
  assert.equal(options.producer.retryStrategy?.(1), null);
  assert.equal(options.worker.maxRetriesPerRequest, null);
  assert.ok(options.worker.retryStrategy?.(1));
  assert.deepEqual(options.producer.tls, {});
});

test('three failed producer attempts recover without another Redis ready event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let n = 0; n < 10; n += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const worker = new EventEmitter() as any;
  worker.close = async () => {};
  worker.isRunning = () => false;
  let ran = 0;
  worker.run = async () => { ran += 1; };
  let creates = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    resolve: async () => [], createWorker: () => worker,
    createQueue: () => {
      const attempt = ++creates;
      const queue = new EventEmitter() as any;
      queue.waitUntilReady = async () => { if (attempt <= 3) throw new Error('offline'); };
      queue.client = Promise.resolve({ config: async (_get: string, key: string) => [key, key === 'appendonly' ? 'yes' : 'noeviction'] });
      queue.setGlobalConcurrency = async () => {};
      queue.upsertJobScheduler = async () => {};
      queue.close = async () => {};
      return queue;
    },
  });
  try {
    runtime.startImageCache(async () => {});
    await flush(); worker.emit('ready'); await flush();
    t.mock.timers.tick(250); await flush();
    t.mock.timers.tick(500); await flush();
    assert.equal(creates, 3);
    t.mock.timers.tick(30000); await flush();
    assert.equal(creates, 4);
    assert.equal(ran, 1);
  } finally { await runtime.onModuleDestroy(); t.mock.timers.reset(); }
});

test('ready during setup is retained for a later control-plane registration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let n = 0; n < 10; n += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const worker = new EventEmitter() as any;
  worker.close = async () => {}; worker.isRunning = () => true;
  let release!: () => void;
  let creates = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue:6380' }), {
    resolve: async () => [], createWorker: () => worker,
    createQueue: () => {
      const attempt = ++creates;
      const queue = new EventEmitter() as any;
      queue.waitUntilReady = () => attempt === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
      queue.client = Promise.resolve({ config: async (_get: string, key: string) => [key, key === 'appendonly' ? 'yes' : 'noeviction'] });
      queue.setGlobalConcurrency = async () => {}; queue.upsertJobScheduler = async () => {}; queue.close = async () => {};
      return queue;
    },
  });
  try {
    runtime.startImageCache(async () => {}); await flush();
    worker.emit('ready'); await flush(); worker.emit('ready');
    release(); await flush();
    t.mock.timers.tick(30000); await flush();
    assert.equal(creates, 2);
  } finally { await runtime.onModuleDestroy(); t.mock.timers.reset(); }
});

test('DNS first failure recovers on bounded control-plane retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let n = 0; n < 10; n += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const worker = new EventEmitter() as any; worker.close = async () => {};
  let created = 0;
  let recovered = false;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue', REDIS_URL: 'redis://cache' }), {
    resolve: async (host) => { if (!recovered) throw new Error('DNS unavailable'); return [{ address: host === 'queue' ? '192.0.2.1' : '192.0.2.2' }]; },
    createWorker: () => { created += 1; return worker; }, createQueue: () => { throw new Error(); },
  });
  try {
    runtime.startImageCache(async () => {}); await flush(); assert.equal(created, 0);
    recovered = true; t.mock.timers.tick(30000); await flush(); assert.equal(created, 1);
  } finally { await runtime.onModuleDestroy(); t.mock.timers.reset(); }
});

test('pending DNS has a deadline and cannot create worker after shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let n = 0; n < 10; n += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  let created = 0;
  const runtime = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: 'redis://queue', REDIS_URL: 'redis://cache' }), {
    resolve: () => new Promise(() => {}), createWorker: () => { created += 1; throw new Error(); }, createQueue: () => { throw new Error(); },
  });
  runtime.startImageCache(async () => {}); await flush();
  const closed = runtime.onModuleDestroy(); t.mock.timers.tick(3000); await flush(); await closed;
  t.mock.timers.tick(60000); await flush(); assert.equal(created, 0);
  t.mock.timers.reset();
});

test('jobs have finite exponential retries and bounded retention', () => {
  assert.equal(IMAGE_CACHE_JOB_OPTIONS.attempts, 3);
  assert.deepEqual(IMAGE_CACHE_JOB_OPTIONS.backoff, { type: 'exponential', delay: 5000 });
  assert.deepEqual(IMAGE_CACHE_JOB_OPTIONS.removeOnComplete, { age: 86400, count: 100 });
  assert.deepEqual(IMAGE_CACHE_JOB_OPTIONS.removeOnFail, { age: 604800, count: 100 });
});

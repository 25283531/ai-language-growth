import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { loadConfig } from '../src/config/config.module';
import { IMAGE_CACHE_QUEUE, IMAGE_CACHE_SCHEDULER, QueueRuntimeService, queueConnectionOptions } from '../src/queue/queue-runtime.service';

// Opt-in disposable loopback Redis DB only. Never read REDIS_URL or production configuration.
const url = process.env.QUEUE_TEST_REDIS_URL;
const authorized = process.env.QUEUE_TEST_REDIS_DISPOSABLE_AUTHORIZED === '1';
const authorizedTarget = (): URL => {
  assert.equal(authorized, true, 'explicit disposable Redis authorization required');
  assert.ok(url, 'QUEUE_TEST_REDIS_URL is required when explicitly authorized');
  const parsed = new URL(url!);
  assert.equal(parsed.protocol, 'redis:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, '6381');
  assert.equal(parsed.pathname, '/15');
  assert.equal(parsed.search, '');
  assert.equal(parsed.hash, '');
  assert.ok(!parsed.username && !parsed.password);
  return parsed;
};
test('real Redis: scheduler dedupe, retry, global concurrency and graceful shutdown', {
  skip: !url || !authorized, timeout: 25000,
}, async () => {
  authorizedTarget();
  const options = queueConnectionOptions(url!, '')!;
  const first = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: url }));
  const second = new QueueRuntimeService(loadConfig({ QUEUE_REDIS_URL: url }));
  let queue: Queue | undefined;
  let attempts = 0;
  let active = 0;
  let maxActive = 0;
  const processor = async () => {
    attempts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await delay(30);
      if (attempts === 1) throw new Error('synthetic failure');
    } finally { active -= 1; }
  };
  try {
    authorizedTarget();
    queue = new Queue(IMAGE_CACHE_QUEUE, { connection: options.producer });
    const client = await queue.client as unknown as { config(command: 'SET', key: string, value: string): Promise<unknown> };
    await client.config('SET', 'appendonly', 'yes');
    await client.config('SET', 'maxmemory-policy', 'noeviction');
    await queue.obliterate({ force: true });
    first.startImageCache(processor);
    second.startImageCache(processor);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && attempts < 2) await delay(50);
    assert.ok(attempts >= 2, 'failed processor must actually retry');
    const schedulers = await queue.getJobSchedulers();
    assert.equal(schedulers.length, 1);
    assert.equal(schedulers[0].key, IMAGE_CACHE_SCHEDULER);
    assert.equal(await queue.getGlobalConcurrency(), 1);
    assert.equal(maxActive, 1);
    await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()]);
    assert.equal(active, 0);
  } finally {
    try { await Promise.all([first.onModuleDestroy(), second.onModuleDestroy()]); } finally {
      if (queue) {
        try { await queue.obliterate({ force: true }); } finally {
          try { await queue.close(); } finally { await queue.disconnect(); }
        }
      }
    }
  }
});

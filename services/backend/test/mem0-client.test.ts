/**
 * L3 Mem0 适配器回归：
 *  - 只发送提取后的教学偏好，不发送原始对话；
 *  - 兼容 Mem0 常见的 results / memories / data 返回形态；
 *  - 未配置、HTTP 失败或超时一律返回 null / 空数组，由调用方回落 PostgreSQL。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config/config.module.ts';
import { Mem0Client } from '../src/memory/mem0.client.ts';
import { MemoryManagerService } from '../src/agents/memory-manager.service.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config = () => loadConfig({
  MEM0_BASE_URL: 'https://mem0.example',
  MEM0_API_KEY: 'test-key',
});

describe('Mem0 适配器', () => {
  it('新增记忆只发送 content 与教学元数据', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ results: [{ id: 'mem-1' }] }), { status: 200 });
    }) as typeof fetch;

    const client = new Mem0Client(config());
    assert.equal(client.isConfigured(), true);
    const added = await client.add({
      learnerId: 'learner-1',
      localMemoryId: 'local-mem-1',
      content: '更喜欢先听慢速示范，再自己读。',
      memoryType: 'learning_preference',
      importance: 0.7,
      sourceSessionId: 'session-1',
    });
    assert.equal(added.id, 'mem-1');
    assert.equal(capturedUrl, 'https://mem0.example/v1/memories/');
    assert.deepEqual(capturedBody.messages, [{ role: 'user', content: '更喜欢先听慢速示范，再自己读。' }]);
    assert.equal(capturedBody.user_id, 'learner-1');
    assert.equal(capturedBody.infer, false);
    const metadata = capturedBody.metadata as Record<string, unknown>;
    assert.equal(metadata.local_memory_id, 'local-mem-1');
    assert.equal(metadata.memory_type, 'learning_preference');
    assert.equal(metadata.source_session_id, 'session-1');
  });

  it('检索兼容 results/memories/data 三种返回形态', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      memories: [
        { id: 'm1', memory: '喜欢游戏练习', score: 0.88, metadata: { memory_type: 'learning_preference' } },
        { id: 'm2', content: '不喜欢重复太多', metadata: JSON.stringify({ memory_type: 'encouragement_preference' }) },
      ],
    }), { status: 200 })) as typeof fetch;
    const hits = await new Mem0Client(config()).search({ learnerId: 'learner-1', query: 'apple', limit: 3 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.content, '喜欢游戏练习');
    assert.equal(hits[0]!.score, 0.88);
    assert.equal(hits[1]!.memoryType, 'encouragement_preference');
  });

  it('HTTP 失败时返回空结果而不是伪造记忆', async () => {
    globalThis.fetch = (async () => new Response('upstream error', { status: 503 })) as typeof fetch;
    const client = new Mem0Client(config());
    assert.deepEqual(await client.search({ learnerId: 'learner-1', query: 'apple', limit: 3 }), []);
    assert.equal(await client.delete('mem-1'), false);
  });

  it('修正记忆时同步外部文本并保留本地回指', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = String(init?.method ?? '');
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new Mem0Client(config());
    const updated = await client.update('mem-1', {
      localMemoryId: 'local-mem-1',
      content: '更喜欢看图后再跟读。',
      memoryType: 'learning_preference',
      importance: 0.6,
    });
    assert.equal(updated, true);
    assert.equal(capturedUrl, 'https://mem0.example/v1/memories/mem-1/');
    assert.equal(capturedMethod, 'PUT');
    assert.equal(capturedBody.text, '更喜欢看图后再跟读。');
    assert.equal((capturedBody.metadata as Record<string, unknown>).local_memory_id, 'local-mem-1');
  });
});

describe('MemoryManager L3 检索', () => {
  it('Mem0 有结果时只采用能回指本地审计行的记忆', async () => {
    const prisma = {
      interaction_memories: {
        findMany: async () => [{
          id: 'local-mem-1',
          content: '喜欢先听慢速示范。',
          memoryType: 'learning_preference',
          importance: 0.8,
        }],
      },
    };
    const mem0 = {
      isConfigured: () => true,
      search: async () => [{
        id: 'm1',
        content: 'Mem0 可能改写过这句话，但不能直接进课堂。',
        score: 0.9,
        memoryType: 'learning_preference',
        metadata: { local_memory_id: 'local-mem-1' },
      }],
    };
    const service = new MemoryManagerService(prisma as never, {} as never, {} as never, mem0 as never);
    const memories = await service.retrieveRelevantMemories({
      learnerId: 'learner-1',
      query: 'apple',
      limit: 3,
    });
    assert.deepEqual(memories, [{
      content: '喜欢先听慢速示范。',
      memoryType: 'learning_preference',
      importance: 0.8,
    }]);
  });

  it('Mem0 返回无本地回指的残留记忆时，回落 PostgreSQL 而不是注入外部文本', async () => {
    const prisma = {
      interaction_memories: {
        findMany: async (args: { where?: { id?: unknown } }) => args.where?.id
          ? []
          : [{
              content: '喜欢游戏练习。',
              memoryType: 'learning_preference',
              importance: 0.6,
            }],
      },
    };
    const mem0 = {
      isConfigured: () => true,
      search: async () => [{
        id: 'm-orphan',
        content: '外部残留的旧偏好。',
        score: 0.9,
        memoryType: 'learning_preference',
        metadata: { local_memory_id: 'local-deleted' },
      }],
    };
    const service = new MemoryManagerService(prisma as never, {} as never, {} as never, mem0 as never);
    const memories = await service.retrieveRelevantMemories({
      learnerId: 'learner-1',
      query: 'apple',
      limit: 3,
    });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.content, '喜欢游戏练习。');
  });

  it('Mem0 无结果时回落 PostgreSQL 关系表', async () => {
    const prisma = {
      interaction_memories: {
        findMany: async () => [{
          content: '喜欢游戏练习。',
          memoryType: 'learning_preference',
          importance: 0.6,
        }],
      },
    };
    const mem0 = {
      isConfigured: () => true,
      search: async () => [],
    };
    const service = new MemoryManagerService(prisma as never, {} as never, {} as never, mem0 as never);
    const memories = await service.retrieveRelevantMemories({
      learnerId: 'learner-1',
      query: 'apple',
      limit: 3,
    });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.content, '喜欢游戏练习。');
  });
});
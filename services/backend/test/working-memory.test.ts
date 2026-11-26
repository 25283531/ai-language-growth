/**
 * L1 工作记忆回归：
 *  - 未配置 Redis 时必须静默回落到数据库路径，不抛错、不阻断开课；
 *  - 最近对话只保留有限条数并裁剪长度，避免 Redis 成为第二份长期对话档案；
 *  - 快照读取会校验 lessonSessionId，拒绝串课。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/config.module.ts';
import {
  WorkingMemoryService,
  appendWorkingMemoryTurn,
  trimWorkingMemoryText,
} from '../src/memory/working-memory.service.ts';

describe('L1 工作记忆', () => {
  it('未配置 Redis 时 get/save/health 安全回落', async () => {
    const service = new WorkingMemoryService(loadConfig({ REDIS_URL: '' }));
    assert.equal(service.isConfigured(), false);
    assert.equal(await service.get('lesson-1'), null);
    assert.equal(await service.save({
      version: 1,
      lessonSessionId: 'lesson-1',
      learnerId: 'learner-1',
      topicId: 'topic-greetings',
      turnCount: 0,
      currentActivityId: null,
      currentReviewScheduleId: null,
      currentDirective: null,
      recentTurns: [],
      updatedAt: new Date().toISOString(),
    }), false);
    assert.deepEqual(await service.health(), {
      configured: false,
      reachable: false,
      ttlSeconds: 21600,
    });
  });

  it('快照 lessonSessionId 不匹配时拒绝串课', async () => {
    const service = new WorkingMemoryService(loadConfig({ REDIS_URL: 'redis://127.0.0.1:6379' }));
    (service as unknown as { client: unknown }).client = {
      status: 'ready',
      get: async () => JSON.stringify({
        version: 1,
        lessonSessionId: 'lesson-2',
        learnerId: 'learner-1',
        topicId: 'topic-greetings',
        turnCount: 1,
        recentTurns: [],
      }),
    };
    assert.equal(await service.get('lesson-1'), null);
  });

  it('最近对话按上限保留，并对单轮文本裁剪', () => {
    let turns = [] as Parameters<typeof appendWorkingMemoryTurn>[0];
    for (let index = 0; index < 12; index += 1) {
      turns = appendWorkingMemoryTurn(turns, {
        at: new Date(index * 1000).toISOString(),
        intent: 'learning_answer',
        childText: `child-${index}`,
        teacherText: `teacher-${index}`,
      });
    }
    assert.equal(turns.length, 8);
    assert.equal(turns[0]!.childText, 'child-4');
    assert.equal(turns[7]!.teacherText, 'teacher-11');

    const long = `${'a'.repeat(300)}   b`;
    assert.equal(trimWorkingMemoryText(long).length, 240);
    assert.equal(trimWorkingMemoryText('  hello   world  '), 'hello world');
  });
});
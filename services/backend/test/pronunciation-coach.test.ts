import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PronunciationCoachService,
  deterministicCoaching,
} from '../src/agents/pronunciation-coach.service.ts';

const decision = {
  level: 'L1',
  serviceKind: 'llm',
  providerAlias: 'mock_llm',
  modelAlias: 'mock-llm',
  maxRetries: 0,
  timeoutMs: 8000,
  fallbackAliases: [],
} as never;

function makeService(content: string, calls: { usage: number }) {
  const gateway = {
    llm: async () => ({
      content,
      providerAlias: 'mock_llm',
      modelAlias: 'mock-llm',
      inputTokens: 20,
      outputTokens: 30,
      latencyMs: 5,
    }),
  };
  const router = {
    route: async () => decision,
    recordUsage: async () => { calls.usage += 1; },
  };
  return new PronunciationCoachService(gateway as never, router as never);
}

describe('发音教练（评分 → 文本模型 → 孩子听得懂的话）', () => {
  it('把本次分数、错误点和上次分数交给模型，拼成一句可直接 TTS 的反馈', async () => {
    const calls = { usage: 0 };
    const service = makeService(JSON.stringify({
      progress: '比上次进步了 8 分，th 比刚才清楚。',
      advice: '把舌尖轻轻放在牙齿之间，再读 three。',
      encouragement: '再读一次试试吧。',
    }), calls);
    const result = await service.createCorrection({
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      targetText: 'three',
      score: 60,
      errorUnits: [{ unit: 'th', kind: 'phoneme', detail: 'heard=s' }],
      previousScore: 52,
      attemptIndex: 2,
    });

    assert.equal(result.fromModel, true);
    assert.equal(result.progress, '比上次进步了 8 分，th 比刚才清楚。');
    assert.match(result.displayText, /three/);
    assert.match(result.displayText, /再读一次/);
    assert.equal(calls.usage, 1);
  });

  it('模型返回坏 JSON 时回退到确定性文案，不中断课堂', async () => {
    const calls = { usage: 0 };
    const service = makeService('not json', calls);
    const result = await service.createCorrection({
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      targetText: 'apple',
      score: 48,
      errorUnits: [{ unit: 'æ', kind: 'phoneme', detail: null }],
      previousScore: 48,
    });

    assert.equal(result.fromModel, false);
    assert.match(result.displayText, /apple/);
    assert.match(result.displayText, /æ/);
  });

  it('没有错误单元也要讲解：只有分数时同样调用模型做对比', async () => {
    const calls = { usage: 0 };
    const service = makeService(JSON.stringify({
      progress: '这次 80 分，比上次稳。',
      advice: '整句再连一遍，别停顿。',
      encouragement: '再读一次试试吧。',
    }), calls);
    const result = await service.createCorrection({
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      targetText: 'hello',
      score: 80,
      errorUnits: [],
      previousScore: 74,
      attemptIndex: 3,
    });

    assert.equal(calls.usage, 1);
    assert.equal(result.fromModel, true);
    assert.match(result.displayText, /80/);
  });

  it('分数下降时兜底文案不编造进步', () => {
    const coaching = deterministicCoaching({
      targetText: 'hello',
      score: 61,
      errorUnits: [],
      previousScore: 72,
    });
    assert.doesNotMatch(coaching.progress, /进步/);
    assert.match(coaching.displayText, /再读一次/);
  });
});

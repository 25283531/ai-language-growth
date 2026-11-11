import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PronunciationCoachService } from '../src/agents/pronunciation-coach.service.ts';

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

describe('发音纠正教练', () => {
  it('把结构化错误交给文本模型，并压成一句可直接 TTS 的引导', async () => {
    const calls = { usage: 0 };
    const service = makeService(JSON.stringify({
      focus: 'th',
      correction: '把舌尖轻轻放在牙齿之间，再发 three。',
      encouragement: '慢一点就更好。',
    }), calls);
    const result = await service.createCorrection({
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      targetText: 'three',
      score: 52,
      errorUnits: [{ unit: 'th', kind: 'phoneme', detail: 'heard=s' }],
    });

    assert.equal(result.focus, 'th');
    assert.match(result.displayText, /three/);
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
    });

    assert.match(result.displayText, /apple/);
    assert.match(result.displayText, /æ/);
  });

  it('没有错误单元时不调用模型，直接给确定性文案', async () => {
    const calls = { usage: 0 };
    const service = makeService('{}', calls);
    const result = await service.createCorrection({
      learnerId: 'learner-1',
      lessonSessionId: 'session-1',
      targetText: 'hello',
      score: 80,
      errorUnits: [],
    });

    assert.match(result.displayText, /hello/);
    assert.equal(calls.usage, 0);
  });
});

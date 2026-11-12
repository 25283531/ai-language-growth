import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import type { UsageRecord } from '@alg/shared-contracts';
import { SpeechController } from '../src/speech/speech.controller.ts';

const decision = {
  level: 'L1',
  serviceKind: 'asr',
  providerAlias: 'configured_asr',
  modelAlias: 'asr-model',
  maxRetries: 0,
  timeoutMs: 8000,
  fallbackAliases: [],
} as never;

function request(headers: Record<string, string> = {}): Request {
  return {
    headers: {
      authorization: 'Bearer test-token',
      'x-learner-id': 'learner-1',
      'x-speech-quota-reservation': 'reservation-1',
      ...headers,
    },
  } as unknown as Request;
}

function asrResult(overrides: Record<string, unknown> = {}) {
  return {
    transcript: 'hello',
    confidence: 0.9,
    seconds: 1.5,
    latencyMs: 12,
    providerAlias: 'configured_asr',
    modelAlias: 'asr-model',
    suspect: false,
    ...overrides,
  };
}

function pass(result: ReturnType<typeof asrResult>, effectiveLevel = 'L1') {
  return {
    result,
    effectiveLevel,
    providerAlias: result.providerAlias,
    latencyMs: result.latencyMs,
    degraded: false,
    reasons: [],
  };
}

function makeHarness(input: {
  trace?: { result: ReturnType<typeof asrResult>; passes: ReturnType<typeof pass>[] };
  pronunciation?: Record<string, unknown>;
  tts?: Record<string, unknown>;
}) {
  const usage: UsageRecord[] = [];
  const checkedSessions: string[] = [];
  const gateway = {
    tts: async () => ({
      audioRef: 'mock://tts/usage-test',
      characters: 12,
      latencyMs: 11,
      providerAlias: 'configured_tts',
      modelAlias: 'tts-model',
      cached: false,
      ...(input.tts ?? {}),
    }),
    asrWithTrace: async () =>
      input.trace ?? { result: asrResult(), passes: [pass(asrResult())] },
    pronunciation: async () =>
      input.pronunciation ?? {
        score: 88,
        passed: true,
        units: [],
        latencyMs: 9,
        providerAlias: 'configured_pronunciation',
        modelAlias: 'pronunciation-model',
      },
  };
  const router = {
    route: async (routeInput: { serviceKind: string }) => ({
      ...decision,
      serviceKind: routeInput.serviceKind,
    }),
    recordUsage: async (record: UsageRecord) => {
      usage.push(record);
    },
  };
  const quota = { assertReservation: async () => {} };
  const auth = {
    assertLearnerOwnership: async () => 'user-1',
    assertLessonSessionOwnership: async (
      _token: string | undefined,
      _learnerId: string,
      lessonSessionId: string,
    ) => {
      checkedSessions.push(lessonSessionId);
    },
  };
  return {
    controller: new SpeechController(
      gateway as never,
      router as never,
      quota as never,
      auth as never,
    ),
    usage,
    checkedSessions,
  };
}

describe('直连语音接口入账', () => {
  it('synthesize 写一条 TTS 字符账，不混入 ASR/发音', async () => {
    const harness = makeHarness({ tts: { characters: 12 } });

    await harness.controller.synthesize(
      { text: 'hello teacher' },
      request(),
    );

    assert.equal(harness.usage.length, 1);
    assert.equal(harness.usage[0]?.learnerId, 'learner-1');
    assert.equal(harness.usage[0]?.lessonSessionId, null);
    assert.equal(harness.usage[0]?.serviceKind, 'tts');
    assert.equal(harness.usage[0]?.taskRoute, 'tts.dynamic_teaching');
    assert.equal(harness.usage[0]?.ttsCharacters, 12);
    assert.equal(harness.usage[0]?.asrSeconds, 0);
    assert.equal(harness.usage[0]?.pronunciationCalls, 0);
    assert.equal(harness.usage[0]?.level, 'L1');
  });

  it('TTS 缓存命中仍保留调用行，但字符数记 0', async () => {
    const harness = makeHarness({
      tts: {
        characters: 0,
        cached: true,
        latencyMs: 0,
        providerAlias: 'configured_tts',
        modelAlias: 'tts-model',
      },
    });

    await harness.controller.synthesize({ text: 'hello teacher' }, request());

    assert.equal(harness.usage.length, 1);
    assert.equal(harness.usage[0]?.serviceKind, 'tts');
    assert.equal(harness.usage[0]?.ttsCharacters, 0);
  });

  it('recognize 写一条带 learner/session/ASR 秒数的账', async () => {
    const harness = makeHarness({});
    await harness.controller.recognize(
      { audioRef: 'data:audio/wav;base64,AA==', lessonSessionId: 'session-1' },
      request(),
    );

    assert.equal(harness.usage.length, 1);
    assert.deepEqual(harness.checkedSessions, ['session-1']);
    assert.equal(harness.usage[0]?.learnerId, 'learner-1');
    assert.equal(harness.usage[0]?.lessonSessionId, 'session-1');
    assert.equal(harness.usage[0]?.serviceKind, 'asr');
    assert.equal(harness.usage[0]?.taskRoute, 'asr.free_speech');
    assert.equal(harness.usage[0]?.asrSeconds, 1.5);
    assert.equal(harness.usage[0]?.pronunciationCalls, 0);
    assert.equal(harness.usage[0]?.level, 'L1');
  });

  it('ASR suspect 触发二次高质量识别时按两次 pass 各写一条', async () => {
    const first = asrResult({
      transcript: '',
      seconds: 1,
      suspect: true,
    });
    const second = asrResult({
      transcript: 'hello there',
      seconds: 2,
      providerAlias: 'configured_asr_hq',
      modelAlias: 'asr-hq-model',
      suspect: false,
    });
    const harness = makeHarness({
      trace: {
        result: second,
        passes: [pass(first, 'L1'), pass(second, 'L2')],
      },
    });

    await harness.controller.recognize(
      { audioRef: 'data:audio/wav;base64,AA==' },
      request(),
    );

    assert.equal(harness.usage.length, 2);
    assert.deepEqual(harness.usage.map((record) => record.asrSeconds), [1, 2]);
    assert.deepEqual(harness.usage.map((record) => record.level), ['L1', 'L2']);
    assert.deepEqual(
      harness.usage.map((record) => record.providerAlias),
      ['configured_asr', 'configured_asr_hq'],
    );
    assert.notEqual(harness.usage[0]?.id, harness.usage[1]?.id);
  });

  it('evaluate 写一条发音调用，不混入 ASR 秒数', async () => {
    const harness = makeHarness({});

    await harness.controller.evaluate(
      {
        audioRef: 'data:audio/wav;base64,AA==',
        targetText: 'hello',
        lessonSessionId: 'session-2',
      },
      request(),
    );

    assert.equal(harness.usage.length, 1);
    assert.equal(harness.usage[0]?.serviceKind, 'pronunciation');
    assert.equal(harness.usage[0]?.taskRoute, 'pronunciation.phoneme');
    assert.equal(harness.usage[0]?.pronunciationCalls, 1);
    assert.equal(harness.usage[0]?.asrSeconds, 0);
    assert.equal(harness.usage[0]?.lessonSessionId, 'session-2');
  });
});

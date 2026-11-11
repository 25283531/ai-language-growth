/**
 * 韵律契约回归：一轮教师话语 = 一次 TTS 请求 = 一个连贯音频。
 *
 * 依据 D-014 评审定稿：不得按固定字数 / 单词 / 短句 / 文章段落切分逐段合成，
 * 否则会出现段首音高重置、跨句语调丢失。本测试用桩网关直接驱动
 * OrchestratorService.synthesize，断言：
 *  - synthesisCallCount === 1（不是「N 次请求拼成一个文件」）；
 *  - speech.segments.length === 1，且 audioRef === segments[0].audioRef；
 *  - teacherUtterance 与 demonstrationText 以单个空格连接后整体送合成；
 *  - 语速量化收敛到 0.05 档位，与返回字段一致；
 *  - 作用域默认 fail-closed 到 PRIVATE_DYNAMIC，PUBLIC 分支不带 learnerId。
 *
 * 全部离线：桩网关 + 桩路由，不连接数据库、不调用真实供应商。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoutingDecision, TeachingDirective, TtsRequest, TtsResponse } from '@alg/shared-contracts';
import { OrchestratorService } from '../src/orchestrator/orchestrator.service.ts';

const decision: RoutingDecision = {
  level: 'L1',
  providerAlias: 'configured_tts_paid',
  modelAlias: 'paid-model',
  strategy: 'primary',
  fellBack: false,
  escalationSignals: [],
};

const audioRef = `/api/v1/media/audio/${'f'.repeat(24)}.mp3`;

function directive(overrides: Partial<TeachingDirective> = {}): TeachingDirective {
  return {
    targetSkillNodeId: 'LA.LISTEN.greeting_core',
    taskType: 'repeat_word',
    isReview: false,
    targetWords: ['hello'],
    targetPhrases: [],
    teacherUtterance: '小朋友，先听老师说一遍 hello。',
    demonstrationText: 'Hello!',
    expectedResponse: 'repeat',
    assessmentRules: [],
    voice: {
      teacherSpeed: 0.47,
      voiceStyle: 'gentle',
      pauseAfterSentenceMs: 800,
      pronunciationMode: 'slow_clear',
    },
    safetyNotes: '不嘲笑、不施压。',
    ...overrides,
  } as TeachingDirective;
}

function makeService() {
  const calls: TtsRequest[] = [];
  const gateway = {
    ttsWithResult: async (request: TtsRequest) => {
      calls.push(request);
      const result: TtsResponse = {
        audioRef,
        characters: [...request.text].length,
        latencyMs: 1,
        providerAlias: 'configured_tts_paid',
        modelAlias: 'paid-model',
        cached: false,
      };
      return {
        result,
        degraded: false,
        reasons: [],
        effectiveLevel: 'L1' as const,
        providerAlias: 'configured_tts_paid',
        latencyMs: 1,
      };
    },
  };
  const router = { route: async () => decision };
  const service = new OrchestratorService(
    {} as never,
    {} as never,
    {} as never,
    gateway as never,
    router as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, calls };
}

function synthesize(
  service: OrchestratorService,
  input: TeachingDirective,
  scope: Record<string, unknown>,
) {
  // synthesize 是内部方法；这里直接驱动它，避免为一次合成拉起整套 DB 依赖。
  return (service as unknown as {
    synthesize(
      directive: TeachingDirective,
      decision: RoutingDecision,
      scope: Record<string, unknown>,
    ): Promise<{ speech: { audioRef: string | null; teacherSpeed: number; segments: Array<{ audioRef: string | null }>; scope?: Record<string, unknown> } }>;
  }).synthesize(input, decision, scope);
}

const privateScope = {
  topicId: 'topic-greetings',
  contentId: 'act-greet-hello',
  contentVersion: 'content-v1',
  learnerId: 'learner-a',
  lessonSessionId: 'session-a',
  publicCurriculum: false,
};

describe('整轮单次合成的韵律契约', () => {
  it('一轮教师话语只发起一次 TTS，返回单段且 audioRef 对齐', async () => {
    const { service, calls } = makeService();
    const result = await synthesize(service, directive(), privateScope);

    assert.equal(calls.length, 1, '整轮必须一次合成，禁止逐段请求');
    assert.equal(result.speech.segments.length, 1, 'segments 只保留 1 项兼容客户端');
    assert.equal(result.speech.audioRef, audioRef);
    assert.equal(result.speech.segments[0]!.audioRef, result.speech.audioRef);
  });

  it('教师引导与示范内容整体送合成（单个空格连接）', async () => {
    const { service, calls } = makeService();
    await synthesize(service, directive(), privateScope);
    assert.equal(calls[0]!.text, '小朋友，先听老师说一遍 hello。 Hello!');
    assert.equal(calls[0]!.text.includes('|'), false, '不得引入分段分隔符');
  });

  it('长句（远超 120 码点）仍为单次请求、单段音频', async () => {
    const long = `${'This is a long teacher sentence. '.repeat(8)}Hello!`;
    const { service, calls } = makeService();
    const result = await synthesize(service, directive({ demonstrationText: long }), privateScope);
    assert.ok([...calls[0]!.text].length > 120);
    assert.equal(calls.length, 1, '不得按 120 码点切分');
    assert.equal(result.speech.segments.length, 1);
  });

  it('语速量化到 0.05 档位，请求与响应保持一致', async () => {
    const { service, calls } = makeService();
    const result = await synthesize(service, directive(), privateScope);
    assert.equal(calls[0]!.voice.teacherSpeed, 0.45);
    assert.equal(result.speech.teacherSpeed, 0.45);
  });

  it('默认 fail-closed 到 PRIVATE_DYNAMIC，并携带归属与课堂标识', async () => {
    const { service, calls } = makeService();
    const result = await synthesize(service, directive(), privateScope);
    assert.equal(calls[0]!.cacheScope?.scope, 'PRIVATE_DYNAMIC');
    assert.equal(calls[0]!.cacheScope?.learnerId, 'learner-a');
    assert.equal(calls[0]!.cacheScope?.lessonSessionId, 'session-a');
    assert.equal(result.speech.scope?.kind, 'PRIVATE_DYNAMIC');
  });

  it('PUBLIC_CURRICULUM 分支绝不携带 learnerId / lessonSessionId', async () => {
    const { service, calls } = makeService();
    const result = await synthesize(service, directive(), { ...privateScope, publicCurriculum: true });
    assert.equal(calls[0]!.cacheScope?.scope, 'PUBLIC_CURRICULUM');
    assert.equal(calls[0]!.cacheScope?.learnerId, undefined);
    assert.equal(calls[0]!.cacheScope?.lessonSessionId, undefined);
    assert.equal(result.speech.scope?.kind, 'PUBLIC_CURRICULUM');
  });

  it('PUBLIC_CURRICULUM 固定课程使用统一音色档，不受某个孩子人格语气影响', async () => {
    const { service, calls } = makeService();
    await synthesize(service, directive({
      voice: {
        teacherSpeed: 0.47,
        voiceStyle: 'encouraging',
        pauseAfterSentenceMs: 1800,
        pronunciationMode: 'syllable_by_syllable',
      },
    }), { ...privateScope, publicCurriculum: true });
    assert.equal(calls[0]!.voice.voiceStyle, 'gentle');
    assert.equal(calls[0]!.voice.pauseAfterSentenceMs, 1000);
    assert.equal(calls[0]!.voice.pronunciationMode, 'slow_clear');
    assert.equal(calls[0]!.voice.teacherSpeed, 0.45);
  });
});

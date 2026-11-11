/**
 * 课程级 TTS 缓存作用域回归（D-014 / D-026 评审定稿）。
 *
 * 覆盖：
 *  - 不同课程（topicId / contentId）相同文本不得共享音频；
 *  - 同一课程、不同用户、不同时间（PUBLIC_CURRICULUM）必须复用；
 *  - PRIVATE_DYNAMIC 按学习者隔离，绝不跨用户命中；
 *  - contentVersion / voiceProfileVersion 变更让旧音频失效；
 *  - 不影响声学结果的 pauseAfterSentenceMs 变化不得产生新音频、不得重复计费；
 *  - voiceStyle 变化属于声学变化，必须换键。
 *
 * 全部使用进程内 mock 适配器与临时目录，不调用任何真实 TTS 供应商。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RoutingDecision, TtsRequest } from '@alg/shared-contracts';
import { audioFingerprint } from '@alg/ai-provider-sdk';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.ts';

type Internals = AiGatewayService & {
  registry: { register(kind: string, adapter: unknown): void };
  runtimeCandidates: { llm: string[]; tts: string[]; asr: string[] };
};

const decision: RoutingDecision = {
  level: 'L1',
  providerAlias: 'configured_tts_paid',
  modelAlias: 'paid-model',
  strategy: 'primary',
  fellBack: false,
  escalationSignals: [],
};

const voice = {
  teacherSpeed: 0.65,
  voiceStyle: 'gentle' as const,
  pauseAfterSentenceMs: 800,
  pronunciationMode: 'slow_clear' as const,
};

const publicScope = {
  scope: 'PUBLIC_CURRICULUM' as const,
  topicId: 'topic-greetings',
  contentId: 'act-greet-hello',
  contentVersion: 'content-v1',
};

const privateScope = {
  scope: 'PRIVATE_DYNAMIC' as const,
  topicId: 'topic-greetings',
  contentId: 'act-greet-hello',
  contentVersion: 'content-v1',
  learnerId: 'learner-a',
  lessonSessionId: 'session-a',
};

let audioDir: string;

before(() => {
  audioDir = mkdtempSync(join(tmpdir(), 'alg-tts-scope-'));
  process.env.AI_AUDIO_DIR = audioDir;
});

after(() => {
  delete process.env.AI_AUDIO_DIR;
  delete process.env.TTS_VOICE_PROFILE_VERSION;
  rmSync(audioDir, { recursive: true, force: true });
});

function makeGateway() {
  const calls: TtsRequest[] = [];
  const gateway = new AiGatewayService({} as never, {} as never, {
    media_assets: { upsert: async () => ({}) },
  } as never) as unknown as Internals;
  gateway.registry.register('tts', {
    alias: 'configured_tts_paid',
    serviceKind: 'tts',
    capabilities: { supportsStructuredOutput: false, supportsStreaming: false },
    pricing: { checkedAt: '2026-11-11' },
    invoke: async (request: TtsRequest) => {
      calls.push(request);
      return {
        audioRef: 'https://media.example/tts/audio.mp3',
        characters: [...request.text].length,
        latencyMs: 1,
        providerAlias: 'configured_tts_paid',
        modelAlias: 'paid-model',
        cached: false,
      };
    },
  });
  gateway.runtimeCandidates.tts = ['configured_tts_paid'];
  return { gateway, calls };
}

function request(overrides: Partial<TtsRequest> = {}): TtsRequest {
  return {
    text: 'Hello! Nice to meet you.',
    voice,
    voiceIdentity: 'teacher_default',
    cacheScope: publicScope,
    ...overrides,
  };
}

describe('课程级 TTS 缓存作用域', () => {
  it('不同课程相同文本不共享音频（topicId / contentId 进键）', async () => {
    const { gateway, calls } = makeGateway();
    await gateway.ttsWithResult(request(), decision);
    await gateway.ttsWithResult(request({ cacheScope: { ...publicScope, topicId: 'topic-objects' } }), decision);
    await gateway.ttsWithResult(request({ cacheScope: { ...publicScope, contentId: 'act-other' } }), decision);
    assert.equal(calls.length, 3, '不同课程 / 不同活动不得命中同一份音频');
  });

  it('同一课程、不同用户、不同时间复用同一份已审核音频', async () => {
    const { gateway, calls } = makeGateway();
    await gateway.ttsWithResult(request(), decision);
    // PUBLIC 分支即使调用方误带了 learnerId，也不得进键。
    await gateway.ttsWithResult(request({ cacheScope: { ...publicScope, learnerId: 'learner-b' } }), decision);
    assert.equal(calls.length, 1, 'PUBLIC_CURRICULUM 必须跨学习者复用');
    const peek = await gateway.peekTtsCache(request({ cacheScope: { ...publicScope, learnerId: 'learner-c' } }));
    assert.equal(peek?.cached, true);
  });

  it('PRIVATE_DYNAMIC 按学习者隔离，绝不跨用户命中', async () => {
    const { gateway, calls } = makeGateway();
    await gateway.ttsWithResult(request({ cacheScope: privateScope }), decision);
    await gateway.ttsWithResult(request({
      cacheScope: { ...privateScope, learnerId: 'learner-b', lessonSessionId: 'session-b' },
    }), decision);
    assert.equal(calls.length, 2, 'PRIVATE_DYNAMIC 不得跨学习者复用');
    assert.equal(await gateway.peekTtsCache(request({ cacheScope: privateScope })).then((hit) => hit?.cached), true);
    // 第三个学习者既未合成也无归属，必须按 miss 处理。
    assert.equal(await gateway.peekTtsCache(request({
      cacheScope: { ...privateScope, learnerId: 'learner-c', lessonSessionId: 'session-c' },
    })), null);
  });

  it('contentVersion 变更让旧课程音频失效', async () => {
    const { gateway, calls } = makeGateway();
    await gateway.ttsWithResult(request(), decision);
    await gateway.ttsWithResult(request({ cacheScope: { ...publicScope, contentVersion: 'content-v2' } }), decision);
    assert.equal(calls.length, 2, '发布内容变更必须重新合成');
  });

  it('voiceProfileVersion 变更让旧音色音频整体失效', async () => {
    const { gateway, calls } = makeGateway();
    delete process.env.TTS_VOICE_PROFILE_VERSION;
    await gateway.ttsWithResult(request(), decision);
    process.env.TTS_VOICE_PROFILE_VERSION = '2';
    try {
      await gateway.ttsWithResult(request(), decision);
    } finally {
      delete process.env.TTS_VOICE_PROFILE_VERSION;
    }
    assert.equal(calls.length, 2, '音色档案升版本不得静默返回旧音频');
  });

  it('pauseAfterSentenceMs 不改变声学结果，不得产生新音频或重复计费', async () => {
    const { gateway, calls } = makeGateway();
    await gateway.ttsWithResult(request(), decision);
    await gateway.ttsWithResult(request({ voice: { ...voice, pauseAfterSentenceMs: 1500 } }), decision);
    assert.equal(calls.length, 1, '暂停参数属播放端行为，不得进入缓存键');
  });

  it('voiceStyle 属于声学维度，变更必须换键', async () => {
    const { gateway, calls } = makeGateway();
    await gateway.ttsWithResult(request(), decision);
    await gateway.ttsWithResult(request({ voice: { ...voice, voiceStyle: 'lively' } }), decision);
    assert.equal(calls.length, 2);
  });

  it('物理音频指纹：PRIVATE 按学习者隔离，PUBLIC 忽略 learnerId，pause 不影响指纹', () => {
    const fingerprint = (cacheScope: Record<string, unknown>, voiceOverride = voice) => audioFingerprint(
      { text: 'Hello! Nice to meet you.', voice: voiceOverride, cacheScope },
      { speed: 0.65, voice: 'teacher', modelAlias: 'paid-model' },
      {},
    );
    const privateA = { ...privateScope, learnerId: 'learner-a' };
    const privateB = { ...privateScope, learnerId: 'learner-b' };
    assert.notEqual(fingerprint(privateA), fingerprint(privateB), '两个孩子的私人音频不得共用一个文件名');
    const publicA = { ...publicScope, learnerId: 'learner-a' };
    const publicB = { ...publicScope, learnerId: 'learner-b' };
    assert.equal(fingerprint(publicA), fingerprint(publicB), 'PUBLIC 课程音频必须跨学习者复用');
    assert.equal(fingerprint(privateA), fingerprint(privateA, { ...voice, pauseAfterSentenceMs: 1500 }));
  });
});

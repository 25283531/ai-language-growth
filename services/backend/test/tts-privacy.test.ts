/**
 * 语音资产隐私与归属回归（评审 P0-B 门禁）。
 *
 * 覆盖两层防线：
 *  1. 网关缓存：PRIVATE_DYNAMIC 只能被归属学习者命中；PUBLIC_CURRICULUM 可跨用户；
 *     过期 / 音频字节被替换 / 旧格式索引一律按 miss 处理，绝不下发。
 *  2. 媒体下载：公共目录音频按 media_assets 的 scope + ownerLearnerId 校验；
 *     儿童录音落在 uploads/<ownerSlug>/，他人即使持有本人有效租约也读不到。
 *
 * 全部离线：mock 适配器 + 临时目录 + 桩 Prisma，不连接数据库、不调用供应商。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Request } from 'express';
import { StreamableFile } from '@nestjs/common';
import { resolveUploadDir } from '@alg/ai-provider-sdk';
import type { RoutingDecision, TtsRequest } from '@alg/shared-contracts';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.ts';
import { MediaController } from '../src/media/media.controller.ts';

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

let audioDir: string;

before(() => {
  audioDir = mkdtempSync(join(tmpdir(), 'alg-tts-privacy-'));
  process.env.AI_AUDIO_DIR = audioDir;
  mkdirSync(audioDir, { recursive: true });
});

after(() => {
  delete process.env.AI_AUDIO_DIR;
  rmSync(audioDir, { recursive: true, force: true });
});

function privateRequest(learnerId: string, ref: string, text = 'Hello, I am Mia.'): TtsRequest {
  return {
    text,
    voice,
    voiceIdentity: 'teacher_default',
    cacheScope: {
      scope: 'PRIVATE_DYNAMIC',
      topicId: 'topic-greetings',
      contentId: 'act-greet-hello',
      contentVersion: 'content-v1',
      learnerId,
      lessonSessionId: `session-${learnerId}`,
    },
  };
}

function makeGateway(ref: string) {
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
        audioRef: ref,
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

function writeAudio(fileName: string, bytes: Buffer | string = Buffer.from('fake-mp3-bytes')): string {
  writeFileSync(join(audioDir, fileName), bytes);
  return `/api/v1/media/audio/${fileName}`;
}

function indexFiles(): string[] {
  return readdirSync(audioDir).filter((name) => /^\.tts-[a-f0-9]{64}\.json$/.test(name));
}

/** 按 audioRef 定位对应的持久化索引（同一临时目录会累积多个用例的索引）。 */
function indexFor(audioRef: string): string {
  for (const name of indexFiles()) {
    const entry = JSON.parse(readFileSync(join(audioDir, name), 'utf8')) as { audioRef?: unknown };
    if (entry.audioRef === audioRef) return name;
  }
  throw new Error(`未找到 ${audioRef} 的持久化索引`);
}

function requestFor(learnerId: string): Request {
  return {
    headers: {
      authorization: 'Bearer test-token',
      'x-learner-id': learnerId,
      'x-speech-quota-reservation': 'reservation-1',
    },
  } as unknown as Request;
}

function makeMediaController(assets: Array<{ scope: string | null; ownerLearnerId: string | null; expiresAt: Date | null }>) {
  return new MediaController(
    { assertReservation: async () => undefined } as never,
    { assertLearnerOwnership: async () => undefined } as never,
    { media_assets: { findMany: async () => assets } } as never,
  );
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: { status?: number; getStatus?: () => number }) => {
    const status = error.status ?? error.getStatus?.();
    return status === 404;
  });
}

function closeStream(file: StreamableFile): void {
  const stream = (file as unknown as { getStream?: () => { destroy?: () => void } }).getStream?.();
  stream?.destroy?.();
}

describe('网关缓存隐私边界', () => {
  it('PRIVATE_DYNAMIC 只命中归属学习者，他人按 miss 处理', async () => {
    const ref = writeAudio(`${'a'.repeat(24)}.mp3`);
    const { gateway } = makeGateway(ref);
    await gateway.ttsWithResult(privateRequest('learner-a', ref), decision);
    assert.equal((await gateway.peekTtsCache(privateRequest('learner-a', ref)))?.cached, true);
    assert.equal(await gateway.peekTtsCache(privateRequest('learner-b', ref)), null);
  });

  it('PUBLIC_CURRICULUM 允许任何学习者命中同一课程音频', async () => {
    const ref = writeAudio(`${'b'.repeat(24)}.mp3`);
    const { gateway } = makeGateway(ref);
    const scope = {
      scope: 'PUBLIC_CURRICULUM' as const,
      topicId: 'topic-greetings',
      contentId: 'act-greet-hello',
      contentVersion: 'content-v1',
    };
    await gateway.ttsWithResult({ text: 'Good morning!', voice, voiceIdentity: 'teacher_default', cacheScope: scope }, decision);
    const hit = await gateway.peekTtsCache({
      text: 'Good morning!',
      voice,
      voiceIdentity: 'teacher_default',
      cacheScope: { ...scope, learnerId: 'learner-z' },
    });
    assert.equal(hit?.cached, true);
  });

  it('过期索引不再下发（PRIVATE TTL）', async () => {
    const ref = writeAudio(`${'c'.repeat(24)}.mp3`);
    const first = makeGateway(ref);
    await first.gateway.ttsWithResult(privateRequest('learner-a', ref, 'expiring utterance'), decision);
    const index = indexFor(ref);
    assert.ok(index, '应写入持久化索引');
    const path = join(audioDir, index);
    const entry = JSON.parse(readFileSync(path, 'utf8')) as { expiresAt: string | null };
    entry.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(path, JSON.stringify(entry), 'utf8');

    const restarted = makeGateway(ref);
    assert.equal(await restarted.gateway.peekTtsCache(privateRequest('learner-a', ref, 'expiring utterance')), null);
  });

  it('音频字节被替换后拒绝命中', async () => {
    const ref = writeAudio(`${'d'.repeat(24)}.mp3`, Buffer.from('original-bytes'));
    const first = makeGateway(ref);
    await first.gateway.ttsWithResult(privateRequest('learner-a', ref, 'tamper check'), decision);
    writeFileSync(join(audioDir, `${'d'.repeat(24)}.mp3`), Buffer.from('tampered-bytes'));

    const restarted = makeGateway(ref);
    assert.equal(await restarted.gateway.peekTtsCache(privateRequest('learner-a', ref, 'tamper check')), null);
  });

  it('旧格式索引（无 keyVersion）一律不命中', async () => {
    const ref = writeAudio(`${'e'.repeat(24)}.mp3`);
    const first = makeGateway(ref);
    await first.gateway.ttsWithResult(privateRequest('learner-a', ref, 'legacy index check'), decision);
    const path = join(audioDir, indexFor(ref));
    const entry = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete entry.keyVersion;
    writeFileSync(path, JSON.stringify(entry), 'utf8');

    const restarted = makeGateway(ref);
    assert.equal(await restarted.gateway.peekTtsCache(privateRequest('learner-a', ref, 'legacy index check')), null);
  });
});

describe('媒体下载归属校验', () => {
  it('别人的 PRIVATE_DYNAMIC 音频：即使持有本人有效租约也返回 404', async () => {
    const fileName = `${'1'.repeat(24)}.mp3`;
    writeAudio(fileName);
    const controller = makeMediaController([
      { scope: 'PRIVATE_DYNAMIC', ownerLearnerId: 'learner-b', expiresAt: null },
    ]);
    await expectNotFound(controller.audio(fileName, requestFor('learner-a')));
  });

  it('本人 PRIVATE_DYNAMIC 音频可读', async () => {
    const fileName = `${'2'.repeat(24)}.mp3`;
    writeAudio(fileName);
    const controller = makeMediaController([
      { scope: 'PRIVATE_DYNAMIC', ownerLearnerId: 'learner-a', expiresAt: null },
    ]);
    const file = await controller.audio(fileName, requestFor('learner-a'));
    assert.ok(file instanceof StreamableFile);
    closeStream(file);
  });

  it('已过期的私人音频按不存在处理', async () => {
    const fileName = `${'3'.repeat(24)}.mp3`;
    writeAudio(fileName);
    const controller = makeMediaController([
      { scope: 'PRIVATE_DYNAMIC', ownerLearnerId: 'learner-a', expiresAt: new Date(Date.now() - 1000) },
    ]);
    await expectNotFound(controller.audio(fileName, requestFor('learner-a')));
  });

  it('PUBLIC_CURRICULUM 课程音频允许其他学习者读取', async () => {
    const fileName = `${'4'.repeat(24)}.mp3`;
    writeAudio(fileName);
    const controller = makeMediaController([
      { scope: 'PUBLIC_CURRICULUM', ownerLearnerId: null, expiresAt: null },
    ]);
    const file = await controller.audio(fileName, requestFor('learner-z'));
    assert.ok(file instanceof StreamableFile);
    closeStream(file);
  });

  it('儿童录音按学习者目录隔离，他人目录内的文件不可读', async () => {
    const fileName = `${'5'.repeat(24)}.mp3`;
    const ownDir = resolveUploadDir('learner-a');
    mkdirSync(ownDir, { recursive: true });
    writeFileSync(join(ownDir, fileName), Buffer.from('learner-a-recording'));

    // 他人（learner-b）请求同一文件名：根目录没有该文件时不得回落到别人的 uploads 目录。
    const controller = makeMediaController([]);
    await expectNotFound(controller.audio(fileName, requestFor('learner-b')));

    // 本人可读自己的录音（优先 uploads/<ownerSlug>）。
    const own = await controller.audio(fileName, requestFor('learner-a'));
    assert.ok(own instanceof StreamableFile);
    closeStream(own);
  });
});

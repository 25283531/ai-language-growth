/**
 * 预生成音频索引命中链路测试（设计文档第 4 节）。
 *
 * 覆盖：
 *  1. 未注入索引服务（等价于 TTS_PREGEN_MODE=off）→ 行为与现状一致，走供应商；
 *  2. 命中 → 不调用供应商、按缓存计 0 字符、下发预生成 audioRef；
 *  3. 命中后回写缓存 → 第二次请求不再查索引；
 *  4. shadow 模式 → 只记录不返回，仍走供应商；
 *  5. 索引说命中但文件缺失 / 字节被替换 → 回落供应商，绝不放出坏音频；
 *  6. 索引未命中（ineligible/miss/disabled）→ 正常走供应商。
 *
 * 隔离要求：每个用例使用独立音频目录。否则前一个用例回写的 `.tts-*.json`
 * 旁车索引会被后一个用例在第 2 步直接命中，测试就测不到索引查询这一步了。
 *
 * 全部使用进程内 mock 适配器与临时目录，不调用任何真实 TTS 供应商。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { RoutingDecision } from '@alg/shared-contracts';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.ts';
import type {
  PregenerationClip,
  PregenerationLookupResult,
} from '../src/speech/pregeneration-index.service.ts';

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
  teacherSpeed: 0.8,
  voiceStyle: 'gentle' as const,
  pauseAfterSentenceMs: 1000,
  pronunciationMode: 'slow_clear' as const,
};

/** 公共课程作用域：预生成索引只对这一类请求生效。 */
const cacheScope = {
  scope: 'PUBLIC_CURRICULUM' as const,
  topicId: 'topic-objects-around',
  contentId: 'content-apple',
  contentVersion: 'v1',
};

const createdDirs: string[] = [];

after(() => {
  delete process.env.AI_AUDIO_DIR;
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

/** 每个用例一个干净的音频目录，避免旁车索引跨用例串味。 */
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'alg-tts-pregen-'));
  createdDirs.push(dir);
  return dir;
}

/** 写一个真实存在的本地音频文件，并返回可在索引里声明的 clip。 */
function writeClip(dir: string, bytes = Buffer.from('ID3-pregenerated-audio-bytes')): PregenerationClip {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const audioFile = `${sha256.slice(0, 24)}.mp3`;
  writeFileSync(join(dir, audioFile), bytes);
  return {
    id: 'clip-1',
    lang: 'en',
    speedTier: 'slow',
    teacherSpeed: 0.8,
    audioFile,
    audioRef: `/api/v1/media/audio/${audioFile}`,
    sha256,
    durationMs: 640,
    bytes: bytes.length,
    voiceId: 'pregenerated_zero_shot',
    engineVersion: 'engine-v1',
  };
}

interface FakeIndex {
  enabled: boolean;
  lookups: number;
  invalidated: string[];
  lookupForTts(input: { text: string; teacherSpeed: number; scope: string }): Promise<PregenerationLookupResult>;
  invalidate(id: string): void;
}

function makeIndex(result: PregenerationLookupResult): FakeIndex {
  return {
    enabled: true,
    lookups: 0,
    invalidated: [],
    async lookupForTts() {
      this.lookups += 1;
      return result;
    },
    invalidate(id: string) {
      this.invalidated.push(id);
    },
  };
}

function makeGateway(dir: string, index?: FakeIndex) {
  process.env.AI_AUDIO_DIR = dir;
  const calls: string[] = [];
  const gateway = new AiGatewayService(
    {} as never,
    {} as never,
    { media_assets: { upsert: async () => ({}) } } as never,
    index as never,
  ) as unknown as Internals;
  gateway.registry.register('tts', {
    alias: 'configured_tts_paid',
    serviceKind: 'tts',
    capabilities: { supportsStructuredOutput: false, supportsStreaming: false },
    pricing: { checkedAt: '2026-11-11' },
    invoke: async (request: { text: string }) => {
      calls.push(request.text);
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

const request = { text: 'apple', voice, voiceIdentity: 'teacher_default', cacheScope };

describe('预生成音频索引命中链路', () => {
  it('未注入索引服务时行为不变，仍走供应商', async () => {
    const { gateway, calls } = makeGateway(makeDir(), undefined);
    const outcome = await gateway.ttsWithResult(request, decision);
    assert.equal(calls.length, 1);
    assert.equal(outcome.result.cached, false);
    assert.equal(gateway.ttsCacheStats().pregenHits, 0);
  });

  it('命中预生成索引：不调供应商、0 字符、下发预生成音频', async () => {
    const dir = makeDir();
    const clip = writeClip(dir);
    const index = makeIndex({ outcome: 'hit', clip });
    const { gateway, calls } = makeGateway(dir, index);
    const outcome = await gateway.ttsWithResult(request, decision);
    assert.equal(calls.length, 0, '命中预生成索引时不得调用供应商');
    assert.equal(outcome.result.audioRef, clip.audioRef);
    assert.equal(outcome.result.cached, true);
    assert.equal(outcome.result.characters, 0);
    assert.equal(outcome.result.providerAlias, 'pregenerated');
    // 预生成音频本身已按档位渲染，客户端不得再变速
    assert.equal(outcome.result.speedMode, 'native');
    assert.equal(outcome.result.playbackRate, 1);
    assert.equal(gateway.ttsCacheStats().pregenHits, 1);
  });

  it('命中后回写缓存：第二次请求不再查索引', async () => {
    const dir = makeDir();
    const clip = writeClip(dir);
    const index = makeIndex({ outcome: 'hit', clip });
    const { gateway } = makeGateway(dir, index);
    await gateway.ttsWithResult(request, decision);
    await gateway.ttsWithResult(request, decision);
    assert.equal(index.lookups, 1, '第二次应命中内存缓存，不再查索引');
  });

  it('shadow 模式只记录不返回，仍走供应商', async () => {
    const dir = makeDir();
    const clip = writeClip(dir);
    const index = makeIndex({ outcome: 'shadow_hit', clip });
    const { gateway, calls } = makeGateway(dir, index);
    const outcome = await gateway.ttsWithResult(request, decision);
    assert.equal(calls.length, 1);
    assert.equal(outcome.result.providerAlias, 'configured_tts_paid');
    assert.equal(gateway.ttsCacheStats().pregenHits, 0);
  });

  it('索引命中但文件缺失：回落供应商，并作废该条索引缓存', async () => {
    const dir = makeDir();
    const clip = writeClip(dir);
    rmSync(join(dir, clip.audioFile));
    const index = makeIndex({ outcome: 'hit', clip });
    const { gateway, calls } = makeGateway(dir, index);
    const outcome = await gateway.ttsWithResult(request, decision);
    assert.equal(calls.length, 1, '坏音频必须回落供应商');
    assert.deepEqual(index.invalidated, [clip.id]);
    assert.equal(outcome.result.providerAlias, 'configured_tts_paid');
  });

  it('索引命中但字节被替换：回落供应商', async () => {
    const dir = makeDir();
    const clip = writeClip(dir);
    writeFileSync(join(dir, clip.audioFile), Buffer.from('tampered-bytes'));
    const index = makeIndex({ outcome: 'hit', clip });
    const { gateway, calls } = makeGateway(dir, index);
    await gateway.ttsWithResult(request, decision);
    assert.equal(calls.length, 1);
    assert.deepEqual(index.invalidated, [clip.id]);
  });

  it('索引未命中（ineligible/miss/disabled）时正常走供应商', async () => {
    for (const outcome of ['ineligible', 'miss', 'disabled'] as const) {
      const { gateway, calls } = makeGateway(makeDir(), makeIndex({ outcome }));
      await gateway.ttsWithResult(request, decision);
      assert.equal(calls.length, 1, `${outcome} 不应拦截供应商调用`);
    }
  });
});

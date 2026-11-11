/**
 * 固定教学内容语音缓存回归测试。
 *
 * 覆盖：冷缓存并发只生成一次、播放前只读探测不触发供应商、参数区分、
 * 服务重启后从磁盘索引恢复、以及文章分段无丢失且不超单次文本上限。
 * 全部使用进程内 mock 适配器与临时目录，不调用任何真实 TTS 供应商。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RoutingDecision } from '@alg/shared-contracts';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.ts';
import { splitTeachingSpeech } from '../src/speech/tts-segments.ts';

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
  audioDir = mkdtempSync(join(tmpdir(), 'alg-tts-cache-'));
  process.env.AI_AUDIO_DIR = audioDir;
});

after(() => {
  delete process.env.AI_AUDIO_DIR;
  rmSync(audioDir, { recursive: true, force: true });
});

function makeGateway(ref = 'https://media.example/tts/audio.mp3') {
  const calls: string[] = [];
  const gateway = new AiGatewayService({} as never, {} as never, {
    media_assets: { upsert: async () => ({}) },
  } as never) as unknown as Internals;
  gateway.registry.register('tts', {
    alias: 'configured_tts_paid',
    serviceKind: 'tts',
    capabilities: { supportsStructuredOutput: false, supportsStreaming: false },
    pricing: { checkedAt: '2026-11-11' },
    invoke: async (request: { text: string }) => {
      calls.push(request.text);
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

describe('服务端 TTS 缓存', () => {
  it('播放前只读探测在冷缓存返回 null，且不调用供应商', async () => {
    const { gateway, calls } = makeGateway();
    const hit = await gateway.peekTtsCache({ text: 'hello', voice, voiceIdentity: 'teacher_default' });
    assert.equal(hit, null);
    assert.equal(calls.length, 0);
  });

  it('同一文本冷缓存并发 8 次只生成 1 次音频', async () => {
    const { gateway, calls } = makeGateway();
    const request = { text: 'hello', voice, voiceIdentity: 'teacher_default' };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => gateway.ttsWithResult(request, decision)),
    );
    assert.equal(calls.length, 1, '并发 miss 必须由 single-flight 合并');
    assert.equal(results.filter((item) => !item.result.cached).length, 1);
    assert.equal(results.filter((item) => item.result.cached).length, 7);
    assert.ok(results.every((item) => item.result.audioRef === 'https://media.example/tts/audio.mp3'));
    assert.ok(results.every((item) => item.result.providerAlias === 'configured_tts_paid'));
  });

  it('合成后播放前探测命中缓存，且命中不重新计费', async () => {
    const { gateway, calls } = makeGateway();
    const request = { text: 'hello', voice, voiceIdentity: 'teacher_default' };
    await gateway.ttsWithResult(request, decision);
    const hit = await gateway.peekTtsCache(request);
    assert.equal(calls.length, 1);
    assert.equal(hit?.cached, true);
    assert.equal(hit?.characters, 0);
    assert.equal(hit?.audioRef, 'https://media.example/tts/audio.mp3');
  });

  it('语速、音色或文本变化使用不同缓存键', async () => {
    const { gateway, calls } = makeGateway();
    await gateway.ttsWithResult({ text: 'hello', voice, voiceIdentity: 'teacher_default' }, decision);
    await gateway.ttsWithResult({ text: 'hello', voice: { ...voice, teacherSpeed: 0.5 }, voiceIdentity: 'teacher_default' }, decision);
    await gateway.ttsWithResult({ text: 'goodbye', voice, voiceIdentity: 'teacher_default' }, decision);
    assert.equal(calls.length, 3);
    assert.equal(await gateway.peekTtsCache({ text: 'hello', voice, voiceIdentity: 'teacher_default' }).then((r) => r?.cached), true);
  });

  it('重启后从磁盘索引恢复，且索引不含明文原文', async () => {
    const digest = 'a1b2c3d4e5f60718293a4b5c';
    const audioRef = `/api/v1/media/audio/${digest}.mp3`;
    mkdirSync(audioDir, { recursive: true });
    writeFileSync(join(audioDir, `${digest}.mp3`), Buffer.from('fake-audio'));
    const first = makeGateway(audioRef);
    await first.gateway.ttsWithResult({ text: '固定短句 pronunciation', voice, voiceIdentity: 'teacher_default' }, decision);

    const indexes = (await import('node:fs/promises')).readdir(audioDir).then((files) => files.filter((name) => name.startsWith('.tts-')));
    const names = await indexes;
    assert.equal(names.length, 1, '应写入一份持久化缓存索引');
    const raw = await (await import('node:fs/promises')).readFile(join(audioDir, names[0]!), 'utf8');
    assert.equal(raw.includes('固定短句 pronunciation'), false, '索引不得保存明文教学内容');

    const restarted = makeGateway(audioRef);
    const hit = await restarted.gateway.peekTtsCache({ text: '固定短句 pronunciation', voice, voiceIdentity: 'teacher_default' });
    assert.equal(hit?.cached, true);
    assert.equal(hit?.audioRef, audioRef);
    assert.equal(restarted.calls.length, 0, '重启后命中缓存不得再次调用供应商');
  });
});

describe('长文语义切分工具（非课堂合成路径）', () => {
  it('长文章无损切分，每段不超过供应商单次上限', () => {
    const article = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} about a little cat. `).join('');
    const chunks = splitTeachingSpeech(article, 120);
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every((chunk) => [...chunk].length <= 120));
    assert.equal(chunks.join(''), article.trim());
  });

  it('中文标点也作为断句点，且不丢字符', () => {
    const text = '小朋友，我们一起来读这一段。hello！再试一次？'.repeat(8);
    const chunks = splitTeachingSpeech(text, 30);
    assert.equal(chunks.join(''), text.trim());
  });

  it('短词与短句保持单段（工具函数；课堂合成不切分）', () => {
    assert.deepEqual(splitTeachingSpeech('hello', 120), ['hello']);
    assert.deepEqual(splitTeachingSpeech('Good morning!', 120), ['Good morning!']);
  });
});

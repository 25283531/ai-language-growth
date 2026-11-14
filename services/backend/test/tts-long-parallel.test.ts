/**
 * 长句并行合成回归（2026-11-14 用户要求：把 94 字长句的等待压下来）。
 *
 * 覆盖：
 *  - 短文本不切（保持单次合成的自然韵律）；
 *  - 长文本按教学句边界切，且单元文本按序拼接能还原原文、不丢标点；
 *  - 中英混排先按语言切，英语单元仍拿慢速档位；
 *  - 适配器真的并行（峰值并发 > 1）、按序拼接字节、纯短句仍只请求一次。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { TtsRequest } from '@alg/shared-contracts';
import {
  mapWithConcurrency,
  planSpeechUnits,
  TencentCloudTtsAdapter,
} from '@alg/ai-provider-sdk';

const LONG = '看，这是一只苹果。苹果是红色的，圆圆的，摸起来滑滑的。我们一起来说：apple。你说得很好，声音再大一点，老师再听一听。今天我们还学了 banana 和 cat，你记得它们的意思吗？好的。';

const originalFetch = globalThis.fetch;
const originalAudioDir = process.env.AI_AUDIO_DIR;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.AI_AUDIO_DIR = originalAudioDir;
});

describe('planSpeechUnits', () => {
  it('短句不切，仍是一次合成', () => {
    const units = planSpeechUnits('apple');
    assert.equal(units.length, 1);
    assert.equal(units[0]!.language, 'en');
  });

  it('94 字长句按句边界切成多单元，拼回原文一字不差', () => {
    const units = planSpeechUnits(LONG);
    assert.ok(units.length >= 3, `期望至少 3 段，实际 ${units.length}`);
    assert.equal(units.map((unit) => unit.text).join(''), LONG);
    // 混排文本里夹着 apple / banana / cat，它们应被识别为英语单元（要放慢）
    assert.equal(units.some((unit) => unit.language === 'zh'), true);
    assert.equal(units.some((unit) => unit.language === 'en'), true);
  });

  it('中英混排先按语言切，英语单元保留 en 标记', () => {
    const units = planSpeechUnits('这是苹果。跟我读：apple，请注意 apple 的发音。', { minCharsToSplit: 8 });
    assert.equal(units.some((unit) => unit.language === 'en'), true);
    assert.equal(units.map((unit) => unit.text).join(''), '这是苹果。跟我读：apple，请注意 apple 的发音。');
  });

  it('单元数量有上限，超出部分合并进最后一段', () => {
    const many = Array.from({ length: 12 }, (_, index) => `第${index}句很短。`).join('');
    const units = planSpeechUnits(many, { maxUnits: 4 });
    assert.ok(units.length <= 4);
    assert.equal(units.map((unit) => unit.text).join(''), many);
  });
});

describe('mapWithConcurrency', () => {
  it('限制并发但结果顺序与输入一致', async () => {
    let inFlight = 0;
    let peak = 0;
    const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5 * (6 - value)));
      inFlight -= 1;
      return value * 10;
    });
    assert.equal(peak, 2);
    assert.deepEqual(output, [10, 20, 30, 40, 50]);
  });
});

describe('适配器：长句并行合成', () => {
  function stubFetch(): { bodies: Array<{ Text: string; Speed: number }>; peak: () => number } {
    const bodies: Array<{ Text: string; Speed: number }> = [];
    let inFlight = 0;
    let peak = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      bodies.push(JSON.parse(String(init?.body)));
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      const audio = Buffer.concat([Buffer.from([0xff, 0xf3, 0x48, 0xc4]), Buffer.alloc(252)]);
      return new Response(JSON.stringify({ Response: { Audio: audio.toString('base64') } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { bodies, peak: () => peak };
  }

  function adapter(audioDir: string): TencentCloudTtsAdapter {
    return new TencentCloudTtsAdapter({
      alias: 'test_tts',
      baseUrl: 'https://tts.example.com',
      modelAlias: 'test-model',
      credentials: { secretId: 'TESTID', secretKey: 'TESTKEY' },
      options: { codec: 'mp3', voiceType: 601009, sampleRate: 24000 },
      pricing: { checkedAt: '2026-11-14' },
    });
  }

  function request(text: string): TtsRequest {
    return {
      text,
      voice: { teacherSpeed: 0.65, voiceStyle: 'gentle', pronunciationMode: 'slow_clear' },
      voiceIdentity: 'teacher_default',
      timeoutMs: 5000,
    } as TtsRequest;
  }

  it('94 字长句发出多次请求且确实并行，文本按序完整', async () => {
    process.env.AI_AUDIO_DIR = mkdtempSync(join(tmpdir(), 'alg-tts-long-'));
    const stub = stubFetch();
    await adapter(process.env.AI_AUDIO_DIR).invoke(request(LONG));

    assert.ok(stub.bodies.length >= 3, `期望多次请求，实际 ${stub.bodies.length}`);
    assert.ok(stub.peak() > 1, `期望并发执行，实际峰值 ${stub.peak()}`);
    assert.equal(stub.bodies.map((body) => body.Text).join(''), LONG);
    // 中文段一律自然语速；夹在里面的英语词仍然放慢
    assert.equal(stub.bodies.some((body) => body.Speed === 0), true);
    assert.equal(stub.bodies.some((body) => body.Speed < 0), true);
  });

  it('短句仍然只请求一次', async () => {
    process.env.AI_AUDIO_DIR = mkdtempSync(join(tmpdir(), 'alg-tts-long-'));
    const stub = stubFetch();
    await adapter(process.env.AI_AUDIO_DIR).invoke(request('Good job!'));
    assert.equal(stub.bodies.length, 1);
  });
});

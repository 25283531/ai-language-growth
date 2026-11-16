/**
 * 语速口径回归：
 *
 * 2026-11-17 产品更正：中英混排句子不是跟读内容（跟读项是纯英文单词/例句），
 * 因此混排统一用 0.8 倍速，不跟「正常/慢速/很慢」三档变；纯中文讲解保持自然语速；
 * **只有纯英文才按档变速**。
 *
 * 覆盖：
 *  - 中英混排按语言边界切段（仅用于选音色），纯中文 / 纯英文仍是一段；
 *  - 语速判定：纯英文跟档、混排固定 0.8、纯中文 1.0；
 *  - 适配器把同一个语速用在所有段上，不拆成一快一慢。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { TtsRequest } from '@alg/shared-contracts';
import {
  iflytekSpeedValue,
  resolveEffectiveTeacherSpeed,
  splitByLanguage,
  TencentCloudTtsAdapter,
  tencentSpeedValue,
} from '@alg/ai-provider-sdk';

const originalFetch = globalThis.fetch;
const originalAudioDir = process.env.AI_AUDIO_DIR;
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.AI_AUDIO_DIR = originalAudioDir;
});

const en = (text: string) => ({ text, language: 'en' as const });
const zh = (text: string) => ({ text, language: 'zh' as const });

describe('splitByLanguage', () => {
  it('纯英文只有一段，且判定为 en', () => {
    const segments = splitByLanguage('Listen and say: apple.');
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.language, 'en');
  });

  it('纯中文只有一段，且判定为 zh', () => {
    const segments = splitByLanguage('看，这是苹果。跟我读。');
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.language, 'zh');
  });

  it('中英混排按语言边界切段，且不丢字', () => {
    const text = '看，这是 apple。跟我读：apple！';
    const segments = splitByLanguage(text);
    assert.ok(segments.length >= 2);
    assert.equal(segments.map((segment) => segment.text).join(''), text);
    assert.equal(segments.some((segment) => segment.language === 'en'), true);
    assert.equal(segments.some((segment) => segment.language === 'zh'), true);
  });

  it('空白文本返回空数组，不抛错', () => {
    assert.deepEqual(splitByLanguage('   '), []);
  });
});

describe('语速判定：只有纯英文跟档位', () => {
  it('纯英文按老师选的档位', () => {
    assert.deepEqual(resolveEffectiveTeacherSpeed('apple', 0.65), { speed: 0.65, mode: 'tier' });
    assert.deepEqual(resolveEffectiveTeacherSpeed('Listen and say apple.', 0.8), { speed: 0.8, mode: 'tier' });
    assert.deepEqual(resolveEffectiveTeacherSpeed('Good morning.', 1.0), { speed: 1, mode: 'tier' });
  });

  it('中英混排固定 0.8，不随三档变化', () => {
    for (const tier of [1.0, 0.8, 0.65]) {
      assert.deepEqual(resolveEffectiveTeacherSpeed('跟我读：apple。', tier), {
        speed: 0.8,
        mode: 'mixed',
      });
    }
    assert.equal(resolveEffectiveTeacherSpeed('这是 apple，那是 banana。', 0.65).speed, 0.8);
  });

  it('纯中文讲解保持自然语速，不被「很慢」拖慢', () => {
    assert.deepEqual(resolveEffectiveTeacherSpeed('苹果是一种水果。', 0.65), { speed: 1, mode: 'natural' });
    assert.deepEqual(resolveEffectiveTeacherSpeed('   ', 0.65), { speed: 1, mode: 'natural' });
  });
});

describe('供应商换算：把有效语速换成各自的参数', () => {
  it('档位型：官方倍率锚点插值', () => {
    assert.equal(tencentSpeedValue(0.44), -2);
    // 0.65 落在官方 -2(0.6x) 与 -1(0.8x) 之间，插值得 -1.75，而不是粗档 -2。
    assert.equal(tencentSpeedValue(0.65), -1.75);
    assert.equal(tencentSpeedValue(0.7), -1.5);
    assert.equal(tencentSpeedValue(0.8), -1);
    assert.equal(tencentSpeedValue(1.0), 0);
    assert.equal(tencentSpeedValue(1.2), 1);
    assert.equal(tencentSpeedValue(1.6), 2.4);
  });

  it('连续型：0—100，实测标定', () => {
    // 实测：50=1.00x，每单位约 0.0058x，所以 speed = clamp(round(50 + (target-1)*171), 0, 100)。
    assert.equal(iflytekSpeedValue(1.0), 50);
    assert.equal(iflytekSpeedValue(0.8), 16);
    assert.equal(iflytekSpeedValue(1.2), 84);
    // 0.65 已越过该发音人下限（0.74x≈speed 0），夹到 0 而不是给负值。
    assert.equal(iflytekSpeedValue(0.65), 0);
    assert.equal(iflytekSpeedValue(0.44), 0);
    assert.ok(iflytekSpeedValue(0.44) < iflytekSpeedValue(1.0));
  });
});

describe('适配器：按语言分段请求并拼接音频', () => {
  function stubFetch(): Array<{ Text: string; Speed: number }> {
    const bodies: Array<{ Text: string; Speed: number }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const audio = Buffer.concat([Buffer.from([0xff, 0xf3, 0x48, 0xc4]), Buffer.alloc(252)]);
      return new Response(JSON.stringify({ Response: { Audio: audio.toString('base64') } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return bodies;
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

  function request(text: string, teacherSpeed = 0.6): TtsRequest {
    return {
      text,
      voice: { teacherSpeed, voiceStyle: 'gentle', pronunciationMode: 'slow_clear' },
      voiceIdentity: 'teacher_default',
      timeoutMs: 5000,
    } as TtsRequest;
  }

  it('中英混排：两段都用混排语速 -1，不拆成一快一慢', async () => {
    process.env.AI_AUDIO_DIR = mkdtempSync(join(tmpdir(), 'alg-tts-lang-'));
    const bodies = stubFetch();
    await adapter(process.env.AI_AUDIO_DIR).invoke(request('这是苹果。跟我读：apple。'));

    assert.equal(bodies.length, 2);
    // 混排固定 0.8 倍速 → 腾讯 -1 档，中文段也是 -1（旧行为是 0）。
    assert.equal(bodies[0]!.Speed, -1);
    assert.ok(bodies[0]!.Text.includes('苹果'));
    assert.equal(bodies[1]!.Speed, -1);
    assert.ok(bodies[1]!.Text.includes('apple'));
  });

  it('纯英文只请求一次，按档位变速', async () => {
    process.env.AI_AUDIO_DIR = mkdtempSync(join(tmpdir(), 'alg-tts-lang-'));
    const bodies = stubFetch();
    await adapter(process.env.AI_AUDIO_DIR).invoke(request('Listen and say apple.'));

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.Speed, -2);
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { TtsRequest } from '@alg/shared-contracts';
import { MatchaTtsAdapter, matchaSpeedForTeacherSpeed } from '@alg/ai-provider-sdk';

/**
 * Matcha（tts.250886.xyz）适配器：
 * - speed 是倍率不是档位，teacherSpeed 直接钳制后透传；
 * - 请求 JSON、响应裸音频、口令走 X-API-Key；
 * - 三档语速必须产出不同指纹，否则缓存会互相覆盖。
 */

function stubFetch(status = 200, body?: () => Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; payload: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      payload: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (body) return body();
    // 合法 MP3 帧头 + 足够长度，模拟 200 返回音频
    const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(4028)]);
    return new Response(audio, { status, headers: { 'content-type': 'audio/mpeg' } });
  }) as typeof fetch;
  return calls;
}

function adapter(overrides: Record<string, unknown> = {}): MatchaTtsAdapter {
  return new MatchaTtsAdapter({
    alias: 'matcha_test',
    baseUrl: 'https://tts.example.test',
    modelAlias: 'matcha-zh-en',
    credentials: { apiKey: 'TEST_TOKEN' },
    options: {},
    pricing: { checkedAt: '2026-11-16' },
    ...overrides,
  });
}

function request(text: string, teacherSpeed = 1): TtsRequest {
  return {
    text,
    voice: { teacherSpeed, voiceStyle: 'gentle', pronunciationMode: 'slow_clear' },
    voiceIdentity: 'teacher_default',
    timeoutMs: 5000,
  } as TtsRequest;
}

describe('matchaSpeedForTeacherSpeed：倍率直接透传并钳制', () => {
  it('三档教学语速原样透传', () => {
    assert.equal(matchaSpeedForTeacherSpeed(1.0), 1);
    assert.equal(matchaSpeedForTeacherSpeed(0.8), 0.8);
    assert.equal(matchaSpeedForTeacherSpeed(0.65), 0.65);
  });

  it('越界钳制到 0.5–2.0，非法值回落 1', () => {
    assert.equal(matchaSpeedForTeacherSpeed(0.25), 0.5);
    assert.equal(matchaSpeedForTeacherSpeed(3), 2);
    assert.equal(matchaSpeedForTeacherSpeed(Number.NaN), 1);
  });

  it('保留两位小数，避免浮点噪声进缓存指纹', () => {
    assert.equal(matchaSpeedForTeacherSpeed(0.333), 0.5);
    assert.equal(matchaSpeedForTeacherSpeed(0.876), 0.88);
  });
});

describe('适配器：请求形态与落盘', () => {
  it('POST /tts，带口令头，body 为 text/speed/format', async () => {
    process.env.AI_AUDIO_DIR = mkdtempSync(join(tmpdir(), 'alg-matcha-'));
    const calls = stubFetch();
    await adapter().invoke(request('hello', 0.8));

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://tts.example.test/tts');
    assert.equal(calls[0]!.headers['x-api-key'], 'TEST_TOKEN');
    assert.deepEqual(calls[0]!.payload, { text: 'hello', speed: 0.8, format: 'mp3' });
  });

  it('音频写入音频目录，并返回 media 路由下的 audioRef', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alg-matcha-'));
    process.env.AI_AUDIO_DIR = dir;
    stubFetch();
    const result = await adapter().invoke(request('apple', 1));

    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[a-f0-9]{24}\.mp3$/);
    assert.equal(result.audioRef, `/api/v1/media/audio/${files[0]}`);
    assert.equal(result.characters, 5);
    assert.equal(result.providerAlias, 'matcha_test');
  });

  it('三档语速产出三个不同文件（缓存不会互相覆盖）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alg-matcha-'));
    process.env.AI_AUDIO_DIR = dir;
    stubFetch();
    const instance = adapter();
    for (const speed of [1, 0.8, 0.65]) {
      await instance.invoke(request('hello', speed));
    }
    assert.equal(readdirSync(dir).length, 3);
  });

  it('口令错误：抛出含状态码的错误，不落盘空文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alg-matcha-'));
    process.env.AI_AUDIO_DIR = dir;
    stubFetch(401, () => new Response(JSON.stringify({ detail: 'invalid or missing API token' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));

    await assert.rejects(
      () => adapter().invoke(request('hello', 1)),
      /HTTP 401 .*invalid or missing API token/,
    );
    assert.equal(readdirSync(dir).length, 0);
  });

  it('缺口令或文本为空时快速失败，不打网络', async () => {
    const calls = stubFetch();
    await assert.rejects(
      () => adapter({ credentials: {} }).invoke(request('hello')),
      /缺少口令配置/,
    );
    await assert.rejects(() => adapter().invoke(request('   ')), /文本为空/);
    assert.equal(calls.length, 0);
  });

  it('超过 800 字符上限显式失败，不静默截断教学文本', async () => {
    const calls = stubFetch();
    await assert.rejects(
      () => adapter().invoke(request('a'.repeat(801))),
      /超出单次合成上限/,
    );
    assert.equal(calls.length, 0);
  });
});

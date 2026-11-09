/**
 * 签名型音频协议适配器单测。
 *
 * 重点覆盖真实联调中最容易「假绿」的分支：HTTP 200 但业务失败、
 * 空音频、容器不匹配、凭据/动作缺失、超长文本，以及签名的 UTC 日期
 * 与重试重算。签名期望值由 Python 标准库独立实现交叉验证。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { TtsRequest } from '@alg/shared-contracts';
import {
  buildSignedHeaders,
  mapTeacherSpeedToOffset,
  SignedJsonTtsAdapter,
  type SignedTtsOptions,
} from '../src/signed-tts.ts';

const FIXED = {
  host: 'tts.example.com',
  service: 'tts',
  secretId: 'TESTID',
  secretKey: 'TESTKEY',
  action: 'TextToVoice',
  version: '2019-08-23',
  region: 'ap-guangzhou',
  body: '{"Text":"hello"}',
  timestamp: 1762531200,
};

function adapterOptions(extra: Partial<SignedTtsOptions> = {}): SignedTtsOptions {
  return {
    alias: 'test_tts',
    serviceKind: 'tts',
    baseUrl: 'https://tts.example.com',
    secretId: 'TESTID',
    secretKey: 'TESTKEY',
    service: 'tts',
    action: 'TextToVoice',
    version: '2019-08-23',
    region: 'ap-guangzhou',
    voice: '990001',
    codec: 'mp3',
    pricing: { checkedAt: '2026-11-07' },
    audioDir: mkdtempSync(join(tmpdir(), 'alg-tts-')),
    ...extra,
  };
}

function request(text = 'Hello. Listen and say hello.'): TtsRequest {
  return {
    text,
    voice: {
      teacherSpeed: 0.65,
      voiceStyle: 'gentle',
      pauseAfterSentenceMs: 1000,
      pronunciationMode: 'slow_clear',
    },
    voiceIdentity: 'teacher_default',
    timeoutMs: 12000,
  } as TtsRequest;
}

/** 合法的无 ID3 头裸 MP3 帧流（真实服务返回的就是这种）。 */
function mp3Bytes(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xf3, 0x48, 0xc4]), Buffer.alloc(256)]);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (init?: RequestInit) => Response): void {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) =>
    handler(init)) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TC3-HMAC-SHA256 签名', () => {
  it('与独立实现交叉验证的签名向量一致', () => {
    const headers = buildSignedHeaders(FIXED);
    assert.equal(headers['x-tc-timestamp'], '1762531200');
    assert.equal(headers['x-tc-action'], 'TextToVoice');
    assert.equal(headers['x-tc-version'], '2019-08-23');
    assert.equal(headers['x-tc-region'], 'ap-guangzhou');
    assert.equal(
      headers.authorization,
      'TC3-HMAC-SHA256 Credential=TESTID/2025-11-07/tts/tc3_request, ' +
        'SignedHeaders=content-type;host, ' +
        'Signature=0633bf042d7cec8dd752376745c09ed17b913da8570b58950615748962212311',
    );
  });

  it('日期按 UTC+0 计算，不随本机时区漂移', () => {
    // 2025-01-01T23:30:00Z：UTC 仍是 01-01，UTC+8 会误算成 01-02。
    const headers = buildSignedHeaders({ ...FIXED, timestamp: 1735774200 });
    assert.match(headers.authorization, /Credential=TESTID\/2025-01-01\/tts\/tc3_request/);
  });

  it('不同时间戳得到不同签名（重试必须重算签名）', () => {
    const first = buildSignedHeaders({ ...FIXED, timestamp: 1762531200 });
    const second = buildSignedHeaders({ ...FIXED, timestamp: 1762531201 });
    assert.notEqual(first.authorization, second.authorization);
  });

  it('签名头不含 X-TC-Token，也不含密钥明文', () => {
    const headers = buildSignedHeaders(FIXED);
    assert.equal(headers['x-tc-token'], undefined);
    assert.ok(!Object.values(headers).some((v) => v.includes(FIXED.secretKey)));
  });
});

describe('抽象语速映射', () => {
  it('单调不减且落在教学区间 [-1, 1]', () => {
    const speeds = [0.25, 0.39, 0.52, 0.65, 1, 1.5, 4];
    const offsets = speeds.map(mapTeacherSpeedToOffset);
    for (let i = 1; i < offsets.length; i += 1) {
      assert.ok(offsets[i]! >= offsets[i - 1]!);
    }
    assert.ok(offsets.every((v) => v >= -1 && v <= 1));
    assert.equal(mapTeacherSpeedToOffset(1), 0);
  });
});

describe('签名型 TTS 适配器', () => {
  it('HTTP 200 + 业务 Error 必须抛错，不能当成功', async () => {
    stubFetch(() =>
      jsonResponse({
        Response: {
          Error: { Code: 'UnsupportedOperation.PkgExhausted', Message: '资源包已耗尽' },
          RequestId: 'req-1',
        },
      }),
    );
    await assert.rejects(
      () => new SignedJsonTtsAdapter(adapterOptions()).invoke(request()),
      /UnsupportedOperation\.PkgExhausted.*req-1/,
    );
  });

  it('响应缺少音频字段必须抛错', async () => {
    stubFetch(() => jsonResponse({ Response: { RequestId: 'req-2' } }));
    await assert.rejects(
      () => new SignedJsonTtsAdapter(adapterOptions()).invoke(request()),
      /缺少 Base64 音频字段/,
    );
  });

  it('容器与配置编码不一致必须抛错（WAV 不能当 MP3 落盘）', async () => {
    stubFetch(() =>
      jsonResponse({ Response: { Audio: Buffer.from('RIFF' + '\0'.repeat(256)).toString('base64') } }),
    );
    await assert.rejects(
      () => new SignedJsonTtsAdapter(adapterOptions()).invoke(request()),
      /音频容器与配置的编码不一致/,
    );
  });

  it('裸 MP3 帧流视为合法音频，且写入的 audioRef 可被平台白名单接受', async () => {
    stubFetch(() => jsonResponse({ Response: { Audio: mp3Bytes().toString('base64') } }));
    const result = await new SignedJsonTtsAdapter(adapterOptions()).invoke(request());
    assert.match(result.audioRef, /^\/api\/v1\/media\/audio\/[a-f0-9]{24}\.mp3$/);
    assert.equal(result.providerAlias, 'test_tts');
    assert.ok(result.characters > 0);
  });

  it('请求体带唯一 SessionId、注入的推理/编码参数，且签名时间每次重算', async () => {
    const seen: Array<{ body: Record<string, unknown>; auth: string }> = [];
    stubFetch((init) => {
      seen.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: (init?.headers as Record<string, string>).authorization,
      });
      return jsonResponse({ Response: { Audio: mp3Bytes().toString('base64') } });
    });
    const adapter = new SignedJsonTtsAdapter(adapterOptions());
    await adapter.invoke(request());
    await adapter.invoke(request('Another sentence.'));

    assert.equal(seen.length, 2);
    assert.match(String(seen[0]!.body.SessionId), /^[0-9a-f-]{36}$/);
    assert.notEqual(seen[0]!.body.SessionId, seen[1]!.body.SessionId);
    assert.equal(seen[0]!.body.Codec, 'mp3');
    assert.equal(seen[0]!.body.VoiceType, 990001);
    assert.equal(seen[0]!.body.Speed, mapTeacherSpeedToOffset(0.65));
    assert.notEqual(seen[0]!.auth, seen[1]!.auth);
  });

  it('生成参数变化时不能复用另一套配置写出的音频文件', async () => {
    stubFetch(() => jsonResponse({ Response: { Audio: mp3Bytes().toString('base64') } }));
    const audioDir = mkdtempSync(join(tmpdir(), 'alg-tts-cache-'));
    const baseline = await new SignedJsonTtsAdapter(
      adapterOptions({ audioDir, volume: 0, version: 'v1' }),
    ).invoke(request());
    const changedVolume = await new SignedJsonTtsAdapter(
      adapterOptions({ audioDir, volume: 1, version: 'v1' }),
    ).invoke(request());
    const changedVersion = await new SignedJsonTtsAdapter(
      adapterOptions({ audioDir, volume: 0, version: 'v2' }),
    ).invoke(request());

    assert.notEqual(baseline.audioRef, changedVolume.audioRef);
    assert.notEqual(baseline.audioRef, changedVersion.audioRef);
  });

  it('额外参数不能覆盖文本、音色或编码', async () => {
    let body: Record<string, unknown> = {};
    stubFetch((init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ Response: { Audio: mp3Bytes().toString('base64') } });
    });
    await new SignedJsonTtsAdapter(
      adapterOptions({ extraBody: { Text: '替换文本', VoiceType: 1, Codec: 'wav', Reasoning: 'low' } }),
    ).invoke(request());

    assert.equal(body.Text, 'Hello. Listen and say hello.');
    assert.equal(body.VoiceType, 990001);
    assert.equal(body.Codec, 'mp3');
    assert.equal(body.Reasoning, 'low');
  });

  it('缺少动作/版本/服务名配置时拒绝调用（换供应商必须改配置）', async () => {
    stubFetch(() => jsonResponse({ Response: { Audio: mp3Bytes().toString('base64') } }));
    await assert.rejects(
      () => new SignedJsonTtsAdapter(adapterOptions({ action: undefined })).invoke(request()),
      /缺少动作\/版本\/服务名配置/,
    );
  });

  it('超过单次合成上限的中文文本必须拒绝，不静默截断', async () => {
    stubFetch(() => jsonResponse({ Response: { Audio: mp3Bytes().toString('base64') } }));
    await assert.rejects(
      () => new SignedJsonTtsAdapter(adapterOptions()).invoke(request('好'.repeat(151))),
      /超出单次合成上限/,
    );
  });
});

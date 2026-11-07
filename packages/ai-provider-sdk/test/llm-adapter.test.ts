/**
 * LLM 适配器与配置装载单测。
 *
 * 覆盖本次切换引入的两个坑：
 *  1) 推理型模型思考耗尽 token 后返回空 content，必须抛错而不是当成功；
 *  2) 配置注入的额外请求字段不能覆盖业务字段（model / messages / max_tokens）。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { LlmRequest } from '@alg/shared-contracts';
import { HttpLlmAdapter } from '../src/protocol.ts';
import {
  assertLiveProviderConfig,
  loadProviderConfig,
  resolveLiveServices,
  resolveTtsProtocol,
} from '../src/config.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function llmRequest(): LlmRequest {
  return {
    promptKey: 'teacher.child_question',
    promptVersion: 'm1.1',
    system: '你是温柔的英语老师',
    messages: [{ role: 'user', content: '为什么天空是蓝色的？' }],
    temperature: 0.4,
    maxTokens: 512,
    timeoutMs: 12000,
  } as LlmRequest;
}

function adapter(extraBody?: Record<string, unknown>, minMaxTokens?: number): HttpLlmAdapter {
  return new HttpLlmAdapter({
    alias: 'test_llm',
    serviceKind: 'llm',
    baseUrl: 'https://llm.example.com/v4',
    apiKey: 'TESTKEY',
    modelAlias: 'test-model',
    pricing: { checkedAt: '2026-11-07' },
    extraBody,
    minMaxTokens,
  });
}

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 155, completion_tokens: 29 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('LLM 额外请求字段', () => {
  it('推理强度与 token 下限被透传，且不出现禁用思考的字段', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return okResponse('我们继续练习吧');
    }) as typeof fetch;

    const result = await adapter({ reasoning_effort: 'low' }, 256).invoke({
      ...llmRequest(),
      maxTokens: 120,
    } as LlmRequest);

    assert.equal(body.model, 'test-model');
    assert.equal(body.max_tokens, 256, 'token 下限应覆盖业务侧的 120');
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.thinking, undefined, '不得给强制思考模型传 disabled');
    assert.equal(result.content, '我们继续练习吧');
    assert.equal(result.outputTokens, 29);
  });

  it('配置注入的字段不能覆盖 model / messages / max_tokens', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return okResponse('好的');
    }) as typeof fetch;

    await adapter(
      { model: 'hijacked', messages: [{ role: 'user', content: '恶意改写' }], max_tokens: 1 },
      256,
    ).invoke(llmRequest());

    assert.equal(body.model, 'test-model');
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(
      (body.messages as Array<{ role: string; content: string }>)[0],
      { role: 'system', content: '你是温柔的英语老师' },
    );
  });

  it('空 content 必须抛错，交由 Gateway 如实降级', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '' } }],
          usage: { prompt_tokens: 17, completion_tokens: 256, completion_tokens_details: { reasoning_tokens: 254 } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    await assert.rejects(
      () => adapter({ reasoning_effort: 'low' }, 256).invoke(llmRequest()),
      /返回空内容/,
    );
  });
});

describe('Provider 配置装载', () => {
  it('无引号 KV 形式可解析（shell source 不会吞掉字段值）', () => {
    const config = loadProviderConfig({
      AI_GATEWAY_MODE: 'live',
      LLM_BASE_URL: 'https://llm.example.com/v4',
      LLM_MODEL: 'test-model',
      LLM_EXTRA_BODY_KV: 'reasoning_effort:low;top_p:0.9',
      LLM_MIN_MAX_TOKENS: '256',
      TTS_BASE_URL: 'https://tts.example.com',
      TTS_PROTOCOL: 'signed_json_audio',
      TTS_SECRET_ID: 'id',
      TTS_SECRET_KEY: 'key',
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config.llm?.extraBody, { reasoning_effort: 'low', top_p: 0.9 });
    assert.equal(config.llm?.minMaxTokens, 256);
    assert.equal(config.ttsProtocol, 'signed_json_audio');
    assert.deepEqual(
      resolveLiveServices({
        AI_GATEWAY_MODE: 'live',
        TTS_BASE_URL: 'https://tts.example.com',
      } as NodeJS.ProcessEnv),
      ['tts'],
    );
  });

  it('live 服务需同时满足模式 + 白名单 + BASE_URL', () => {
    const env = {
      AI_GATEWAY_MODE: 'live',
      AI_GATEWAY_LIVE_SERVICES: 'llm,asr',
      LLM_BASE_URL: 'https://llm.example.com/v4',
      ASR_BASE_URL: 'https://asr.example.com/v1',
      TTS_BASE_URL: 'https://tts.example.com',
    } as NodeJS.ProcessEnv;
    assert.deepEqual(resolveLiveServices(env), ['llm', 'asr']);
    assert.equal(resolveTtsProtocol({ TTS_PROTOCOL: 'openai_audio' } as NodeJS.ProcessEnv), 'openai_audio');
    assert.equal(resolveTtsProtocol({} as NodeJS.ProcessEnv), 'openai_audio');
  });
});

describe('启动期 fail-fast', () => {
  const base = {
    AI_GATEWAY_MODE: 'live',
    AI_GATEWAY_LIVE_SERVICES: 'llm,tts,asr',
    LLM_BASE_URL: 'https://llm.example.com/v4',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'test-model',
    LLM_EXTRA_BODY_KV: 'reasoning_effort:low',
    LLM_MIN_MAX_TOKENS: '256',
    TTS_BASE_URL: 'https://tts.example.com',
    TTS_PROTOCOL: 'signed_json_audio',
    TTS_SECRET_ID: 'id',
    TTS_SECRET_KEY: 'key',
    TTS_SERVICE: 'tts',
    TTS_ACTION: 'TextToVoice',
    TTS_VERSION: '2019-08-23',
    TTS_VOICE: '502001',
    TTS_MODEL_TYPE: '1',
    TTS_CODEC: 'mp3',
    ASR_BASE_URL: 'https://asr.example.com/v1',
    ASR_API_KEY: 'k',
    ASR_MODEL: 'asr-model',
  } as NodeJS.ProcessEnv;

  it('mock 模式与完整 live 配置均放行', () => {
    assert.doesNotThrow(() => assertLiveProviderConfig({ AI_GATEWAY_MODE: 'mock' } as NodeJS.ProcessEnv));
    assert.doesNotThrow(() => assertLiveProviderConfig(base));
  });

  it('漏填 LLM 凭据 / 签名凭据 / 音色编号都会拒绝启动', () => {
    const cases: Array<[string, NodeJS.ProcessEnv]> = [
      ['LLM_API_KEY', { ...base, LLM_API_KEY: '' }],
      ['TTS_SECRET_KEY', { ...base, TTS_SECRET_KEY: '' }],
      ['TTS_ACTION', { ...base, TTS_ACTION: '' }],
      ['LLM_MIN_MAX_TOKENS', { ...base, LLM_MIN_MAX_TOKENS: '0' }],
      ['LLM_MIN_MAX_TOKENS', { ...base, LLM_MIN_MAX_TOKENS: '1.5' }],
    ];
    for (const [expected, env] of cases) {
      assert.throws(() => assertLiveProviderConfig(env), new RegExp(expected));
    }
  });

  it('配了双凭据却没切协议、或非法音色编号，必须拒绝启动', () => {
    assert.throws(
      () => assertLiveProviderConfig({ ...base, TTS_PROTOCOL: '' }),
      /TTS_PROTOCOL/,
    );
    assert.throws(
      () => assertLiveProviderConfig({ ...base, TTS_VOICE: 'teacher_default' }),
      /TTS_VOICE/,
    );
    assert.throws(
      () => assertLiveProviderConfig({ ...base, TTS_MODEL_TYPE: '3' }),
      /TTS_MODEL_TYPE/,
    );
    assert.throws(
      () => assertLiveProviderConfig({ ...base, TTS_PROTOCOL: 'signed-json' }),
      /TTS_PROTOCOL 不受支持/,
    );
  });

  it('额外的推理参数格式非法时拒绝启动，不静默忽略', () => {
    assert.throws(
      () => assertLiveProviderConfig({ ...base, LLM_EXTRA_BODY_KV: 'this-is-not-valid' }),
      /额外请求字段格式非法/,
    );
  });
});

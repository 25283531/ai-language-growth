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

  it('未注入额外字段时请求体不含推理参数（回滚态）', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return okResponse('我们继续练习吧');
    }) as typeof fetch;

    await adapter(undefined).invoke(llmRequest());

    assert.equal(body.reasoning_effort, undefined, '回滚态不得残留推理强度字段');
    assert.equal(body.thinking, undefined, '回滚态不得残留禁用思考字段');
    assert.equal(body.model, 'test-model', '业务字段仍由适配器组装');
    assert.deepEqual(
      (body.messages as Array<{ role: string; content: string }>)[0],
      { role: 'system', content: '你是温柔的英语老师' },
      'messages 仍由业务侧组装，反向断言不误伤正常字段',
    );
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
    LLM_EXTRA_POLICY: 'required',
    LLM_REQUIRED_EXTRA_KV: 'reasoning_effort:low',
    LLM_FORBIDDEN_EXTRA_KEYS: 'thinking',
    LLM_MIN_MAX_TOKENS: '256',
    TTS_BASE_URL: 'https://tts.example.com',
    TTS_PROTOCOL: 'signed_json_audio',
    TTS_SECRET_ID: 'id',
    TTS_SECRET_KEY: 'key',
    TTS_SERVICE: 'tts',
    TTS_ACTION: 'TextToVoice',
    TTS_VERSION: '2019-08-23',
    TTS_VOICE: '990001',
    TTS_MODEL_TYPE: '1',
    TTS_CODEC: 'mp3',
    ASR_BASE_URL: 'https://asr.example.com/v1',
    ASR_API_KEY: 'k',
    ASR_MODEL: 'asr-model',
  } as NodeJS.ProcessEnv;

  /** 从 base 真正删除若干键，模拟「配置漏填」而非置空串。 */
  const omit = (keys: string[]): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const key of keys) delete env[key];
    return env;
  };

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

  it('LLM 额外字段缺失/非法与 token 下限漏填均启动期拒绝（N27）', () => {
    const cases: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
      ['两键删除（policy=required）', omit(['LLM_EXTRA_BODY_KV', 'LLM_EXTRA_BODY_JSON']), /缺少必需配置.*LLM_EXTRA_BODY/],
      ['KV 为空串且 JSON 缺失', { ...base, LLM_EXTRA_BODY_KV: '' }, /缺少必需配置.*LLM_EXTRA_BODY/],
      ['值不被允许（与期望 KV 不符）', { ...base, LLM_EXTRA_BODY_KV: 'reasoning_effort:max' }, /reasoning_effort/],
      ['缺必需键（期望 KV 的键）', { ...base, LLM_EXTRA_BODY_KV: 'top_p:0.9' }, /reasoning_effort/],
      ['命中 .env 追加的禁止键', { ...base, LLM_EXTRA_BODY_KV: 'reasoning_effort:low;thinking:disabled' }, /thinking/],
      ['token 下限键删除', omit(['LLM_MIN_MAX_TOKENS']), /LLM_MIN_MAX_TOKENS/],
      ['token 下限为空串', { ...base, LLM_MIN_MAX_TOKENS: '' }, /LLM_MIN_MAX_TOKENS/],
    ];
    for (const [label, env, pattern] of cases) {
      assert.throws(() => assertLiveProviderConfig(env), pattern, label);
    }
  });

  it('策略本身漏配 / 非法值 / 期望 KV 缺失或不符均拒绝启动', () => {
    const cases: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
      ['LLM_EXTRA_POLICY 删除', omit(['LLM_EXTRA_POLICY']), /LLM_EXTRA_POLICY/],
      ['LLM_EXTRA_POLICY 为空串', { ...base, LLM_EXTRA_POLICY: '' }, /LLM_EXTRA_POLICY/],
      ['LLM_EXTRA_POLICY 非法值 auto', { ...base, LLM_EXTRA_POLICY: 'auto' }, /LLM_EXTRA_POLICY/],
      ['policy=required 但期望 KV 删除', omit(['LLM_REQUIRED_EXTRA_KV']), /LLM_REQUIRED_EXTRA_KV/],
      ['期望 KV 与实际注入值不符', {
        ...base,
        LLM_REQUIRED_EXTRA_KV: 'reasoning_effort:high',
        LLM_EXTRA_BODY_KV: 'reasoning_effort:low',
      }, /reasoning_effort/],
    ];
    for (const [label, env, pattern] of cases) {
      assert.throws(() => assertLiveProviderConfig(env), pattern, label);
    }
  });

  it('配置层一键回滚到非思考模型：policy=none 时无需额外字段与期望 KV', () => {
    // 回滚只改 .env：策略置 none、删掉推理相关键、token 下限填任意正整数，代码零改动
    const rollback = omit(['LLM_EXTRA_BODY_KV', 'LLM_EXTRA_BODY_JSON', 'LLM_REQUIRED_EXTRA_KV']);
    rollback.LLM_EXTRA_POLICY = 'none';
    rollback.LLM_MIN_MAX_TOKENS = '120';
    assert.doesNotThrow(() => assertLiveProviderConfig(rollback));
  });

  it('policy=none 下仍禁止覆盖通用业务字段 model', () => {
    assert.throws(
      () => assertLiveProviderConfig({
        ...base,
        LLM_EXTRA_POLICY: 'none',
        LLM_EXTRA_BODY_KV: 'model:hijacked',
        LLM_MIN_MAX_TOKENS: '120',
      }),
      /model/,
    );
  });

  it('期望 KV 支持 JSON 形式，完整配置与 JSON 单键形式均放行', () => {
    assert.doesNotThrow(() => assertLiveProviderConfig({
      ...base,
      LLM_REQUIRED_EXTRA_KV: '{"reasoning_effort":"low"}',
    }));
    assert.doesNotThrow(() => assertLiveProviderConfig(base));
    const jsonOnly = omit(['LLM_EXTRA_BODY_KV']);
    jsonOnly.LLM_EXTRA_BODY_JSON = '{"reasoning_effort":"low"}';
    assert.doesNotThrow(() => assertLiveProviderConfig(jsonOnly));
  });

  it('mock 模式与 live 白名单不含 llm 时不强制 LLM 键', () => {
    assert.doesNotThrow(() =>
      assertLiveProviderConfig({ AI_GATEWAY_MODE: 'mock' } as NodeJS.ProcessEnv));
    const noLlm: NodeJS.ProcessEnv = {
      ...base,
      AI_GATEWAY_LIVE_SERVICES: 'tts,asr',
      LLM_EXTRA_BODY_KV: '',
      LLM_MIN_MAX_TOKENS: '',
    };
    assert.doesNotThrow(() => assertLiveProviderConfig(noLlm));
  });
});

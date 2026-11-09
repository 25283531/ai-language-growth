import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getProviderPreset, listProviderPresets, presetSupportsService } from '../src/provider-presets.ts';

describe('预置模型接入平台', () => {
  it('包含要求的平台及各自预置的服务入口', () => {
    const requiredServices = {
      bailian: ['llm', 'tts', 'asr', 'embedding'],
      volcengine: ['llm', 'tts', 'asr'],
      'baidu-qianfan': ['llm', 'tts', 'asr'],
      'iflytek-spark': ['llm', 'tts', 'asr', 'pronunciation'],
      minimax: ['llm', 'tts'],
      ollama: ['llm', 'tts', 'asr', 'embedding'],
      siliconflow: ['llm', 'tts', 'asr', 'embedding'],
      'tencent-cloud': ['tts', 'asr'],
      'tencent-hunyuan': ['llm'],
      'openai-compatible': ['llm', 'tts', 'asr', 'embedding'],
    } as const;
    for (const [id, services] of Object.entries(requiredServices)) {
      const preset = getProviderPreset(id);
      assert.ok(preset, `缺少 ${id} 预置`);
      assert.deepEqual(preset.services, services);
      for (const service of services) {
        const baseUrl = preset.defaultBaseUrls[service];
        assert.ok(baseUrl || id === 'openai-compatible', `${id}/${service} 缺少默认接入点`);
        if (baseUrl) {
          assert.match(baseUrl, /^(https?|wss?):\/\//);
        }
      }
    }
    assert.deepEqual(getProviderPreset('tencent-soe')?.services, ['pronunciation']);
    assert.deepEqual(getProviderPreset('azure-speech')?.services, ['pronunciation']);
    assert.deepEqual(getProviderPreset('speechace')?.services, ['pronunciation']);
    assert.deepEqual(getProviderPreset('chivox')?.services, ['pronunciation']);
  });

  it('Ollama 声明 OpenAI 兼容服务，未知平台安全返回 undefined', () => {
    assert.equal(presetSupportsService('ollama', 'llm'), true);
    assert.equal(presetSupportsService('ollama', 'tts'), true);
    assert.equal(presetSupportsService('ollama', 'asr'), true);
    assert.equal(presetSupportsService('ollama', 'embedding'), true);
    assert.equal(getProviderPreset('unknown-provider'), undefined);
    assert.equal(presetSupportsService('unknown-provider', 'llm'), false);
  });

  it('调用方修改 catalog 返回值不会污染后续配置', () => {
    const first = listProviderPresets();
    first[0]!.services.push('pronunciation');
    first[0]!.defaultBaseUrls.llm = 'https://invalid.example';

    const next = getProviderPreset('bailian');
    assert.equal(next?.services.includes('pronunciation'), false);
    assert.notEqual(next?.defaultBaseUrls.llm, 'https://invalid.example');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getProviderPreset, listProviderPresets, presetSupportsService } from '../src/provider-presets.ts';

describe('预置模型接入平台', () => {
  it('包含约定的七个平台，并为 OpenAI 兼容 LLM 提供默认接入地址', () => {
    const presets = listProviderPresets();
    assert.deepEqual(presets.map((preset) => preset.id), [
      'bailian',
      'volcengine',
      'baidu-qianfan',
      'iflytek-spark',
      'minimax',
      'ollama',
      'openai-compatible',
      'tencent-soe',
      'azure-speech',
      'speechace',
      'chivox',
    ]);
    for (const preset of presets.slice(0, 6)) {
      assert.match(preset.defaultBaseUrls.llm ?? '', /^https?:\/\//);
    }
    assert.equal(presets[6]?.defaultBaseUrls.llm, undefined);
    assert.deepEqual(presets[7]?.services, ['pronunciation']);
    assert.deepEqual(presets[8]?.services, ['pronunciation']);
    assert.deepEqual(presets[9]?.services, ['pronunciation']);
    assert.deepEqual(presets[10]?.services, ['pronunciation']);
  });

  it('Ollama 只声明已验证的 LLM 服务，未知平台安全返回 undefined', () => {
    assert.equal(presetSupportsService('ollama', 'llm'), true);
    assert.equal(presetSupportsService('ollama', 'tts'), false);
    assert.equal(presetSupportsService('ollama', 'asr'), false);
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

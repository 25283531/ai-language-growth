import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProviderConfig } from '../src/config';
import { MockPronunciationAdapter } from '../src/mock';

const request = {
  audioRef: '/tmp/acceptance.wav',
  targetText: 'I get up at seven.',
  language: 'en-US',
  granularity: 'word' as const,
};

test('mock 发音默认保留末音节错误分支', async () => {
  const result = await new MockPronunciationAdapter().invoke(request);

  assert.equal(result.score, 62);
  assert.equal(result.passed, false);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0]!.correct, false);
  assert.equal(result.units[0]!.detail, '尾音不稳定');
});

test('mock 发音通过夹具返回可通过分数', async () => {
  const result = await new MockPronunciationAdapter({ pass: true }).invoke(request);

  assert.equal(result.score, 92);
  assert.equal(result.passed, true);
  assert.equal(result.units.length, 1);
  assert.equal(result.units[0]!.correct, true);
  assert.equal(result.units[0]!.detail, null);
});

test('通过夹具只由显式配置开启', () => {
  assert.equal(loadProviderConfig({}).mockPronunciationPass, false);
  assert.equal(
    loadProviderConfig({ MOCK_PRONUNCIATION_PASS: '1' }).mockPronunciationPass,
    true,
  );
});
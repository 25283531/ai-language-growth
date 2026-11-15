import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimateTimeoutMs,
  FallbackExhaustedError,
  splitSentences,
  TIMEOUT_MARGIN_FLAT_MS,
  TIMEOUT_MARGIN_RATIO,
  TimeoutError,
  TtsFallbackChain,
  withHardTimeout,
  type TtsProvider,
} from '../src/speech/tts-fallback-chain.js';

function fakeProvider(
  name: string,
  behaviour: 'ok' | 'timeout' | 'error',
  clock?: { value: number; step: number },
): TtsProvider {
  return {
    name,
    async synthesize(request) {
      if (clock) clock.value += clock.step;
      if (behaviour === 'timeout') throw new TimeoutError(`${name} 超时`);
      if (behaviour === 'error') throw new Error(`${name} 挂了`);
      return { audio: Buffer.from(`${name}:${request.text}`), sampleRate: 24000, provider: name, waitedMs: 0 };
    },
  };
}

test('超时预估：短句 2–3 秒，中句 5 秒左右，长句更大', () => {
  const short = estimateTimeoutMs('欢迎回来');
  const medium = estimateTimeoutMs('欢迎回来。上次我们一起练习了身边物品，今天继续学习。');
  const long = estimateTimeoutMs('这是一段很长的课文朗读文本，用来验证长句会得到更大的超时预算。'.repeat(3));
  assert.ok(short >= 2000 * TIMEOUT_MARGIN_RATIO && short <= 3000 * TIMEOUT_MARGIN_RATIO + TIMEOUT_MARGIN_FLAT_MS + 1);
  assert.ok(medium > short && medium <= 5000 * TIMEOUT_MARGIN_RATIO + TIMEOUT_MARGIN_FLAT_MS + 1);
  assert.ok(long > medium);
});

test('长句先拆句，拆出的每句都不超过阈值', () => {
  const text = '第一句话。第二句话比较长一些，需要继续拆开。第三句话！';
  const pieces = splitSentences(text, 12);
  assert.ok(pieces.length >= 3);
  for (const piece of pieces) assert.ok([...piece].length <= 12, `超长片段：${piece}`);
});

test('首选成功：只调用一次，日志一条 ok', async () => {
  const chain = new TtsFallbackChain([
    withHardTimeout(fakeProvider('edge', 'ok')),
    withHardTimeout(fakeProvider('iflytek', 'ok')),
  ]);
  const outcome = await chain.synthesizeOne({ text: 'family', speed: 1.0 });
  assert.equal(outcome.logs.length, 1);
  assert.equal(outcome.logs[0]!.provider, 'edge');
  assert.equal(outcome.logs[0]!.outcome, 'ok');
  assert.equal(outcome.result.provider, 'edge');
});

test('Edge 超时 → 讯飞；不重试 Edge', async () => {
  let edgeCalls = 0;
  const edge: TtsProvider = {
    name: 'edge',
    async synthesize() {
      edgeCalls += 1;
      throw new TimeoutError('edge timeout');
    },
  };
  const chain = new TtsFallbackChain([withHardTimeout(edge), withHardTimeout(fakeProvider('iflytek', 'ok'))]);
  const outcome = await chain.synthesizeOne({ text: '我们来读这个单词 family', speed: 0.8 });
  assert.equal(edgeCalls, 1);
  assert.deepEqual(outcome.logs.map((l) => l.outcome), ['timeout', 'ok']);
  assert.equal(outcome.result.provider, 'iflytek');
  assert.match(outcome.logs[1]!.reason, /上一级回落/);
});

test('三级全挂 → 第四级本地 Piper，日志四级齐全', async () => {
  const chain = new TtsFallbackChain([
    fakeProvider('edge', 'timeout'),
    fakeProvider('iflytek', 'timeout'),
    fakeProvider('tencent', 'error'),
    fakeProvider('local-piper', 'ok'),
  ]);
  const outcome = await chain.synthesizeOne({ text: '妈麻马骂', speed: 0.65 });
  assert.equal(outcome.usedLocalFallback, true);
  assert.equal(outcome.result.provider, 'local-piper');
  assert.deepEqual(outcome.logs.map((l) => l.provider), ['edge', 'iflytek', 'tencent', 'local-piper']);
  assert.deepEqual(outcome.logs.map((l) => l.outcome), ['timeout', 'timeout', 'error', 'ok']);
});

test('全部无响应时抛 FallbackExhaustedError 并带完整日志', async () => {
  const chain = new TtsFallbackChain([fakeProvider('edge', 'timeout'), fakeProvider('iflytek', 'timeout')]);
  await assert.rejects(
    () => chain.synthesizeOne({ text: 'hello', speed: 1.0 }),
    (error: unknown) => {
      assert.ok(error instanceof FallbackExhaustedError);
      assert.equal(error.logs.length, 2);
      return true;
    },
  );
});

test('硬超时生效：慢 provider 被判超时，不等待其自然完成', async () => {
  const slow: TtsProvider = {
    name: 'tencent',
    async synthesize() {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return { audio: Buffer.from('x'), sampleRate: 24000, provider: 'tencent', waitedMs: 0 };
    },
  };
  const chain = new TtsFallbackChain([withHardTimeout(slow)]);
  const started = Date.now();
  await assert.rejects(() => chain.synthesizeOne({ text: '短句', speed: 1.0 }), /超时|无响应/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3500, `应被硬超时提前打断（预估约 2.9s），实际 ${elapsed}ms`);
});

test('日志字段完整：时间、原文、句长、预估、等待、厂商、原因', async () => {
  const chain = new TtsFallbackChain([fakeProvider('edge', 'ok')]);
  const outcome = await chain.synthesizeOne({ text: '欢迎回来', speed: 1.0 });
  const entry = outcome.logs[0]!;
  assert.ok(entry.at.length > 10);
  assert.equal(entry.text, '欢迎回来');
  assert.equal(entry.chars, 4);
  assert.ok(entry.estimatedMs > 0);
  assert.ok(entry.waitedMs >= 0);
  assert.equal(entry.provider, 'edge');
  assert.ok(entry.reason.length > 0);
});

test('长句整段合成会拆成多句逐句回落', async () => {
  const chain = new TtsFallbackChain([fakeProvider('edge', 'ok')]);
  const text = Array.from({ length: 5 }, (_, i) => `第${i + 1}句话比较长需要拆开处理。`).join('');
  assert.ok([...text].length > 40);
  const outcome = await chain.synthesize({ text, speed: 1.0 });
  assert.ok(outcome.logs.length >= 2, `实际 ${outcome.logs.length} 条日志`);
  assert.ok(outcome.result.audio.length > 0);
});

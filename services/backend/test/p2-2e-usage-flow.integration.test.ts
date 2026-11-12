import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

/**
 * P2-2E：TTS / ASR / 发音真实 HTTP 链路与账本、管理员聚合 API 对账。
 *
 * 只允许在带 ci/test/tmp/disposable 标记的一次性库上运行；不会写生产库。
 * 运行前需要已启动 mock API（AI_GATEWAY_MODE=mock），并配置测试管理员账号。
 */
const prisma = new PrismaClient();
const runId = process.env.P2_2E_RUN_ID ?? process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const userId = `p2-2e-user-${runId}`;
const learnerId = `p2-2e-learner-${runId}`;
const topicId = `p2-2e-topic-${runId}`;
const lessonSessionId = `p2-2e-session-${runId}`;
const api = process.env.P2_2E_API_URL ?? process.env.M1_API_URL ?? 'http://127.0.0.1:3100/api/v1';
const keepFixtures = process.env.P2_2E_KEEP_FIXTURES === '1';
const databaseUrl = process.env.DATABASE_URL ?? '';
const databaseName = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const enabled =
  process.env.P2_2E_DB_INTEGRATION === '1' &&
  process.env.NODE_ENV !== 'production' &&
  /(^|[_-])(ci|test|tmp|disposable)([_-]|$)/i.test(databaseName);

let studentHeaders: Record<string, string> = {};
let adminHeaders: Record<string, string> = {};

type Json = Record<string, any>;

async function request(
  path: string,
  input: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const response = await fetch(`${api}${path}`, {
    method: input.method ?? (input.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(input.headers ?? {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  let body: Json = {};
  try {
    body = text ? (JSON.parse(text) as Json) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

async function ok(
  path: string,
  input: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Json> {
  const result = await request(path, input);
  assert.equal(result.status >= 200 && result.status < 300, true, `${path} returned ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function adminLogin(): Promise<Record<string, string>> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  assert.ok(username && password, 'P2-2E 需要测试管理员 ADMIN_USERNAME/ADMIN_PASSWORD');
  const result = await request('/admin/auth/login', {
    body: { username, password },
  });
  assert.equal(result.status, 201, `管理员登录失败: ${JSON.stringify(result.body)}`);
  const cookie = result.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, '管理员登录未返回 Cookie');
  return { cookie };
}

async function reserve(serviceKind: 'tts' | 'asr' | 'pronunciation', idempotencyKey: string) {
  return ok('/speech/quota/reserve', {
    body: { learnerId, serviceKind, seconds: 10, idempotencyKey },
    headers: studentHeaders,
  });
}

function speechHeaders(reservationId: string): Record<string, string> {
  return {
    ...studentHeaders,
    'X-Learner-Id': learnerId,
    'X-Speech-Quota-Reservation': reservationId,
  };
}

before(async () => {
  if (!enabled) return;
  await prisma.users.create({
    data: {
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: 'ci-only',
      displayName: 'P2-2E Guardian',
      role: 'guardian',
    },
  });
  await prisma.learner_profiles.create({
    data: {
      id: learnerId,
      userId,
      guardianId: userId,
      displayName: 'P2-2E Learner',
      ageGroup: '6-9',
      entryLevel: 'pre_a1',
      membershipTier: 'free',
    },
  });
  await prisma.lesson_sessions.create({
    data: { id: lessonSessionId, learnerId, topicId },
  });
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.auth_sessions.create({
    data: {
      userId,
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  studentHeaders = { Authorization: `Bearer ${rawToken}` };
  adminHeaders = await adminLogin();
});

after(async () => {
  try {
    if (enabled && !keepFixtures) {
      await prisma.ai_usage_logs.deleteMany({ where: { learnerId } });
      await prisma.speech_quota_reservations.deleteMany({ where: { learnerId } });
      await prisma.speech_quota_buckets.deleteMany({ where: { learnerId } });
      await prisma.lesson_sessions.deleteMany({ where: { learnerId } });
      await prisma.auth_sessions.deleteMany({ where: { userId } });
      await prisma.learner_profiles.deleteMany({ where: { id: learnerId } });
      await prisma.users.deleteMany({ where: { id: userId } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test(
  'TTS/ASR/发音若干次后，账本行数、单位与管理员聚合一致',
  { skip: !enabled },
  async () => {
    const health = await ok('/health');
    assert.equal(health.gatewayMode, 'mock');

    const ttsReservation = await reserve('tts', `p2-2e-tts-${runId}`);
    const ttsHeaders = speechHeaders(ttsReservation.reservationId);
    const ttsOne = await ok('/speech/synthesize', {
      body: { text: 'alpha', scope: { lessonSessionId } },
      headers: ttsHeaders,
    });
    const ttsTwo = await ok('/speech/synthesize', {
      body: { text: 'beta', scope: { lessonSessionId } },
      headers: ttsHeaders,
    });
    const ttsCached = await ok('/speech/synthesize', {
      body: { text: 'alpha', scope: { lessonSessionId } },
      headers: ttsHeaders,
    });
    assert.equal(ttsOne.cached, false);
    assert.equal(ttsTwo.cached, false);
    assert.equal(ttsCached.cached, true);
    assert.equal(ttsCached.characters, 0);
    await ok('/speech/quota/settle', {
      body: { reservationId: ttsReservation.reservationId, seconds: 1 },
      headers: studentHeaders,
    });

    const asrReservation = await reserve('asr', `p2-2e-asr-${runId}`);
    const asrHeaders = speechHeaders(asrReservation.reservationId);
    const asrResults = [];
    for (const audioRef of ['audio-one', 'audio-two', 'audio-three']) {
      asrResults.push(await ok('/speech/recognize', {
        body: { audioRef, lessonSessionId },
        headers: asrHeaders,
      }));
    }
    await ok('/speech/quota/settle', {
      body: { reservationId: asrReservation.reservationId, seconds: 4.5 },
      headers: studentHeaders,
    });

    const pronunciationReservation = await reserve('pronunciation', `p2-2e-pron-${runId}`);
    const pronunciationHeaders = speechHeaders(pronunciationReservation.reservationId);
    const pronunciationResults = [];
    for (const audioRef of ['audio-one', 'audio-two', 'audio-three']) {
      pronunciationResults.push(await ok('/speech/evaluate', {
        body: { audioRef, targetText: 'hello', lessonSessionId },
        headers: pronunciationHeaders,
      }));
    }
    await ok('/speech/quota/settle', {
      body: { reservationId: pronunciationReservation.reservationId, seconds: 1 },
      headers: studentHeaders,
    });

    const rows = await prisma.ai_usage_logs.findMany({
      where: { learnerId },
      orderBy: { createdAt: 'asc' },
    });
    const byService = (kind: string) => rows.filter((row) => row.serviceKind === kind);
    const ttsRows = byService('tts');
    const asrRows = byService('asr');
    const pronunciationRows = byService('pronunciation');
    const expectedTtsCharacters = [...'alpha'].length + [...'beta'].length;
    const expectedAsrSeconds = asrResults.reduce((sum, result) => sum + Number(result.seconds), 0);

    assert.equal(rows.length, 9, '应为 TTS 3 + ASR 3 + 发音 3 共 9 行');
    assert.equal(ttsRows.length, 3);
    assert.equal(asrRows.length, 3);
    assert.equal(pronunciationRows.length, 3);
    assert.equal(
      ttsRows.reduce((sum, row) => sum + row.ttsCharacters, 0),
      expectedTtsCharacters,
    );
    assert.equal(ttsRows.filter((row) => row.ttsCharacters === 0).length, 1, '缓存重播应记 0 字符');
    assert.equal(
      asrRows.reduce((sum, row) => sum + row.asrSeconds, 0),
      expectedAsrSeconds,
    );
    assert.equal(
      pronunciationRows.reduce((sum, row) => sum + row.pronunciationCalls, 0),
      3,
    );
    assert.ok(rows.every((row) => row.lessonSessionId === lessonSessionId));
    assert.ok(rows.every((row) => row.level === 'L0'));
    assert.ok(rows.every((row) => row.estimatedCostCny === 0));
    assert.equal(pronunciationResults.length, 3);

    const aggregate = await ok(
      `/admin/usage/cost?from=${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}` +
        `&to=${encodeURIComponent(new Date(Date.now() + 60 * 60 * 1000).toISOString())}` +
        `&learnerId=${encodeURIComponent(learnerId)}`,
      { headers: adminHeaders },
    );

    assert.equal(aggregate.totals.calls, 9);
    assert.equal(aggregate.totals.ttsCharacters, expectedTtsCharacters);
    assert.equal(aggregate.totals.asrSeconds, expectedAsrSeconds);
    assert.equal(aggregate.totals.pronunciationCalls, 3);
    assert.equal(aggregate.totals.estimatedCostCny, 0);
    assert.equal(aggregate.totals.unpricedCalls, 0);
    assert.equal(aggregate.byLearner.length, 1);
    assert.equal(aggregate.byLearner[0]?.learnerId, learnerId);
    assert.equal(aggregate.byLearner[0]?.calls, 9);
    assert.equal(aggregate.byTopic.length, 1);
    assert.equal(aggregate.byTopic[0]?.topicId, topicId);
    assert.equal(aggregate.byTopic[0]?.calls, 9);
    assert.equal(
      aggregate.byDay.reduce((sum: number, bucket: Json) => sum + bucket.calls, 0),
      9,
    );

    console.log(JSON.stringify({
      runId,
      learnerId,
      topicId,
      lessonSessionId,
      expected: {
        calls: 9,
        ttsCharacters: expectedTtsCharacters,
        asrSeconds: expectedAsrSeconds,
        pronunciationCalls: 3,
      },
    }));
  },
);

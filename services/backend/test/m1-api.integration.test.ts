import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const userId = `ci-m1-user-${runId}`;
const learnerId = `ci-m1-learner-${runId}`;
const api = process.env.M1_API_URL ?? 'http://127.0.0.1:3100/api/v1';

async function request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(`${api}${path}`, {
    ...(body === undefined
      ? { headers: extraHeaders }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...extraHeaders },
          body: JSON.stringify(body),
        }),
  });
  const payload = await response.json() as Record<string, any>;
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

before(async () => {
  await prisma.users.create({
    data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'ci-only', displayName: 'CI Guardian', role: 'guardian' },
  });
  await prisma.learner_profiles.create({
    data: {
      id: learnerId,
      userId,
      guardianId: userId,
      displayName: 'CI Learner',
      ageGroup: '6-9',
      entryLevel: 'pre_a1',
      membershipTier: 'free',
    },
  });
});

after(async () => { await prisma.$disconnect(); });

test('M1 HTTP loop starts, responds idempotently, caches TTS, and archives growth', async () => {
  const health = await request('/health');
  assert.equal(health.status, 'ok');
  assert.equal(health.gatewayMode, 'mock');

  const ttsPayload = { text: 'Hello from the teacher.', teacherSpeed: 0.6, voiceStyle: 'gentle', pauseAfterSentenceMs: 900, pronunciationMode: 'slow_clear' };
  const ttsReservation = await request('/speech/quota/reserve', {
    learnerId,
    serviceKind: 'tts',
    seconds: 10,
    idempotencyKey: `ci-tts-${runId}`,
  });
  const speechHeaders = {
    'X-Learner-Id': learnerId,
    'X-Speech-Quota-Reservation': ttsReservation.reservationId,
  };
  const firstSpeech = await request('/speech/synthesize', ttsPayload, speechHeaders);
  const repeatedSpeech = await request('/speech/synthesize', ttsPayload, speechHeaders);
  await request('/speech/quota/settle', { reservationId: ttsReservation.reservationId, seconds: 1 });
  assert.equal(firstSpeech.cached, false);
  assert.equal(repeatedSpeech.cached, true);
  assert.equal(repeatedSpeech.characters, 0);

  const lesson = await request('/lessons/start', { learnerId });
  assert.ok(lesson.lessonSessionId);
  assert.ok(lesson.directive.teacherUtterance);
  assert.ok(lesson.learnerState.masteryStates);

  const repeatTurn = await request(`/lessons/${lesson.lessonSessionId}/turn`, {
    learnerId,
    response: { requestedRepeat: true },
    idempotencyKey: `ci-repeat-${runId}`,
  });
  assert.equal(repeatTurn.intent, 'repeat_request');
  assert.equal(repeatTurn.speech.cached, true);
  assert.deepEqual(repeatTurn.evidence, []);
  assert.deepEqual(repeatTurn.stateChanges, []);
  assert.equal(repeatTurn.speech.audioRef, lesson.speech.audioRef);

  const slowTurn = await request(`/lessons/${lesson.lessonSessionId}/turn`, {
    learnerId,
    response: { requestedSlower: true },
    idempotencyKey: `ci-slow-${runId}`,
  });
  assert.equal(slowTurn.intent, 'slow_request');
  assert.ok(slowTurn.speech.teacherSpeed < repeatTurn.speech.teacherSpeed);
  assert.deepEqual(slowTurn.evidence, []);
  assert.deepEqual(slowTurn.stateChanges, []);

  const turnBody = {
    learnerId,
    response: { text: 'Why do people say hello?', freeUtterance: 'Why do people say hello?' },
    idempotencyKey: `ci-question-${runId}`,
    clientTimestamp: new Date().toISOString(),
  };
  const turn = await request(`/lessons/${lesson.lessonSessionId}/turn`, turnBody);
  assert.equal(turn.intent, 'question');
  assert.ok(turn.directive.teacherUtterance);
  assert.equal(turn.lessonSessionId, lesson.lessonSessionId);

  const replay = await request(`/lessons/${lesson.lessonSessionId}/turn`, turnBody);
  assert.deepEqual(replay, turn, 'same idempotency key must return the original result');

  const finished = await request(`/lessons/${lesson.lessonSessionId}/finish`, { learnerId });
  assert.ok(finished.summary);
  const growth = await request(`/learners/${learnerId}/growth`);
  assert.equal(growth.snapshots.length, 1);
  assert.equal(growth.memories.length, 1);
});

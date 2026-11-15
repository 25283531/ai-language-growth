import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapTeacherSpeedTier } from '../src/orchestrator/orchestrator.service.ts';
import { OrchestratorService } from '../src/orchestrator/orchestrator.service.ts';

const DIRECTIVE = {
  taskType: 'image_identification',
  targetWords: ['apple'],
  imageOptions: [{ id: 'img-apple', assetName: 'img_apple' }],
  teacherUtterance: '哪张图是 apple？',
  voice: {
    teacherSpeed: 0.65,
    voiceStyle: 'gentle',
    pauseAfterSentenceMs: 1000,
    pronunciationMode: 'slow_clear',
  },
};

function harness(sessionRow: unknown | (() => never)) {
  const service = Object.create(OrchestratorService.prototype) as any;
  const warnings: string[] = [];
  service.logger = { warn: (message: string) => warnings.push(message), log: () => undefined };
  service.prisma = {
    lesson_sessions: {
      findUnique: async () => (typeof sessionRow === 'function' ? (sessionRow as () => never)() : sessionRow),
    },
  };
  return { service, warnings };
}

test('语速只落三档：档外值吸附到最近档', () => {
  assert.equal(snapTeacherSpeedTier(0.46), 0.65);
  assert.equal(snapTeacherSpeedTier(0.5), 0.65);
  assert.equal(snapTeacherSpeedTier(0.75), 0.8);
  assert.equal(snapTeacherSpeedTier(0.9), 1.0);
  assert.equal(snapTeacherSpeedTier(1), 1.0);
  assert.equal(snapTeacherSpeedTier(Number.NaN), 0.65);
});

test('兜底保留当前活动，不把孩子送回 hello 课', async () => {
  const { service } = harness({ currentDirective: DIRECTIVE });
  const response = await service.offlineFallback({
    lessonSessionId: 's1',
    learnerId: 'l1',
    reason: 'Unique constraint failed on the fields: (`activeKey`)',
  });
  assert.equal(response.directive.targetWords[0], 'apple');
  assert.equal(response.directive.taskType, 'image_identification');
  assert.match(response.directive.teacherUtterance, /再试一次/);
  assert.match(response.directive.teacherUtterance, /哪张图是 apple/);
  // 文本变了，旧音频不能用，交给客户端按新文本重取
  assert.equal(response.speech.audioRef, null);
  assert.equal(response.speech.cached, false);
  assert.equal(response.degradation.degraded, true);
  assert.equal(response.degradation.offlineFallback, true);
});

test('数据库也不可用时才退回内置 hello 课', async () => {
  const { service } = harness(() => {
    throw new Error('connect ECONNREFUSED');
  });
  const response = await service.offlineFallback({
    lessonSessionId: 's1',
    learnerId: 'l1',
    reason: 'db down',
  });
  assert.deepEqual(response.directive.targetWords, ['hello']);
  assert.equal(response.speech.audioRef, 'offline://fixed-course/hello');
  assert.equal(response.speech.cached, true);
});

test('会话没有可复用指令时退回内置 hello 课', async () => {
  const { service } = harness({ currentDirective: null });
  const response = await service.offlineFallback({
    lessonSessionId: 's1',
    learnerId: 'l1',
    reason: 'no directive',
  });
  assert.deepEqual(response.directive.targetWords, ['hello']);
});

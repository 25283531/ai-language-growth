import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { curriculumPassageSchema } from '@alg/shared-contracts';
import { CurriculumAudioService } from '../src/curriculum/curriculum-audio.service.ts';

/**
 * P2-01~P2-03 的真实 PostgreSQL 验证（本地 15433）。
 * 默认跳过，避免误连非本地库；运行方式见 docs/本地数据库与词库导入.md。
 */
const enabled = process.env.P2_AUDIO_DB_INTEGRATION === '1';
const prisma = new PrismaClient();
const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const topicId = `p2-audio-topic-${runId}`;
let unitId = '';

const content = {
  resourceType: 'textbook_unit',
  textbook: { publisher: '测试出版社', grade: '三年级', volume: '上册' },
  unit: { code: 'P2 Unit', title: 'My Family', order: 1 },
  objectives: ['能朗读课文'],
  passage: {
    title: 'My Family',
    paragraphs: [{
      sentences: [
        { id: 'P2-s01', en: 'This is my father.', zh: '这是我的爸爸。', keyWords: ['father'] },
        { id: 'P2-s02', en: 'My father is kind.', zh: '我的爸爸很和善。', keyWords: ['father'] },
      ],
    }],
  },
  grammarPoints: [],
  activities: [{
    id: 'P2 Unit:0',
    title: '跟读',
    taskType: 'word_mimicry',
    scenario: 'story_scene',
    skillNodeIds: ['LA.VOCAB.family'],
    targetWords: ['father'],
    teacherUtteranceZh: '跟老师读 father。',
    demonstrationText: 'father',
    requiresPronunciationAssessment: true,
    requiresAsr: false,
    evidenceKind: 'pronunciation',
    assessment: {},
    difficulty: 1,
    imageRequirements: [],
    media: { speechKey: 'P2 Unit:0', speechText: '跟老师读 father。 father', imageKeys: [] },
  }],
  vocabulary: [{
    word: 'father',
    phonetic: '/ˈfɑːðər/',
    meaningZh: '爸爸',
    syllables: ['fa', 'ther'],
    difficultPhonemes: ['/ð/'],
    phrases: [],
    exampleSentences: [],
  }],
};

function fakeGateway() {
  let seq = 0;
  return {
    ttsWithResult: async (request: { text: string }) => {
      seq += 1;
      const hex = seq.toString(16).padStart(24, '0');
      return {
        result: {
          audioRef: `/api/v1/media/audio/${hex}.mp3`,
          characters: Array.from(request.text).length,
          providerAlias: 'integration-test',
          modelAlias: 'test-voice',
          cached: false,
          speedMode: 'native',
          playbackRate: 1,
        },
        degraded: false,
        reasons: [],
        effectiveLevel: 'L1',
        providerAlias: 'integration-test',
        latencyMs: 1,
      };
    },
  };
}

before(async () => {
  if (!enabled) return;
  const unit = await prisma.curriculum_units.create({
    data: {
      topicId,
      stage: 1,
      level: 'A1',
      title: 'P2 My Family',
      order: 1,
      reviewStatus: 'published',
      availability: 'active',
      publishedAt: new Date(),
      contentVersion: `p2-${runId}`,
      currentVersion: 1,
      content: content as never,
    },
    select: { id: true },
  });
  unitId = unit.id;
});

after(async () => {
  if (unitId) await prisma.curriculum_units.delete({ where: { id: unitId } }).catch(() => undefined);
  await prisma.$disconnect();
});

test('真实数据库：双速/拆读写入、命中、重建与课文装配', { skip: !enabled }, async () => {
  const service = new CurriculumAudioService(
    prisma as never,
    fakeGateway() as never,
    { route: async () => ({ level: 'L1', modelAlias: 'test-voice' }) } as never,
  );

  const warmed = await service.warmUnit(unitId);
  assert.equal(warmed.mode, 'live');
  assert.equal(warmed.plannedSentences, 2);
  assert.equal(warmed.sentenceClips, 4);
  assert.ok(warmed.wordClips >= 5);
  assert.equal(warmed.failed, 0);

  const rows = await prisma.curriculum_audio_clips.findMany({
    where: { unitId, contentVersion: `p2-${runId}`, status: 'ready' },
  });
  assert.equal(rows.length, warmed.plannedClips);
  assert.deepEqual(
    [...new Set(rows.filter((row) => row.kind === 'sentence').map((row) => row.speedTier))].sort(),
    ['normal', 'slow'],
  );

  const passage = await service.passageForTopic(topicId);
  assert.ok(passage);
  const parsed = curriculumPassageSchema.parse(passage);
  assert.equal(parsed.audioReady, true);
  assert.equal(passage.paragraphs[0]!.sentences[0]!.audio?.normalRef?.startsWith('/api/v1/media/audio/'), true);
  assert.ok(passage.focusWords.some((word) => word.clips.some((clip) => clip.kind === 'phoneme')));

  const reused = await service.warmUnit(unitId);
  assert.equal(reused.generated, 0);
  assert.equal(reused.reused, warmed.plannedClips);

  const rebuilt = await service.rebuildUnit(unitId);
  assert.equal(rebuilt.invalidated, warmed.plannedClips);
  assert.equal(rebuilt.generated, warmed.plannedClips);

  const status = await service.statusForUnit(unitId);
  assert.equal(status.byStatus.ready, warmed.plannedClips);
  assert.equal(status.byStatus.stale, undefined);
});

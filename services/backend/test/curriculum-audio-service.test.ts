import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CurriculumAudioService } from '../src/curriculum/curriculum-audio.service.ts';

type Row = {
  id: string;
  unitId: string;
  topicId: string;
  contentVersion: string;
  clipKey: string;
  kind: string;
  partIndex: number;
  position: number;
  speedTier: string;
  speed: number;
  text: string;
  audioRef: string | null;
  durationMs: number | null;
  status: string;
  error: string | null;
};

const content = {
  resourceType: 'textbook_unit',
  textbook: { publisher: '测试出版社', grade: '三年级', volume: '上册' },
  unit: { code: 'Unit 3', title: 'My Family', order: 3 },
  objectives: ['能朗读课文'],
  passage: {
    title: 'My Family',
    paragraphs: [{
      sentences: [
        { id: 'Unit-3-s01', en: 'This is my father.', zh: '这是我的爸爸。', keyWords: ['father'] },
        { id: 'Unit-3-s02', en: 'My father is kind.', zh: '我的爸爸很和善。', keyWords: ['father'] },
      ],
    }],
  },
  grammarPoints: [],
  activities: [{
    id: 'Unit 3:0',
    title: '读一读',
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
    media: { speechKey: 'Unit 3:0', speechText: '跟老师读 father。 father', imageKeys: [] },
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

function fixture(options: { providerAlias?: string } = {}) {
  const rows = new Map<string, Row>();
  const unit = {
    id: 'unit-1',
    topicId: 'topic-textbook-1',
    content,
    contentVersion: 'v1',
  };
  let seq = 0;
  let findFirstWhere: Record<string, unknown> | null = null;
  const prisma = {
    curriculum_units: {
      findUnique: async () => unit,
      findFirst: async (args: { where: Record<string, unknown> }) => {
        findFirstWhere = args.where;
        return unit;
      },
    },
    phoneme_items: {
      findMany: async () => [{ phoneme: 'ð', ipa: '/ð/' }],
    },
    curriculum_audio_clips: {
      findUnique: async (args: { where: { curriculum_audio_clip_identity: Record<string, unknown> } }) =>
        rows.get(identityOf(args.where.curriculum_audio_clip_identity)) ?? null,
      upsert: async (args: {
        where: { curriculum_audio_clip_identity: Record<string, unknown> };
        create: Omit<Row, 'id'>;
        update: Partial<Row>;
      }) => {
        const key = identityOf(args.where.curriculum_audio_clip_identity);
        const existing = rows.get(key);
        const row = existing
          ? { ...existing, ...args.update }
          : { id: `clip-${++seq}`, ...args.create } as Row;
        rows.set(key, row);
        return row;
      },
      findMany: async (args: { where: Record<string, unknown> }) => {
        const where = args.where;
        return [...rows.values()].filter((row) =>
          (where.unitId === undefined || row.unitId === where.unitId)
          && (where.contentVersion === undefined || row.contentVersion === where.contentVersion)
          && (where.status === undefined
            || (typeof where.status === 'string' ? row.status === where.status
              : (where.status as { in?: string[] }).in?.includes(row.status) ?? false))
          && (where.topicId === undefined || row.topicId === where.topicId));
      },
      updateMany: async (args: { where: Record<string, unknown>; data: { status: string } }) => {
        let count = 0;
        const ids = (args.where.id as { in?: string[] } | undefined)?.in;
        for (const [key, row] of rows) {
          if (ids) {
            if (!ids.includes(row.id)) continue;
          } else {
            if (row.unitId !== args.where.unitId || row.contentVersion !== args.where.contentVersion) continue;
            if (row.status !== 'ready' && row.status !== 'failed') continue;
          }
          rows.set(key, { ...row, status: args.data.status });
          count += 1;
        }
        return { count };
      },
    },
  };
  let ttsCalls = 0;
  const gateway = {
    ttsWithResult: async (request: { text: string; voice: { teacherSpeed: number } }) => {
      ttsCalls += 1;
      return {
        result: {
          audioRef: `/api/v1/media/audio/${String(ttsCalls).padStart(24, '0')}.mp3`,
          characters: Array.from(request.text).length,
          providerAlias: options.providerAlias ?? 'test',
          modelAlias: 'test-voice',
          cached: false,
          requestedTeacherSpeed: request.voice.teacherSpeed,
          speedMode: 'native',
          playbackRate: 1,
        },
        degraded: false,
        reasons: [],
        effectiveLevel: 'L1',
        providerAlias: options.providerAlias ?? 'test',
        latencyMs: 1,
      };
    },
  };
  const router = { route: async () => ({ level: 'L1', modelAlias: 'test-voice' }) };
  const service = new CurriculumAudioService(prisma as never, gateway as never, router as never);
  return {
    service,
    rows,
    unit,
    get ttsCalls() { return ttsCalls; },
    get findFirstWhere() { return findFirstWhere; },
  };
}

function identityOf(where: Record<string, unknown>): string {
  return [where.unitId, where.contentVersion, where.clipKey, where.kind, where.partIndex, where.speedTier]
    .join('|');
}

describe('CurriculumAudioService', () => {
  it('为逐句双速与重点词拆读写入版本化片段，第二次预热全部复用', async () => {
    const f = fixture();
    const first = await f.service.warmUnit('unit-1');
    assert.equal(first.mode, 'live');
    assert.equal(first.plannedSentences, 2);
    assert.equal(first.plannedFocusWords, 1);
    assert.equal(first.sentenceClips, 4);
    assert.ok(first.wordClips >= 5);
    assert.equal(first.failed, 0);
    assert.equal(f.ttsCalls, first.plannedClips);

    const sentence = [...f.rows.values()].filter((row) => row.kind === 'sentence');
    assert.equal(sentence.length, 4);
    assert.deepEqual(
      [...new Set(sentence.map((row) => row.speedTier))].sort(),
      ['normal', 'slow'],
    );
    assert.ok(sentence.every((row) => row.contentVersion === 'v1' && row.status === 'ready'));
    assert.ok([...f.rows.values()].some((row) => row.kind === 'phoneme' && row.text === 'ð'));

    const before = f.ttsCalls;
    const second = await f.service.warmUnit('unit-1');
    assert.equal(second.generated, 0);
    assert.equal(second.reused, first.plannedClips);
    assert.equal(f.ttsCalls, before);
  });

  it('重建会先标记 stale，再强制重合成当前版本', async () => {
    const f = fixture();
    const first = await f.service.warmUnit('unit-1');
    const before = f.ttsCalls;
    const rebuilt = await f.service.rebuildUnit('unit-1');
    assert.equal(rebuilt.invalidated, first.plannedClips);
    assert.equal(rebuilt.generated, first.plannedClips);
    assert.equal(f.ttsCalls, before + first.plannedClips);
    assert.ok([...f.rows.values()].every((row) => row.status === 'ready'));
  });

  it('contentVersion 变化后旧片段不再被运行时装配选中', async () => {
    const f = fixture();
    await f.service.warmUnit('unit-1');
    const oldReady = [...f.rows.values()].filter((row) => row.contentVersion === 'v1').length;
    assert.ok(oldReady > 0);

    f.unit.contentVersion = 'v2';
    const next = await f.service.warmUnit('unit-1');
    assert.equal(next.generated, next.plannedClips);
    assert.ok([...f.rows.values()].some((row) => row.contentVersion === 'v1'));
    assert.ok([...f.rows.values()].some((row) => row.contentVersion === 'v2'));

    const passage = await f.service.passageForTopic('topic-textbook-1');
    assert.ok(passage);
    assert.equal(passage.contentVersion, 'v2');
    assert.equal(passage.audioReady, true);
    assert.equal(passage.paragraphs[0]!.sentences[0]!.audio?.normalRef !== undefined, true);
  });

  it('只装配 ready 片段；失败片段保留 key 但不冒充可播放', async () => {
    const f = fixture({ providerAlias: 'mock_tts' });
    const result = await f.service.warmUnit('unit-1');
    assert.equal(result.mode, 'mock-skip');
    assert.equal(result.generated, 0);
    assert.equal(result.failed, result.plannedClips);
    assert.equal(f.rows.size, 0, 'mock 音频不得写入正式课程缓存');

    const passage = await f.service.passageForTopic('topic-textbook-1');
    assert.ok(passage);
    assert.equal(passage.audioReady, false);
    assert.equal(passage.paragraphs[0]!.sentences[0]!.audio?.normalRef, undefined);
    assert.match(passage.paragraphs[0]!.sentences[0]!.audio?.normalKey ?? '', /sentence:Unit-3-s01/);
  });

  it('课文查询只匹配已发布且 active 的课程单元', async () => {
    const f = fixture();
    await f.service.passageForTopic('topic-textbook-1');
    assert.deepEqual(f.findFirstWhere, {
      topicId: 'topic-textbook-1',
      reviewStatus: 'published',
      availability: 'active',
    });
  });

  it('音频状态按当前版本统计', async () => {
    const f = fixture();
    const warmed = await f.service.warmUnit('unit-1');
    const status = await f.service.statusForUnit('unit-1');
    assert.equal(status.contentVersion, 'v1');
    assert.equal(status.total, warmed.plannedClips);
    assert.equal(status.byStatus.ready, warmed.plannedClips);
    assert.equal(status.byKind.sentence, 4);
  });

  it('CURRICULUM_WARMUP_ENABLED=false 时直接跳过，不调用 TTS', async () => {
    const previous = process.env.CURRICULUM_WARMUP_ENABLED;
    process.env.CURRICULUM_WARMUP_ENABLED = 'false';
    try {
      const f = fixture();
      const result = await f.service.warmUnit('unit-1');
      assert.equal(result.mode, 'disabled');
      assert.equal(f.ttsCalls, 0);
      assert.equal(f.rows.size, 0);
    } finally {
      if (previous === undefined) delete process.env.CURRICULUM_WARMUP_ENABLED;
      else process.env.CURRICULUM_WARMUP_ENABLED = previous;
    }
  });

  it('供应商不可用时重建不把原有 ready 音频留在 stale', async () => {
    const f = fixture();
    const warmed = await f.service.warmUnit('unit-1');
    const previous = process.env.CURRICULUM_WARMUP_ENABLED;
    process.env.CURRICULUM_WARMUP_ENABLED = 'false';
    try {
      const rebuilt = await f.service.rebuildUnit('unit-1');
      assert.equal(rebuilt.mode, 'disabled');
      assert.equal(rebuilt.invalidated, warmed.plannedClips);
      const status = await f.service.statusForUnit('unit-1');
      assert.equal(status.byStatus.ready, warmed.plannedClips);
      assert.equal(status.byStatus.stale, undefined);
    } finally {
      if (previous === undefined) delete process.env.CURRICULUM_WARMUP_ENABLED;
      else process.env.CURRICULUM_WARMUP_ENABLED = previous;
    }
  });
});

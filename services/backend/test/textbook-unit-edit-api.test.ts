import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CurriculumAdminController } from '../src/curriculum/curriculum-admin.controller.ts';

const unitId = '33333333-3333-4333-8333-333333333333';
const textbookUnitId = '44444444-4444-4444-8444-444444444444';

function textbookContent() {
  return {
    resourceType: 'textbook_unit',
    textbook: { publisher: '人教版', grade: '三年级', volume: '上册' },
    unit: { code: 'Unit 3', title: 'My Family', order: 3 },
    objectives: ['能听懂并朗读课文'],
    passage: {
      title: 'My Family',
      paragraphs: [{
        sentences: [
          { id: 'Unit-3-s01', en: 'This is my family.', zh: '这是我的家庭。' },
        ],
      }],
    },
    grammarPoints: [{
      id: 'g01',
      pattern: 'This is my ...',
      titleZh: '介绍家庭成员',
      explanationZh: '用 This is my ... 介绍家人。',
      examples: [{ en: 'This is my family.', zh: '这是我的家庭。' }],
      sentenceIds: ['Unit-3-s01'],
    }],
    vocabulary: [
      { word: 'family', phonetic: '/ˈfæməli/', meaningZh: '家庭', syllables: ['fam', 'i', 'ly'] },
    ],
    activities: [{
      id: 'Unit-3-a01',
      title: '朗读课文',
      taskType: 'reading_story',
      scenario: 'story_scene',
      skillNodeIds: ['SE.SCHOOL.reading'],
      targetWords: ['family'],
      teacherUtteranceZh: '先听老师读一遍课文。',
      demonstrationText: 'This is my family.',
      requiresPronunciationAssessment: false,
      requiresAsr: false,
      evidenceKind: 'none',
      passiveReading: true,
      assessment: { acceptedImageIds: [], acceptedTexts: [], requiredPhrases: [], openResponse: false },
      difficulty: 1,
      media: { speechKey: 'Unit-3-a01', speechText: '先听老师读一遍课文。 This is my family.' },
    }],
    stageHint: 1,
  };
}

function validation() {
  return {
    ok: true,
    checkedAt: '2026-11-18T10:00:00.000Z',
    errors: [],
    warnings: [],
    issues: [],
    stats: {
      sentences: 1,
      translatedSentences: 1,
      vocabulary: 1,
      phonetic: 1,
      meaning: 1,
      activities: 1,
      grammarPoints: 1,
      schoolActivities: 0,
    },
    checks: {},
  };
}

function setup(options: {
  updateResult?: Record<string, unknown>;
  rollbackResult?: Record<string, unknown>;
  updateError?: Error;
  rollbackError?: Error;
  warmup?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const result = options.updateResult ?? {
    updated: true,
    unitId,
    textbookUnitId,
    topicId: 'topic-1',
    version: 2,
    contentVersion: 'hash-2',
    availability: 'active',
    validation: validation(),
    qcReport: { checkedAt: '2026-11-18T10:00:00.000Z', validation: validation() },
  };
  const rollback = options.rollbackResult ?? {
    updated: true,
    rolledBack: true,
    unitId,
    textbookUnitId,
    topicId: 'topic-1',
    version: 3,
    sourceVersion: 1,
    contentVersion: 'hash-1',
    availability: 'active',
    validation: validation(),
    qcReport: { checkedAt: '2026-11-18T10:00:00.000Z', validation: validation() },
  };
  const publisher = {
    updateTextbookUnit: async (...args: unknown[]) => {
      calls.push({ method: 'updateTextbookUnit', args });
      if (options.updateError) throw options.updateError;
      return result;
    },
    rollbackTextbookUnit: async (...args: unknown[]) => {
      calls.push({ method: 'rollbackTextbookUnit', args });
      if (options.rollbackError) throw options.rollbackError;
      return rollback;
    },
  };
  const prisma = {
    curriculum_units: {
      findUnique: async () => ({
        id: unitId,
        textbookUnitId,
        topicId: 'topic-1',
        currentVersion: 1,
        availability: 'active',
        reviewStatus: 'published',
      }),
    },
  };
  const controller = new CurriculumAdminController(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    { resolveRequest: () => 'admin' } as never,
    {} as never,
    (options.warmup ?? {}) as never,
    undefined,
    undefined,
    publisher as never,
  );
  return { controller, calls, publisher };
}

function responseOf(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof BadRequestException);
  return error.getResponse() as Record<string, unknown>;
}

describe('P1-07 教材单元编辑/回滚接口', () => {
  it('PUT units/:unitId/content 识别教材资源包并调用编辑事务', async () => {
    const { controller, calls } = setup();
    const body = { ...textbookContent(), expectedVersion: 1, reason: '修正标题' };
    const result = await controller.updateUnitContent('cookie', unitId, body) as Record<string, unknown>;

    assert.equal(result.version, 2);
    assert.equal(result.needsReview, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'updateTextbookUnit');
    const args = calls[0]?.args as unknown[];
    assert.equal(args[0], textbookUnitId);
    assert.equal((args[1] as { unit: { code: string } }).unit.code, 'Unit 3');
    assert.equal(args[2], 1);
    assert.equal(args[3], 'admin');
    assert.equal(args[4], '修正标题');
  });

  it('编辑校验失败返回 400，并带可定位 path', async () => {
    const failedValidation = {
      ...validation(),
      ok: false,
      errors: [{
        code: 'sentence_zh_placeholder',
        path: 'passage.paragraphs.0.sentences.0.zh',
        message: '句子 Unit-3-s01 的中文仍是占位文本。',
        severity: 'error',
      }],
    };
    const { controller } = setup({
      updateResult: {
        updated: false,
        unitId,
        textbookUnitId,
        validation: failedValidation,
        qcReport: { validation: failedValidation },
      },
    });
    await assert.rejects(
      controller.updateUnitContent('cookie', unitId, { ...textbookContent(), expectedVersion: 1 }),
      (error: unknown) => {
        const response = responseOf(error);
        assert.equal(response.message, '自动校验未通过，课时未更新');
        const issues = response.issues as Array<{ code: string; path: string }>;
        assert.equal(issues[0]?.code, 'sentence_zh_placeholder');
        assert.equal(issues[0]?.path, 'passage.paragraphs.0.sentences.0.zh');
        return true;
      },
    );
  });

  it('编辑 expectedVersion 冲突返回 409，不进入写事务', async () => {
    const { controller } = setup({
      updateError: new ConflictException('课程已被其他操作修改，请刷新后重试'),
    });
    await assert.rejects(
      controller.updateUnitContent('cookie', unitId, { ...textbookContent(), expectedVersion: 99 }),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal(error.getStatus(), 409);
        return true;
      },
    );
  });

  it('POST units/:unitId/rollback 识别教材单元并复制历史版本', async () => {
    const { controller, calls } = setup();
    const result = await controller.rollbackUnit('cookie', unitId, { version: 1, reason: '发音错误' }) as Record<string, unknown>;

    assert.equal(result.sourceVersion, 1);
    assert.equal(result.version, 3);
    assert.equal(calls[0]?.method, 'rollbackTextbookUnit');
    const args = calls[0]?.args as unknown[];
    assert.equal(args[0], unitId);
    assert.equal(args[1], 1);
    assert.equal(args[2], '发音错误');
    assert.equal(args[3], 'admin');
  });

  it('回滚到损坏历史版本返回 400，且保留当前版本', async () => {
    const failedValidation = {
      ...validation(),
      ok: false,
      errors: [{
        code: 'sentence_zh_empty',
        path: 'passage.paragraphs.0.sentences.0.zh',
        message: '句子缺少中文译文。',
        severity: 'error',
      }],
    };
    const { controller } = setup({
      rollbackResult: {
        updated: false,
        rolledBack: false,
        unitId,
        sourceVersion: 1,
        validation: failedValidation,
        qcReport: { validation: failedValidation },
      },
    });
    await assert.rejects(
      controller.rollbackUnit('cookie', unitId, { version: 1 }),
      (error: unknown) => {
        const response = responseOf(error);
        assert.equal(response.message, '自动校验未通过，未回滚');
        const issues = response.issues as Array<{ code: string }>;
        assert.equal(issues[0]?.code, 'sentence_zh_empty');
        return true;
      },
    );
  });

  it('POST units/:unitId/rebuild-audio 鉴权后透传 maxClips 并返回重建统计', async () => {
    const calls: Array<{ unitId: string; options: unknown }> = [];
    const { controller } = setup({
      warmup: {
        rebuildUnitAudio: async (id: string, options: unknown) => {
          calls.push({ unitId: id, options });
          return { unitId: id, invalidated: 4, generated: 4, reused: 0, failed: 0 };
        },
      },
    });
    const result = await controller.rebuildUnitAudio('cookie', unitId, { maxClips: 20 });
    assert.deepEqual(calls, [{ unitId, options: { maxClips: 20 } }]);
    assert.equal(result.invalidated, 4);
    await assert.rejects(controller.rebuildUnitAudio('cookie', unitId, { maxClips: 0 }), BadRequestException);
  });

  it('GET units/:unitId/audio 返回当前版本覆盖情况', async () => {
    const { controller } = setup({
      warmup: {
        unitAudioStatus: async (id: string) => ({ unitId: id, total: 7, byStatus: { ready: 7 } }),
      },
    });
    const result = await controller.unitAudioStatus('cookie', unitId);
    assert.equal(result.total, 7);
    assert.equal(result.byStatus.ready, 7);
  });

  it('POST preset/warmup 接受 maxAudioClips 并透传给级别预热', async () => {
    const calls: Array<{ level: string; options: unknown }> = [];
    const { controller } = setup({
      warmup: {
        warmLevel: async (level: string, options: unknown) => {
          calls.push({ level, options });
          return { level, audioUnitsWarmed: 1 };
        },
      },
    });
    const result = await controller.warmPreset('cookie', {
      level: 'A1',
      maxImages: 0,
      maxSpeech: 0,
      maxAudioClips: 30,
    });
    assert.deepEqual(calls, [{
      level: 'A1',
      options: { maxImages: 0, maxSpeech: 0, maxAudioClips: 30, force: undefined },
    }]);
    assert.equal(result.audioUnitsWarmed, 1);
    await assert.rejects(
      controller.warmPreset('cookie', { level: 'A1', maxAudioClips: 241 }),
      BadRequestException,
    );
  });
});

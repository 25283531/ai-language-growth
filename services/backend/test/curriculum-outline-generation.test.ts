import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CurriculumAdminController } from '../src/curriculum/curriculum-admin.controller.ts';
import { validateGenerated } from '../../curriculum-generator/src/main.ts';

const lesson = {
  title: '动物', level: 'pre-A1', objectives: ['听懂动物名称'],
  vocabulary: [{ word: 'cat', phonetic: '/kæt/', meaningZh: '猫', syllables: ['cat'], difficultPhonemes: [] }],
  activities: [{ taskType: 'word_mimicry', scenario: 'object_pic_scene', targetWords: ['cat'], teacherUtteranceZh: '请跟读', demonstrationText: 'cat', skillNodeIds: ['skill-1'], requiresPronunciationAssessment: true, requiresAsr: false, difficulty: 1, assessment: { acceptedTexts: ['cat'], acceptedImageIds: [], requiredPhrases: [], openResponse: false } }], images: [],
};
function setup(options: { status?: string; invalid?: unknown; smallFailure?: boolean; conflict?: boolean } = {}) {
  const draft = { id: 'draft-1', title: '动物', level: 'pre-A1', topicId: null, status: options.status || 'draft', version: 1, wordList: [], generatedContent: { outline: '认识猫和狗', objectives: '听懂动物名称' } };
  const calls: Array<{ role: string; prompt?: string; data?: unknown }> = [];
  const tx = {
    curriculum_drafts: {
      updateMany: async (args: unknown) => { calls.push({ role: 'write', data: args }); return { count: options.conflict ? 0 : 1 }; },
      findUnique: async () => ({ ...draft, status: 'generated' }),
    },
    curriculum_review_records: { create: async (args: unknown) => calls.push({ role: 'audit', data: args }) },
  };
  const prisma = {
    curriculum_drafts: { findUnique: async () => draft, create: async ({ data }: { data: unknown }) => { calls.push({ role: 'create', data }); return draft; } },
    curriculum_review_records: tx.curriculum_review_records,
    skill_nodes: { findMany: async () => [{ id: 'skill-1', code: 'word', name: '词汇', objective: '认识词汇' }] },
    $transaction: async (callback: (value: typeof tx) => unknown) => callback(tx),
  };
  const gateway = {
    smallLlm: async (request: { messages: Array<{ content: string }> }) => { calls.push({ role: 'small', prompt: request.messages[0].content }); if (options.smallFailure) throw new Error('small unavailable'); return { content: '{"words":[{"word":"cat"}]}' }; },
    llm: async (request: { messages: Array<{ content: string }> }) => { calls.push({ role: 'main', prompt: request.messages[0].content }); return { content: JSON.stringify(options.invalid === undefined ? lesson : options.invalid) }; },
  };
  const controller = new CurriculumAdminController(prisma as never, {} as never, gateway as never, { route: async () => ({}) } as never, { resolveRequest: () => 'admin' } as never);
  return { controller, calls };
}

describe('大纲和目的驱动 AI 补全', () => {
  it('无词表可创建草稿，并保留大纲和目的', async () => {
    const { controller, calls } = setup();
    await controller.createDraft('cookie', { title: '动物', level: 'pre-A1', outline: '认识猫和狗', objectives: '听懂动物名称' });
    const data = calls.find((call) => call.role === 'create')!.data as { wordList: unknown; generatedContent: unknown };
    assert.deepEqual(data.wordList, []);
    assert.deepEqual(data.generatedContent, { outline: '认识猫和狗', objectives: '听懂动物名称' });
  });
  it('大纲和目的传递给两个模型，成功后事务写入并审计', async () => {
    const { controller, calls } = setup();
    await controller.generateDraft('cookie', 'draft-1');
    for (const role of ['small', 'main']) {
      const prompt = JSON.parse(calls.find((call) => call.role === role)!.prompt!);
      assert.equal(prompt.outline, '认识猫和狗'); assert.equal(prompt.objectives, '听懂动物名称');
    }
    assert.equal(calls.filter((call) => call.role === 'write').length, 1);
    assert.equal(calls.filter((call) => call.role === 'audit').length, 1);
  });
  it('小模型不可用时主模型仍接收原始素材', async () => {
    const { controller, calls } = setup({ smallFailure: true });
    await controller.generateDraft('cookie', 'draft-1');
    assert.equal(JSON.parse(calls.find((call) => call.role === 'main')!.prompt!).outline, '认识猫和狗');
  });
  it('主模型空输出、非法任务或能力节点均不写成功状态', async () => {
    for (const invalid of [{}, { ...lesson, vocabulary: [] }, { ...lesson, activities: [] }, { ...lesson, activities: [{ ...lesson.activities[0], skillNodeIds: ['forged'] }] }, { ...lesson, activities: [{ ...lesson.activities[0], taskType: 'invalid' }] }]) {
      const { controller, calls } = setup({ invalid });
      await assert.rejects(controller.generateDraft('cookie', 'draft-1'), /AI 补全失败/);
      assert.equal(calls.filter((call) => call.role === 'write').length, 0);
    }
  });
  it('独立生成器拒绝非法图片和缺失授权，接受无图片课程', () => {
    const skills = new Set(['skill-1']);
    assert.doesNotThrow(() => validateGenerated(lesson, skills));
    for (const image of [null, 'invalid', { url: 'invalid', license: 'CC0' }, { url: 'https://example.com/cat.png', license: '' }, { url: 'http://example.com/cat.png', license: 'CC0' }]) {
      assert.throws(() => validateGenerated({ ...lesson, images: [image] }, skills), /图片/);
      assert.throws(() => validateGenerated({ ...lesson, vocabulary: [{ ...lesson.vocabulary[0], image }] }, skills), /图片/);
    }
    assert.doesNotThrow(() => validateGenerated({ ...lesson, images: [{ url: 'https://example.com/cat.png', license: 'CC0' }] }, skills));
  });
  it('已发布课程拒绝重新生成，且不调用模型', async () => {
    const { controller, calls } = setup({ status: 'published' });
    await assert.rejects(controller.generateDraft('cookie', 'draft-1'), /不允许/);
    assert.equal(calls.length, 0);
  });
  it('版本冲突拒绝覆盖且不记成功审计', async () => {
    const { controller, calls } = setup({ conflict: true });
    await assert.rejects(controller.generateDraft('cookie', 'draft-1'), /其他操作修改/);
    assert.equal(calls.filter((call) => call.role === 'audit').length, 0);
    const args = calls.find((call) => call.role === 'write')!.data as { where: unknown };
    assert.deepEqual(args.where, { id: 'draft-1', status: 'draft', version: 1 });
  });
});

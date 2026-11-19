import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * P1-11 教材单元全链路集成测试。
 *
 * 只在显式开启且数据库是本地 15433 时运行，避免误连生产库：
 *   P1_11_DB_INTEGRATION=1
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:15433/ai_language_growth?schema=public
 *
 * 测试内启动真实 Nest 应用（随机端口），模型调用使用 AI_GATEWAY_MODE=mock；
 * 运行前先构建后端：npm run build --workspace @alg/backend。
 * 覆盖：录入 → 生成并自动启用 → 修改单句 → expectedVersion 保存 → 回滚。
 * 测试数据在 after 中按教材目录级联清理，不依赖外部脚本。
 */

const databaseUrl = process.env.DATABASE_URL ?? '';
const parsedDatabaseUrl = (() => {
  try {
    return new URL(databaseUrl);
  } catch {
    return null;
  }
})();
const enabled = process.env.P1_11_DB_INTEGRATION === '1'
  && process.env.NODE_ENV !== 'production'
  && parsedDatabaseUrl !== null
  && ['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl.hostname)
  && parsedDatabaseUrl.port === '15433';

const prisma = new PrismaClient();
const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const unitCode = `p111-${runId}`;
const publisher = `P1-11 集成测试出版社 ${runId}`;
const adminUsername = 'p1-11-admin';
const adminPassword = 'p1-11-password';
const adminSessionSecret = 'p1-11-session-secret';

let backend: ChildProcess | undefined;
let baseUrl = '';
let adminCookie = '';
let textbookId = '';
let textbookUnitId = '';
let publishedUnitId = '';
let backendOutput = '';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(port > 0, '未能分配测试端口');
  return port;
}

async function waitForBackend(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`后端进程提前退出（code=${child.exitCode}）：\n${backendOutput.slice(-4000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // 端口尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待后端启动超时：\n${backendOutput.slice(-4000)}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sentencesOf(content: Record<string, unknown>): Array<Record<string, unknown>> {
  const passage = asRecord(content.passage);
  const paragraphs = Array.isArray(passage.paragraphs) ? passage.paragraphs : [];
  return paragraphs.flatMap((paragraph) => {
    const sentences = asRecord(paragraph).sentences;
    return Array.isArray(sentences) ? sentences.map(asRecord) : [];
  });
}

async function call(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    cookie?: string;
  } = {},
): Promise<{ response: Response; payload: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function cleanup(): Promise<void> {
  if (!enabled) return;
  try {
    const textbook = textbookId
      ? await prisma.textbook_catalogs.findUnique({
        where: { id: textbookId },
        select: { id: true },
      })
      : await prisma.textbook_catalogs.findFirst({
        where: { publisher },
        select: { id: true },
      });
    if (textbook) {
      const units = await prisma.textbook_units.findMany({
        where: { textbookId: textbook.id },
        select: { id: true },
      });
      const unitIds = units.map((unit) => unit.id);
      const drafts = unitIds.length
        ? await prisma.curriculum_drafts.findMany({
          where: { textbookUnitId: { in: unitIds } },
          select: { id: true, topicId: true },
        })
        : [];
      const topicIds = [...new Set([
        ...drafts.map((draft) => draft.topicId).filter((topicId): topicId is string => Boolean(topicId)),
        ...unitIds.map((unitId) => `topic-textbook-${unitId}`),
      ])];
      const draftIds = drafts.map((draft) => draft.id);
      if (draftIds.length) {
        await prisma.curriculum_review_records.deleteMany({ where: { draftId: { in: draftIds } } });
        await prisma.curriculum_drafts.deleteMany({ where: { id: { in: draftIds } } });
      }
      if (unitIds.length) {
        await prisma.curriculum_units.deleteMany({ where: { textbookUnitId: { in: unitIds } } });
      }
      if (topicIds.length) {
        await prisma.learning_items.deleteMany({ where: { topicId: { in: topicIds } } });
        await prisma.vocabulary_items.deleteMany({ where: { topicId: { in: topicIds } } });
      }
      await prisma.textbook_units.deleteMany({ where: { textbookId: textbook.id } });
      await prisma.textbook_catalogs.delete({ where: { id: textbook.id } });
    }
  } catch (error) {
    console.error('P1-11 清理测试数据失败：', error);
  }
}

before(async () => {
  if (!enabled) return;
  const port = await freePort();
  const backendRoot = process.cwd();
  backend = spawn(process.execPath, [join(backendRoot, 'dist', 'main.js')], {
    cwd: backendRoot,
    env: {
      ...process.env,
      AI_GATEWAY_MODE: 'mock',
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD: adminPassword,
      ADMIN_SESSION_SECRET: adminSessionSecret,
      PORT: String(port),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout?.on('data', (chunk: Buffer) => { backendOutput += chunk.toString(); });
  backend.stderr?.on('data', (chunk: Buffer) => { backendOutput += chunk.toString(); });
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
  await waitForBackend(port, backend);

  const login = await call('/admin/auth/login', {
    body: { username: adminUsername, password: adminPassword },
  });
  assert.equal(login.response.status, 201, `管理员登录失败：${JSON.stringify(login.payload)}`);
  const setCookie = login.response.headers.get('set-cookie');
  assert.ok(setCookie, '管理员登录未返回 cookie');
  adminCookie = setCookie.split(';', 1)[0]!;
});

after(async () => {
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 5000);
      backend?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await cleanup();
  await prisma.$disconnect();
});

test(
  'P1-11 教材单元：录入→生成自动启用→改单句→expectedVersion 保存→回滚',
  { skip: enabled ? false : '未设置 P1_11_DB_INTEGRATION=1，或数据库不是本地 127.0.0.1:15433' },
  async () => {
    const health = await call('/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.gatewayMode, 'mock');

    const textbook = await call('/admin/curriculum/textbooks', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        publisher,
        publicationYear: 2026,
        grade: '三年级',
        title: 'P1-11 集成测试教材',
        edition: '测试版',
      },
    });
    assert.equal(textbook.response.status, 201, `创建教材失败：${JSON.stringify(textbook.payload)}`);
    textbookId = textbook.payload.id;
    assert.ok(textbookId);

    const passage = [
      'This is my family.',
      'This is my mother.',
      'I love my family.',
    ].join('\n\n');
    const content = {
      resourceType: 'textbook_unit',
      textbook: {
        publisher,
        grade: '三年级',
        volume: '上册',
        edition: '测试版',
      },
      unit: {
        code: unitCode,
        title: 'My Family',
        order: 1,
      },
      objectives: ['能听懂并朗读课文，说出家庭成员。'],
      passage: {
        title: 'My Family',
        paragraphs: [
          {
            sentences: [
              { id: `${unitCode}-s01`, en: 'This is my family.', zh: '这是我的家人。', keyWords: ['family'], schoolModules: [] },
              { id: `${unitCode}-s02`, en: 'This is my mother.', zh: '这是我的妈妈。', keyWords: ['mother'], schoolModules: [] },
              { id: `${unitCode}-s03`, en: 'I love my family.', zh: '我爱我的家人。', keyWords: ['love', 'family'], schoolModules: [] },
            ],
          },
        ],
      },
      grammarPoints: [],
      vocabulary: [],
      activities: [
        {
          id: `${unitCode}-a01`,
          title: '朗读课文：My Family',
          taskType: 'reading_story',
          scenario: 'story_scene',
          skillNodeIds: ['LA.LISTEN.word_recognition', 'SE.SCHOOL.reading'],
          targetWords: ['family'],
          teacherUtteranceZh: '先听老师读一遍课文，再跟着读。',
          demonstrationText: 'This is my family.',
          requiresPronunciationAssessment: false,
          requiresAsr: false,
          evidenceKind: 'none',
          passiveReading: true,
          assessment: {
            acceptedImageIds: [],
            acceptedTexts: [],
            requiredPhrases: [],
            openResponse: false,
          },
          difficulty: 1,
          imageRequirements: [],
          media: {
            speechKey: `${unitCode}-a01`,
            speechText: '先听老师读一遍课文，再跟着读。 This is my family.',
            imageKeys: [],
          },
        },
      ],
    };

    const entry = await call('/admin/curriculum/textbook/units', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        textbookId,
        unit: content.unit,
        passage,
        words: ['family', 'mother', 'love'],
        grammarFocus: ['This is my family.'],
        objectives: content.objectives,
        content,
      },
    });
    assert.equal(entry.response.status, 201, `录入教材单元失败：${JSON.stringify(entry.payload)}`);
    textbookUnitId = entry.payload.id;
    assert.ok(textbookUnitId);
    assert.equal(entry.payload.publishedUnitId, null, '录入阶段不应提前生成线上单元');

    const inferredMapping = await call(`/admin/curriculum/textbook/units/${textbookUnitId}/mapping`, {
      cookie: adminCookie,
    });
    assert.equal(inferredMapping.response.status, 200);
    assert.equal(inferredMapping.payload.stored, null);
    assert.equal(inferredMapping.payload.effective.origin, 'inferred');

    const savedMapping = await call(`/admin/curriculum/textbook/units/${textbookUnitId}/mapping`, {
      method: 'PUT',
      cookie: adminCookie,
      body: {
        skillNodeIds: ['LA.VOCAB.receptive', 'SE.SCHOOL.letters', 'SE.SCHOOL.reading'],
        domains: ['family'],
        schoolModules: ['A', 'C'],
        stageHint: 2,
        source: 'editorial',
      },
    });
    assert.equal(savedMapping.response.status, 200, `保存教材映射失败：${JSON.stringify(savedMapping.payload)}`);
    assert.equal(savedMapping.payload.stored.version, 1);
    assert.deepEqual(savedMapping.payload.effective.schoolModules, ['A', 'C']);

    const generated = await call(`/admin/curriculum/textbook/units/${textbookUnitId}/generate`, {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(generated.response.status, 201, `生成教材单元失败：${JSON.stringify(generated.payload)}`);
    assert.equal(generated.payload.activation?.activated, true);
    assert.equal(generated.payload.activation?.version, 1);
    assert.equal(generated.payload.validation?.ok, true, JSON.stringify(generated.payload.validation));
    const generatedContent = generated.payload.content as Record<string, unknown>;
    const generatedSentences = sentencesOf(generatedContent);
    assert.equal(generatedSentences.length, 3);
    assert.deepEqual(generatedSentences.map((sentence) => sentence.zh), [
      '这是我的家人。',
      '这是我的妈妈。',
      '我爱我的家人。',
    ]);
    assert.equal(generatedContent.stageHint, 2);
    assert.deepEqual(
      (generatedContent.schoolTrack as { modules?: string[] } | undefined)?.modules,
      ['A', 'C'],
    );
    assert.equal(
      (generatedContent.schoolTrack as { activities?: unknown[] } | undefined)?.activities?.length,
      2,
    );

    publishedUnitId = generated.payload.activation.unitId;
    assert.ok(publishedUnitId);

    const afterGenerate = await call(`/admin/curriculum/textbook/units/${textbookUnitId}`, {
      cookie: adminCookie,
    });
    assert.equal(afterGenerate.response.status, 200);
    assert.equal(afterGenerate.payload.publishedUnitId, publishedUnitId);
    assert.equal(afterGenerate.payload.currentVersion, 1);
    assert.equal(afterGenerate.payload.availability, 'active');

    const editedContent = structuredClone(generatedContent);
    const editedSentences = sentencesOf(editedContent);
    editedSentences[2]!.zh = '我爱我的家。';
    const edit = await call(`/admin/curriculum/units/${publishedUnitId}/content`, {
      method: 'PUT',
      cookie: adminCookie,
      body: {
        ...editedContent,
        expectedVersion: 1,
        reason: 'P1-11 单句修订',
      },
    });
    assert.equal(edit.response.status, 200, `编辑教材单元失败：${JSON.stringify(edit.payload)}`);
    assert.equal(edit.payload.updated, true);
    assert.equal(edit.payload.version, 2);
    assert.equal(edit.payload.validation?.ok, true, JSON.stringify(edit.payload.validation));

    const afterEdit = await call(`/admin/curriculum/textbook/units/${textbookUnitId}`, {
      cookie: adminCookie,
    });
    assert.equal(afterEdit.response.status, 200);
    assert.equal(afterEdit.payload.currentVersion, 2);
    assert.equal(sentencesOf(afterEdit.payload.content)[2]!.zh, '我爱我的家。');

    const stale = await call(`/admin/curriculum/units/${publishedUnitId}/content`, {
      method: 'PUT',
      cookie: adminCookie,
      body: {
        ...generatedContent,
        expectedVersion: 1,
        reason: 'P1-11 过期版本不应覆盖',
      },
    });
    assert.equal(stale.response.status, 409, `过期 expectedVersion 应返回 409：${JSON.stringify(stale.payload)}`);

    const afterStale = await call(`/admin/curriculum/textbook/units/${textbookUnitId}`, {
      cookie: adminCookie,
    });
    assert.equal(afterStale.response.status, 200);
    assert.equal(afterStale.payload.currentVersion, 2);
    assert.equal(sentencesOf(afterStale.payload.content)[2]!.zh, '我爱我的家。');

    const rollback = await call(`/admin/curriculum/units/${publishedUnitId}/rollback`, {
      method: 'POST',
      cookie: adminCookie,
      body: { version: 1, reason: 'P1-11 回滚验证' },
    });
    assert.equal(rollback.response.status, 201, `回滚教材单元失败：${JSON.stringify(rollback.payload)}`);
    assert.equal(rollback.payload.rolledBack, true);
    assert.equal(rollback.payload.sourceVersion, 1);
    assert.equal(rollback.payload.version, 3);
    assert.equal(rollback.payload.validation?.ok, true, JSON.stringify(rollback.payload.validation));

    const afterRollback = await call(`/admin/curriculum/textbook/units/${textbookUnitId}`, {
      cookie: adminCookie,
    });
    assert.equal(afterRollback.response.status, 200);
    assert.equal(afterRollback.payload.currentVersion, 3);
    assert.equal(sentencesOf(afterRollback.payload.content)[2]!.zh, '我爱我的家人。');

    const versions = await prisma.curriculum_unit_versions.findMany({
      where: { unitId: publishedUnitId },
      orderBy: { version: 'asc' },
      select: { version: true },
    });
    assert.deepEqual(versions.map((item) => item.version), [1, 2, 3]);
  },
);

import assert from 'node:assert/strict';
import test from 'node:test';
import { CurriculumWarmupService } from '../src/curriculum/curriculum-warmup.service';

type Content = Record<string, unknown>;

function activityContent(): Content {
  return {
    teacherUtteranceZh: '听一听，选出你听到的词：hello。',
    demonstrationText: 'hello',
    targetWords: ['hello'],
    imageRequirements: [{
      key: 'img:a1-u01:hello',
      kind: 'word',
      targetWord: 'hello',
      targetText: 'hello',
      query: 'hello children flashcard illustration',
      alt: 'hello 的儿童教学图片',
    }],
  };
}

function fakePrisma(initialContent: Content) {
  const updates = new Map<string, Content>();
  return {
    updates,
    prisma: {
      curriculum_units: {
        findMany: async () => [{ id: 'unit-1', topicId: 'topic-1' }],
      },
      learning_items: {
        findMany: async () => [{
          id: 'item-1',
          refId: 'unit-1:0',
          topicId: 'topic-1',
          content: initialContent,
          updatedAt: new Date(),
        }],
        update: async ({ where, data }: { where: { id: string }; data: { content: Content } }) => {
          updates.set(where.id, data.content);
          return { id: where.id };
        },
      },
      media_assets: {
        findFirst: async () => null,
        create: async ({ data }: { data: { ref: string; sourceUrl: string } }) => ({
          id: 'asset-1',
          ref: data.ref,
          sourceUrl: data.sourceUrl,
          cacheStatus: 'pending',
        }),
        findUnique: async () => ({
          id: 'asset-1',
          ref: 'https://example.test/hello.jpg',
          sourceUrl: 'https://example.test/hello.jpg',
          cacheStatus: 'cached',
        }),
      },
    },
  };
}

async function withFetch<T>(handler: (url: string) => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('图片预热：检索多源候选，缓存最合适的一张并回填活动', async () => {
  const fixture = fakePrisma(activityContent());
  const cached: string[] = [];
  const service = new CurriculumWarmupService(
    fixture.prisma as never,
    {} as never,
    {} as never,
    { cacheNext: async (id: string) => { cached.push(id); } } as never,
  );
  const previousMode = process.env.AI_GATEWAY_MODE;
  process.env.AI_GATEWAY_MODE = 'live';
  try {
    const result = await withFetch((url) => {
      if (url.includes('api.openverse.org')) {
        return new Response(JSON.stringify({
          results: [{
            url: 'https://example.test/hello.jpg',
            license: 'cc0',
            license_version: '1.0',
            creator: 'Test',
            title: 'Hello flashcard',
            source: 'openverse',
            width: 1200,
            height: 800,
            tags: [{ name: 'hello' }],
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ query: { pages: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }, () => service.warmLevel('A1', { maxImages: 5, maxSpeech: 0 }));

    assert.equal(result.imagesResolved, 1);
    assert.equal(result.imagesQueued, 0);
    assert.equal(result.imagesAttached, 1);
    assert.deepEqual(result.missingImages, []);
    assert.deepEqual(cached, ['asset-1']);
    const content = fixture.updates.get('item-1');
    assert.ok(content);
    const assets = content.imageAssets as Array<Record<string, unknown>>;
    assert.equal(assets[0]?.key, 'img:a1-u01:hello');
    assert.equal(assets[0]?.kind, 'word');
    assert.equal(assets[0]?.targetText, 'hello');
    assert.deepEqual(content.imageAssetIds, ['asset-1']);
  } finally {
    if (previousMode === undefined) delete process.env.AI_GATEWAY_MODE;
    else process.env.AI_GATEWAY_MODE = previousMode;
  }
});

test('图片预热：两个来源都没有结果时返回可上传的缺失清单', async () => {
  const fixture = fakePrisma(activityContent());
  const service = new CurriculumWarmupService(
    fixture.prisma as never,
    {} as never,
    {} as never,
    { cacheNext: async () => undefined } as never,
  );
  const previousMode = process.env.AI_GATEWAY_MODE;
  process.env.AI_GATEWAY_MODE = 'mock';
  try {
    const result = await withFetch(
      () => new Response('temporarily unavailable', { status: 503 }),
      () => service.warmLevel('A1', { maxImages: 5, maxSpeech: 0 }),
    );

    assert.equal(result.imagesResolved, 0);
    assert.equal(result.imagesAttached, 0);
    assert.equal(result.missingImages.length, 1);
    assert.equal(result.missingImages[0]?.key, 'img:a1-u01:hello');
    assert.equal(result.missingImages[0]?.reason, '未搜索到授权明确的图片');
    assert.equal(fixture.updates.size, 0);
  } finally {
    if (previousMode === undefined) delete process.env.AI_GATEWAY_MODE;
    else process.env.AI_GATEWAY_MODE = previousMode;
  }
});

test('管理员上传图片：按 imageKey 挂到已发布活动', async () => {
  const fixture = fakePrisma(activityContent());
  fixture.prisma.media_assets.findUnique = async () => ({
    id: 'upload-1',
    sourceUrl: null,
    ref: 'img:a1-u01:hello',
    cacheStatus: 'cached',
  }) as never;
  const service = new CurriculumWarmupService(
    fixture.prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const result = await service.attachUploadedImage({
    assetId: 'upload-1',
    key: 'img:a1-u01:hello',
    kind: 'word',
    targetText: 'hello',
    targetWord: 'hello',
  });

  assert.deepEqual(result, { attached: 1 });
  const content = fixture.updates.get('item-1');
  assert.ok(content);
  const assets = content.imageAssets as Array<Record<string, unknown>>;
  assert.equal(assets[0]?.id, 'upload-1');
  assert.equal(assets[0]?.key, 'img:a1-u01:hello');
  assert.equal(assets[0]?.targetWord, 'hello');
});

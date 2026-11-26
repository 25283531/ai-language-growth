/**
 * L5 课程知识 RAG 回归：
 *  - 分词、词法得分与余弦相似度的确定性行为；
 *  - Embedding 可用时走混合召回，不可用时只走词法召回；
 *  - 检索结果只返回课程知识块，不返回儿童学习证据。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CurriculumKnowledgeService,
  cosineSimilarity,
  lexicalScore,
  tokenizeQuery,
} from '../src/memory/curriculum-knowledge.service.ts';

describe('L5 知识库打分', () => {
  it('英文按词、中文按二字滑窗分词', () => {
    assert.deepEqual(tokenizeQuery('Apple 苹果怎么读'), ['apple', '苹果', '果怎', '怎么', '么读']);
    assert.deepEqual(tokenizeQuery('a'), []);
  });

  it('完整短语命中优先于单词零散命中', () => {
    const phrase = lexicalScore('apple pie', ['apple', 'pie'], '食物', 'I like apple pie.');
    const scattered = lexicalScore('apple pie', ['apple', 'pie'], '食物', 'apple and pie are separate.');
    assert.ok(phrase > scattered);
  });

  it('余弦相似度维度不一致或零向量返回 0', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [1]), 0);
    assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  });
});

describe('CurriculumKnowledgeService.search', () => {
  const rows = [
    {
      id: 'chunk-1',
      sourceType: 'lexicon',
      sourceId: 'lex-1',
      topicId: null,
      title: '单词 apple',
      content: 'apple ˈæpl。中文：苹果。例句：I like apples.',
      metadata: { word: 'apple' },
      embedding: [1, 0],
    },
    {
      id: 'chunk-2',
      sourceType: 'curriculum_unit',
      sourceId: 'unit-1',
      topicId: 'topic-food',
      title: '课程单元 Fruit',
      content: '学习 banana 与 grape，并练习 I like bananas.',
      metadata: { unitId: 'unit-1' },
      embedding: [0, 1],
    },
  ];

  function serviceWith(embeddingEnabled: boolean) {
    const prisma = {
      curriculum_knowledge_chunks: {
        findMany: async () => rows,
      },
    };
    const embeddings = {
      isConfigured: async () => embeddingEnabled,
      embed: async () => embeddingEnabled ? { vectors: [[0.9, 0.1]], model: 'test-embedding' } : null,
    };
    return new CurriculumKnowledgeService(prisma as never, embeddings as never);
  }

  it('Embedding 可用时混合召回', async () => {
    const hits = await serviceWith(true).search({ query: 'apple', limit: 2 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.sourceType, 'lexicon');
    assert.ok(hits[0]!.score > hits[1]!.score);
  });

  it('Embedding 不可用时仍可词法召回', async () => {
    const hits = await serviceWith(false).search({ query: 'banana', limit: 2 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.sourceId, 'unit-1');
  });

  it('空查询直接返回空数组', async () => {
    const hits = await serviceWith(true).search({ query: '   ', limit: 3 });
    assert.deepEqual(hits, []);
  });

  it('带主题检索时主题过滤与词法过滤同时生效，不互相覆盖', async () => {
    const capturedWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      curriculum_knowledge_chunks: {
        findMany: async (args: { where?: Record<string, unknown> }) => {
          capturedWhere.push(args.where ?? {});
          return [];
        },
      },
    };
    const embeddings = {
      isConfigured: async () => false,
      embed: async () => null,
    };
    const service = new CurriculumKnowledgeService(prisma as never, embeddings as never);
    await service.search({ query: 'apple', topicId: 'topic-food' });
    assert.equal(capturedWhere.length, 2);
    assert.ok(Array.isArray(capturedWhere[0]!.AND));
    assert.deepEqual(capturedWhere[1]!.OR, [{ topicId: 'topic-food' }, { topicId: null }]);
  });
});

describe('CurriculumKnowledgeService.reindex', () => {
  function fakePrisma(existing: Record<string, unknown> | null) {
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      lexicon_entries: {
        findMany: async () => [{
          id: 'lex-1',
          word: 'apple',
          phonetic: 'ˈæpl',
          pos: 'n.',
          meaningZh: '苹果',
          domains: ['food'],
          examples: [{ en: 'I like apples.', zh: '我喜欢苹果。' }],
          collocations: ['apple pie'],
        }],
      },
      curriculum_units: { findMany: async () => [] },
      vocabulary_items: { findMany: async () => [] },
      sentence_patterns: { findMany: async () => [] },
      phoneme_items: { findMany: async () => [] },
      curriculum_knowledge_chunks: {
        findUnique: async () => existing,
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
        create: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
    };
    return { prisma, updates };
  }

  it('内容变化但 Embedding 不可用时更新文本并清掉旧向量', async () => {
    const { prisma, updates } = fakePrisma({
      id: 'chunk-1',
      contentHash: 'stale-hash',
      embedding: [1, 0],
      embeddingModel: 'old-model',
    });
    const embeddings = {
      isConfigured: async () => false,
      embed: async () => null,
    };
    const service = new CurriculumKnowledgeService(prisma as never, embeddings as never);
    const result = await service.reindex({ prune: true });
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.embedded, 0);
    assert.equal(updates.length, 1);
    assert.notEqual(updates[0]!.contentHash, 'stale-hash');
    assert.equal(updates[0]!.embeddingModel, null);
    assert.ok(updates[0]!.embedding);
  });

  it('没有旧块时创建新块', async () => {
    const { prisma, updates } = fakePrisma(null);
    const embeddings = {
      isConfigured: async () => false,
      embed: async () => null,
    };
    const service = new CurriculumKnowledgeService(prisma as never, embeddings as never);
    const first = await service.reindex({});
    assert.equal(first.created, 1);
    assert.equal(updates.length, 0);
  });
});
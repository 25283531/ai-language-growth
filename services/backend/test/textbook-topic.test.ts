import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTextbookTopic } from '../src/curriculum/textbook-topic.ts';

type Query = Record<string, unknown>;

function stub(rows: Array<{ topicId: string } | null>) {
  const queries: Query[] = [];
  const prisma = {
    curriculum_units: {
      findFirst: async (args: Query) => {
        queries.push(args);
        return rows.shift() ?? null;
      },
    },
  };
  return { prisma, queries };
}

describe('教材单元 → 课程主题解析', () => {
  it('有明确教材单元时按该单元取已发布主题', async () => {
    const { prisma, queries } = stub([{ topicId: 'topic-textbook-u07' }]);
    const topicId = await resolveTextbookTopic(prisma, {
      unitId: 'unit-7',
      textbookId: 'book-1',
    });
    assert.equal(topicId, 'topic-textbook-u07');
    const where = queries[0]?.where as Query;
    assert.equal(where.textbookUnitId, 'unit-7');
    assert.equal(where.reviewStatus, 'published');
    assert.equal(where.availability, 'active');
    assert.deepEqual(where.textbookUnit, { textbookId: 'book-1' });
  });

  it('没有指定单元时取该教材顺序最靠前的已发布单元', async () => {
    const { prisma, queries } = stub([{ topicId: 'topic-book-1-u01' }]);
    const topicId = await resolveTextbookTopic(prisma, { textbookId: 'book-1' });
    assert.equal(topicId, 'topic-book-1-u01');
    const args = queries[0] as Query;
    assert.equal(args.textbookUnitId, undefined);
    assert.deepEqual((args.where as Query).textbookUnit, { textbook: { id: 'book-1' } });
    assert.deepEqual(args.orderBy, [
      { textbookUnit: { order: 'asc' } },
      { publishedAt: 'desc' },
    ]);
  });

  it('教材映射只记出版社与年级时按出版社+年级收敛', async () => {
    const { prisma, queries } = stub([{ topicId: 'topic-pep-grade8' }]);
    const topicId = await resolveTextbookTopic(prisma, { publisher: '人民教育出版社', grade: '八年级' });
    assert.equal(topicId, 'topic-pep-grade8');
    assert.deepEqual((queries[0]?.where as Query).textbookUnit, {
      textbook: { publisher: '人民教育出版社', grade: '八年级' },
    });
  });

  it('查不到已发布单元时返回 null，调用方维持旧行为', async () => {
    const { prisma, queries } = stub([null]);
    assert.equal(await resolveTextbookTopic(prisma, { unitId: 'unit-x' }), null);
    // 出版社与年级都缺失时不发无意义查询。
    const empty = stub([]);
    assert.equal(await resolveTextbookTopic(empty.prisma, {}), null);
    assert.equal(empty.queries.length, 0);
    assert.equal(queries.length, 1);
  });

  it('空白 topicId 视为未解析', async () => {
    const { prisma } = stub([{ topicId: '   ' }]);
    assert.equal(await resolveTextbookTopic(prisma, { unitId: 'unit-7' }), null);
  });
});

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
  it('有明确教材单元时优先按单元取已发布主题', async () => {
    const { prisma, queries } = stub([{ topicId: 'topic-textbook-u07' }]);
    const topicId = await resolveTextbookTopic(prisma, {
      textbookId: 'book-1',
      unitId: 'unit-7',
    });
    assert.equal(topicId, 'topic-textbook-u07');
    const where = queries[0]?.where as Query;
    assert.equal(where.textbookUnitId, 'unit-7');
    assert.equal(where.reviewStatus, 'published');
    assert.equal(where.availability, 'active');
    assert.deepEqual(where.textbookUnit, { textbookId: 'book-1' });
    assert.equal(queries.length, 1);
  });

  it('有新映射的 textbookId 时取该教材顺序最靠前的已发布单元', async () => {
    const { prisma, queries } = stub([{ topicId: 'topic-book-1-u01' }]);
    const topicId = await resolveTextbookTopic(prisma, { textbookId: 'book-1', grade: '八年级' });
    assert.equal(topicId, 'topic-book-1-u01');
    const args = queries[0] as Query;
    assert.equal(args.textbookUnitId, undefined);
    assert.deepEqual((args.where as Query).textbookUnit, { textbookId: 'book-1' });
    assert.deepEqual(args.orderBy, [
      { textbookUnit: { order: 'asc' } },
      { publishedAt: 'desc' },
    ]);
  });

  it('老映射只有出版社+年级时按精确值匹配', async () => {
    const { prisma, queries } = stub([{ topicId: 'topic-pep-grade8' }]);
    const topicId = await resolveTextbookTopic(prisma, { publisher: '人民教育出版社', grade: '八年级' });
    assert.equal(topicId, 'topic-pep-grade8');
    assert.deepEqual((queries[0]?.where as Query).textbookUnit, {
      textbook: { publisher: '人民教育出版社', grade: '八年级' },
    });
  });

  it('出版社写法不一致时退回年级+版次', async () => {
    // 映射存「人教版」，目录存「人民教育出版社」：精确匹配空，第二次按年级+版次命中。
    const { prisma, queries } = stub([null, { topicId: 'topic-grade8-vol1' }]);
    const topicId = await resolveTextbookTopic(prisma, {
      publisher: '人教版',
      grade: '八年级',
      edition: '上册',
    });
    assert.equal(topicId, 'topic-grade8-vol1');
    assert.equal(queries.length, 2);
    assert.deepEqual((queries[1]?.where as Query).textbookUnit, {
      textbook: { grade: '八年级', edition: '上册' },
    });
  });

  it('都有 id 时不跨教材按年级兜底', async () => {
    const { prisma, queries } = stub([null, null]);
    const topicId = await resolveTextbookTopic(prisma, {
      textbookId: 'book-1',
      unitId: 'unit-x',
      grade: '八年级',
    });
    assert.equal(topicId, null);
    // 只试「单元」与「教材」两种定位，不用年级兜底。
    assert.equal(queries.length, 2);
  });

  it('查不到已发布单元时返回 null，且无条件时不发查询', async () => {
    const empty = stub([]);
    assert.equal(await resolveTextbookTopic(empty.prisma, {}), null);
    assert.equal(empty.queries.length, 0);
  });

  it('空白 topicId 视为未解析', async () => {
    const { prisma } = stub([{ topicId: '   ' }]);
    assert.equal(await resolveTextbookTopic(prisma, { unitId: 'unit-7' }), null);
  });
});

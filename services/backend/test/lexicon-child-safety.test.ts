import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LexiconService } from '../src/curriculum/lexicon.service';
import type { PrismaService } from '../src/prisma/prisma.service';

function row(word: string, childSafe: boolean, domains: string[] = []) {
  return {
    word,
    lemma: word,
    familyKey: word,
    familyRank: 1,
    phonetic: `/${word}/`,
    pos: 'n.',
    meaningZh: word === 'war' ? '战争' : '苹果',
    frequencyRank: 1,
    bncRank: null,
    tags: [],
    domains,
    variants: [word],
    collocations: [],
    examples: [],
    source: 'ecdict',
    license: 'MIT',
    childSafe,
    isCore: true,
    isFunctionWord: false,
    textbookUnitIds: [],
  };
}

function serviceWithRows() {
  const prisma = {
    lexicon_entries: {
      findMany: async () => [row('war', false), row('apple', true, ['food'])],
    },
    textbook_units: {
      findUnique: async () => null,
    },
  };
  return new LexiconService(prisma as unknown as PrismaService);
}

describe('LexiconService 儿童安全过滤', () => {
  it('管理端默认保留全量词条', async () => {
    const entries = await serviceWithRows().lookupMany(['war', 'apple']);
    assert.deepEqual([...entries.keys()].sort(), ['apple', 'war']);
    assert.equal(entries.get('war')?.childSafe, false);
  });

  it('儿童课程入口只返回 childSafe=true 的词', async () => {
    const entries = await serviceWithRows().lookupMany(['war', 'apple'], { childSafeOnly: true });
    assert.deepEqual([...entries.keys()], ['apple']);
    assert.equal(entries.get('apple')?.childSafe, true);
  });

  it('单条查询同样尊重 childSafeOnly', async () => {
    const service = serviceWithRows();
    assert.equal(await service.lookup('war', { childSafeOnly: true }), null);
    assert.equal((await service.lookup('war'))?.childSafe, false);
  });

});

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

  it('管理端统计返回核心/扩展字段与儿童安全覆盖', async () => {
    const prisma = {
      lexicon_entries: {
        count: async (args: { where?: Record<string, unknown> } = {}) => {
          const where = args.where;
          if (where?.isCore) {
            if (where.phonetic) return 2992;
            if (where.meaningZh) return 3000;
            if (where.pos) return 3000;
            if (where.domains) return 983;
            if (where.childSafe === false) return 39;
            return 3000;
          }
          if (where?.textbookUnitIds) return 10;
          if (where?.phonetic) return 4967;
          if (where?.meaningZh) return 5000;
          if (where?.pos) return 5000;
          if (where?.domains) return 1407;
          if (where?.childSafe === false) return 55;
          return 5000;
        },
      },
    };
    const stats = await new LexiconService(prisma as unknown as PrismaService).stats();
    assert.equal(stats.core, 3000);
    assert.equal(stats.extension, 2000);
    assert.equal(stats.coreDomainCoverage, 983 / 3000);
    assert.equal(stats.coreChildSafeFalse, 39);
    assert.equal(stats.coreChildSafeCoverage, (3000 - 39) / 3000);
    assert.equal(stats.extensionPhoneticCoverage, 1975 / 2000);
    assert.equal(stats.extensionMeaningCoverage, 1);
    assert.equal(stats.extensionPosCoverage, 1);
    assert.equal(stats.extensionDomainCoverage, 424 / 2000);
    assert.equal(stats.extensionChildSafeFalse, 16);
    assert.equal(stats.extensionChildSafeCoverage, 1984 / 2000);
    assert.equal(stats.totalChildSafeFalse, 55);
    assert.equal(stats.totalChildSafeCoverage, 4945 / 5000);
  });
});

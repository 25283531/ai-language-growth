import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LexiconService, extractTextbookMetadata, extractUnitWordList } from '../src/curriculum/lexicon.service';

const textbookUnitId = '11111111-1111-4111-8111-111111111111';
const textbookId = '22222222-2222-4222-8222-222222222222';

function row(overrides: Record<string, unknown>) {
  return {
    word: 'cat',
    lemma: 'cat',
    familyKey: 'cat',
    familyRank: 10,
    phonetic: '/kæt/',
    pos: 'n.',
    meaningZh: '猫',
    frequencyRank: 1775,
    bncRank: 1712,
    tags: ['zk', 'gk'],
    domains: ['animals'],
    variants: ['cats'],
    collocations: [],
    examples: [],
    source: 'ecdict',
    license: 'MIT',
    childSafe: true,
    isCore: true,
    isFunctionWord: false,
    textbookUnitIds: [],
    ...overrides,
  };
}

function setup() {
  const rows = [
    row({}),
    row({
      word: 'run', lemma: 'run', familyKey: 'run', familyRank: 182,
      phonetic: '/rʌn/', pos: 'v.', meaningZh: '跑', frequencyRank: 202,
      bncRank: 208, domains: ['actions'], variants: ['ran', 'running', 'runs'],
    }),
  ];
  const prisma = {
    lexicon_entries: {
      findMany: async () => rows,
      count: async () => rows.length,
    },
    textbook_units: {
      findUnique: async () => ({
        metadata: {
          vocabulary: [
            { word: 'cat', phonetic: '/kæt-teaching/', meaningZh: '猫（教材释义）' },
            { word: 'giraffe', phonetic: '/dʒɪˈrɑːf/', meaningZh: '长颈鹿' },
          ],
        },
      }),
    },
  };
  return new LexiconService(prisma as never);
}

describe('LexiconService：教材词优先', () => {  it('教材 metadata 覆盖 ECDICT 字段，并保留教材单元标记', async () => {
    const service = setup();
    const entries = await service.lookupMany(['cat', 'run'], { textbookUnitId });
    const cat = entries.get('cat');
    const run = entries.get('run');

    assert.equal(cat?.matchSource, 'textbook');
    assert.equal(cat?.phonetic, '/kæt-teaching/');
    assert.equal(cat?.meaningZh, '猫（教材释义）');
    assert.deepEqual(cat?.textbookUnitIds, [textbookUnitId]);
    assert.equal(run?.matchSource, 'ecdict');
    assert.equal(run?.phonetic, '/rʌn/');
  });

  it('教材词表里有、全局词库没有的词，也能以教材来源返回', async () => {
    const service = setup();
    const entry = await service.lookup('giraffe', { textbookUnitId });
    assert.equal(entry?.matchSource, 'textbook');
    assert.equal(entry?.word, 'giraffe');
    assert.equal(entry?.meaningZh, '长颈鹿');
    assert.equal(entry?.source, 'textbook');
  });

  it('输入词表本身视为教材词，未落库也不会丢词', async () => {
    const service = setup();
    const entry = await service.lookup('dog', { textbookWords: ['dog'] });
    assert.equal(entry?.matchSource, 'textbook');
    assert.equal(entry?.word, 'dog');
    assert.equal(entry?.meaningZh, '');
  });

  it('屈折形式通过 variants 命中词族代表词，并记录 matchedForm', async () => {
    const service = setup();
    const entry = await service.lookup('cats');
    assert.equal(entry?.word, 'cat');
    assert.equal(entry?.matchedForm, 'cats');
    assert.equal(entry?.matchSource, 'ecdict');
  });

  it('metadata 同时支持字符串数组与对象数组', () => {
    const entries = extractTextbookMetadata({
      words: ['cat', 'dog'],
      vocabulary: [{ word: 'giraffe', meaning: '长颈鹿' }],
    });
    assert.deepEqual([...entries.keys()].sort(), ['cat', 'dog', 'giraffe']);
    assert.equal(entries.get('giraffe')?.meaningZh, '长颈鹿');
  });
});

const coverageUnitId = '33333333-3333-4333-8333-333333333333';

function coverageSetup(options: { words?: unknown[]; rows?: Array<Record<string, unknown>> } = {}) {
  const rows = options.rows ?? [
    row({ word: 'family', lemma: 'family', familyKey: 'family', phonetic: '/ˈfæməli/', meaningZh: '家庭', variants: ['families'] }),
    row({ word: 'mother', lemma: 'mother', familyKey: 'mother', phonetic: '/ˈmʌðə/', meaningZh: '妈妈', variants: ['mothers'] }),
    row({ word: 'cat', lemma: 'cat', familyKey: 'cat', phonetic: '', meaningZh: '猫', variants: ['cats'], isCore: false }),
  ];
  const calls: Array<{ model: string; action: string; args?: unknown }> = [];
  const prisma = {
    textbook_units: {
      findUnique: async (args: unknown) => {
        calls.push({ model: 'unit', action: 'findUnique', args });
        return {
          id: coverageUnitId,
          textbookId,
          unitCode: 'Unit 3',
          title: 'My Family',
          order: 3,
          metadata: { words: options.words ?? ['1. family', 'mother', 'cats', 'unicorn'] },
        };
      },
      findMany: async (args: unknown) => {
        calls.push({ model: 'unit', action: 'findMany', args });
        return [
          { unitCode: 'Unit 1', order: 1, metadata: { words: ['mother', 'cat'] } },
          { unitCode: 'Unit 2', order: 2, metadata: { words: ['future'] } },
        ];
      },
    },
    lexicon_entries: {
      findMany: async (args: unknown) => {
        calls.push({ model: 'lexicon', action: 'findMany', args });
        return rows;
      },
    },
  };
  return { service: new LexiconService(prisma as never), calls };
}

describe('LexiconService：教材单元词表覆盖率', () => {
  it('按 word/variants 命中，区分新词、复用词与缺口', async () => {
    const { service, calls } = coverageSetup();
    const coverage = await service.textbookUnitCoverage(coverageUnitId);

    assert.ok(coverage);
    assert.deepEqual(coverage.counts, { total: 4, covered: 3, newWords: 1, reusedWords: 2, gaps: 1 });
    assert.equal(coverage.hitRate, 0.75);
    assert.deepEqual(coverage.newWords.map((item) => item.word), ['family']);
    assert.deepEqual(coverage.reusedWords.map((item) => item.word), ['mother', 'cats']);
    assert.deepEqual(coverage.gaps, ['unicorn']);

    const cats = coverage.reusedWords.find((item) => item.word === 'cats');
    assert.equal(cats?.matchedWord, 'cat');
    assert.deepEqual(cats?.priorUnitCodes, ['Unit 1']);
    assert.deepEqual(coverage.fieldCoverage, {
      phonetic: 2,
      meaningZh: 3,
      phoneticRate: 2 / 3,
      meaningZhRate: 1,
    });
    assert.equal(coverage.coreWords, 2);
    assert.equal(coverage.coreRate, 0.5);
    assert.deepEqual(coverage.method, { priorScope: 'same_textbook_earlier_units', priorUnitCount: 2 });

    const priorQuery = calls.find((call) => call.model === 'unit' && call.action === 'findMany');
    assert.deepEqual(priorQuery?.args, {
      where: { textbookId, order: { lt: 3 }, id: { not: coverageUnitId } },
      select: { unitCode: true, order: true, metadata: true },
      orderBy: [{ order: 'asc' }, { unitCode: 'asc' }],
    });
  });

  it('空词表返回 0 覆盖率且不查词库', async () => {
    const { service, calls } = coverageSetup({ words: [] });
    const coverage = await service.textbookUnitCoverage(coverageUnitId);

    assert.ok(coverage);
    assert.deepEqual(coverage.counts, { total: 0, covered: 0, newWords: 0, reusedWords: 0, gaps: 0 });
    assert.equal(coverage.hitRate, 0);
    assert.equal(coverage.fieldCoverage.phoneticRate, 0);
    assert.equal(coverage.fieldCoverage.meaningZhRate, 0);
    assert.equal(coverage.coreRate, 0);
    assert.equal(calls.some((call) => call.model === 'lexicon'), false);
  });

  it('合并 metadata 词表与已生成 vocabulary，去重并去掉序号', () => {
    assert.deepEqual(extractUnitWordList({
      words: ['1. family', 'Mother', 'family'],
      vocabulary: [{ word: 'mother' }, { word: 'giraffe' }],
      content: { vocabulary: [{ word: 'FAMILY' }, { word: 'ice cream' }] },
    }), ['family', 'mother', 'giraffe', 'ice cream']);
  });
});

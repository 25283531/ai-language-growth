import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyChildSafeExamples,
  applyChildSenseOverrides,
  buildChildSafeExample,
} from '../src/examples';
import type { LexiconRecord } from '../src/types';

function record(overrides: Partial<LexiconRecord> = {}): LexiconRecord {
  return {
    word: 'apple',
    lemma: 'apple',
    familyKey: 'apple',
    familyRank: 1,
    phonetic: '',
    pos: 'n.',
    meaningZh: '苹果',
    tags: ['zk', 'gk'],
    domains: [],
    variants: [],
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

describe('P3-05 核心词儿童例句', () => {
  it('功能词按实际课程义项生成，不采用 ECDICT 的错误首义', () => {
    const can = applyChildSenseOverrides([record({ word: 'can', pos: 'vt.', meaningZh: '装罐' })])[0];
    assert.equal(can.pos, 'aux.');
    assert.equal(can.meaningZh, '能；可以');
    assert.deepEqual(buildChildSafeExample(can), { en: 'I can run.', zh: '我能跑。' });
  });

  it('词性误标的高频名词/动词按儿童义项修正', () => {
    const plane = applyChildSenseOverrides([record({ word: 'plane', meaningZh: '平面；扁平物' })])[0];
    assert.equal(plane.meaningZh, '飞机');
    assert.deepEqual(buildChildSafeExample(plane), { en: 'This is a plane.', zh: '这是一架飞机。' });

    const ruler = applyChildSenseOverrides([record({ word: 'ruler', meaningZh: '统治者；管理者' })])[0];
    assert.equal(ruler.meaningZh, '尺子');
    assert.deepEqual(buildChildSafeExample(ruler), { en: 'This is a ruler.', zh: '这是一把尺子。' });
  });

  it('数字例句使用中文数字，不把英文数词混进中文', () => {
    const eight = buildChildSafeExample(record({ word: 'eight', pos: 'num.', meaningZh: '八；八个' }));
    assert.deepEqual(eight, { en: 'I have eight apples.', zh: '我有八个苹果。' });
    assert.doesNotMatch(eight.zh, /[A-Za-z]/);
  });

  it('只给指定标签的前 N 个词写例句', () => {
    const entries = [
      record({ word: 'first', familyRank: 1 }),
      record({ word: 'outside', familyRank: 2, tags: ['other'] }),
      record({ word: 'second', familyRank: 3 }),
      record({ word: 'third', familyRank: 4 }),
    ];
    const result = applyChildSafeExamples(entries, { limit: 2, tags: ['zk', 'gk'] });
    assert.deepEqual(result.map((entry) => entry.examples.length), [1, 0, 1, 0]);
  });

  it('默认跳过不安全词和非核心词，不把例句写进儿童不可用数据', () => {
    const entries = [
      record({ word: 'safe', familyRank: 1 }),
      record({ word: 'unsafe', familyRank: 2, childSafe: false }),
      record({ word: 'extended', familyRank: 3001, isCore: false }),
    ];
    const result = applyChildSafeExamples(entries, { limit: 10, coreOnly: true });
    assert.deepEqual(result.map((entry) => entry.examples.length), [1, 0, 0]);
  });

  it('生成的完整核心数据覆盖全部安全词，并通过基础质量校验', () => {
    const dataset = JSON.parse(readFileSync(resolve(__dirname, '../data/lexicon.json'), 'utf8')) as {
      entries: LexiconRecord[];
    };
    const core = dataset.entries.filter((entry) => entry.isCore);
    const safeCore = core.filter((entry) => entry.childSafe);
    const withExamples = core.filter((entry) => entry.examples.length > 0);
    assert.equal(core.length, 3000);
    assert.equal(withExamples.length, safeCore.length);
    assert.ok(withExamples.length >= 2950);
    assert.equal(new Set(withExamples.map((entry) => entry.word)).size, withExamples.length);

    for (const entry of withExamples) {
      const example = entry.examples[0];
      assert.ok(example.en, entry.word);
      assert.ok(example.zh, entry.word);
      assert.ok(entry.pos, entry.word);
      assert.ok(entry.meaningZh, entry.word);
      assert.equal(entry.childSafe, true, entry.word);
      assert.match(example.en, /[.!?]$/, entry.word);
      assert.match(example.zh, /[\u4e00-\u9fff]/, entry.word);
      assert.doesNotMatch(example.zh, /[A-Za-z]{2,}/, entry.word);
      assert.ok(example.en.toLowerCase().includes(entry.word.toLowerCase()), entry.word);
    }

    const unsafe = core.filter((entry) => !entry.childSafe);
    assert.ok(unsafe.length > 0);
    assert.ok(unsafe.every((entry) => entry.examples.length === 0));

    const byWord = new Map(withExamples.map((entry) => [entry.word, entry]));
    assert.equal(byWord.get('can')?.meaningZh, '能；可以');
    assert.equal(byWord.get('plane')?.meaningZh, '飞机');
    assert.equal(byWord.get('ruler')?.meaningZh, '尺子');
    assert.equal(byWord.get('eight')?.examples[0].zh, '我有八个苹果。');
    assert.equal(byWord.get('a')?.pos, 'art.');
    assert.equal(byWord.get('medical')?.pos, 'a.');
    assert.equal(byWord.get('steal'), undefined);
  });

});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { buildLexiconFromRows, cleanMeaningZh, parseForms, TEXTBOOK_PRIORITY_WORDS } from '../src/lexicon';
import type { EcdictRow } from '../src/types';

function ecdict(word: string, overrides: Partial<EcdictRow> = {}): EcdictRow {
  return {
    word,
    phonetic: '',
    definition: '',
    translation: 'n. 测试',
    pos: '',
    collins: '',
    oxford: '',
    tag: '',
    bnc: '0',
    frq: '1',
    exchange: '',
    detail: '',
    audio: '',
    ...overrides,
  };
}

describe('ECDICT 词族构建', () => {
  it('按 exchange 归并屈折形式，不把 0/1 元数据当成词形', () => {
    assert.deepEqual(parseForms('run', 'p:ran/i:running/d:run/0:run/1:ing/3:runs/s:runs').sort(), [
      'ran', 'run', 'running', 'runs',
    ]);
  });

  it('同一词族只保留一个代表词，variants 供反向查询', () => {
    const dataset = buildLexiconFromRows([
      ecdict('run', { frq: '202', exchange: 'p:ran/i:running/3:runs' }),
      ecdict('running', { frq: '900', exchange: '0:running/1:ing' }),
      ecdict('cat', { frq: '1775', phonetic: 'kæt', translation: 'n. 猫, 恶妇\\nvi. 呕吐', exchange: 's:cats' }),
      ecdict('cats', { frq: '4000', exchange: '0:cats' }),
    ], { maxFamilies: 10, coreFamilies: 5 });

    assert.equal(dataset.entries.length, 2);
    const run = dataset.entries.find((entry) => entry.word === 'run');
    assert.ok(run);
    assert.deepEqual(run.variants.sort(), ['ran', 'running', 'runs']);
    const cat = dataset.entries.find((entry) => entry.word === 'cat');
    assert.ok(cat);
    assert.equal(cat.meaningZh, '猫');
    assert.deepEqual(cat.variants, ['cats']);
  });

  it('中文释义不会被英文换行转义串进中文栏', () => {
    assert.equal(cleanMeaningZh('n. 狗, 坏蛋\\nvt. 跟踪, 尾随'), '狗');
  });

  it('教材首册高频词全部有音标和中文释义', () => {
    const dataset = JSON.parse(readFileSync(resolve(__dirname, '../data/lexicon.json'), 'utf8')) as {
      entries: Array<{ word: string; variants: string[]; phonetic: string; meaningZh: string }>;
    };
    const byForm = new Map<string, (typeof dataset.entries)[number]>();
    for (const entry of dataset.entries) {
      byForm.set(entry.word, entry);
      for (const variant of entry.variants) if (!byForm.has(variant)) byForm.set(variant, entry);
    }
    const missing = [...TEXTBOOK_PRIORITY_WORDS].filter((word) => {
      const entry = byForm.get(word);
      return !entry?.phonetic || !entry.meaningZh;
    });
    assert.deepEqual(missing, []);
  });

  it('生成数据达到 3,000 核心 + 5,000 词族，核心音标覆盖 ≥99%', () => {
    const dataset = JSON.parse(readFileSync(resolve(__dirname, '../data/lexicon.json'), 'utf8')) as {
      totalFamilies: number;
      coreFamilies: number;
      entries: Array<{ word: string; isCore: boolean; phonetic: string; meaningZh: string }>;
    };
    assert.equal(dataset.totalFamilies, 5000);
    assert.equal(dataset.coreFamilies, 3000);
    assert.equal(dataset.entries.length, 5000);
    const core = dataset.entries.filter((entry) => entry.isCore);
    assert.equal(core.length, 3000);
    assert.ok(core.filter((entry) => entry.phonetic).length / core.length >= 0.99);
    assert.equal(core.filter((entry) => entry.meaningZh).length, core.length);
    assert.equal(dataset.entries.find((entry) => entry.word === 'cat')?.meaningZh, '猫');
    assert.ok(dataset.entries.some((entry) => entry.word === 'hello' && entry.phonetic && entry.meaningZh));
    assert.ok(dataset.entries.some((entry) => entry.word === 'goodbye' && entry.phonetic && entry.meaningZh));
  });
});

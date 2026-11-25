import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assessChildSafety, buildLexiconFromRows, cleanMeaningZh, detectDomains, parseForms, TEXTBOOK_PRIORITY_WORDS } from '../src/lexicon';
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



  it('领域标签覆盖教材优先词，抽象词允许为空', () => {
    assert.ok(detectDomains('aunt', '阿姨').includes('self_family'));
    assert.ok(detectDomains('gray', '灰色').includes('colors_numbers'));
    assert.ok(detectDomains('pear', '梨').includes('food'));
    assert.ok(detectDomains('plane', '飞机').includes('community_transport'));
    assert.ok(detectDomains('yesterday', '昨天').includes('weather_time'));
    assert.ok(detectDomains('think', '想；考虑').includes('actions'));
    assert.deepEqual(detectDomains('good', '好的'), []);
  });

  it('儿童安全判定覆盖屈折/派生形式和中文风险义项', () => {
    for (const word of ['dead', 'death', 'die', 'killing', 'killer', 'sexual', 'wine', 'cancer', 'war', 'knife', 'pregnant']) {
      assert.equal(assessChildSafety(word, ''), false, word);
    }
    for (const word of ['apple', 'happy', 'doctor', 'police', 'family']) {
      assert.equal(assessChildSafety(word, ''), true, word);
    }
    assert.equal(assessChildSafety('ghost', '鬼；灵魂'), false);
    assert.equal(assessChildSafety('safe', '安全的'), true);
    // deadline 含 dead 词形、tuna 的中文“金枪鱼”含“枪”，但都不是儿童风险词。
    assert.equal(assessChildSafety('deadline', '最后期限；截止期限'), true);
    assert.equal(assessChildSafety('tuna', '金枪鱼；金枪鱼肉'), true);
  });

  it('构建时把可保留的风险词标为 childSafe=false', () => {
    const dataset = buildLexiconFromRows([
      ecdict('dead', { frq: '1', translation: 'a. 死的；不活泼的' }),
      ecdict('apple', { frq: '2', translation: 'n. 苹果' }),
      ecdict('killing', { frq: '3', translation: 'n. 杀戮' }),
    ], { maxFamilies: 10, coreFamilies: 5 });
    const byWord = new Map(dataset.entries.map((entry) => [entry.word, entry]));
    assert.equal(byWord.get('dead')?.childSafe, false);
    assert.equal(byWord.get('killing')?.childSafe, false);
    assert.equal(byWord.get('apple')?.childSafe, true);
    assert.ok(byWord.get('apple')?.domains.includes('food'));
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

  it('生成数据达到 3,000 核心词族，字段可导入', () => {
    const dataset = JSON.parse(readFileSync(resolve(__dirname, '../data/lexicon.json'), 'utf8')) as {
      totalFamilies: number;
      coreFamilies: number;
      entries: Array<{
        word: string;
        variants: string[];
        isCore: boolean;
        phonetic: string;
        pos: string;
        meaningZh: string;
        childSafe: boolean;
        domains: string[];
        examples: Array<{ en: string; zh: string }>;
      }>;
    };
    assert.equal(dataset.totalFamilies, 3000);
    assert.equal(dataset.coreFamilies, 3000);
    assert.equal(dataset.entries.length, 3000);
    const core = dataset.entries.filter((entry) => entry.isCore);
    assert.equal(core.length, 3000);
    assert.ok(core.filter((entry) => entry.phonetic).length / core.length >= 0.99);
    assert.equal(core.filter((entry) => entry.meaningZh).length, core.length);
    assert.equal(core.filter((entry) => entry.pos).length, core.length);
    assert.ok(core.filter((entry) => entry.domains.length > 0).length > 900);
    assert.ok(core.filter((entry) => entry.examples.length > 0).length / core.length >= 0.95);
    assert.equal(core.filter((entry) => !entry.childSafe).length, 39);
    assert.equal(dataset.entries.find((entry) => entry.word === 'cat')?.meaningZh, '猫');
    assert.ok(dataset.entries.some((entry) => entry.word === 'hello' && entry.phonetic && entry.meaningZh));
    assert.ok(dataset.entries.some((entry) => entry.word === 'goodbye' && entry.phonetic && entry.meaningZh));
  });
});

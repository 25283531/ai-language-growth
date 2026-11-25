import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { assessChildSafety, buildLexiconFromRows, cleanMeaningZh, detectDomains, EXTENSION_PRIORITY_WORDS, EXTENSION_PRIORITY_WORDS_BATCH_1, EXTENSION_PRIORITY_WORDS_BATCH_2, parseForms, SAFE_FORM_ALIASES, TEXTBOOK_PRIORITY_WORDS } from '../src/lexicon';
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

  it('技术义项不再误删 computer / internet 的常用释义', () => {
    assert.equal(cleanMeaningZh('n. 电脑, 电子计算机\\n[计] 计算机'), '电脑；电子计算机');
    assert.equal(cleanMeaningZh('[计] 因特网, 国际互连网, 网际网络'), '因特网；国际互连网');
    assert.equal(cleanMeaningZh('[网络用语] 网络用语示例'), '');
  });

  it('英式拼写和不规则复数挂到已有词族，不新增词族', () => {
    const aliases = Object.entries(SAFE_FORM_ALIASES);
    assert.equal(aliases.length, 14);
    const dataset = buildLexiconFromRows(
      aliases.map(([base], index) => ecdict(base, { frq: String(index + 1) })),
      { maxFamilies: 20, coreFamilies: 10 },
    );
    assert.equal(dataset.entries.length, 14);
    const byWord = new Map(dataset.entries.map((entry) => [entry.word, entry]));
    for (const [base, forms] of aliases) {
      const entry = byWord.get(base);
      assert.ok(entry, base);
      for (const alias of forms) {
        assert.ok(entry.variants.includes(alias), `${base} -> ${alias}`);
        assert.equal(byWord.has(alias), false, alias);
      }
    }
  });

  it('扩展层教材优先词只替换扩展层尾部，核心层保持不变', () => {
    const dataset = buildLexiconFromRows([
      ecdict('alpha', { frq: '1' }),
      ecdict('beta', { frq: '2' }),
      ecdict('gamma', { frq: '3' }),
      ecdict('delta', { frq: '4' }),
      ecdict('blackboard', { frq: '90000', translation: 'n. 黑板' }),
      ecdict('schoolbag', { frq: '0', bnc: '0', translation: 'n. 书包' }),
    ], { maxFamilies: 4, coreFamilies: 2 });

    const core = dataset.entries.filter((entry) => entry.isCore);
    const extension = dataset.entries.filter((entry) => !entry.isCore);
    assert.deepEqual(core.map((entry) => entry.word), ['alpha', 'beta']);
    assert.equal(extension.length, 2);
    assert.ok(extension.some((entry) => entry.word === 'blackboard'));
    assert.ok(extension.some((entry) => entry.word === 'schoolbag'));
    assert.equal(dataset.entries.length, 4);
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

  it('生成数据达到 3,000 核心 + 5,000 词族，扩展层字段可导入', () => {
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
      }>;
    };
    assert.equal(dataset.totalFamilies, 5000);
    assert.equal(dataset.coreFamilies, 3000);
    assert.equal(dataset.entries.length, 5000);
    const core = dataset.entries.filter((entry) => entry.isCore);
    const extension = dataset.entries.filter((entry) => !entry.isCore);
    const byForm = new Map<string, (typeof dataset.entries)[number]>();
    for (const entry of dataset.entries) {
      byForm.set(entry.word, entry);
      for (const variant of entry.variants) if (!byForm.has(variant)) byForm.set(variant, entry);
    }
    assert.equal(core.length, 3000);
    assert.equal(extension.length, 2000);
    assert.ok(core.filter((entry) => entry.phonetic).length / core.length >= 0.99);
    assert.equal(core.filter((entry) => entry.meaningZh).length, core.length);
    assert.equal(core.filter((entry) => entry.pos).length, core.length);
    // 扩展层进入 5,000 族后可被查询/导入，不能留下空词性；音标允许少量缺失。
    assert.equal(extension.filter((entry) => entry.meaningZh).length, extension.length);
    assert.equal(extension.filter((entry) => entry.pos).length, extension.length);
    assert.ok(extension.filter((entry) => entry.phonetic).length / extension.length >= 0.98);
    assert.equal(extension.filter((entry) => !entry.childSafe).length, 16);
    assert.equal(dataset.entries.find((entry) => entry.word === 'bacteria')?.pos, 'n.');
    assert.equal(dataset.entries.find((entry) => entry.word === 'uh')?.pos, 'interj.');
    assert.equal(dataset.entries.find((entry) => entry.word === 'deadline')?.childSafe, true);
    assert.equal(dataset.entries.find((entry) => entry.word === 'tuna')?.childSafe, true);
    assert.equal(dataset.entries.find((entry) => entry.word === 'cat')?.meaningZh, '猫');
    assert.ok(dataset.entries.some((entry) => entry.word === 'hello' && entry.phonetic && entry.meaningZh));
    assert.ok(dataset.entries.some((entry) => entry.word === 'goodbye' && entry.phonetic && entry.meaningZh));
    assert.equal(EXTENSION_PRIORITY_WORDS_BATCH_1.size, 30);
    assert.equal(EXTENSION_PRIORITY_WORDS_BATCH_2.size, 35);
    assert.equal(EXTENSION_PRIORITY_WORDS.size, 65);
    for (const word of EXTENSION_PRIORITY_WORDS) {
      const entry = byForm.get(word);
      assert.ok(entry, word);
      assert.equal(entry.isCore, false, word);
    }
    assert.equal(byForm.get('tidy')?.pos, 'a.');
    assert.equal(byForm.get('tidy')?.meaningZh, '整洁的；整理');
    assert.equal(byForm.get('fetch')?.pos, 'v.');
    assert.equal(byForm.get('fetch')?.meaningZh, '接来；取来');
    assert.equal(byForm.get('clap')?.pos, 'v.');
    assert.equal(byForm.get('clap')?.meaningZh, '拍手；鼓掌');
    assert.equal(byForm.get('clap')?.childSafe, true);
    // 尾部替换必须保护已覆盖的 zk/gk 词族，不能把 motorcycle 挤出词库。
    assert.equal(byForm.get('motorcycle')?.isCore, false);
    assert.ok(byForm.get('motorcycle')?.tags.includes('zk'));
    for (const [base, aliases] of Object.entries(SAFE_FORM_ALIASES)) {
      const entry = dataset.entries.find((item) => item.word === base);
      assert.ok(entry, base);
      for (const alias of aliases) assert.ok(entry.variants.includes(alias), `${base} -> ${alias}`);
    }
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseCsvRecords } from '../src/csv';
import { applyChildSafeExamples, applyChildSenseOverrides } from '../src/examples';
import { assessChildSafety, buildLexiconFromRows, detectDomains, EXTENSION_PRIORITY_WORDS, isFunctionWord, TEXTBOOK_PRIORITY_WORDS } from '../src/lexicon';
import type { EcdictRow } from '../src/types';

/**
 * 从 ECDICT CSV 生成 3,000 核心 + 2,000 扩展词族 JSON。
 *
 * 运行：
 *   默认读取仓库上级目录的 ecdict.csv（G:\workbuddy\英语\ecdict.csv）
 *   npm run build:lexicon --workspace @alg/vocabulary
 *   可选环境变量：ECDICT_PATH、LEXICON_MAX_FAMILIES、LEXICON_CORE_FAMILIES、
 *   LEXICON_EXAMPLE_LIMIT（默认 3000，覆盖全部安全核心词；设为 0 可关闭）
 *
 * 例句只写入 childSafe=true 的核心词；不安全词保留空例句，由课程侧过滤。
 */
async function main() {
  const input = process.env.ECDICT_PATH
    ? resolve(process.env.ECDICT_PATH)
    : resolve(__dirname, '../../../../ecdict.csv');
  const output = resolve(__dirname, '../data/lexicon.json');
  const maxFamilies = Number.parseInt(process.env.LEXICON_MAX_FAMILIES || '5000', 10);
  const coreFamilies = Number.parseInt(process.env.LEXICON_CORE_FAMILIES || '3000', 10);
  const exampleLimit = Number.parseInt(process.env.LEXICON_EXAMPLE_LIMIT || '3000', 10);

  const rows: EcdictRow[] = [];
  let scanned = 0;
  for await (const record of parseCsvRecords(input)) {
    scanned += 1;
    if (!record.word) continue;
    const frq = Number.parseInt(record.frq || '0', 10);
    const bnc = Number.parseInt(record.bnc || '0', 10);
    const word = (record.word || '').trim().toLowerCase();
    if (!(frq > 0) && !(bnc > 0) && !TEXTBOOK_PRIORITY_WORDS.has(word) && !EXTENSION_PRIORITY_WORDS.has(word)) continue;
    rows.push(record as EcdictRow);
  }

  const built = buildLexiconFromRows(rows, {
    maxFamilies: Number.isFinite(maxFamilies) ? maxFamilies : 5000,
    coreFamilies: Number.isFinite(coreFamilies) ? coreFamilies : 3000,
  });
  // 先修正儿童课程需要的词性/首义，再重算领域、安全和功能词标记，
  // 否则 plane=平面、ruler=统治者 会影响领域标签和例句。
  const sensed = applyChildSenseOverrides(built.entries).map((entry) => ({
    ...entry,
    domains: [...new Set([...entry.domains, ...detectDomains(entry.word, entry.meaningZh)])],
    childSafe: assessChildSafety(entry.word, entry.meaningZh),
    isFunctionWord: isFunctionWord(entry.word, entry.pos, entry.tags),
  }));
  const dataset = {
    ...built,
    entries: Number.isFinite(exampleLimit) && exampleLimit > 0
      ? applyChildSafeExamples(sensed, { limit: exampleLimit, coreOnly: true })
      : sensed,
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');

  const core = dataset.entries.filter((entry) => entry.isCore);
  const extension = dataset.entries.filter((entry) => !entry.isCore);
  const fieldStats = (entries: typeof dataset.entries) => ({
    phonetic: entries.filter((entry) => entry.phonetic).length,
    pos: entries.filter((entry) => entry.pos).length,
    meaning: entries.filter((entry) => entry.meaningZh).length,
    domains: entries.filter((entry) => entry.domains.length > 0).length,
    childSafeFalse: entries.filter((entry) => !entry.childSafe).length,
    examples: entries.filter((entry) => entry.examples.length > 0).length,
  });
  const coreFields = fieldStats(core);
  const extensionFields = fieldStats(extension);
  const totalFields = fieldStats(dataset.entries);
  console.log(
    `wrote ${output}: scanned=${scanned} candidates=${rows.length} ` +
    `families=${dataset.totalFamilies} core=${core.length} extension=${extension.length} ` +
    `corePhonetic=${coreFields.phonetic}/${core.length} coreMeaning=${coreFields.meaning}/${core.length} ` +
    `corePos=${coreFields.pos}/${core.length} coreDomains=${coreFields.domains}/${core.length} ` +
    `coreChildSafeFalse=${coreFields.childSafeFalse} coreExamples=${coreFields.examples}/${core.length} ` +
    `extensionPhonetic=${extensionFields.phonetic}/${extension.length} ` +
    `extensionMeaning=${extensionFields.meaning}/${extension.length} ` +
    `extensionPos=${extensionFields.pos}/${extension.length} ` +
    `extensionDomains=${extensionFields.domains}/${extension.length} ` +
    `extensionChildSafeFalse=${extensionFields.childSafeFalse} ` +
    `extensionExamples=${extensionFields.examples}/${extension.length} ` +
    `totalChildSafeFalse=${totalFields.childSafeFalse}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

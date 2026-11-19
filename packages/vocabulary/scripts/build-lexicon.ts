import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseCsvRecords } from '../src/csv';
import { buildLexiconFromRows } from '../src/lexicon';
import type { EcdictRow } from '../src/types';

/**
 * 从 ECDICT CSV 生成 3,000 核心 + 2,000 扩展词族 JSON。
 *
 * 运行：
 *   默认读取仓库上级目录的 ecdict.csv（G:\workbuddy\英语\ecdict.csv）
 *   npm run build:lexicon --workspace @alg/vocabulary
 *   可选环境变量：ECDICT_PATH、LEXICON_MAX_FAMILIES、LEXICON_CORE_FAMILIES
 *
 * 产物只含 ECDICT 可提供的数据；不生成例句、搭配或图片，避免伪造。
 */
async function main() {
  const input = process.env.ECDICT_PATH
    ? resolve(process.env.ECDICT_PATH)
    : resolve(__dirname, '../../../../ecdict.csv');
  const output = resolve(__dirname, '../data/lexicon.json');
  const maxFamilies = Number.parseInt(process.env.LEXICON_MAX_FAMILIES || '5000', 10);
  const coreFamilies = Number.parseInt(process.env.LEXICON_CORE_FAMILIES || '3000', 10);

  const rows: EcdictRow[] = [];
  let scanned = 0;
  for await (const record of parseCsvRecords(input)) {
    scanned += 1;
    if (!record.word) continue;
    const frq = Number.parseInt(record.frq || '0', 10);
    const bnc = Number.parseInt(record.bnc || '0', 10);
    if (!(frq > 0) && !(bnc > 0)) continue;
    rows.push(record as EcdictRow);
  }

  const dataset = buildLexiconFromRows(rows, {
    maxFamilies: Number.isFinite(maxFamilies) ? maxFamilies : 5000,
    coreFamilies: Number.isFinite(coreFamilies) ? coreFamilies : 3000,
  });

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');

  const core = dataset.entries.filter((entry) => entry.isCore);
  const phoneticCore = core.filter((entry) => entry.phonetic).length;
  const meaningCore = core.filter((entry) => entry.meaningZh).length;
  console.log(
    `wrote ${output}: scanned=${scanned} candidates=${rows.length} ` +
    `families=${dataset.totalFamilies} core=${core.length} ` +
    `corePhonetic=${phoneticCore}/${core.length} coreMeaning=${meaningCore}/${core.length}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

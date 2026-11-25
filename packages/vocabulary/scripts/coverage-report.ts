import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildLexiconCoverageReport,
  formatCoverageDelta,
  formatCoverageRate,
  type CoverageTarget,
} from '../src/coverage';
import { parseCsvRecords } from '../src/csv';
import { assessChildSafety, TEXTBOOK_PRIORITY_WORDS } from '../src/lexicon';
import type { LexiconDataset } from '../src/types';

/**
 * 生成 3,000 核心 → 5,000 全量层的可复现覆盖报告。
 *
 * 目标词表使用 ECDICT 的公开标签（zk/gk/cet4/cet6）和首批教材高频词，
 * 不把任何出版社教材原文写入仓库。实际教材单元词的覆盖率仍由
 * LexiconService.textbookUnitCoverage 在管理端按授权单元计算。
 */
async function main() {
  const ecdictPath = process.env.ECDICT_PATH
    ? resolve(process.env.ECDICT_PATH)
    : resolve(__dirname, '../../../../ecdict.csv');
  const lexiconPath = process.env.LEXICON_JSON
    ? resolve(process.env.LEXICON_JSON)
    : resolve(__dirname, '../data/lexicon.json');
  const jsonOutput = resolve(__dirname, '../data/lexicon-coverage.json');
  const docOutput = resolve(__dirname, '../../../docs/lexicon-coverage.md');

  const dataset = JSON.parse(readFileSync(lexiconPath, 'utf8')) as LexiconDataset;
  const tagWords = new Map<string, Set<string>>([
    ['zk', new Set()],
    ['gk', new Set()],
    ['cet4', new Set()],
    ['cet6', new Set()],
  ]);
  const curriculumWords = new Set<string>();
  for await (const record of parseCsvRecords(ecdictPath)) {
    const original = (record.word || '').trim();
    // 与词库构建一致：专有名词/缩写不进入教材词覆盖分母。
    if (!original || original !== original.toLowerCase()) continue;
    const word = original.toLowerCase();
    if (!/^[a-z][a-z'-]*$/.test(word)) continue;
    if (!(record.translation || '').trim()) continue;
    // 儿童不可用的词不应用来制造“覆盖缺口”；它们本来就不会进入儿童课程。
    if (!assessChildSafety(word, record.translation)) continue;
    const tags = (record.tag || '').toLowerCase().split(/\s+/).filter(Boolean);
    for (const tag of tagWords.keys()) {
      if (tags.includes(tag)) tagWords.get(tag)!.add(word);
    }
    if (tags.includes('zk') || tags.includes('gk')) curriculumWords.add(word);
  }

  const targets: CoverageTarget[] = [
    {
      id: 'zk',
      label: '课标/教材优先词（ECDICT zk）',
      note: 'ECDICT 中考标签，作为义务教育阶段教材优先词的公开代理，不等同于某一本教材的单元词表。',
      words: [...tagWords.get('zk')!],
    },
    {
      id: 'gk',
      label: '课标/阅读扩展词（ECDICT gk）',
      note: 'ECDICT 高考标签，用于检查阅读扩展覆盖，不表示产品要求孩子掌握高考词汇。',
      words: [...tagWords.get('gk')!],
    },
    {
      id: 'curriculum',
      label: '课标/教材优先词（zk ∪ gk）',
      note: '两个公开标签的并集；去重后作为本报告的教材优先词代理。',
      words: [...curriculumWords],
    },
    {
      id: 'textbook-priority',
      label: '首批教材高频词（TEXTBOOK_PRIORITY_WORDS）',
      note: '仓库内置的小学教材首册高频词护栏，必须全部进入 5,000 族。',
      words: [...TEXTBOOK_PRIORITY_WORDS],
    },
    {
      id: 'cet4',
      label: '大学英语四级（cet4，参考）',
      note: '仅用于观察扩展层的阅读覆盖，不是儿童课程目标。',
      words: [...tagWords.get('cet4')!],
    },
    {
      id: 'cet6',
      label: '大学英语六级（cet6，参考）',
      note: '仅用于观察扩展层的阅读覆盖，不是儿童课程目标。',
      words: [...tagWords.get('cet6')!],
    },
  ];

  const coverage = buildLexiconCoverageReport(dataset.entries, targets);
  const core = dataset.entries.filter((entry) => entry.isCore);
  const extension = dataset.entries.filter((entry) => !entry.isCore);
  const field = (entries: LexiconDataset['entries']) => ({
    count: entries.length,
    phonetic: entries.filter((entry) => entry.phonetic).length,
    pos: entries.filter((entry) => entry.pos).length,
    meaning: entries.filter((entry) => entry.meaningZh).length,
    domains: entries.filter((entry) => entry.domains.length > 0).length,
    childSafeFalse: entries.filter((entry) => !entry.childSafe).length,
    examples: entries.filter((entry) => entry.examples.length > 0).length,
    textbookLinked: entries.filter((entry) => entry.textbookUnitIds.length > 0).length,
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'ECDICT',
    license: 'MIT',
    methodology: {
      baseline: 'isCore=true（3,000 核心族）',
      expanded: '全部 5,000 族（3,000 核心 + 2,000 扩展）',
      targetSource: 'ECDICT tag=zk/gk/cet4/cet6；教材首批高频词来自 TEXTBOOK_PRIORITY_WORDS',
      match: 'word 或 variants 命中即覆盖；同一目标词重复只计一次',
      textbookUnitWords: '出版社教材单元词不在静态报告中；由 import-lexicon 扫描授权单元后按册/单元计算',
    },
    scale: {
      families: dataset.totalFamilies,
      core: core.length,
      extension: extension.length,
      examples: {
        core: field(core).examples,
        extension: field(extension).examples,
        total: field(dataset.entries).examples,
      },
    },
    fields: {
      core: field(core),
      extension: field(extension),
      total: field(dataset.entries),
    },
    coverage,
  };

  mkdirSync(resolve(__dirname, '../data'), { recursive: true });
  writeFileSync(jsonOutput, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeFileSync(docOutput, renderMarkdown(payload), 'utf8');
  console.log(
    `wrote ${jsonOutput} and ${docOutput}: families=${dataset.totalFamilies} ` +
    `core=${core.length} extension=${extension.length}`,
  );
  for (const target of coverage.targets) {
    console.log(
      `${target.id}: ${target.before.covered}/${target.before.total} ` +
      `(${formatCoverageRate(target.before.rate)}) -> ${target.after.covered}/${target.after.total} ` +
      `(${formatCoverageRate(target.after.rate)}, ${formatCoverageDelta(target.improvement)})`,
    );
  }
}

type ReportPayload = {
  generatedAt: string;
  scale: {
    families: number;
    core: number;
    extension: number;
    examples: { core: number; extension: number; total: number };
  };
  fields: {
    core: ReturnType<typeof fieldShape>;
    extension: ReturnType<typeof fieldShape>;
    total: ReturnType<typeof fieldShape>;
  };
  coverage: ReturnType<typeof buildLexiconCoverageReport>;
};

function fieldShape() {
  return {
    count: 0,
    phonetic: 0,
    pos: 0,
    meaning: 0,
    domains: 0,
    childSafeFalse: 0,
    examples: 0,
    textbookLinked: 0,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(payload: ReportPayload): string {
  const lines: string[] = [
    '# 词库扩容覆盖报告（P3-06）',
    '',
    `> 生成时间：${payload.generatedAt}`,
    '> 数据源：ECDICT（MIT）5,000 词族；教材/课标目标词使用 ECDICT 公开标签作为代理。',
    '',
    '## 1. 口径',
    '',
    '- **基线（3,000）**：`isCore=true` 的核心词族，P3-05 已上线。',
    '- **扩容（5,000）**：核心 3,000 + 扩展 2,000，全部进入 `lexicon.json` 并可导入 `lexicon_entries`。',
    '- **命中**：目标词命中词族 `word` 或 `variants` 即算覆盖；同一目标词去重后只计一次。',
    '- **教材词边界**：本报告不包含出版社教材原文。`zk/gk` 是可公开复现的课标词代理；授权教材单元的实际覆盖仍按册/单元计算。',
    '- **已知噪声**：ECDICT 将少量月份/地名按小写词条收录（如 august、pacific），仍按原标签计入；扩容前后使用同一分母，不影响对比结论。',
    '- **2026-11-25 修订**：修复 `computer`/`internet` 技术释义误删，并将 12 个英式拼写与 2 个不规则复数别名挂入现有词族；3,000 基线也因这些命中而上升。另将 65 个教材优先词插入扩展层（第一批 30 个、第二批 35 个），替换扩展层尾部同样数量的低频词，并保护已有的 `zk`/`gk` 标签词族；3,000 核心层逐词不变。',
    '',
    '## 2. 规模',
    '',
    '| 项目 | 3,000 核心 | 5,000 全量 |',
    '|---|---:|---:|',
    `| 词族数 | ${payload.scale.core} | ${payload.scale.families} |`,
    `| 扩展层词族 | — | ${payload.scale.extension} |`,
    `| 有例句词族 | ${payload.scale.examples.core} | ${payload.scale.examples.total} |`,
    `| 有中文释义 | ${payload.fields.core.meaning} | ${payload.fields.total.meaning} |`,
    `| 有音标 | ${payload.fields.core.phonetic} | ${payload.fields.total.phonetic} |`,
    `| 有词性 | ${payload.fields.core.pos} | ${payload.fields.total.pos} |`,
    `| 有领域标签 | ${payload.fields.core.domains} | ${payload.fields.total.domains} |`,
    `| ` + '`childSafe=false`' + ` | ${payload.fields.core.childSafeFalse} | ${payload.fields.total.childSafeFalse} |`,
    '',
    '## 3. 教材/课标优先词覆盖对比',
    '',
    '| 目标词表 | 目标词数 | 3,000 覆盖 | 5,000 覆盖 | 新增 | 提升 | 5,000 缺口 |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const target of payload.coverage.targets) {
    lines.push(
      `| ${target.label} | ${target.before.total} | ${target.before.covered}（${formatCoverageRate(target.before.rate)}） ` +
      `| ${target.after.covered}（${formatCoverageRate(target.after.rate)}） | ${target.added} ` +
      `| ${formatCoverageDelta(target.improvement)} | ${target.after.gaps.length} |`,
    );
  }
  lines.push(
    '',
    '## 4. 5,000 缺口摘要',
    '',
    '`zk` 缺口是全量词库对义务教育阶段教材优先词的剩余空白；`gk` 缺口只代表阅读扩展空间，不是儿童阶段目标。',
    '',
  );
  for (const id of ['zk', 'gk']) {
    const target = payload.coverage.targets.find((item) => item.id === id);
    if (!target) continue;
    const shown = Math.min(80, target.after.gaps.length);
    const preview = target.after.gaps.slice(0, shown).join(', ') || '无';
    lines.push(`### ${target.label}（${target.after.gaps.length} 个）`, '', preview, '');
    if (target.after.gaps.length > shown) {
      lines.push(`> 仅展示前 ${shown} 个；完整缺口见 \`packages/vocabulary/data/lexicon-coverage.json\`。`, '');
    }
  }
  lines.push(
    '## 5. 教材单元词注入',
    '',
    '- `services/backend/scripts/import-lexicon.ts` 在导入全局词库后扫描 `textbook_units.metadata` 与 `curriculum_drafts.wordList`；',
    '- 已命中的词挂到现有词族，未命中的词以 `source=textbook`、`childSafe=false` 保守入库，待补齐释义/审核后放行；',
    '- 静态 JSON 中 `textbookUnitIds` 非空的词族数为 ' + `${payload.fields.total.textbookLinked}` + '；出版社单元要求授权后录入，不能由 ECDICT 标签替代。',
    '- 管理端按册汇总：`GET /api/v1/admin/curriculum/textbook/units/:unitId/lexicon-coverage`。',
    '',
    '## 6. 当前质量状态',
    '',
    `- 5,000 全量：音标 ${payload.fields.total.phonetic}/${payload.fields.total.count}（${percent(payload.fields.total.phonetic / payload.fields.total.count)}），` +
    `中文 ${payload.fields.total.meaning}/${payload.fields.total.count}，词性 ${payload.fields.total.pos}/${payload.fields.total.count}。`,
    `- 扩展层：音标 ${payload.fields.extension.phonetic}/${payload.fields.extension.count}，` +
    `中文 ${payload.fields.extension.meaning}/${payload.fields.extension.count}，词性 ${payload.fields.extension.pos}/${payload.fields.extension.count}。`,
    `- 例句仍按 P3-05/任务书 9.3 只要求核心词：核心 ${payload.scale.examples.core}/${payload.scale.core}；` +
    `扩展层不批量生成低置信模板句，避免把不自然句子写进儿童课程。`,
    '',
  );
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

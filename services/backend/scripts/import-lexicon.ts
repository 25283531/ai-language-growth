import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { lexiconDatasetSchema, type LexiconEntry } from '@alg/shared-contracts';
import { extractMetadataWords, normalizeTextbookWord } from '../src/curriculum/textbook-word-injection';

/**
 * 把 packages/vocabulary/data/lexicon.json 导入 lexicon_entries。
 *
 * 运行：
 *   npm run lexicon:import --workspace @alg/backend
 *   可选 LEXICON_JSON 指向其他文件；--skip-textbook 跳过教材词注入。
 *
 * 教材词注入规则：现有 curriculum_drafts.wordList 与 textbook_units.metadata
 * 中的词无条件进入词库；即使超出 5,000 词族也保留，并把 unitId 记到 textbookUnitIds。
 */
const prisma = new PrismaClient();

type TextbookWord = { word: string; unitIds: Set<string> };

async function main() {
  const file = process.env.LEXICON_JSON
    ? resolve(process.env.LEXICON_JSON)
    : resolve(__dirname, '../../../packages/vocabulary/data/lexicon.json');
  const dataset = lexiconDatasetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  console.log(`import ${file}: families=${dataset.totalFamilies} core=${dataset.coreFamilies}`);
  if (process.argv.includes('--dry-run')) {
    console.log('dry-run: JSON 校验通过，未写入数据库');
    return;
  }

  for (let offset = 0; offset < dataset.entries.length; offset += 200) {
    const batch = dataset.entries.slice(offset, offset + 200);
    await prisma.$transaction(batch.map((entry) => prisma.lexicon_entries.upsert({
      where: { word: entry.word },
      create: toCreate(entry),
      update: toUpdate(entry),
    })));
  }
  console.log(`imported lexicon entries: ${dataset.entries.length}`);

  if (!process.argv.includes('--skip-textbook')) {
    const stats = await importTextbookWords();
    console.log(`textbook words: linked=${stats.linked} added=${stats.added}`);
  }
}

function toCreate(entry: LexiconEntry): Prisma.lexicon_entriesCreateInput {
  return {
    word: entry.word,
    lemma: entry.lemma,
    familyKey: entry.familyKey,
    familyRank: entry.familyRank ?? null,
    phonetic: entry.phonetic,
    pos: entry.pos,
    meaningZh: entry.meaningZh,
    frequencyRank: entry.frequencyRank ?? null,
    bncRank: entry.bncRank ?? null,
    tags: entry.tags,
    domains: entry.domains,
    variants: entry.variants,
    collocations: entry.collocations as Prisma.InputJsonValue,
    examples: entry.examples as Prisma.InputJsonValue,
    source: entry.source,
    license: entry.license,
    childSafe: entry.childSafe,
    isCore: entry.isCore,
    isFunctionWord: entry.isFunctionWord,
    textbookUnitIds: entry.textbookUnitIds,
  };
}

function toUpdate(entry: LexiconEntry): Prisma.lexicon_entriesUpdateInput {
  const { textbookUnitIds: _textbookUnitIds, ...fields } = toCreate(entry);
  return fields;
}

async function importTextbookWords(): Promise<{ linked: number; added: number }> {
  const [units, drafts] = await Promise.all([
    prisma.textbook_units.findMany({ select: { id: true, metadata: true } }),
    prisma.curriculum_drafts.findMany({
      where: { textbookUnitId: { not: null } },
      select: { textbookUnitId: true, wordList: true },
    }),
  ]);

  const words = new Map<string, TextbookWord>();
  const add = (value: unknown, unitId: string) => {
    const word = normalizeTextbookWord(value);
    if (!word) return;
    const current = words.get(word);
    if (current) current.unitIds.add(unitId);
    else words.set(word, { word, unitIds: new Set([unitId]) });
  };

  for (const unit of units) {
    for (const value of extractMetadataWords(unit.metadata)) add(value, unit.id);
  }
  for (const draft of drafts) {
    if (!draft.textbookUnitId) continue;
    for (const value of Array.isArray(draft.wordList) ? draft.wordList : []) add(value, draft.textbookUnitId);
  }

  let linked = 0;
  let added = 0;
  const entries = [...words.values()];
  for (let offset = 0; offset < entries.length; offset += 200) {
    const batch = entries.slice(offset, offset + 200);
    const existing = await prisma.lexicon_entries.findMany({
      where: {
        OR: [
          { word: { in: batch.map((entry) => entry.word) } },
          { variants: { hasSome: batch.map((entry) => entry.word) } },
        ],
      },
      select: { word: true, variants: true, textbookUnitIds: true, source: true, meaningZh: true, childSafe: true },
    });
    // 教材写的是 running / cats 时，优先挂到已有词族 run / cat，
    // 不要另建一个没有音标和释义的同形条目。
    const byWord = new Map<string, typeof existing[number]>();
    for (const item of existing) {
      byWord.set(item.word, item);
      for (const variant of item.variants) {
        if (!byWord.has(variant)) byWord.set(variant, item);
      }
    }
    // 同一批里可能同时出现 cat / cats；它们映射到同一个词族，必须合并后再更新，
    // 否则后一次 update 会覆盖前一次教材单元标记。
    const updates = new Map<string, { word: string; unitIds: Set<string>; count: number; childSafe: boolean }>();
    const creates: TextbookWord[] = [];
    for (const entry of batch) {
      const current = byWord.get(entry.word);
      if (!current) {
        creates.push(entry);
        continue;
      }
      const target = updates.get(current.word);
      if (target) {
        for (const unitId of entry.unitIds) target.unitIds.add(unitId);
        target.count += 1;
      } else {
        updates.set(current.word, {
          word: current.word,
          unitIds: new Set([...current.textbookUnitIds, ...entry.unitIds]),
          count: 1,
          // 旧版本导入的教材新词可能带着 childSafe=true 但没有释义；
          // 重新扫描时保守降为 false，避免未经审核的词继续进入儿童课程。
          childSafe: current.source === 'textbook' && !current.meaningZh ? false : current.childSafe,
        });
      }
    }
    linked += [...updates.values()].reduce((sum, item) => sum + item.count, 0);
    added += creates.length;
    await prisma.$transaction([
      ...[...updates.values()].map((item) => prisma.lexicon_entries.update({
        where: { word: item.word },
        data: { textbookUnitIds: [...item.unitIds].sort(), childSafe: item.childSafe },
      })),
      ...creates.map((entry) => prisma.lexicon_entries.create({
        data: {
          word: entry.word,
          lemma: entry.word,
          familyKey: entry.word,
          phonetic: '',
          pos: '',
          meaningZh: '',
          tags: [],
          domains: [],
          variants: [entry.word],
          collocations: [] as Prisma.InputJsonValue,
          examples: [] as Prisma.InputJsonValue,
          source: 'textbook',
          license: 'textbook',
          // 新教材词没有经过词库安全判定；先保守标 false，待补齐释义/审核后再放行。
          childSafe: false,
          isCore: false,
          isFunctionWord: false,
          textbookUnitIds: [...entry.unitIds].sort(),
        },
      })),
    ]);
  }
  return { linked, added };
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

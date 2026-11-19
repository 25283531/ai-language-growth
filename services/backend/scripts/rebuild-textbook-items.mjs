/**
 * 重建已发布教材单元的 learning_items（P0-2 / P0-4 的一次性修复工具）。
 *
 * 发布链路已经会自动生成逐句跟读与重点词条目；这个脚本用于把**此前已发布**的单元
 * 补齐成同样的结构，不需要重新走一遍资源包导入。
 *
 * 用法（容器内）：node scripts/rebuild-textbook-items.mjs [--dry]
 */
import { PrismaClient } from '@prisma/client';
import { derivedTextbookActivities } from '../dist/curriculum/textbook-item-plan.js';

const dry = process.argv.includes('--dry');
const prisma = new PrismaClient();

const units = await prisma.curriculum_units.findMany({
  where: { reviewStatus: 'published', availability: 'active', textbookUnitId: { not: null } },
  select: { id: true, topicId: true, content: true },
});

for (const unit of units) {
  const content = unit.content;
  if (!content || typeof content !== 'object') continue;
  const authored = [
    ...(content.activities ?? []),
    ...(content.schoolTrack?.activities ?? []),
  ];
  const ordered = [...derivedTextbookActivities(content, authored), ...authored];

  const skillKeys = [...new Set(ordered.flatMap((activity) => activity.skillNodeIds ?? []))];
  const skills = await prisma.skill_nodes.findMany({
    where: { OR: [{ id: { in: skillKeys } }, { code: { in: skillKeys } }] },
    select: { id: true, code: true },
  });
  const skillIdByKey = new Map(skills.flatMap((skill) => [[skill.id, skill.id], [skill.code, skill.id]]));

  const existing = await prisma.learning_items.findMany({
    where: { itemType: 'curriculum_activity', refId: { startsWith: `${unit.id}:` } },
    select: { id: true, refId: true },
  });
  const idByRef = new Map(existing.map((row) => [row.refId, row.id]));
  const keep = new Set();

  for (const [index, activity] of ordered.entries()) {
    const skillNodeId = skillIdByKey.get(activity.skillNodeIds?.[0] ?? '');
    if (!skillNodeId) {
      console.log(`SKIP ${unit.topicId} #${index}: 未知能力节点 ${activity.skillNodeIds?.[0]}`);
      continue;
    }
    const refId = `${unit.id}:${index}`;
    keep.add(refId);
    const data = {
      skillNodeId,
      itemType: 'curriculum_activity',
      refId,
      topicId: unit.topicId,
      reviewStatus: 'published',
      content: { ...activity, id: refId, topicId: unit.topicId, order: index, m1Scope: false },
    };
    if (dry) continue;
    const existingId = idByRef.get(refId);
    if (existingId) await prisma.learning_items.update({ where: { id: existingId }, data });
    else await prisma.learning_items.create({ data });
  }

  const staleIds = existing.filter((row) => !keep.has(row.refId)).map((row) => row.id);
  if (!dry && staleIds.length) {
    await prisma.learning_items.updateMany({ where: { id: { in: staleIds } }, data: { reviewStatus: 'archived' } });
  }
  console.log(`UNIT ${unit.topicId}: 写入 ${keep.size} 条，归档 ${staleIds.length} 条${dry ? '（dry-run）' : ''}`);
}

await prisma.$disconnect();

/**
 * 教材单元 → 课程主题（topicId）解析。
 *
 * 课文教学包是按 curriculum_units.topicId 装配的（见 CurriculumAudioService.passageForTopic）。
 * 因此「我的 → 切教材 → 开课」要真的落在所选单元上，客户端开课必须带上该单元的 topicId。
 *
 * 解析严格按确定性优先级，不做语义猜测：
 *   1. textbookId（新映射记录，能唯一定位教材）；
 *   2. 明确教材单元（textbook_units.id，即 mapping.currentUnit）；
 *   3. 出版社 + 年级（老映射没有 textbookId，只能按展示字段收敛）；
 *   4. 年级 + 版次（出版社写法不统一时退一步：映射写「人教版」、目录写「人民教育出版社」）。
 * 都没命中则返回 null，调用方保持原有行为（Planner 自选主题）。
 */

export interface TextbookTopicPrisma {
  curriculum_units: {
    findFirst(args: unknown): Promise<{ topicId: string } | null>;
  };
}

export type TextbookTopicInput = {
  /** textbook_catalogs.id；映射表新增字段，命中率最高。 */
  textbookId?: string | null;
  /** textbook_units.id；textbook_mappings.currentUnit 存的就是它。 */
  unitId?: string | null;
  publisher?: string | null;
  grade?: string | null;
  /** textbook_mappings.version，实际存的是教材版次（如「上册」）。 */
  edition?: string | null;
};

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function resolveTextbookTopic(
  prisma: TextbookTopicPrisma,
  input: TextbookTopicInput,
): Promise<string | null> {
  const base = { reviewStatus: 'published', availability: 'active' };
  const unitId = text(input.unitId);
  const textbookId = text(input.textbookId);
  const publisher = text(input.publisher);
  const grade = text(input.grade);
  const edition = text(input.edition);

  const lookups: Array<{ where: Record<string, unknown>; orderBy: unknown[] }> = [];

  if (unitId) {
    lookups.push({
      where: { ...base, textbookUnitId: unitId, ...(textbookId ? { textbookUnit: { textbookId } } : {}) },
      orderBy: [{ publishedAt: 'desc' }, { currentVersion: 'desc' }],
    });
  }
  if (textbookId) {
    lookups.push({
      where: { ...base, textbookUnit: { textbookId } },
      orderBy: [{ textbookUnit: { order: 'asc' } }, { publishedAt: 'desc' }],
    });
  }
  if (publisher && grade) {
    lookups.push({
      where: { ...base, textbookUnit: { textbook: { publisher, grade } } },
      orderBy: [{ textbookUnit: { order: 'asc' } }, { publishedAt: 'desc' }],
    });
  }
  if (grade && edition) {
    lookups.push({
      where: { ...base, textbookUnit: { textbook: { grade, edition } } },
      orderBy: [{ textbookUnit: { order: 'asc' } }, { publishedAt: 'desc' }],
    });
  }
  if (textbookId || unitId) {
    // 有教材 id / 单元 id 时不按年级兜底：宁可退回 Planner，也不要跨教材串课。
  } else if (grade) {
    lookups.push({
      where: { ...base, textbookUnit: { textbook: { grade } } },
      orderBy: [{ textbookUnit: { order: 'asc' } }, { publishedAt: 'desc' }],
    });
  }

  for (const lookup of lookups) {
    const row = await prisma.curriculum_units.findFirst({
      where: lookup.where,
      orderBy: lookup.orderBy,
      select: { topicId: true },
    });
    const topicId = row?.topicId?.trim();
    if (topicId) return topicId;
  }
  return null;
}

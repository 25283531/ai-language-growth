/**
 * 教材单元 → 课程主题（topicId）解析。
 *
 * 课文教学包是按 curriculum_units.topicId 装配的（见 CurriculumAudioService.passageForTopic）。
 * 因此「我的 → 切教材 → 开课」要真的落在所选单元上，客户端开课必须带上该单元的 topicId。
 * 这里只做确定性解析，不猜语义：
 *   1. 有明确教材单元（textbook_units.id）→ 取该单元已发布且启用的课程单元；
 *   2. 没有明确单元 → 取该教材（或同出版社同年级）顺序最靠前的已发布单元；
 *   3. 都没有 → null，调用方保持原有行为（Planner 自选主题）。
 */

export interface TextbookTopicPrisma {
  curriculum_units: {
    findFirst(args: unknown): Promise<{ topicId: string } | null>;
  };
}

export type TextbookTopicInput = {
  /** textbook_units.id；textbook_mappings.currentUnit 存的就是它。 */
  unitId?: string | null;
  /** textbook_catalogs.id；与 unitId 一起用于校验单元归属。 */
  textbookId?: string | null;
  publisher?: string | null;
  grade?: string | null;
};

export async function resolveTextbookTopic(
  prisma: TextbookTopicPrisma,
  input: TextbookTopicInput,
): Promise<string | null> {
  const base = { reviewStatus: 'published', availability: 'active' };
  const unitId = input.unitId?.trim();
  const textbookId = input.textbookId?.trim();
  const publisher = input.publisher?.trim();
  const grade = input.grade?.trim();

  let row: { topicId: string } | null = null;

  if (unitId) {
    row = await prisma.curriculum_units.findFirst({
      where: {
        ...base,
        textbookUnitId: unitId,
        ...(textbookId ? { textbookUnit: { textbookId } } : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { currentVersion: 'desc' }],
      select: { topicId: true },
    });
  } else if (textbookId || (publisher && grade)) {
    // 教材映射表只记出版社/年级，没有 textbookId；两者都支持，缺教材 id 时按出版社+年级收敛。
    const textbook = textbookId ? { id: textbookId } : { publisher, grade };
    row = await prisma.curriculum_units.findFirst({
      where: { ...base, textbookUnit: { textbook } },
      orderBy: [{ textbookUnit: { order: 'asc' } }, { publishedAt: 'desc' }],
      select: { topicId: true },
    });
  }

  const topicId = row?.topicId?.trim();
  return topicId ? topicId : null;
}

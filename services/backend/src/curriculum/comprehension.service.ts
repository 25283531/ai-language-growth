import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { textbookUnitContentSchema } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';

/** 每单元目标 3 题；课文过短时至少保留 2 题。 */
export const COMPREHENSION_ITEM_COUNT = 3;
export const COMPREHENSION_MIN_ITEMS = 2;

export const COMPREHENSION_KINDS = ['true_false', 'single_choice'] as const;
export type ComprehensionKind = (typeof COMPREHENSION_KINDS)[number];

const generatedSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(COMPREHENSION_KINDS),
    prompt: z.string().trim().min(4).max(400),
    options: z.array(z.string().trim().min(1).max(300)).max(4).default([]),
    answer: z.string().trim().min(1).max(300),
    explanationZh: z.string().trim().max(300).default(''),
    sourceSentenceIds: z.array(z.string().trim().max(80)).max(4).default([]),
  })).min(1).max(COMPREHENSION_ITEM_COUNT),
});

type GeneratedItem = z.infer<typeof generatedSchema>['items'][number];

export interface ComprehensionItemPayload {
  id: string;
  kind: ComprehensionKind;
  prompt: string;
  options: string[];
  sourceSentenceIds: string[];
}

/**
 * P4-02：教材单元理解题。
 *
 * 每单元 2–3 题，题型为判断和单选；题目落库缓存，生成失败时用课文原句
 * 与重点词替换兜底。与完形不同，理解题一次判分，不做续批。
 */
@Injectable()
export class ComprehensionService {
  private readonly logger = new Logger(ComprehensionService.name);
  /** 同一单元的补题任务只跑一份，避免并发重复生成。 */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly router: ModelRouterImpl,
  ) {}

  async payload(topicId: string): Promise<{
    items: ComprehensionItemPayload[];
    rule: { minItems: number; maxItems: number };
  }> {
    const unit = await this.loadUnit(topicId);
    await this.ensureItems(unit.id, topicId, unit.content);
    const rows = (await this.prisma.unit_comprehension_items.findMany({
      where: { unitId: unit.id },
      orderBy: { itemIndex: 'asc' },
    })).slice(0, COMPREHENSION_ITEM_COUNT);
    if (!rows.length) throw new NotFoundException('这个主题还没有可用的理解题');
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind === 'single_choice' ? 'single_choice' : 'true_false',
        prompt: row.prompt,
        options: row.options,
        sourceSentenceIds: row.sourceSentenceIds,
      })),
      rule: { minItems: COMPREHENSION_MIN_ITEMS, maxItems: COMPREHENSION_ITEM_COUNT },
    };
  }

  async grade(
    topicId: string,
    answers: Array<{ itemId: string; answer: string }>,
  ): Promise<{
    correct: number;
    total: number;
    accuracy: number;
    details: Array<{
      itemId: string;
      kind: ComprehensionKind;
      prompt: string;
      answer: string;
      correctAnswer: string;
      correct: boolean;
      explanationZh: string;
    }>;
  }> {
    const unit = await this.loadUnit(topicId);
    const rows = (await this.prisma.unit_comprehension_items.findMany({
      where: { unitId: unit.id },
      orderBy: { itemIndex: 'asc' },
    })).slice(0, COMPREHENSION_ITEM_COUNT);
    if (!rows.length) throw new NotFoundException('这个单元还没有生成理解题');

    const submitted = new Map(answers.map((entry) => [entry.itemId, entry.answer]));
    const details = rows.map((row) => {
      const answer = submitted.get(row.id) ?? '';
      return {
        itemId: row.id,
        kind: row.kind === 'single_choice' ? 'single_choice' as const : 'true_false' as const,
        prompt: row.prompt,
        answer,
        correctAnswer: row.answer,
        correct: normalizeAnswer(answer) !== '' && normalizeAnswer(answer) === normalizeAnswer(row.answer),
        explanationZh: row.explanationZh,
      };
    });
    const correct = details.filter((item) => item.correct).length;
    const total = rows.length;
    return {
      correct,
      total,
      accuracy: total ? correct / total : 0,
      details,
    };
  }

  private async loadUnit(topicId: string) {
    const unit = await this.prisma.curriculum_units.findFirst({
      where: { topicId },
      select: { id: true, content: true },
    });
    const parsed = unit ? textbookUnitContentSchema.safeParse(unit.content) : null;
    if (!unit || !parsed?.success) throw new NotFoundException('这个主题没有可用的教材资源包');
    return { id: unit.id, content: parsed.data };
  }

  /** 按需补齐到 3 题；已有 2 题时不重复调用模型。 */
  private async ensureItems(
    unitId: string,
    topicId: string,
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
  ): Promise<void> {
    const existing = await this.prisma.unit_comprehension_items.count({ where: { unitId } });
    if (existing >= COMPREHENSION_MIN_ITEMS) return;
    const running = this.pending.get(unitId);
    if (running) {
      await running;
      const after = await this.prisma.unit_comprehension_items.count({ where: { unitId } });
      if (after >= COMPREHENSION_MIN_ITEMS) return;
    }
    const task = this.fillItems(unitId, topicId, content)
      .finally(() => this.pending.delete(unitId));
    this.pending.set(unitId, task);
    await task;
  }

  private async fillItems(
    unitId: string,
    topicId: string,
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
  ): Promise<void> {
    const existing = await this.prisma.unit_comprehension_items.count({ where: { unitId } });
    if (existing >= COMPREHENSION_MIN_ITEMS) return;
    const need = COMPREHENSION_ITEM_COUNT - existing;
    const generated = (await this.generate(content, need)) ?? [];
    const items = [
      ...generated,
      ...this.fallbackItems(content, Math.max(0, need - generated.length)),
    ].slice(0, need);
    const unique = dedupeByContent(items);
    if (!unique.length) return;
    await this.prisma.unit_comprehension_items.createMany({
      data: unique.map((item, offset) => ({
        unitId,
        topicId,
        itemIndex: existing + offset,
        kind: item.kind,
        prompt: item.prompt,
        options: item.options,
        answer: item.answer,
        explanationZh: item.explanationZh,
        sourceSentenceIds: item.sourceSentenceIds,
      })),
      skipDuplicates: true,
    });
  }

  private async generate(
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
    count: number,
  ): Promise<GeneratedItem[] | null> {
    const sentences = content.passage.paragraphs.flatMap((paragraph) => paragraph.sentences);
    if (!sentences.length) return null;
    const decision = await this.router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.curriculum_unit_comprehension',
    });
    const result = await this.gateway
      .smallLlm(
        {
          promptKey: 'curriculum.comprehension_generate',
          promptVersion: 'v1',
          system: [
            '你是小学英语阅读理解出题人。根据课文出 2–3 道理解题，题型只用 true_false 和 single_choice。',
            'true_false 的 answer 只能是 "true" 或 "false"，options 留空；single_choice 给 2–4 个选项，answer 必须是其中一个选项。',
            '题干和选项用英文，解释用中文一句话；不要出需要课文外知识或主观回答的题。',
            '只输出 {"items":[{"kind":"true_false","prompt":"The passage says: ...","options":[],"answer":"true","explanationZh":"...","sourceSentenceIds":["..."]}]}。',
          ].join(''),
          messages: [{
            role: 'user',
            content: JSON.stringify({
              title: content.passage.title,
              sentences: sentences.slice(0, 8).map((sentence) => ({
                id: sentence.id,
                en: sentence.en,
              })),
              vocabulary: content.vocabulary.slice(0, 12).map((item) => item.word),
              grammarPoints: content.grammarPoints.map((point) => ({
                id: point.id,
                title: point.titleZh,
              })),
              count,
            }),
          }],
          temperature: 0.3,
          maxTokens: 800,
          timeoutMs: 20000,
        },
        decision,
      )
      .catch((error: unknown) => {
        this.logger.warn(`理解题生成失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    if (!result) return null;
    const parsed = generatedSchema.safeParse(extractJson(result.content));
    if (!parsed.success) {
      this.logger.warn(`理解题返回不合规：${result.content.slice(0, 200)}`);
      return null;
    }
    const items = parsed.data.items
      .map(normalizeGeneratedItem)
      .filter((item): item is GeneratedItem => item !== null);
    return items.length >= COMPREHENSION_MIN_ITEMS ? items.slice(0, count) : null;
  }

  /**
   * 兜底题不调用模型：用课文原句做“判断”，用重点词替换做错误项，
   * 再用原句与替换句做“哪句出现在课文中”的单选。
   */
  private fallbackItems(
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
    count: number,
  ): GeneratedItem[] {
    if (count <= 0) return [];
    const sentences = content.passage.paragraphs
      .flatMap((paragraph) => paragraph.sentences)
      .map((sentence) => ({ id: sentence.id, en: sentence.en.trim() }))
      .filter((sentence) => sentence.en.length <= 280 && sentence.en.split(/\s+/).length >= 4);
    const words = content.vocabulary.map((item) => item.word.trim()).filter(Boolean);
    const items: GeneratedItem[] = [];
    const seen = new Set<string>();
    const add = (item: GeneratedItem) => {
      if (items.length >= count) return;
      const key = itemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };

    for (const sentence of sentences) {
      if (items.length >= count) break;
      add({
        kind: 'true_false',
        prompt: `The passage says: "${sentence.en}"`,
        options: ['true', 'false'],
        answer: 'true',
        explanationZh: '这句话与课文原句一致。',
        sourceSentenceIds: [sentence.id],
      });
      if (items.length >= count) break;

      const altered = alterSentence(sentence.en, words);
      if (altered) {
        add({
          kind: 'true_false',
          prompt: `The passage says: "${altered}"`,
          options: ['true', 'false'],
          answer: 'false',
          explanationZh: `课文原句是 “${sentence.en}”。`,
          sourceSentenceIds: [sentence.id],
        });
      }
      if (items.length >= count) break;

      const variants = alteredVariants(sentence.en, words, 2);
      if (variants.length >= 2) {
        add({
          kind: 'single_choice',
          prompt: 'Which sentence appears in the passage?',
          options: shuffleOptions([sentence.en, ...variants]),
          answer: sentence.en,
          explanationZh: '只有这个选项与课文原句完全一致。',
          sourceSentenceIds: [sentence.id],
        });
      }
    }
    return items;
  }
}

function normalizeGeneratedItem(item: GeneratedItem): GeneratedItem | null {
  if (item.kind === 'true_false') {
    const answer = normalizeAnswer(item.answer);
    if (answer !== 'true' && answer !== 'false') return null;
    return { ...item, options: ['true', 'false'], answer };
  }
  const options = [...new Set(item.options.map((option) => option.trim()).filter(Boolean))].slice(0, 4);
  if (options.length < 2) return null;
  const answer = options.find((option) => normalizeAnswer(option) === normalizeAnswer(item.answer));
  if (!answer) return null;
  return { ...item, options, answer };
}

function normalizeAnswer(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'true' || normalized === 't' || normalized === '对' || normalized === '正确') return 'true';
  if (normalized === 'false' || normalized === 'f' || normalized === '错' || normalized === '错误') return 'false';
  return normalized;
}

function itemKey(item: GeneratedItem): string {
  return [
    item.kind,
    item.prompt.trim().toLowerCase(),
    item.options.join('\u0001').toLowerCase(),
    item.answer.toLowerCase(),
  ].join('\u0002');
}

function dedupeByContent(items: GeneratedItem[]): GeneratedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = itemKey(item);
    if (!item.prompt.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordPattern(word: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
}

function alterSentence(sentence: string, words: string[]): string | null {
  for (const word of words) {
    if (!wordPattern(word).test(sentence)) continue;
    const replacement = words.find((candidate) =>
      candidate.toLowerCase() !== word.toLowerCase() && !wordPattern(candidate).test(sentence),
    );
    if (replacement) return sentence.replace(wordPattern(word), replacement);
  }
  return null;
}

function alteredVariants(sentence: string, words: string[], limit: number): string[] {
  const variants: string[] = [];
  for (const word of words) {
    if (!wordPattern(word).test(sentence)) continue;
    for (const replacement of words) {
      if (replacement.toLowerCase() === word.toLowerCase() || wordPattern(replacement).test(sentence)) continue;
      const variant = sentence.replace(wordPattern(word), replacement);
      if (variant !== sentence && variant.length <= 280 && !variants.includes(variant)) variants.push(variant);
      if (variants.length >= limit) return variants;
    }
  }
  return variants;
}

function shuffleOptions(options: string[]): string[] {
  return [...options].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { textbookUnitContentSchema, type GrammarPoint } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';

export const CLOZE_BATCH_SIZE = 5;
export const CLOZE_PASS_RATE = 0.8;

const generatedSchema = z.object({
  items: z.array(z.object({
    sentence: z.string().trim().min(4).max(300),
    answer: z.string().trim().min(1).max(60),
    options: z.array(z.string().trim().min(1).max(60)).min(2).max(4),
    explanationZh: z.string().trim().max(200).default(''),
    grammarPointId: z.string().trim().max(80).default(''),
  })).min(1).max(5),
});

export interface ClozeItemPayload {
  id: string;
  sentence: string;
  options: string[];
  grammarPointId: string;
  explanationZh: string;
}

/**
 * P3：语法讲解 + 完形。
 *
 * 规则：每批 5 题；一批正确率 < 80% 时继续追加下一批，直到 ≥ 80%。
 * 语法讲解直接取单元 content.grammarPoints，不重复生成；完形由模型按课文句生成并落库缓存。
 */
@Injectable()
export class ClozeService {
  private readonly logger = new Logger(ClozeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly router: ModelRouterImpl,
  ) {}

  async payload(topicId: string, batchIndex = 0): Promise<{
    grammarPoints: GrammarPoint[];
    batchIndex: number;
    items: ClozeItemPayload[];
    rule: { batchSize: number; passRate: number };
  }> {
    const unit = await this.loadUnit(topicId);
    await this.ensureItems(unit.id, topicId, unit.content, (batchIndex + 1) * CLOZE_BATCH_SIZE);
    const rows = await this.prisma.unit_cloze_items.findMany({
      where: { unitId: unit.id, itemIndex: { gte: batchIndex * CLOZE_BATCH_SIZE, lt: (batchIndex + 1) * CLOZE_BATCH_SIZE } },
      orderBy: { itemIndex: 'asc' },
    });
    return {
      grammarPoints: unit.content.grammarPoints,
      batchIndex,
      items: rows.map((row) => ({
        id: row.id,
        sentence: row.sentence,
        options: row.options,
        grammarPointId: row.grammarPointId,
        explanationZh: row.explanationZh,
      })),
      rule: { batchSize: CLOZE_BATCH_SIZE, passRate: CLOZE_PASS_RATE },
    };
  }

  async grade(
    topicId: string,
    batchIndex: number,
    answers: Array<{ itemId: string; answer: string }>,
  ): Promise<{
    correct: number;
    total: number;
    accuracy: number;
    passed: boolean;
    details: Array<{ itemId: string; answer: string; correctAnswer: string; correct: boolean; explanationZh: string }>;
    nextBatchIndex: number | null;
  }> {
    const unit = await this.loadUnit(topicId);
    const rows = await this.prisma.unit_cloze_items.findMany({
      where: { unitId: unit.id, itemIndex: { gte: batchIndex * CLOZE_BATCH_SIZE, lt: (batchIndex + 1) * CLOZE_BATCH_SIZE } },
      orderBy: { itemIndex: 'asc' },
    });
    if (!rows.length) throw new NotFoundException('这一批完形题还没有生成');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const details = answers.map((entry) => {
      const row = byId.get(entry.itemId);
      const correctAnswer = row?.answer ?? '';
      return {
        itemId: entry.itemId,
        answer: entry.answer,
        correctAnswer,
        correct: correctAnswer !== '' && entry.answer.trim().toLowerCase() === correctAnswer.trim().toLowerCase(),
        explanationZh: row?.explanationZh ?? '',
      };
    });
    const correct = details.filter((item) => item.correct).length;
    const total = rows.length;
    const accuracy = total ? correct / total : 0;
    const passed = accuracy >= CLOZE_PASS_RATE;
    if (!passed) {
      await this.ensureItems(unit.id, topicId, unit.content, (batchIndex + 2) * CLOZE_BATCH_SIZE);
    }
    return {
      correct,
      total,
      accuracy,
      passed,
      details,
      nextBatchIndex: passed ? null : batchIndex + 1,
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

  /** 按需补齐到 target 题；先查库，不够再生成，生成失败用课文句兜底。 */
  private async ensureItems(
    unitId: string,
    topicId: string,
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
    target: number,
  ): Promise<void> {
    const existing = await this.prisma.unit_cloze_items.count({ where: { unitId } });
    if (existing >= target) return;
    const need = Math.min(target - existing, CLOZE_BATCH_SIZE);
    const generated = (await this.generate(content, need)) ?? this.fallbackItems(content, need);
    if (!generated.length) return;
    await this.prisma.unit_cloze_items.createMany({
      data: generated.slice(0, need).map((item, offset) => ({
        unitId,
        topicId,
        itemIndex: existing + offset,
        sentence: item.sentence,
        answer: item.answer,
        options: item.options,
        explanationZh: item.explanationZh,
        grammarPointId: item.grammarPointId,
      })),
      skipDuplicates: true,
    });
  }

  private async generate(
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
    count: number,
  ): Promise<z.infer<typeof generatedSchema>['items'] | null> {
    const sentences = content.passage.paragraphs.flatMap((paragraph) => paragraph.sentences);
    if (!sentences.length) return null;
    const decision = await this.router.route({ serviceKind: 'llm', taskRoute: 'llm.curriculum_unit_grammar' });
    const result = await this.gateway
      .smallLlm(
        {
          promptKey: 'curriculum.cloze_generate',
          promptVersion: 'v1',
          system: [
            '你是小学英语练习题出题人。根据课文句和语法点出完形填空题。',
            `一次出 ${count} 题，每题只挖一个空，用三个连续下划线 ___ 表示；选项 3 个，必须包含正确答案。`,
            '干扰项要合理但唯一正确；解释用中文一句话说明语法原因。',
            '只输出 {"items":[{"sentence":"I ___ my mother clean the house.","answer":"helped","options":["helped","help","helping"],"explanationZh":"过去发生的事用过去式。","grammarPointId":"..."}]}。',
          ].join(''),
          messages: [{
            role: 'user',
            content: JSON.stringify({
              sentences: sentences.map((sentence) => sentence.en).slice(0, 8),
              grammarPoints: content.grammarPoints.map((point) => ({ id: point.id, title: point.titleZh })),
            }),
          }],
          temperature: 0.3,
          maxTokens: 900,
          timeoutMs: 20000,
        },
        decision,
      )
      .catch((error: unknown) => {
        this.logger.warn(`完形生成失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    if (!result) return null;
    const parsed = generatedSchema.safeParse(extractJson(result.content));
    if (!parsed.success) {
      this.logger.warn(`完形生成返回不合规：${result.content.slice(0, 200)}`);
      return null;
    }
    return parsed.data.items.filter((item) =>
      item.sentence.includes('___') && item.options.includes(item.answer),
    );
  }

  /** 兜底：取课文句里的重点词挖空，选项用同句其他词，保证题型成立。 */
  private fallbackItems(
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
    count: number,
  ): z.infer<typeof generatedSchema>['items'] {
    const sentences = content.passage.paragraphs
      .flatMap((paragraph) => paragraph.sentences)
      .map((sentence) => sentence.en.trim())
      .filter((text) => text.split(/\s+/).length >= 4);
    const words = content.vocabulary.map((item) => item.word.trim()).filter(Boolean);
    const items: z.infer<typeof generatedSchema>['items'] = [];
    for (const sentence of sentences) {
      if (items.length >= count) break;
      const answer = words.find((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(sentence));
      if (!answer) continue;
      const distractors = words.filter((word) => word.toLowerCase() !== answer.toLowerCase()).slice(0, 2);
      if (distractors.length < 2) continue;
      items.push({
        sentence: sentence.replace(new RegExp(`\\b${escapeRegExp(answer)}\\b`, 'i'), '___'),
        answer,
        options: shuffleOptions([answer, ...distractors]),
        explanationZh: `根据课文语境应填 ${answer}。`,
        grammarPointId: content.grammarPoints[0]?.id ?? '',
      });
    }
    return items;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

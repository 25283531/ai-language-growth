import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { textbookUnitContentSchema } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';

/** 角色扮演/复述的达标覆盖率；开放表达不要求逐字匹配参考答案。 */
export const EXPRESSION_PASS_COVERAGE = 0.6;
export const EXPRESSION_KINDS = ['role_play', 'retell'] as const;
export type ExpressionKind = (typeof EXPRESSION_KINDS)[number];

const generatedSchema = z.object({
  task: z.object({
    kind: z.enum(EXPRESSION_KINDS),
    title: z.string().trim().min(1).max(200),
    scenarioZh: z.string().trim().min(1).max(500),
    promptEn: z.string().trim().min(1).max(500),
    promptZh: z.string().trim().min(1).max(500),
    referenceAnswer: z.string().trim().min(3).max(1000),
    /** 必须能在参考答案中定位，用于判分而不要求逐字复述。 */
    requiredPhrases: z.array(z.string().trim().min(1).max(100)).min(2).max(4),
    sourceSentenceIds: z.array(z.string().trim().max(80)).max(6).default([]),
  }),
});

type GeneratedTask = z.infer<typeof generatedSchema>['task'];

export interface ExpressionTaskPayload {
  id: string;
  kind: ExpressionKind;
  title: string;
  scenarioZh: string;
  promptEn: string;
  promptZh: string;
  /** 给学习者的表达提示；参考答案只在判分后返回。 */
  requiredPhrases: string[];
}

/**
 * P4-03：教材单元的角色扮演/复述模板。
 *
 * 每单元 1 个任务，参考答案不在取题时下发；判分以必用短语覆盖率为准，
 * 不要求逐字复述。模型失败时用课文原句和重点词生成可判分的兜底任务。
 */
@Injectable()
export class ExpressionTaskService {
  private readonly logger = new Logger(ExpressionTaskService.name);
  /** 同一单元只生成一份模板。 */
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly router: ModelRouterImpl,
  ) {}

  async payload(topicId: string): Promise<{
    task: ExpressionTaskPayload;
    rule: { passCoverage: number };
  }> {
    const unit = await this.loadUnit(topicId);
    const task = await this.ensureTask(unit.id, topicId, unit.content);
    return {
      task: {
        id: task.id,
        kind: task.kind === 'retell' ? 'retell' : 'role_play',
        title: task.title,
        scenarioZh: task.scenarioZh,
        promptEn: task.promptEn,
        promptZh: task.promptZh,
        requiredPhrases: task.requiredPhrases,
      },
      rule: { passCoverage: EXPRESSION_PASS_COVERAGE },
    };
  }

  async grade(topicId: string, answer: string): Promise<{
    answer: string;
    normalizedAnswer: string;
    referenceAnswer: string;
    matchedPhrases: string[];
    missingPhrases: string[];
    coverage: number;
    passed: boolean;
    feedbackZh: string;
  }> {
    const unit = await this.loadUnit(topicId);
    const task = await this.prisma.unit_expression_tasks.findFirst({
      where: { unitId: unit.id },
    });
    if (!task) throw new NotFoundException('这个单元还没有生成角色扮演/复述任务');

    const normalizedAnswer = normalizeText(answer);
    const matchedPhrases = task.requiredPhrases.filter((phrase) =>
      containsWholePhrase(normalizedAnswer, normalizeText(phrase)),
    );
    const missingPhrases = task.requiredPhrases.filter((phrase) => !matchedPhrases.includes(phrase));
    const coverage = task.requiredPhrases.length
      ? matchedPhrases.length / task.requiredPhrases.length
      : (normalizedAnswer ? 1 : 0);
    const passed = coverage >= EXPRESSION_PASS_COVERAGE;
    return {
      answer,
      normalizedAnswer,
      referenceAnswer: task.referenceAnswer,
      matchedPhrases,
      missingPhrases,
      coverage,
      passed,
      feedbackZh: passed
        ? '表达完整，已经把本课的重点表达用上了。'
        : `再试着用上：${missingPhrases.join('、') || '本课重点表达'}。`,
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

  private async ensureTask(
    unitId: string,
    topicId: string,
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
  ) {
    const existing = await this.prisma.unit_expression_tasks.findFirst({ where: { unitId } });
    if (existing) return existing;
    const running = this.pending.get(unitId);
    if (running) {
      await running;
      const after = await this.prisma.unit_expression_tasks.findFirst({ where: { unitId } });
      if (after) return after;
    }
    const task = this.fillTask(unitId, topicId, content)
      .finally(() => this.pending.delete(unitId));
    this.pending.set(unitId, task);
    await task;
    const created = await this.prisma.unit_expression_tasks.findFirst({ where: { unitId } });
    if (!created) throw new NotFoundException('这个单元还没有可用的角色扮演/复述任务');
    return created;
  }

  private async fillTask(
    unitId: string,
    topicId: string,
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
  ): Promise<void> {
    const existing = await this.prisma.unit_expression_tasks.findFirst({ where: { unitId } });
    if (existing) return;
    const generated = (await this.generate(content)) ?? this.fallbackTask(content);
    if (!generated) return;
    await this.prisma.unit_expression_tasks.create({
      data: {
        unitId,
        topicId,
        kind: generated.kind,
        title: generated.title,
        scenarioZh: generated.scenarioZh,
        promptEn: generated.promptEn,
        promptZh: generated.promptZh,
        referenceAnswer: generated.referenceAnswer,
        requiredPhrases: generated.requiredPhrases,
        sourceSentenceIds: generated.sourceSentenceIds,
      },
    });
  }

  private async generate(
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
  ): Promise<GeneratedTask | null> {
    const sentences = content.passage.paragraphs.flatMap((paragraph) => paragraph.sentences);
    if (!sentences.length) return null;
    const decision = await this.router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.curriculum_unit_expression',
    });
    const result = await this.gateway
      .smallLlm(
        {
          promptKey: 'curriculum.expression_generate',
          promptVersion: 'v1',
          system: [
            '你是小学英语口语任务设计者。根据课文设计 1 个角色扮演或复述任务。',
            '任务要给出中文情境、英文指令和中文指令、1–2 句英文参考答案，以及 2–4 个必须用到的短语。',
            '必用短语必须逐字出现在参考答案中；只使用课文和词表里的表达，不编造新词。',
            '只输出 {"task":{"kind":"role_play","title":"...","scenarioZh":"...","promptEn":"...","promptZh":"...","referenceAnswer":"...","requiredPhrases":["..."],"sourceSentenceIds":["..."]}}。',
          ].join(''),
          messages: [{
            role: 'user',
            content: JSON.stringify({
              title: content.passage.title,
              sentences: sentences.slice(0, 8).map((sentence) => ({
                id: sentence.id,
                en: sentence.en,
                zh: sentence.zh,
              })),
              vocabulary: content.vocabulary.slice(0, 12).map((item) => item.word),
              grammarPoints: content.grammarPoints.map((point) => ({
                id: point.id,
                pattern: point.pattern,
              })),
            }),
          }],
          temperature: 0.4,
          maxTokens: 700,
          timeoutMs: 20000,
        },
        decision,
      )
      .catch((error: unknown) => {
        this.logger.warn(`角色扮演/复述生成失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    if (!result) return null;
    const parsed = generatedSchema.safeParse(extractJson(result.content));
    if (!parsed.success) {
      this.logger.warn(`角色扮演/复述返回不合规：${result.content.slice(0, 200)}`);
      return null;
    }
    return normalizeGeneratedTask(parsed.data.task);
  }

  private fallbackTask(
    content: ReturnType<typeof textbookUnitContentSchema.parse>,
  ): GeneratedTask | null {
    const sentences = content.passage.paragraphs
      .flatMap((paragraph) => paragraph.sentences)
      .map((sentence) => ({ id: sentence.id, en: sentence.en.trim() }))
      .filter((sentence) => sentence.en.length >= 3 && sentence.en.split(/\s+/).length >= 3)
      .slice(0, 2);
    if (!sentences.length) return null;
    const referenceAnswer = sentences.map((sentence) => sentence.en).join(' ');
    const normalizedReference = normalizeText(referenceAnswer);
    const vocabularyPhrases = content.vocabulary
      .map((item) => item.word.trim())
      .filter((word) => word && containsWholePhrase(normalizedReference, normalizeText(word)))
      .slice(0, 3);
    const requiredPhrases = vocabularyPhrases.length >= 2
      ? vocabularyPhrases
      : fallbackPhrases(referenceAnswer, vocabularyPhrases);
    return {
      kind: 'role_play',
      title: `角色扮演：${content.passage.title}`,
      scenarioZh: `你和同学在谈论《${content.passage.title}》，请用课文里的表达完成对话。`,
      promptEn: 'Talk about the passage with your partner.',
      promptZh: '和同伴说一说课文内容。',
      referenceAnswer,
      requiredPhrases,
      sourceSentenceIds: sentences.map((sentence) => sentence.id),
    };
  }
}

function normalizeGeneratedTask(task: GeneratedTask): GeneratedTask | null {
  const normalizedReference = normalizeText(task.referenceAnswer);
  const phrases = [...new Set(task.requiredPhrases.map((phrase) => phrase.trim()).filter(Boolean))]
    .filter((phrase) => containsWholePhrase(normalizedReference, normalizeText(phrase)))
    .slice(0, 4);
  if (phrases.length < 2) return null;
  return { ...task, requiredPhrases: phrases };
}

function fallbackPhrases(referenceAnswer: string, existing: string[]): string[] {
  const phrases = [...existing];
  for (const word of referenceAnswer.match(/[A-Za-z]+/g) ?? []) {
    const normalized = normalizeText(word);
    if (normalized.length < 3 || phrases.some((phrase) => normalizeText(phrase) === normalized)) continue;
    phrases.push(word);
    if (phrases.length >= 3) break;
  }
  return phrases;
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsWholePhrase(answer: string, phrase: string): boolean {
  if (!answer || !phrase) return false;
  return ` ${answer} `.includes(` ${phrase} `);
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
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';

const memoriesSchema = z.object({
  memories: z.array(z.object({
    memoryType: z.enum(['learning_preference', 'encouragement_preference']),
    content: z.string().trim().min(1).max(300),
    importance: z.number().min(0.4).max(0.9),
  }).strict()).max(3),
}).strict();

export type ExtractedMemory = z.infer<typeof memoriesSchema>['memories'][number];

@Injectable()
export class MemoryManagerService {
  private readonly logger = new Logger(MemoryManagerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ModelRouterImpl) private readonly router: ModelRouterImpl,
    @Inject(AiGatewayService) private readonly gateway: AiGatewayService,
  ) {}

  /** Extract only explicit, reusable preferences after a lesson; never persist raw dialogue. */
  async extractLessonMemories(input: {
    learnerId: string;
    lessonSessionId: string;
    topicId: string;
    evidenceBySkill: Array<{ skillName: string; independentSuccesses: number; unsuccessfulAttempts: number }>;
  }): Promise<ExtractedMemory[]> {
    const events = await this.prisma.interaction_events.findMany({
      where: { learnerId: input.learnerId, lessonSessionId: input.lessonSessionId },
      orderBy: { turnIndex: 'asc' },
      select: { input: true, output: true },
      take: 30,
    });
    const explicitSignals = events.flatMap((event) => {
      const request = event.input as { text?: unknown; freeUtterance?: unknown };
      const response = event.output as { directive?: { teacherUtterance?: unknown } };
      const childText = [request.text, request.freeUtterance]
        .find((value): value is string => typeof value === 'string');
      if (!childText) return [];
      const utterance = childText.trim().slice(0, 240);
      if (!utterance) return [];
      // Only forward explicit teaching feedback/preference statements for extraction.
      if (!/(喜欢|不喜欢|更喜欢|想要|希望|慢一点|快一点|再多|少一点|不想|最爱|最喜欢|like|love|prefer|don't like|do not like|slower|faster|again)/i.test(utterance)) return [];
      return [{
        childStatement: utterance,
        teachingResponse: typeof response.directive?.teacherUtterance === 'string'
          ? response.directive.teacherUtterance.slice(0, 160)
          : '',
      }];
    }).slice(-12);
    if (!explicitSignals.length) return [];

    const decision = await this.router.route({ serviceKind: 'llm', taskRoute: 'llm.memory_extraction' });
    try {
      const result = await this.gateway.llm({
        promptKey: 'memory_manager.lesson_extraction',
        promptVersion: 'v1',
        system: [
          '你是儿童英语学习交互记忆整理器。只提取孩子明确表达且可用于调整教学的兴趣或反馈偏好。',
          '不得推断人格、心理状态、家庭信息、身份信息或未表达的偏好；忽略无关对话。',
          '不要保留原句或个人信息，改写为简短、可纠正的教学提示；最多输出 3 条 JSON。',
          '只输出 {"memories":[{"memoryType":"learning_preference|encouragement_preference","content":"...","importance":0.4到0.9}]}。',
        ].join(''),
        messages: [{ role: 'user', content: JSON.stringify({
          topicId: input.topicId,
          evidenceBySkill: input.evidenceBySkill,
          explicitSignals,
        }) }],
        temperature: 0,
        maxTokens: 220,
        timeoutMs: 8000,
      }, decision);
      await this.router.recordUsage({
        id: `usage-memory-extraction-${input.lessonSessionId}`,
        learnerId: input.learnerId,
        lessonSessionId: input.lessonSessionId,
        serviceKind: 'llm',
        taskRoute: 'llm.memory_extraction',
        level: result.providerAlias.startsWith('mock_') ? 'L0' : decision.level,
        providerAlias: result.providerAlias,
        modelAlias: result.modelAlias,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ttsCharacters: 0,
        asrSeconds: 0,
        pronunciationCalls: 0,
        estimatedCostCny: 0,
        latencyMs: result.latencyMs,
        createdAt: new Date().toISOString(),
      });
      const parsed = memoriesSchema.safeParse(JSON.parse(result.content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()));
      if (!parsed.success) return [];
      return parsed.data.memories;
    } catch (error) {
      this.logger.warn(`交互记忆提取跳过: ${(error as Error).message}`);
      return [];
    }
  }

  async saveLessonMemories(input: {
    learnerId: string;
    lessonSessionId: string;
    memories: ExtractedMemory[];
  }): Promise<void> {
    for (const memory of input.memories) {
      const existing = await this.prisma.interaction_memories.findFirst({
        where: { learnerId: input.learnerId, memoryType: memory.memoryType, content: memory.content },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.interaction_memories.update({
          where: { id: existing.id },
          data: { importance: memory.importance, expiresAt: new Date(Date.now() + 180 * 86400000), source: 'batch_extract' },
        });
        continue;
      }
      await this.prisma.interaction_memories.create({
        data: {
          learnerId: input.learnerId,
          sourceSessionId: input.lessonSessionId,
          memoryType: memory.memoryType,
          content: memory.content,
          importance: memory.importance,
          source: 'batch_extract',
          expiresAt: new Date(Date.now() + 180 * 86400000),
        },
      });
    }
    await this.prisma.interaction_memories.deleteMany({
      where: { learnerId: input.learnerId, expiresAt: { lt: new Date() } },
    });
  }
}

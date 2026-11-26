import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';
import { Mem0Client } from '../memory/mem0.client';

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
    @Inject(Mem0Client) private readonly mem0: Mem0Client,
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
      const request = event.input && typeof event.input === 'object'
        ? event.input as { text?: unknown; freeUtterance?: unknown }
        : {};
      const response = event.output && typeof event.output === 'object'
        ? event.output as { directive?: { teacherUtterance?: unknown } }
        : {};
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
      const result = await this.gateway.smallLlm({
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
        select: { id: true, externalId: true },
      });
      let memoryId = existing?.id;
      let externalId = existing?.externalId ?? null;
      if (existing) {
        await this.prisma.interaction_memories.update({
          where: { id: existing.id },
          data: { importance: memory.importance, expiresAt: new Date(Date.now() + 180 * 86400000), source: 'batch_extract' },
        });
      } else {
        const created = await this.prisma.interaction_memories.create({
          data: {
            learnerId: input.learnerId,
            sourceSessionId: input.lessonSessionId,
            memoryType: memory.memoryType,
            content: memory.content,
            importance: memory.importance,
            source: 'batch_extract',
            expiresAt: new Date(Date.now() + 180 * 86400000),
          },
          select: { id: true },
        });
        memoryId = created.id;
      }

      // L3：Mem0 只作为语义检索层；失败不阻断结课，PostgreSQL 行仍可审计、可删除。
      if (memoryId && !externalId && this.mem0.isConfigured()) {
        const added = await this.mem0.add({
          learnerId: input.learnerId,
          localMemoryId: memoryId,
          content: memory.content,
          memoryType: memory.memoryType,
          importance: memory.importance,
          sourceSessionId: input.lessonSessionId,
        });
        if (added.id) {
          externalId = added.id;
          await this.prisma.interaction_memories.update({
            where: { id: memoryId },
            data: { externalId: added.id, externalProvider: 'mem0' },
          });
        }
      }
    }
    const expired = await this.prisma.interaction_memories.findMany({
      where: {
        learnerId: input.learnerId,
        expiresAt: { lt: new Date() },
      },
      select: { id: true, externalId: true },
      take: 100,
    });
    if (expired.length) {
      await this.prisma.interaction_memories.deleteMany({
        where: { id: { in: expired.map((row) => row.id) }, learnerId: input.learnerId },
      });
      // 本地过期即不再可被检索；外部副本尽力清理，失败也不会通过本地回指校验进入课堂。
      for (const row of expired) {
        if (row.externalId) await this.mem0.delete(row.externalId);
      }
    }
  }

  /**
   * 读取与当前教学上下文最相关的交互记忆。
   * Mem0 可用时做语义召回，失败或无结果时回落到 PostgreSQL 的确定性排序。
   */
  async retrieveRelevantMemories(input: {
    learnerId: string;
    query: string;
    limit: number;
  }): Promise<Array<{ content: string; memoryType: string; importance: number }>> {
    const limit = Math.max(1, Math.min(10, input.limit));
    if (this.mem0.isConfigured() && input.query.trim()) {
      const hits = await this.mem0.search({
        learnerId: input.learnerId,
        query: input.query,
        limit,
      });
      if (hits.length) {
        // Mem0 只是索引：只接受能回指本地可审计行的命中，外部残留/过期内容不得进入课堂。
        const localIds = hits
          .map((hit) => hit.metadata.local_memory_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (localIds.length) {
          const localRows = await this.prisma.interaction_memories.findMany({
            where: {
              id: { in: localIds },
              learnerId: input.learnerId,
              memoryType: { in: ['learning_preference', 'encouragement_preference'] },
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            select: { id: true, content: true, memoryType: true, importance: true },
          });
          const byId = new Map(localRows.map((row) => [row.id, row]));
          const trusted = hits
            .map((hit) => {
              const localId = hit.metadata.local_memory_id;
              return typeof localId === 'string' ? byId.get(localId) : undefined;
            })
            .filter((row): row is NonNullable<typeof row> => Boolean(row))
            .slice(0, limit);
          if (trusted.length) {
            return trusted.map((row) => ({
              content: row.content,
              memoryType: row.memoryType,
              importance: row.importance,
            }));
          }
        }
      }
    }
    return this.prisma.interaction_memories.findMany({
      where: {
        learnerId: input.learnerId,
        memoryType: { in: ['learning_preference', 'encouragement_preference'] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
      select: { content: true, memoryType: true, importance: true },
    });
  }

  /** 管理员修正本地记忆；外部索引只做尽力同步，命中仍回指本地可审计行。 */
  async updateMemory(input: {
    learnerId: string;
    memoryId: string;
    data: {
      memoryType: string;
      content: string;
      importance: number;
      expiresAt: Date | null | undefined;
    };
  }): Promise<{
    id: string;
    learnerId: string;
    memoryType: string;
    content: string;
    importance: number;
    expiresAt: Date | null;
    source: string;
    updatedAt: Date;
  } | null> {
    const existing = await this.prisma.interaction_memories.findFirst({
      where: { id: input.memoryId, learnerId: input.learnerId },
      select: { id: true, externalId: true },
    });
    if (!existing) return null;
    const updated = await this.prisma.interaction_memories.update({
      where: { id: existing.id },
      data: {
        memoryType: input.data.memoryType,
        content: input.data.content,
        importance: input.data.importance,
        expiresAt: input.data.expiresAt,
        source: 'admin_corrected',
      },
    });
    if (existing.externalId && this.mem0.isConfigured()) {
      const synced = await this.mem0.update(existing.externalId, {
        localMemoryId: existing.id,
        content: input.data.content,
        memoryType: input.data.memoryType,
        importance: input.data.importance,
      });
      if (!synced) {
        this.logger.warn(`L3 外部记忆修正未同步，保留本地权威副本：memory=${existing.id}`);
      }
    }
    return {
      id: updated.id,
      learnerId: updated.learnerId,
      memoryType: updated.memoryType,
      content: updated.content,
      importance: updated.importance,
      expiresAt: updated.expiresAt,
      source: updated.source,
      updatedAt: updated.updatedAt,
    };
  }

  /** 删除单条交互记忆：先尝试外部 Mem0，再删除本地可审计副本。 */
  async deleteMemory(input: { learnerId: string; memoryId: string }): Promise<boolean> {
    const existing = await this.prisma.interaction_memories.findFirst({
      where: { id: input.memoryId, learnerId: input.learnerId },
      select: { id: true, externalId: true },
    });
    if (!existing) return false;
    if (existing.externalId) {
      await this.mem0.delete(existing.externalId);
    }
    await this.prisma.interaction_memories.delete({ where: { id: existing.id } });
    return true;
  }
}

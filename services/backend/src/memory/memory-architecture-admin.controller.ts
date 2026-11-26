import { BadRequestException, Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ProviderConfigService } from '../providers/provider-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurriculumKnowledgeService } from './curriculum-knowledge.service';
import { EmbeddingService } from './embedding.service';
import { WorkingMemoryService } from './working-memory.service';
import { Mem0Client } from './mem0.client';

const reindexInput = z.object({
  limit: z.number().int().min(1).max(12000).optional(),
  embed: z.boolean().optional(),
  prune: z.boolean().optional(),
}).strict();

/** L1/L3/L5 记忆与知识库的只读状态、手动重建与检索验证入口。 */
@Controller('api/v1/admin/memory')
export class MemoryArchitectureAdminController {
  constructor(
    private readonly configs: ProviderConfigService,
    private readonly prisma: PrismaService,
    private readonly workingMemory: WorkingMemoryService,
    private readonly mem0: Mem0Client,
    private readonly embeddings: EmbeddingService,
    private readonly knowledge: CurriculumKnowledgeService,
  ) {}

  private authorize(token?: string) {
    this.configs.assertAdminToken(token);
  }

  @Get('status')
  async status(@Headers('x-admin-token') token: string | undefined) {
    this.authorize(token);
    const [working, embeddingConfigured, chunkCount, embeddedRows] = await Promise.all([
      this.workingMemory.health(),
      this.embeddings.isConfigured(),
      this.prisma.curriculum_knowledge_chunks.count(),
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
        FROM "curriculum_knowledge_chunks"
        WHERE "embedding" IS NOT NULL
      `,
    ]);
    const embeddedCount = Number(embeddedRows[0]?.count ?? 0);
    const embeddingDegraded = this.embeddings.isDegraded();
    return {
      l1WorkingMemory: working,
      l3Mem0: {
        configured: this.mem0.isConfigured(),
        degraded: this.mem0.isDegraded(),
        note: this.mem0.isConfigured()
          ? 'Mem0 已配置；交互记忆写入与检索优先走 Mem0，失败回落 PostgreSQL。'
          : 'Mem0 未配置；交互记忆使用 PostgreSQL 关系表，配置 MEM0_BASE_URL 后启用语义检索。',
      },
      l5Knowledge: {
        embeddingConfigured,
        embeddingDegraded,
        chunks: chunkCount,
        embeddedChunks: embeddedCount,
        embeddingCoverage: chunkCount > 0 ? Number((embeddedCount / chunkCount).toFixed(3)) : 0,
        lexicalFallback: !embeddingConfigured || embeddingDegraded || embeddedCount === 0,
      },
    };
  }

  @Post('knowledge/reindex')
  async reindex(
    @Headers('x-admin-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    this.authorize(token);
    const parsed = reindexInput.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.knowledge.reindex(parsed.data);
  }

  @Get('knowledge/search')
  async search(
    @Headers('x-admin-token') token: string | undefined,
    @Query('q') query?: string,
    @Query('limit') limit?: string,
    @Query('topicId') topicId?: string,
  ) {
    this.authorize(token);
    if (!query?.trim()) throw new BadRequestException('缺少检索词 q');
    const parsedLimit = limit ? Number(limit) : 5;
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 10) {
      throw new BadRequestException('limit 必须是 1—10');
    }
    return {
      query,
      hits: await this.knowledge.search({
        query,
        limit: parsedLimit,
        topicId: topicId?.trim() || null,
      }),
    };
  }
}
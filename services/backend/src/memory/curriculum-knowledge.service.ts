import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';

export interface KnowledgeChunk {
  sourceType: string;
  sourceId: string;
  topicId: string | null;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeHit extends KnowledgeChunk {
  score: number;
}

export interface ReindexResult {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  embedded: number;
  pruned: number;
  embeddingConfigured: boolean;
  durationMs: number;
}

const EMBED_BATCH_SIZE = 32;
const MAX_QUERY_CANDIDATES = 1200;
const DEFAULT_INDEX_CHUNKS = 12000;
const MAX_INDEX_CHUNKS = 12000;

/**
 * L5 课程知识库 RAG（PostgreSQL + Embedding）。
 *
 * 分层：
 *  - 结构化知识（词库 / 词汇卡 / 句型 / 音素 / 已发布课程单元）先转成可检索文本块；
 *  - Embedding 可用时写入向量，查询走「词法预筛 + 余弦相似度」混合召回；
 *  - Embedding 未配置或失败时只走词法匹配，不伪造向量。
 *
 * 边界：知识库只给教师提供事实参考，不是教学指令；不得据此改掌握状态或绕过 Planner。
 */
@Injectable()
export class CurriculumKnowledgeService {
  private readonly logger = new Logger(CurriculumKnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
  ) {}

  async reindex(input: {
    limit?: number;
    embed?: boolean;
    prune?: boolean;
  } = {}): Promise<ReindexResult> {
    const started = Date.now();
    const startedAt = new Date();
    const allChunks = await this.buildChunks();
    const requestedLimit = Math.max(1, Math.min(MAX_INDEX_CHUNKS, input.limit ?? DEFAULT_INDEX_CHUNKS));
    const chunks = allChunks.slice(0, requestedLimit);
    const fullScan = chunks.length === allChunks.length;
    const embeddingConfigured = await this.embeddings.isConfigured();
    let shouldEmbed = Boolean(input.embed ?? true) && embeddingConfigured;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let embedded = 0;

    for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
      // 供应商一旦失败，本轮剩余批次不再逐个等待超时；文本仍照常入库，保留词法检索。
      const vectors = shouldEmbed
        ? await this.embeddings.embed(batch.map((chunk) => this.embeddingText(chunk)))
        : null;
      if (shouldEmbed && !vectors) shouldEmbed = false;

      for (const [index, chunk] of batch.entries()) {
        const contentHash = this.contentHash(chunk);
        const vector = vectors?.vectors[index] ?? null;
        const existing = await this.prisma.curriculum_knowledge_chunks.findUnique({
          where: {
            sourceType_sourceId: {
              sourceType: chunk.sourceType,
              sourceId: chunk.sourceId,
            },
          },
          select: { id: true, contentHash: true, embedding: true, embeddingModel: true },
        });
        if (existing) {
          const contentChanged = existing.contentHash !== contentHash;
          const modelChanged = Boolean(vector)
            && (!this.hasEmbedding(existing.embedding)
              || (Boolean(vectors?.model) && existing.embeddingModel !== vectors?.model));
          if (contentChanged || modelChanged) {
            await this.prisma.curriculum_knowledge_chunks.update({
              where: { id: existing.id },
              data: {
                title: chunk.title,
                topicId: chunk.topicId,
                content: chunk.content,
                metadata: chunk.metadata as object,
                contentHash,
                // 内容已变而本轮没有新向量时必须清空旧向量，避免用旧语义匹配新文本。
                embedding: vector ?? Prisma.DbNull,
                embeddingModel: vector ? (vectors?.model ?? null) : null,
                updatedAt: new Date(),
              },
            });
            if (vector) embedded += 1;
            updated += 1;
          } else {
            // 内容未变也要刷新时间，供 prune 区分本次扫描过的块。
            await this.prisma.curriculum_knowledge_chunks.update({
              where: { id: existing.id },
              data: { updatedAt: new Date() },
            });
            unchanged += 1;
          }
          continue;
        }

        await this.prisma.curriculum_knowledge_chunks.create({
          data: {
            sourceType: chunk.sourceType,
            sourceId: chunk.sourceId,
            topicId: chunk.topicId,
            title: chunk.title,
            content: chunk.content,
            metadata: chunk.metadata as object,
            embedding: vector ?? Prisma.DbNull,
            embeddingModel: vector ? (vectors?.model ?? null) : null,
            contentHash,
          },
        });
        created += 1;
        if (vector) embedded += 1;
      }
    }

    const pruned = input.prune !== false && fullScan
      ? (await this.prisma.curriculum_knowledge_chunks.deleteMany({
          where: { updatedAt: { lt: startedAt } },
        })).count
      : 0;

    const result: ReindexResult = {
      scanned: chunks.length,
      created,
      updated,
      unchanged,
      embedded,
      pruned,
      embeddingConfigured,
      durationMs: Date.now() - started,
    };
    this.logger.log(`L5 知识库重建完成：${JSON.stringify(result)}`);
    return result;
  }

  async search(input: {
    query: string;
    limit?: number;
    topicId?: string | null;
  }): Promise<KnowledgeHit[]> {
    const query = input.query.trim();
    if (!query) return [];
    const limit = Math.max(1, Math.min(10, input.limit ?? 5));
    const tokens = tokenizeQuery(query);
    const [queryVector, candidates] = await Promise.all([
      this.embedQuery(query),
      this.candidateChunks(tokens, input.topicId ?? null),
    ]);
    if (!candidates.length) return [];

    const lexicalScores = new Map<string, number>();
    for (const chunk of candidates) {
      lexicalScores.set(chunk.id, lexicalScore(query, tokens, chunk.title, chunk.content));
    }
    const maxLexical = Math.max(1, ...lexicalScores.values());

    const scored = candidates.map((chunk) => {
      const lexical = (lexicalScores.get(chunk.id) ?? 0) / maxLexical;
      const semantic = queryVector ? cosineSimilarity(queryVector, this.toVector(chunk.embedding)) : 0;
      const score = queryVector
        ? semantic * 0.65 + lexical * 0.35
        : lexical;
      return {
        sourceType: chunk.sourceType,
        sourceId: chunk.sourceId,
        topicId: chunk.topicId,
        title: chunk.title,
        content: chunk.content,
        metadata: (chunk.metadata ?? {}) as Record<string, unknown>,
        score,
      };
    });

    return scored
      .filter((hit) => hit.score > 0.001)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  /** 给教师问答用的紧凑知识片段；只返回已脱敏的课程内容。 */
  async searchForPrompt(query: string, limit = 3): Promise<string[]> {
    const hits = await this.search({ query, limit });
    return hits.map((hit) => `[${hit.sourceType}] ${hit.title}：${hit.content.replace(/\s+/g, ' ').slice(0, 500)}`);
  }

  private async embedQuery(query: string): Promise<number[] | null> {
    if (!(await this.embeddings.isConfigured())) return null;
    // 问答链路只等短时间：慢供应商不能拖住课堂，超时后本轮用词法结果。
    const result = await this.embeddings.embed([query], { timeoutMs: 2500 });
    return result?.vectors[0] ?? null;
  }

  private async candidateChunks(
    tokens: string[],
    topicId: string | null,
  ): Promise<Array<{
    id: string;
    sourceType: string;
    sourceId: string;
    topicId: string | null;
    title: string;
    content: string;
    metadata: unknown;
    embedding: unknown;
  }>> {
    const topicFilter = topicId
      ? { OR: [{ topicId }, { topicId: null }] }
      : {};
    const termFilter = tokens.length
      ? {
          OR: tokens.slice(0, 8).flatMap((token) => [
            { title: { contains: token, mode: 'insensitive' as const } },
            { content: { contains: token, mode: 'insensitive' as const } },
          ]),
        }
      : {};
    const where = tokens.length
      ? { AND: [topicFilter, termFilter] }
      : topicFilter;
    let rows = await this.prisma.curriculum_knowledge_chunks.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: MAX_QUERY_CANDIDATES,
      select: {
        id: true,
        sourceType: true,
        sourceId: true,
        topicId: true,
        title: true,
        content: true,
        metadata: true,
        embedding: true,
      },
    });
    if (!rows.length && tokens.length) {
      // 词法预筛过窄时回落到最近更新的知识块，避免 RAG 因一个生僻词完全失明。
      rows = await this.prisma.curriculum_knowledge_chunks.findMany({
        where: topicFilter,
        orderBy: { updatedAt: 'desc' },
        take: MAX_QUERY_CANDIDATES,
        select: {
          id: true,
          sourceType: true,
          sourceId: true,
          topicId: true,
          title: true,
          content: true,
          metadata: true,
          embedding: true,
        },
      });
    }
    return rows;
  }

  private async buildChunks(): Promise<KnowledgeChunk[]> {
    const [lexicon, units, vocabulary, patterns, phonemes] = await Promise.all([
      this.prisma.lexicon_entries.findMany({
        where: { childSafe: true },
        orderBy: [{ frequencyRank: 'asc' }, { word: 'asc' }],
        take: MAX_INDEX_CHUNKS,
        select: {
          id: true,
          word: true,
          phonetic: true,
          pos: true,
          meaningZh: true,
          domains: true,
          examples: true,
          collocations: true,
        },
      }),
      this.prisma.curriculum_units.findMany({
        where: { reviewStatus: 'published', availability: 'active' },
        orderBy: [{ topicId: 'asc' }, { order: 'asc' }],
        take: 2000,
        select: { id: true, topicId: true, title: true, description: true, stage: true, content: true },
      }),
      this.prisma.vocabulary_items.findMany({
        where: { reviewStatus: 'published' },
        orderBy: [{ word: 'asc' }, { id: 'asc' }],
        take: 5000,
        select: {
          id: true,
          topicId: true,
          word: true,
          phonetic: true,
          meaningZh: true,
          exampleSentences: true,
        },
      }),
      this.prisma.sentence_patterns.findMany({
        where: { reviewStatus: 'published' },
        orderBy: [{ pattern: 'asc' }, { id: 'asc' }],
        take: 3000,
        select: { id: true, topicId: true, pattern: true, zh: true, examples: true },
      }),
      this.prisma.phoneme_items.findMany({
        where: { reviewStatus: 'published' },
        orderBy: [{ phoneme: 'asc' }, { id: 'asc' }],
        take: 200,
        select: { id: true, phoneme: true, ipa: true, descriptionZh: true },
      }),
    ]);

    const chunks: KnowledgeChunk[] = [];

    // 先放课程与教材内容，再放通用词库：默认索引上限下，课程知识不会被大词库挤掉。
    for (const unit of units) {
      const content = unit.content && typeof unit.content === 'object' ? unit.content as Record<string, unknown> : {};
      const overview = [
        unit.title,
        unit.description ?? '',
        typeof content.stageHint === 'number' ? `建议阶段：${content.stageHint}` : `阶段：${unit.stage}`,
        this.unitObjectives(content),
        this.unitPassage(content),
        this.unitGrammar(content),
      ].filter(Boolean).join('。');
      if (overview.trim()) {
        chunks.push({
          sourceType: 'curriculum_unit',
          sourceId: unit.id,
          topicId: unit.topicId,
          title: `课程单元 ${unit.title}`,
          content: overview,
          metadata: { unitId: unit.id, topicId: unit.topicId, stage: unit.stage },
        });
      }
      for (const sentence of this.unitSentences(content)) {
        chunks.push({
          sourceType: 'passage_sentence',
          sourceId: `${unit.id}:${sentence.id}`,
          topicId: unit.topicId,
          title: `课文例句 ${sentence.en.slice(0, 40)}`,
          content: `${sentence.en} ${sentence.zh}`.trim(),
          metadata: { unitId: unit.id, sentenceId: sentence.id, keyWords: sentence.keyWords },
        });
      }
    }

    for (const pattern of patterns) {
      chunks.push({
        sourceType: 'sentence_pattern',
        sourceId: pattern.id,
        topicId: pattern.topicId,
        title: `句型 ${pattern.pattern}`,
        content: `${pattern.pattern} ${pattern.zh} ${this.exampleText(pattern.examples)}`.trim(),
        metadata: { topicId: pattern.topicId },
      });
    }

    for (const item of vocabulary) {
      chunks.push({
        sourceType: 'vocabulary',
        sourceId: item.id,
        topicId: item.topicId,
        title: `词汇卡 ${item.word}`,
        content: [
          `${item.word}${item.phonetic ? ` ${item.phonetic}` : ''}`,
          `中文：${item.meaningZh}`,
          this.exampleText(item.exampleSentences) ? `例句：${this.exampleText(item.exampleSentences)}` : '',
        ].filter(Boolean).join('。'),
        metadata: { word: item.word, topicId: item.topicId },
      });
    }

    for (const phoneme of phonemes) {
      chunks.push({
        sourceType: 'phoneme',
        sourceId: phoneme.id,
        topicId: null,
        title: `音素 ${phoneme.phoneme}`,
        content: `${phoneme.phoneme} ${phoneme.ipa} ${phoneme.descriptionZh}`.trim(),
        metadata: { phoneme: phoneme.phoneme },
      });
    }

    for (const entry of lexicon) {
      const examples = this.exampleText(entry.examples);
      const collocations = Array.isArray(entry.collocations) ? entry.collocations.join(', ') : '';
      chunks.push({
        sourceType: 'lexicon',
        sourceId: entry.id,
        topicId: null,
        title: `单词 ${entry.word}`,
        content: [
          `${entry.word}${entry.phonetic ? ` ${entry.phonetic}` : ''}`,
          entry.pos ? `词性：${entry.pos}` : '',
          `中文：${entry.meaningZh}`,
          entry.domains.length ? `领域：${entry.domains.join('、')}` : '',
          collocations ? `搭配：${collocations}` : '',
          examples ? `例句：${examples}` : '',
        ].filter(Boolean).join('。'),
        metadata: { word: entry.word, domains: entry.domains, source: 'ecdict' },
      });
    }

    return chunks;
  }

  private unitObjectives(content: Record<string, unknown>): string {
    const objectives = Array.isArray(content.objectives)
      ? content.objectives.filter((item): item is string => typeof item === 'string')
      : [];
    return objectives.length ? `教学目标：${objectives.join('；')}` : '';
  }

  private unitPassage(content: Record<string, unknown>): string {
    const sentences = this.unitSentences(content);
    return sentences.length ? `课文：${sentences.map((sentence) => sentence.en).join(' ')}` : '';
  }

  private unitGrammar(content: Record<string, unknown>): string {
    const grammar = Array.isArray(content.grammarPoints) ? content.grammarPoints : [];
    return grammar
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const point = item as Record<string, unknown>;
        const pattern = typeof point.pattern === 'string' ? point.pattern : '';
        const explanation = typeof point.explanationZh === 'string' ? point.explanationZh : '';
        return [pattern, explanation].filter(Boolean).join('：');
      })
      .filter(Boolean)
      .join('；');
  }

  private unitSentences(content: Record<string, unknown>): Array<{
    id: string;
    en: string;
    zh: string;
    keyWords: string[];
  }> {
    const paragraphs = content.passage && typeof content.passage === 'object'
      ? (content.passage as Record<string, unknown>).paragraphs
      : null;
    if (!Array.isArray(paragraphs)) return [];
    const sentences: Array<{ id: string; en: string; zh: string; keyWords: string[] }> = [];
    for (const paragraph of paragraphs) {
      if (!paragraph || typeof paragraph !== 'object') continue;
      const rows = (paragraph as Record<string, unknown>).sentences;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const sentence = row as Record<string, unknown>;
        if (typeof sentence.en !== 'string' || !sentence.en.trim()) continue;
        sentences.push({
          id: typeof sentence.id === 'string' ? sentence.id : `s${sentences.length + 1}`,
          en: sentence.en.trim(),
          zh: typeof sentence.zh === 'string' ? sentence.zh.trim() : '',
          keyWords: Array.isArray(sentence.keyWords)
            ? sentence.keyWords.filter((word): word is string => typeof word === 'string')
            : [],
        });
      }
    }
    return sentences;
  }

  private exampleText(value: unknown): string {
    if (!Array.isArray(value)) return '';
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const example = item as Record<string, unknown>;
        const en = typeof example.en === 'string' ? example.en : '';
        const zh = typeof example.zh === 'string' ? example.zh : '';
        return [en, zh].filter(Boolean).join(' / ');
      })
      .filter(Boolean)
      .slice(0, 3)
      .join('；');
  }

  private embeddingText(chunk: KnowledgeChunk): string {
    return `${chunk.title}\n${chunk.content}`.slice(0, 6000);
  }

  private contentHash(chunk: KnowledgeChunk): string {
    // 标题、主题与元数据也参与指纹：单元改标题或换主题后，旧块不能继续被召回。
    return createHash('sha256')
      .update([
        chunk.sourceType,
        chunk.sourceId,
        chunk.topicId ?? '',
        chunk.title,
        chunk.content,
        JSON.stringify(chunk.metadata),
      ].join('\n'))
      .digest('hex');
  }

  private hasEmbedding(value: unknown): boolean {
    const vector = this.toVector(value);
    return Boolean(vector && vector.length);
  }

  private toVector(value: unknown): number[] | null {
    if (!Array.isArray(value) || !value.length) return null;
    const vector = value.map((item) => typeof item === 'number' ? item : Number.NaN);
    return vector.every((item) => Number.isFinite(item)) ? vector : null;
  }
}

/** 查询分词：英文按词、中文按 2 字滑窗；不引入第三方分词器。 */
export function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z][a-z'-]{1,}/g) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  const chinese = normalized.replace(/[^\u4e00-\u9fff]/g, '');
  for (let index = 0; index < chinese.length - 1; index += 1) {
    tokens.add(chinese.slice(index, index + 2));
  }
  if (chinese.length === 1) tokens.add(chinese);
  return Array.from(tokens).slice(0, 12);
}

/** 词法得分：完整短语命中优先，其次标题/正文词项覆盖。 */
export function lexicalScore(
  query: string,
  tokens: string[],
  title: string,
  content: string,
): number {
  const haystack = `${title} ${content}`.toLowerCase();
  const needle = query.toLowerCase().trim();
  let score = 0;
  if (needle && haystack.includes(needle)) score += 8;
  const titleLower = title.toLowerCase();
  for (const token of tokens) {
    if (!token) continue;
    if (titleLower.includes(token)) score += 3;
    let index = haystack.indexOf(token);
    let occurrences = 0;
    while (index !== -1 && occurrences < 4) {
      occurrences += 1;
      score += 1;
      index = haystack.indexOf(token, index + token.length);
    }
  }
  return score;
}

/** 余弦相似度；维度不一致或零向量返回 0，不抛错。 */
export function cosineSimilarity(left: number[], right: number[] | null): number {
  if (!right || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
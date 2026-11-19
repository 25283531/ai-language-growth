import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { textbookUnitContentSchema } from '@alg/shared-contracts';
import { ModelRouterImpl } from '@alg/model-router';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PrismaService } from '../prisma/prisma.service';

const proofreadItemSchema = z.object({
  form: z.string().trim().min(1).max(80),
  ipa: z.string().max(80).default(''),
  pos: z.string().max(20).default(''),
});

const proofreadPayloadSchema = z.union([
  z.array(proofreadItemSchema).max(40),
  z.object({ words: z.array(proofreadItemSchema).max(40) }),
]);

export interface ProofreadChange {
  word: string;
  from: string;
  to: string;
}

/**
 * ECDICT 存量音标批量校对。
 *
 * ECDICT 的音标是简化转写（如 nearly → /niәli/、plant 一条里塞两个读音），
 * 不适合直接教孩子。这里用同一个小参数模型按“实际拼写 + 常用教学读音”重注，
 * 写回 lexicon_entries 并打 ipa-proofread 标记，避免重复校对。
 */
@Injectable()
export class LexiconProofreadService {
  private readonly logger = new Logger(LexiconProofreadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly router: ModelRouterImpl,
  ) {}

  async proofread(input: { unitId?: string; limit?: number } = {}): Promise<{
    words: number;
    checked: number;
    updated: number;
    failed: number;
    changes: ProofreadChange[];
  }> {
    const words = await this.collectWords(input.unitId);
    if (!words.length) return { words: 0, checked: 0, updated: 0, failed: 0, changes: [] };
    const rows = await this.prisma.lexicon_entries.findMany({
      where: { word: { in: words } },
      select: { word: true, phonetic: true, pos: true, tags: true },
    });
    const pending = rows
      .filter((row) => !row.tags.includes('ipa-proofread'))
      .slice(0, Math.min(input.limit ?? 120, 200));
    const changes: ProofreadChange[] = [];
    let failed = 0;

    for (let start = 0; start < pending.length; start += 20) {
      const batch = pending.slice(start, start + 20);
      const items = await this.judge(batch.map((row) => row.word));
      if (!items) {
        failed += batch.length;
        continue;
      }
      for (const item of items) {
        const word = item.form.trim().toLowerCase();
        const phonetic = normalizeIpa(item.ipa);
        const row = batch.find((candidate) => candidate.word === word);
        if (!row || !phonetic) continue;
        const partOfSpeech = item.pos.trim().slice(0, 20);
        await this.prisma.lexicon_entries
          .update({
            where: { word },
            data: {
              phonetic,
              ...(partOfSpeech ? { pos: partOfSpeech } : {}),
              tags: { set: [...new Set([...row.tags, 'ipa-proofread'])] },
            },
          })
          .catch((error: unknown) => {
            this.logger.warn(
              `音标校对写入失败 ${word}：${error instanceof Error ? error.message : String(error)}`,
            );
          });
        if (row.phonetic.trim() !== phonetic) {
          changes.push({ word, from: row.phonetic.trim(), to: phonetic });
        }
      }
    }

    this.logger.log(
      `音标批量校对完成：待校对 ${pending.length}，改动 ${changes.length}，失败批次词数 ${failed}`,
    );
    return { words: words.length, checked: pending.length, updated: changes.length, failed, changes };
  }

  private async collectWords(unitId?: string): Promise<string[]> {
    if (!unitId) {
      const tagged = await this.prisma.lexicon_entries.findMany({
        where: { NOT: { textbookUnitIds: { isEmpty: true } } },
        select: { word: true },
        take: 500,
      });
      return tagged.map((row) => row.word.toLowerCase());
    }
    const unit = await this.prisma.curriculum_units.findUnique({
      where: { id: unitId },
      select: { content: true },
    });
    const parsed = unit ? textbookUnitContentSchema.safeParse(unit.content) : null;
    if (!parsed?.success) return [];
    return [...new Set([
      ...parsed.data.vocabulary.map((item) => item.word.trim().toLowerCase()),
      ...parsed.data.passage.paragraphs
        .flatMap((paragraph) => paragraph.sentences)
        .flatMap((sentence) => sentence.en.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []),
    ])].filter((word) => word.length > 0);
  }

  private async judge(words: string[]): Promise<z.infer<typeof proofreadItemSchema>[] | null> {
    const decision = await this.router.route({
      serviceKind: 'llm',
      taskRoute: 'llm.curriculum_unit_enrich',
    });
    const result = await this.gateway
      .smallLlm(
        {
          promptKey: 'curriculum.lexicon_proofread',
          promptVersion: 'v1',
          system: [
            '你是英语发音词典编辑，服务中国小学生。',
            '为每个单词标注英式 IPA：必须有重音符号，schwa 写作 /ə/，长音写 /ː/，只给一个最常用的教学读音。',
            '现有词库音标来自 ECDICT，是简化转写，常有错（nearly 应为 /ˈnɪəli/，plant 名词应为 /plɑːnt/）；请独立判断，不要照抄。',
            '无法确定时 ipa 留空。',
            '只输出 {"words":[{"form":"nearly","ipa":"/ˈnɪəli/","pos":"adv."}]}。',
          ].join(''),
          messages: [{ role: 'user', content: JSON.stringify({ words }) }],
          temperature: 0,
          maxTokens: 1200,
          timeoutMs: 20000,
        },
        decision,
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `音标校对模型调用失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
    if (!result) return null;
    const parsed = proofreadPayloadSchema.safeParse(extractJson(result.content));
    if (!parsed.success) {
      this.logger.warn(`音标校对返回无法解析：${result.content.slice(0, 200)}`);
      return null;
    }
    return Array.isArray(parsed.data) ? parsed.data : parsed.data.words;
  }
}

function normalizeIpa(raw: string): string {
  const inner = raw.trim().replace(/^\/|\/$/g, '').trim();
  if (!inner) return '';
  if (!/^[a-zA-Zəɪʊʌæɑɒɔɜθðʃʒŋɡɹɾʔːˈˌ' .-]+$/.test(inner)) return '';
  return `/${inner}/`;
}

function extractJson(text: string): unknown {
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // 试下一个候选
    }
  }
  return null;
}

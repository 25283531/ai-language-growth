import { z } from 'zod';

/**
 * 全局词库契约。ECDICT 是唯一直接复用的第三方数据源（MIT）；
 * 教材单元词以 textbookUnitIds 标记，查询时优先于普通词频词条命中。
 */
export const lexiconDomains = [
  'self_family',
  'food',
  'animals',
  'school',
  'home',
  'actions',
  'emotions',
  'colors_numbers',
  'weather_time',
  'community_transport',
] as const;

export type LexiconDomain = (typeof lexiconDomains)[number];

export const lexiconEntrySchema = z.object({
  word: z.string().min(1).max(100),
  lemma: z.string().max(100).default(''),
  familyKey: z.string().max(100).default(''),
  familyRank: z.number().int().min(1).max(200000).optional(),
  phonetic: z.string().max(100).default(''),
  pos: z.string().max(40).default(''),
  meaningZh: z.string().max(300).default(''),
  frequencyRank: z.number().int().min(1).max(200000).optional(),
  bncRank: z.number().int().min(1).max(200000).optional(),
  tags: z.array(z.string().max(20)).max(30).default([]),
  domains: z.array(z.enum(lexiconDomains)).max(4).default([]),
  variants: z.array(z.string().max(100)).max(50).default([]),
  collocations: z.array(z.string().max(200)).max(20).default([]),
  examples: z.array(z.object({ en: z.string().max(500), zh: z.string().max(500) })).max(5).default([]),
  source: z.string().max(100).default('ecdict'),
  license: z.string().max(100).default('MIT'),
  childSafe: z.boolean().default(true),
  isCore: z.boolean().default(false),
  isFunctionWord: z.boolean().default(false),
  textbookUnitIds: z.array(z.string().uuid()).max(100).default([]),
});

export type LexiconEntry = z.infer<typeof lexiconEntrySchema>;

export const lexiconDatasetSchema = z.object({
  version: z.number().int().min(1),
  source: z.string(),
  license: z.string(),
  generatedAt: z.string().datetime(),
  totalFamilies: z.number().int().min(1),
  coreFamilies: z.number().int().min(0),
  entries: z.array(lexiconEntrySchema).min(1),
});

export type LexiconDataset = z.infer<typeof lexiconDatasetSchema>;

export type LexiconMatchSource = 'textbook' | 'ecdict';

export type LexiconLookupEntry = LexiconEntry & {
  /** 命中的是教材单元词还是普通词库词；教材词永远优先。 */
  matchSource: LexiconMatchSource;
  /** 实际命中的拼写（可能是 variants 中的屈折形式）。 */
  matchedForm: string;
};

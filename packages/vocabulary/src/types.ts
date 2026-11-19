/**
 * ECDICT CSV 行。字段名保留 ECDICT 原始拼写，便于导入脚本直接消费。
 * 数据来源：https://github.com/skywind3000/ECDICT（MIT）。
 */
export type EcdictRow = {
  word: string;
  phonetic: string;
  definition: string;
  translation: string;
  pos: string;
  collins: string;
  oxford: string;
  tag: string;
  bnc: string;
  frq: string;
  exchange: string;
  detail: string;
  audio: string;
};

export type LexiconDomain =
  | 'self_family'
  | 'food'
  | 'animals'
  | 'school'
  | 'home'
  | 'actions'
  | 'emotions'
  | 'colors_numbers'
  | 'weather_time'
  | 'community_transport';

export type LexiconRecord = {
  word: string;
  lemma: string;
  familyKey: string;
  familyRank: number;
  phonetic: string;
  pos: string;
  meaningZh: string;
  frequencyRank?: number;
  bncRank?: number;
  tags: string[];
  domains: LexiconDomain[];
  variants: string[];
  collocations: string[];
  examples: Array<{ en: string; zh: string }>;
  source: 'ecdict';
  license: 'MIT';
  childSafe: boolean;
  isCore: boolean;
  isFunctionWord: boolean;
  textbookUnitIds: string[];
};

export type LexiconDataset = {
  version: number;
  source: 'ECDICT';
  license: 'MIT';
  generatedAt: string;
  totalFamilies: number;
  coreFamilies: number;
  entries: LexiconRecord[];
};

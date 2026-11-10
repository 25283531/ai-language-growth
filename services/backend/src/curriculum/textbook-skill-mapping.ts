/**
 * 教材单元 → 能力节点映射（纯函数，无 IO、无数据库结构变更）。
 *
 * 背景（任务书第 3 节「教材同步」的核心承诺）：
 *   选定教材单元后，系统应知道「这个单元在练哪些能力」，
 *   教学规划据此把教材进度与能力进度对齐。
 *
 * 此前 `textbook_mappings.skillNodeIds` 恒为空数组（`[] as never[]`），
 * 承诺等于没有落地：映射存在但永远是空的，Planner 拿不到任何信息。
 *
 * 本次实现原则：
 *  1. **不改数据库 schema、不加 migration** —— 复用既有 `skillNodeIds Json` 列。
 *  2. **确定性** —— 只按单元标题/编码/教材标题里的关键词匹配，同输入必得同输出，
 *     不含随机、不含时间、不调用模型（D-008：程序管确定性）。
 *  3. **只能产出能力图谱里真实存在的节点** —— 候选集合直接取自
 *     `M1_SKILL_NODES`，映射规则不可能写出图谱里没有的编码。
 *  4. **双轨都覆盖** —— 语言习得轨（LA.*）与学校英语轨（SE.*）各有规则，
 *     不允许只映射一条轨（D-002）。
 */

import { M1_SKILL_NODES } from '@alg/skill-graph';

/** 图谱里真实存在的节点集合。 */
const KNOWN_SKILL_NODE_IDS: ReadonlySet<string> = new Set(M1_SKILL_NODES.map((node) => node.id));

/**
 * 无关键词命中时的兜底节点。
 *
 * 选 `LA.VOCAB.receptive`（阶段 2 的接受性词汇）而不是更晚的节点：
 * 兜底必须是一个「起点可选、不会被硬前置阻塞」的能力，否则映射一旦兜底
 * 就会连带把该单元的候选活动全部卡在硬前置上。
 */
export const DEFAULT_SKILL_NODE_IDS: readonly string[] = Object.freeze(['LA.VOCAB.receptive']);

/** 一次映射最多产出的节点数，避免把半个图谱塞进一个单元。 */
const MAX_NODES_PER_UNIT = 4;

interface UnitKeywordRule {
  /** 关键词（中英混排）。英文按词边界匹配，中文按子串匹配。 */
  keywords: readonly string[];
  /** 命中后追加的能力节点，按优先级排列。 */
  skillNodeIds: readonly string[];
}

/**
 * 关键词规则表。顺序即优先级：先命中的规则排在前，最多取 MAX_NODES_PER_UNIT 个。
 *
 * 关键词只描述「这个单元在教什么」，不描述「学生学到什么程度」——
 * 掌握程度永远由 learning_evidence 决定，不在这里。
 */
const UNIT_KEYWORD_RULES: readonly UnitKeywordRule[] = [
  {
    keywords: [
      'hello', 'hi', 'greeting', 'greet', 'introduce', 'introduction', 'name', 'morning', 'afternoon',
      '你好', '您好', '打招呼', '问好', '自我介绍', '名字', '早上好', '下午好',
    ],
    skillNodeIds: ['LA.LISTEN.greeting_core', 'LA.SPEAK.imitation', 'LA.COMM.respond'],
  },
  {
    keywords: ['letter', 'letters', 'alphabet', 'abc', '字母', '大小写'],
    skillNodeIds: ['SE.SCHOOL.letters'],
  },
  {
    keywords: ['phonic', 'phonics', '拼读', '自然拼读', '音素', 'letter sound'],
    skillNodeIds: ['SE.SCHOOL.phonics', 'SE.SCHOOL.letters'],
  },
  {
    keywords: ['spell', 'spelling', '拼写', '默写'],
    skillNodeIds: ['SE.SCHOOL.spelling', 'SE.SCHOOL.phonics'],
  },
  {
    keywords: ['read', 'reading', 'story', 'passage', '阅读', '故事', '课文', '绘本'],
    skillNodeIds: ['SE.SCHOOL.reading', 'SE.SCHOOL.word_reading'],
  },
  {
    keywords: ['write', 'writing', 'handwriting', '书写', '写作', '抄写'],
    skillNodeIds: ['SE.SCHOOL.writing', 'SE.SCHOOL.spelling'],
  },
  {
    keywords: ['word', 'words', 'vocabulary', '单词', '词汇', '认读', '识读'],
    skillNodeIds: ['LA.VOCAB.receptive', 'SE.SCHOOL.word_reading'],
  },
  {
    keywords: ['listen', 'listening', 'instruction', '指令', '听力', '听辨'],
    skillNodeIds: ['LA.LISTEN.instruction', 'LA.LISTEN.word_recognition'],
  },
  {
    keywords: ['sentence', 'sentences', 'pattern', '句型', '句子', '句式'],
    skillNodeIds: ['LA.SPEAK.simple_sentences', 'LA.GRAM.basic_pattern'],
  },
  {
    keywords: ['dialogue', 'dialog', 'conversation', 'talk', '对话', '交流', '情景', '交谈'],
    skillNodeIds: ['LA.COMM.dialogue', 'LA.SPEAK.phrases'],
  },
  {
    keywords: ['grammar', '语法'],
    skillNodeIds: ['LA.GRAM.basic_pattern'],
  },
  {
    keywords: ['pronunciation', 'pronounce', 'phoneme', '发音', '音标'],
    skillNodeIds: ['LA.PRON.phonemes', 'LA.PRON.short_vowels'],
  },
  {
    // 常见话题单元：颜色、数字、动物、家庭、食物……词汇与单词表达为主。
    keywords: [
      'colour', 'color', 'number', 'numbers', 'animal', 'animals', 'family', 'food', 'fruit',
      'body', 'toy', 'toys', 'clothes', 'school', 'friend', 'friends', 'pet', 'pets',
      '颜色', '数字', '动物', '家庭', '家人', '食物', '水果', '身体', '玩具', '衣服', '朋友',
    ],
    skillNodeIds: ['LA.VOCAB.receptive', 'LA.SPEAK.single_words'],
  },
];

/** 单个关键词是否出现在文本里。英文按词边界，中文按子串。 */
function containsKeyword(text: string, keyword: string): boolean {
  if (!keyword) return false;
  if (/[\u4e00-\u9fa5]/.test(keyword)) return text.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

export interface TextbookUnitInput {
  /** 单元编码，如 "Unit 3"。 */
  unitCode?: string | null;
  /** 单元标题，如 "Unit 3 Look at me!"。 */
  unitTitle?: string | null;
  /** 教材标题，通常不含单元信息，作为补充上下文。 */
  textbookTitle?: string | null;
  /** 年级/册次，如 "三年级上册"。 */
  grade?: string | null;
}

/**
 * 由教材单元信息推导能力节点列表。
 *
 * 结果只保证「与图谱一致 + 确定性」，不代表任何掌握判定；
 * 学习者真实能力仍只来自 learning_evidence / learner_skill_states。
 */
export function mapTextbookUnitToSkillNodeIds(input: TextbookUnitInput): string[] {
  const text = [input.unitTitle, input.unitCode, input.textbookTitle, input.grade]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .toLowerCase();

  const collected: string[] = [];
  const seen = new Set<string>();
  for (const rule of UNIT_KEYWORD_RULES) {
    if (!rule.keywords.some((keyword) => containsKeyword(text, keyword))) continue;
    for (const skillNodeId of rule.skillNodeIds) {
      if (seen.has(skillNodeId) || !KNOWN_SKILL_NODE_IDS.has(skillNodeId)) continue;
      seen.add(skillNodeId);
      collected.push(skillNodeId);
      if (collected.length >= MAX_NODES_PER_UNIT) return collected;
    }
  }

  return collected.length ? collected : [...DEFAULT_SKILL_NODE_IDS];
}

/**
 * 从数据库 Json 列安全读出能力节点列表。
 *
 * `textbook_mappings.skillNodeIds` 是 Json 列，历史数据可能为空数组、
 * null 或非字符串元素；读取方一律走这个函数，避免把脏数据带进规划逻辑。
 */
export function parseSkillNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const id = item.trim();
    if (!KNOWN_SKILL_NODE_IDS.has(id) || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}

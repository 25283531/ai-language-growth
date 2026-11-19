import type { EcdictRow, LexiconDataset, LexiconDomain, LexiconRecord } from './types';

const WORD_RE = /^[a-z][a-z'-]*$/;
const HAN_RE = /\p{Script=Han}/u;
const POS_PREFIX_RE = /^(n|v|vt|vi|a|ad|adj|adv|prep|conj|pron|art|num|interj|aux|abbr)\.\s*/i;

/** 儿童课程不收录的成人/暴力/歧视词干；命中直接跳过，避免“先入库再靠 UI 隐藏”。 */
const UNSAFE_WORDS = new Set([
  'adult', 'anal', 'anus', 'bastard', 'bitch', 'blowjob', 'boob', 'breast', 'brothel',
  'cocaine', 'condom', 'cunt', 'damn', 'dick', 'drug', 'drunk', 'fuck', 'gamble',
  'gang', 'gun', 'heroin', 'hitler', 'hooker', 'kill', 'lesbian', 'marijuana', 'murder',
  'naked', 'nazi', 'nigger', 'nude', 'orgasm', 'penis', 'porn', 'prostitute', 'rape',
  'rifle', 'sex', 'sexy', 'shit', 'slut', 'suicide', 'terrorist', 'vagina', 'weapon',
  'whore', 'wtf',
]);

/** 中文释义里出现这些词时，删掉该义项；若全部被删则整词不进入核心库。 */
const UNSAFE_ZH = [
  '性交', '色情', '强奸', '裸体', '裸照', '杀人', '谋杀', '自杀', '武器', '枪械', '枪支',
  '毒品', '海洛因', '可卡因', '妓女', '卖淫', '淫秽', '阴茎', '阴道', '肛门', '性行为',
  '恶妇', '坏蛋', '混蛋', '婊子', '屎', '尿', '地狱', '纳粹', '种族歧视',
];

const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'because', 'so', 'than', 'then', 'that',
  'this', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
  'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have',
  'has', 'had', 'will', 'would', 'can', 'could', 'may', 'might', 'must', 'shall',
  'should', 'not', 'no', 'yes', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with',
  'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'here', 'there',
  'when', 'where', 'why', 'how', 'what', 'who', 'which', 'as', 'until', 'while',
]);

/**
 * 小学教材首册就会出现的词，不应被词频排序挤出 5,000 族。
 * 这些词仍保留 ECDICT 的音标/释义，只提升入选优先级。
 */
export const TEXTBOOK_PRIORITY_WORDS = new Set([
  'hello', 'hi', 'goodbye', 'bye', 'please', 'thanks', 'thank', 'sorry', 'yes', 'no', 'okay',
  'morning', 'afternoon', 'evening', 'night', 'today', 'tomorrow', 'yesterday',
  'apple', 'banana', 'orange', 'pear', 'grape', 'watermelon', 'milk', 'water', 'bread',
  'cake', 'candy', 'egg', 'fish', 'rice', 'noodle', 'soup', 'cookie',
  'cat', 'dog', 'bird', 'duck', 'pig', 'cow', 'sheep', 'horse', 'rabbit', 'panda',
  'monkey', 'tiger', 'lion', 'elephant', 'mouse', 'frog', 'zoo',
  'book', 'pen', 'pencil', 'ruler', 'eraser', 'bag', 'desk', 'chair', 'school',
  'classroom', 'teacher', 'student', 'friend', 'boy', 'girl',
  'red', 'blue', 'yellow', 'green', 'black', 'white', 'pink', 'purple', 'brown', 'grey', 'gray',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'mother', 'father', 'mom', 'dad', 'sister', 'brother', 'family', 'baby', 'grandma', 'grandpa',
  'uncle', 'aunt', 'happy', 'sad', 'angry', 'tired', 'hungry', 'thirsty', 'hot', 'cold',
  'big', 'small', 'tall', 'short', 'run', 'jump', 'walk', 'swim', 'sing', 'dance', 'read',
  'write', 'draw', 'play', 'eat', 'drink', 'sleep', 'car', 'bus', 'bike', 'train', 'plane',
  'boat', 'ship', 'taxi', 'road', 'street', 'park', 'rain', 'sun', 'snow', 'wind', 'cloud',
  'sunny', 'rainy', 'windy', 'cloudy', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'this', 'that', 'these', 'those', 'here', 'there', 'what', 'who', 'where', 'when', 'why', 'how',
]);

const DOMAIN_WORDS: Record<LexiconDomain, string[]> = {
  self_family: [
    'baby', 'boy', 'brother', 'dad', 'daddy', 'family', 'father', 'friend', 'girl',
    'grandfather', 'grandmother', 'man', 'mom', 'mommy', 'mother', 'name', 'parent',
    'sister', 'son', 'daughter', 'woman', 'child', 'children', 'people', 'person',
  ],
  food: [
    'apple', 'banana', 'bread', 'breakfast', 'cake', 'candy', 'carrot', 'cheese',
    'chicken', 'coffee', 'cookie', 'dinner', 'drink', 'egg', 'fish', 'food', 'fruit',
    'grape', 'hungry', 'ice', 'juice', 'lunch', 'milk', 'noodle', 'orange', 'rice',
    'salad', 'soup', 'strawberry', 'sugar', 'tea', 'tomato', 'vegetable', 'water',
  ],
  animals: [
    'animal', 'bear', 'bee', 'bird', 'butterfly', 'cat', 'cow', 'dog', 'duck',
    'elephant', 'fish', 'frog', 'giraffe', 'goat', 'horse', 'lion', 'monkey',
    'mouse', 'panda', 'pig', 'rabbit', 'sheep', 'snake', 'tiger', 'turtle', 'zoo',
  ],
  school: [
    'book', 'class', 'classroom', 'crayon', 'desk', 'eraser', 'homework', 'learn',
    'lesson', 'pen', 'pencil', 'read', 'ruler', 'school', 'student', 'study',
    'teacher', 'write', 'bag', 'chair',
  ],
  home: [
    'bed', 'bathroom', 'chair', 'clean', 'cup', 'door', 'house', 'home', 'kitchen',
    'lamp', 'room', 'sofa', 'spoon', 'table', 'television', 'toy', 'window',
  ],
  actions: [
    'bring', 'buy', 'catch', 'clean', 'climb', 'close', 'come', 'cook', 'cry', 'cut',
    'dance', 'draw', 'drink', 'drive', 'eat', 'fall', 'fly', 'get', 'give', 'go',
    'help', 'jump', 'listen', 'look', 'make', 'open', 'play', 'put', 'read', 'run',
    'say', 'see', 'sing', 'sit', 'sleep', 'smile', 'stand', 'swim', 'take', 'talk',
    'throw', 'walk', 'wash', 'watch', 'write',
  ],
  emotions: [
    'afraid', 'angry', 'bored', 'brave', 'calm', 'careful', 'excited', 'glad',
    'happy', 'kind', 'lonely', 'love', 'mad', 'nice', 'proud', 'sad', 'scared',
    'shy', 'sorry', 'surprised', 'tired', 'worry',
  ],
  colors_numbers: [
    'black', 'blue', 'brown', 'color', 'eight', 'five', 'four', 'green', 'grey',
    'nine', 'number', 'one', 'orange', 'pink', 'purple', 'red', 'seven', 'six',
    'ten', 'three', 'two', 'white', 'yellow', 'zero',
  ],
  weather_time: [
    'afternoon', 'autumn', 'cloud', 'cloudy', 'cold', 'day', 'evening', 'hot',
    'morning', 'night', 'rain', 'rainy', 'season', 'snow', 'spring', 'summer',
    'sun', 'sunny', 'today', 'tomorrow', 'weather', 'wind', 'windy', 'winter', 'year',
  ],
  community_transport: [
    'airport', 'bank', 'bike', 'boat', 'bus', 'car', 'doctor', 'hospital', 'hotel',
    'library', 'market', 'nurse', 'park', 'police', 'restaurant', 'road', 'shop',
    'station', 'store', 'street', 'taxi', 'train', 'truck', 'zoo',
  ],
};

const DOMAIN_ZH: Record<LexiconDomain, string[]> = {
  self_family: ['家庭', '爸爸', '妈妈', '父亲', '母亲', '兄弟', '姐妹', '孩子', '男孩', '女孩', '朋友', '名字', '人'],
  food: ['食物', '吃', '喝', '苹果', '香蕉', '面包', '牛奶', '水', '米饭', '蛋', '鱼', '肉', '水果', '蔬菜', '果汁', '蛋糕'],
  animals: ['动物', '猫', '狗', '鸟', '鱼', '猪', '牛', '羊', '马', '兔', '象', '猴', '虎', '狮', '熊猫', '长颈鹿'],
  school: ['学校', '老师', '学生', '书', '笔', '铅笔', '书包', '课', '学习', '读', '写', '教室'],
  home: ['家', '房子', '床', '桌', '椅', '门', '窗', '房间', '厨房', '客厅'],
  actions: ['跑', '跳', '走', '吃', '喝', '看', '听', '说', '读', '写', '玩', '睡', '洗', '打开', '关'],
  emotions: ['高兴', '快乐', '伤心', '难过', '生气', '害怕', '累', '爱', '喜欢', '惊讶'],
  colors_numbers: ['颜色', '红', '蓝', '黄', '绿', '白', '黑', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '数'],
  weather_time: ['天气', '雨', '雪', '风', '晴', '云', '热', '冷', '早上', '下午', '晚上', '今天', '明天', '春', '夏', '秋', '冬'],
  community_transport: ['公共汽车', '汽车', '火车', '飞机', '船', '自行车', '医院', '医生', '商店', '公园', '车站', '机场', '路', '街'],
};

type Candidate = {
  word: string;
  originalWord: string;
  phonetic: string;
  pos: string;
  meaningZh: string;
  frequencyRank?: number;
  bncRank?: number;
  rank: number;
  tags: string[];
  forms: string[];
  isFunctionWord: boolean;
};

export type BuildLexiconOptions = {
  maxFamilies?: number;
  coreFamilies?: number;
  candidatePool?: number;
  generatedAt?: string;
};

export function buildLexiconFromRows(rows: EcdictRow[], options: BuildLexiconOptions = {}): LexiconDataset {
  const maxFamilies = options.maxFamilies ?? 5000;
  const coreFamilies = Math.min(options.coreFamilies ?? 3000, maxFamilies);
  const candidatePool = options.candidatePool ?? Math.max(12000, maxFamilies * 2);

  const byWord = new Map<string, Candidate>();
  for (const row of rows) {
    const candidate = toCandidate(row);
    if (!candidate) continue;
    const existing = byWord.get(candidate.word);
    if (!existing || candidate.rank < existing.rank) byWord.set(candidate.word, candidate);
  }

  const candidates = [...byWord.values()].sort(compareCandidates).slice(0, candidatePool);
  const families = groupFamilies(candidates);
  families.sort((left, right) => left.rank - right.rank);

  const selected = families.slice(0, maxFamilies);
  const entries: LexiconRecord[] = selected.map((family, index) => {
    const representative = family.members[0]!;
    const phonetic = representative.phonetic || family.members.find((member) => member.phonetic)?.phonetic || '';
    return {
      word: representative.word,
      lemma: representative.word,
      familyKey: representative.word,
      familyRank: index + 1,
      phonetic,
      pos: representative.pos,
      meaningZh: representative.meaningZh,
      ...(representative.frequencyRank ? { frequencyRank: representative.frequencyRank } : {}),
      ...(representative.bncRank ? { bncRank: representative.bncRank } : {}),
      tags: representative.tags,
      domains: detectDomains(representative.word, representative.meaningZh),
      variants: family.forms.filter((form) => form !== representative.word).slice(0, 50),
      collocations: [],
      examples: [],
      source: 'ecdict',
      license: 'MIT',
      childSafe: true,
      isCore: index < coreFamilies,
      isFunctionWord: representative.isFunctionWord,
      textbookUnitIds: [],
    };
  });

  return {
    version: 1,
    source: 'ECDICT',
    license: 'MIT',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    totalFamilies: entries.length,
    coreFamilies: Math.min(coreFamilies, entries.length),
    entries,
  };
}

export function toCandidate(row: EcdictRow): Candidate | null {
  const originalWord = (row.word || '').trim();
  const word = originalWord.toLowerCase();
  if (!word || !WORD_RE.test(word) || word.length > 40) return null;
  if (originalWord !== originalWord.toLowerCase() && word !== 'i') return null;
  if (UNSAFE_WORDS.has(word)) return null;

  const frequencyRank = positiveInt(row.frq);
  const bncRank = positiveInt(row.bnc);
  const priority = TEXTBOOK_PRIORITY_WORDS.has(word);
  if (!frequencyRank && !bncRank && !priority) return null;

  const meaningZh = cleanMeaningZh(row.translation);
  if (!meaningZh) return null;

  const pos = extractPos(row.pos, row.translation);

  const tags = parseTags(row.tag);
  return {
    word,
    originalWord,
    phonetic: normalizePhonetic(row.phonetic),
    pos,
    meaningZh,
    ...(frequencyRank ? { frequencyRank } : {}),
    ...(bncRank ? { bncRank } : {}),
    rank: priority ? 1 : (frequencyRank ?? 100000 + (bncRank ?? 0)),
    tags,
    forms: parseForms(word, row.exchange),
    isFunctionWord: isFunctionWord(word, pos, tags),
  };
}

export function cleanMeaningZh(translation: string): string {
  const normalized = (translation || '').replace(/\\r\\n|\\n|\\r/g, '\n');
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('[')) continue;
    if (/\[计\]|计算机|网络用语/.test(line)) continue;
    const body = line.replace(POS_PREFIX_RE, '').replace(/\[[^\]]*\]/g, '').trim();
    if (!HAN_RE.test(body)) continue;
    const senses = body
      .split(/[,，;；]/)
      .map((sense) => sense.trim())
      .filter((sense) => sense && HAN_RE.test(sense))
      .filter((sense) => !UNSAFE_ZH.some((word) => sense.includes(word)));
    if (!senses.length) continue;
    const value = [...new Set(senses)].slice(0, 2).join('；');
    if (value.length > 300) continue;
    return value;
  }
  return '';
}

export function normalizePhonetic(value: string): string {
  const cleaned = (value || '')
    .trim()
    .replace(/^["'\[]+|["'\]]+$/g, '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  return cleaned ? `/${cleaned}/` : '';
}

export function extractPos(pos: string, translation: string): string {
  const direct = (pos || '').trim();
  if (direct) return direct.slice(0, 40);
  const first = (translation || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const match = first.match(POS_PREFIX_RE);
  return match ? `${match[1]!.toLowerCase()}.` : '';
}

export function parseTags(value: string): string[] {
  return [...new Set((value || '').split(/\s+/).map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
    .filter((tag) => /^[a-z0-9_-]{1,20}$/.test(tag))
    .slice(0, 30);
}

export function parseForms(word: string, exchange: string): string[] {
  const forms = new Set<string>([word]);
  // ECDICT 的 exchange 同时包含 0/1 等词形元数据；只取真正的屈折形式，
  // 否则大量动词会通过 1:ing / 1:d 之类的标记被错误合并成一个巨型词族。
  const allowedKeys = new Set(['p', 'd', 'i', '3', 's', 'r', 't']);
  for (const part of (exchange || '').split('/')) {
    const separator = part.indexOf(':');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    if (!allowedKeys.has(key)) continue;
    const values = part.slice(separator + 1);
    for (const value of values.split(/[,;]/)) {
      const form = value.trim().toLowerCase();
      if (!WORD_RE.test(form) || form.length > 40) continue;
      if (form.length === 1 && form !== 'a' && form !== 'i') continue;
      forms.add(form);
    }
  }
  return [...forms];
}

export function isFunctionWord(word: string, pos: string, tags: string[]): boolean {
  if (FUNCTION_WORDS.has(word)) return true;
  if (/^(pron|prep|conj|art|aux|det)\.?$/i.test(pos.replace(/\.$/, ''))) return true;
  return tags.includes('function_word');
}

export function detectDomains(word: string, meaningZh: string): LexiconDomain[] {
  const domains: LexiconDomain[] = [];
  for (const [domain, words] of Object.entries(DOMAIN_WORDS) as Array<[LexiconDomain, string[]]>) {
    if (words.includes(word) || DOMAIN_ZH[domain].some((keyword) => meaningZh.includes(keyword))) {
      domains.push(domain);
    }
    if (domains.length >= 4) break;
  }
  return domains;
}

function groupFamilies(candidates: Candidate[]): Array<{ rank: number; members: Candidate[]; forms: string[] }> {
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const ownerByForm = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    for (const form of candidate.forms) {
      const owner = ownerByForm.get(form);
      if (owner === undefined) ownerByForm.set(form, index);
      else union(owner, index);
    }
  });

  const groups = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  });

  return [...groups.values()].map((indices) => {
    const members = indices.map((index) => candidates[index]!).sort(compareCandidates);
    const forms = [...new Set(members.flatMap((member) => member.forms))].sort();
    return { rank: members[0]!.rank, members, forms };
  });
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.rank - right.rank || left.word.localeCompare(right.word);
}

function positiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value || '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

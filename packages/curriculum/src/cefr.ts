/**
 * CEFR 课程 JSON 生成器（纯函数，不访问数据库、不调用模型）。
 *
 * 设计目标：
 * 1. 输入一份教材单词表，即可生成完整、可审核、可发布的结构化课程；
 * 2. 先只生成 JSON（词汇、句型、活动、评估规则、媒体需求），不生成图片/音频；
 * 3. 图片和语音在“到达对应级别”后由服务端预热，避免一次性产生不可控费用。
 *
 * 这里刻意不使用 LLM：模板保证结构稳定、可复现；需要更自然的例句/释义时，
 * 由后端 `CurriculumGeneratorService` 再做一次可选的 AI 润色，失败则保留本结果。
 */
import type {
  CefrCurriculumLevel,
  CefrCurriculumPackage,
  CefrLesson,
  CefrUnit,
  CefrVocabularyEntry,
} from '@alg/shared-contracts';

export const CEFR_LEVEL_NAMES: Record<CefrCurriculumLevel, string> = {
  'pre-A1': '语感启蒙',
  A1: '基础生存',
  A2: '日常拓展',
  B1: '独立表达',
  B2: '流畅讨论',
  C1: '深度表达',
  C2: '接近母语',
};

export const CEFR_CAN_DO: Record<CefrCurriculumLevel, string[]> = {
  'pre-A1': ['听懂高频问候和指令', '能模仿单词和短句', '建立声音与图片的联系'],
  A1: ['能介绍自己与身边的人', '能说出常见物品和颜色', '能进行简单问答'],
  A2: ['能描述日常活动', '能表达喜好与需求', '能处理购物、出行等熟悉场景'],
  B1: ['能讲述简单经历', '能说明理由和计划', '能应对大多数旅行场景'],
  B2: ['能就熟悉话题展开讨论', '能理解主要观点', '能写出结构清晰的短文'],
  C1: ['能灵活表达复杂观点', '能理解隐含态度', '能进行较长的自主表达'],
  C2: ['能精确区分语义和语气', '能理解高难度文本', '能自然、准确地表达复杂思想'],
};

/** 预置词库：每个级别 25 个核心词，按每单元 6 词生成约 5 个单元。 */
export const CEFR_PRESET_WORDS: Record<CefrCurriculumLevel, string[]> = {
  'pre-A1': [
    'hello', 'hi', 'bye', 'yes', 'no', 'please', 'sorry', 'thanks', 'name', 'boy',
    'girl', 'mom', 'dad', 'apple', 'ball', 'cat', 'dog', 'red', 'blue', 'one',
    'two', 'three', 'big', 'small', 'happy',
  ],
  A1: [
    'family', 'friend', 'teacher', 'school', 'book', 'bag', 'pencil', 'chair', 'table', 'water',
    'milk', 'bread', 'egg', 'banana', 'morning', 'afternoon', 'evening', 'today', 'play', 'run',
    'jump', 'read', 'write', 'like', 'want',
  ],
  A2: [
    'weekend', 'holiday', 'birthday', 'present', 'picnic', 'museum', 'library', 'hospital', 'station', 'ticket',
    'travel', 'bicycle', 'bus', 'train', 'map', 'weather', 'sunny', 'rainy', 'cold', 'hot',
    'because', 'before', 'after', 'always', 'sometimes',
  ],
  B1: [
    'experience', 'advice', 'decision', 'opportunity', 'environment', 'pollution', 'recycle', 'energy', 'culture', 'tradition',
    'festival', 'celebrate', 'communicate', 'improve', 'practice', 'prepare', 'discuss', 'explain', 'suggest', 'agree',
    'possible', 'necessary', 'although', 'however', 'instead',
  ],
  B2: [
    'achieve', 'challenge', 'consider', 'contribute', 'convince', 'determine', 'establish', 'evaluate', 'evidence', 'influence',
    'maintain', 'participate', 'perspective', 'principle', 'relevant', 'resource', 'respond', 'significant', 'strategy', 'structure',
    'assume', 'consequence', 'critical', 'diverse', 'efficient',
  ],
  C1: [
    'acknowledge', 'advocate', 'allocate', 'ambiguous', 'coherent', 'comprehensive', 'contradict', 'controversial', 'crucial', 'demonstrate',
    'derive', 'distinguish', 'elaborate', 'empirical', 'enhance', 'explicit', 'facilitate', 'framework', 'hypothesis', 'integrate',
    'interpret', 'justify', 'legitimate', 'perceive', 'pursue',
  ],
  C2: [
    'aesthetic', 'arbitrary', 'compelling', 'concise', 'contemplate', 'conventional', 'cumulative', 'deteriorate', 'dilemma', 'discern',
    'disparate', 'elusive', 'exemplify', 'feasible', 'fluctuate', 'hierarchy', 'inevitable', 'infer', 'intricate', 'intrinsic',
    'nuanced', 'obsolete', 'paradox', 'plausible', 'sophisticated',
  ],
};

const LEXICON: Record<string, { zh: string; phonetic?: string }> = {
  hello: { zh: '你好', phonetic: '/həˈloʊ/' },
  hi: { zh: '嗨，你好', phonetic: '/haɪ/' },
  bye: { zh: '再见', phonetic: '/baɪ/' },
  yes: { zh: '是；好的', phonetic: '/jes/' },
  no: { zh: '不；不是', phonetic: '/noʊ/' },
  please: { zh: '请', phonetic: '/pliːz/' },
  sorry: { zh: '对不起', phonetic: '/ˈsɒri/' },
  thanks: { zh: '谢谢', phonetic: '/θæŋks/' },
  name: { zh: '名字', phonetic: '/neɪm/' },
  boy: { zh: '男孩', phonetic: '/bɔɪ/' },
  girl: { zh: '女孩', phonetic: '/ɡɜːrl/' },
  mom: { zh: '妈妈', phonetic: '/mɑːm/' },
  dad: { zh: '爸爸', phonetic: '/dæd/' },
  apple: { zh: '苹果', phonetic: '/ˈæpəl/' },
  ball: { zh: '球', phonetic: '/bɔːl/' },
  cat: { zh: '猫', phonetic: '/kæt/' },
  dog: { zh: '狗', phonetic: '/dɔːɡ/' },
  red: { zh: '红色', phonetic: '/red/' },
  blue: { zh: '蓝色', phonetic: '/bluː/' },
  one: { zh: '一', phonetic: '/wʌn/' },
  two: { zh: '二', phonetic: '/tuː/' },
  three: { zh: '三', phonetic: '/θriː/' },
  big: { zh: '大的', phonetic: '/bɪɡ/' },
  small: { zh: '小的', phonetic: '/smɔːl/' },
  happy: { zh: '开心的', phonetic: '/ˈhæpi/' },
  family: { zh: '家庭', phonetic: '/ˈfæməli/' },
  friend: { zh: '朋友', phonetic: '/frend/' },
  teacher: { zh: '老师', phonetic: '/ˈtiːtʃər/' },
  school: { zh: '学校', phonetic: '/skuːl/' },
  book: { zh: '书', phonetic: '/bʊk/' },
  bag: { zh: '包', phonetic: '/bæɡ/' },
  pencil: { zh: '铅笔', phonetic: '/ˈpensəl/' },
  chair: { zh: '椅子', phonetic: '/tʃer/' },
  table: { zh: '桌子', phonetic: '/ˈteɪbəl/' },
  water: { zh: '水', phonetic: '/ˈwɔːtər/' },
  milk: { zh: '牛奶', phonetic: '/mɪlk/' },
  bread: { zh: '面包', phonetic: '/bred/' },
  egg: { zh: '鸡蛋', phonetic: '/eɡ/' },
  banana: { zh: '香蕉', phonetic: '/bəˈnænə/' },
  morning: { zh: '早上', phonetic: '/ˈmɔːrnɪŋ/' },
  afternoon: { zh: '下午', phonetic: '/ˌæftərˈnuːn/' },
  evening: { zh: '晚上', phonetic: '/ˈiːvnɪŋ/' },
  today: { zh: '今天', phonetic: '/təˈdeɪ/' },
  play: { zh: '玩；玩耍', phonetic: '/pleɪ/' },
  run: { zh: '跑', phonetic: '/rʌn/' },
  jump: { zh: '跳', phonetic: '/dʒʌmp/' },
  read: { zh: '读', phonetic: '/riːd/' },
  write: { zh: '写', phonetic: '/raɪt/' },
  like: { zh: '喜欢', phonetic: '/laɪk/' },
  want: { zh: '想要', phonetic: '/wɑːnt/' },
  weekend: { zh: '周末', phonetic: '/ˈwiːkend/' },
  holiday: { zh: '假期', phonetic: '/ˈhɑːlədeɪ/' },
  birthday: { zh: '生日', phonetic: '/ˈbɜːrθdeɪ/' },
  present: { zh: '礼物', phonetic: '/ˈprezənt/' },
  picnic: { zh: '野餐', phonetic: '/ˈpɪknɪk/' },
  museum: { zh: '博物馆', phonetic: '/mjuˈziːəm/' },
  library: { zh: '图书馆', phonetic: '/ˈlaɪbreri/' },
  hospital: { zh: '医院', phonetic: '/ˈhɑːspɪtəl/' },
  station: { zh: '车站', phonetic: '/ˈsteɪʃən/' },
  ticket: { zh: '票', phonetic: '/ˈtɪkɪt/' },
  travel: { zh: '旅行', phonetic: '/ˈtrævəl/' },
  bicycle: { zh: '自行车', phonetic: '/ˈbaɪsɪkəl/' },
  bus: { zh: '公共汽车', phonetic: '/bʌs/' },
  train: { zh: '火车', phonetic: '/treɪn/' },
  map: { zh: '地图', phonetic: '/mæp/' },
  weather: { zh: '天气', phonetic: '/ˈweðər/' },
  sunny: { zh: '晴朗的', phonetic: '/ˈsʌni/' },
  rainy: { zh: '下雨的', phonetic: '/ˈreɪni/' },
  cold: { zh: '寒冷的', phonetic: '/koʊld/' },
  hot: { zh: '炎热的', phonetic: '/hɑːt/' },
  because: { zh: '因为', phonetic: '/bɪˈkɔːz/' },
  before: { zh: '在……之前', phonetic: '/bɪˈfɔːr/' },
  after: { zh: '在……之后', phonetic: '/ˈæftər/' },
  always: { zh: '总是', phonetic: '/ˈɔːlweɪz/' },
  sometimes: { zh: '有时', phonetic: '/ˈsʌmtaɪmz/' },
  experience: { zh: '经历；经验', phonetic: '/ɪkˈspɪriəns/' },
  advice: { zh: '建议', phonetic: '/ədˈvaɪs/' },
  decision: { zh: '决定', phonetic: '/dɪˈsɪʒən/' },
  opportunity: { zh: '机会', phonetic: '/ˌɑːpərˈtuːnəti/' },
  environment: { zh: '环境', phonetic: '/ɪnˈvaɪrənmənt/' },
  pollution: { zh: '污染', phonetic: '/pəˈluːʃən/' },
  recycle: { zh: '回收利用', phonetic: '/ˌriːˈsaɪkəl/' },
  energy: { zh: '能源；精力', phonetic: '/ˈenərdʒi/' },
  culture: { zh: '文化', phonetic: '/ˈkʌltʃər/' },
  tradition: { zh: '传统', phonetic: '/trəˈdɪʃən/' },
  festival: { zh: '节日', phonetic: '/ˈfestɪvəl/' },
  celebrate: { zh: '庆祝', phonetic: '/ˈselɪbreɪt/' },
  communicate: { zh: '交流', phonetic: '/kəˈmjuːnɪkeɪt/' },
  improve: { zh: '改善', phonetic: '/ɪmˈpruːv/' },
  practice: { zh: '练习', phonetic: '/ˈpræktɪs/' },
  prepare: { zh: '准备', phonetic: '/prɪˈper/' },
  discuss: { zh: '讨论', phonetic: '/dɪˈskʌs/' },
  explain: { zh: '解释', phonetic: '/ɪkˈspleɪn/' },
  suggest: { zh: '建议', phonetic: '/səɡˈdʒest/' },
  agree: { zh: '同意', phonetic: '/əˈɡriː/' },
  possible: { zh: '可能的', phonetic: '/ˈpɑːsəbəl/' },
  necessary: { zh: '必要的', phonetic: '/ˈnesəseri/' },
  although: { zh: '虽然', phonetic: '/ɔːlˈðoʊ/' },
  however: { zh: '然而', phonetic: '/haʊˈevər/' },
  instead: { zh: '代替；反而', phonetic: '/ɪnˈsted/' },
  achieve: { zh: '实现；达到', phonetic: '/əˈtʃiːv/' },
  challenge: { zh: '挑战', phonetic: '/ˈtʃælɪndʒ/' },
  consider: { zh: '考虑', phonetic: '/kənˈsɪdər/' },
  contribute: { zh: '贡献', phonetic: '/kənˈtrɪbjuːt/' },
  convince: { zh: '说服', phonetic: '/kənˈvɪns/' },
  determine: { zh: '决定；确定', phonetic: '/dɪˈtɜːrmɪn/' },
  establish: { zh: '建立', phonetic: '/ɪˈstæblɪʃ/' },
  evaluate: { zh: '评估', phonetic: '/ɪˈvæljueɪt/' },
  evidence: { zh: '证据', phonetic: '/ˈevɪdəns/' },
  influence: { zh: '影响', phonetic: '/ˈɪnfluəns/' },
  maintain: { zh: '维持', phonetic: '/meɪnˈteɪn/' },
  participate: { zh: '参与', phonetic: '/pɑːrˈtɪsɪpeɪt/' },
  perspective: { zh: '视角', phonetic: '/pərˈspektɪv/' },
  principle: { zh: '原则', phonetic: '/ˈprɪnsəpəl/' },
  relevant: { zh: '相关的', phonetic: '/ˈreləvənt/' },
  resource: { zh: '资源', phonetic: '/ˈriːsɔːrs/' },
  respond: { zh: '回应', phonetic: '/rɪˈspɑːnd/' },
  significant: { zh: '重要的；显著的', phonetic: '/sɪɡˈnɪfɪkənt/' },
  strategy: { zh: '策略', phonetic: '/ˈstrætədʒi/' },
  structure: { zh: '结构', phonetic: '/ˈstrʌktʃər/' },
  assume: { zh: '假定', phonetic: '/əˈsuːm/' },
  consequence: { zh: '后果', phonetic: '/ˈkɑːnsəkwens/' },
  critical: { zh: '批判性的；关键的', phonetic: '/ˈkrɪtɪkəl/' },
  diverse: { zh: '多样的', phonetic: '/daɪˈvɜːrs/' },
  efficient: { zh: '高效的', phonetic: '/ɪˈfɪʃənt/' },
  acknowledge: { zh: '承认', phonetic: '/əkˈnɑːlɪdʒ/' },
  advocate: { zh: '提倡', phonetic: '/ˈædvəkeɪt/' },
  allocate: { zh: '分配', phonetic: '/ˈæləkeɪt/' },
  ambiguous: { zh: '模糊的', phonetic: '/æmˈbɪɡjuəs/' },
  coherent: { zh: '连贯的', phonetic: '/koʊˈhɪrənt/' },
  comprehensive: { zh: '全面的', phonetic: '/ˌkɑːmprɪˈhensɪv/' },
  contradict: { zh: '反驳；矛盾', phonetic: '/ˌkɑːntrəˈdɪkt/' },
  controversial: { zh: '有争议的', phonetic: '/ˌkɑːntrəˈvɜːrʃəl/' },
  crucial: { zh: '关键的', phonetic: '/ˈkruːʃəl/' },
  demonstrate: { zh: '证明；展示', phonetic: '/ˈdemənstreɪt/' },
  derive: { zh: '推导；源于', phonetic: '/dɪˈraɪv/' },
  distinguish: { zh: '区分', phonetic: '/dɪˈstɪŋɡwɪʃ/' },
  elaborate: { zh: '详述；精心制作的', phonetic: '/ɪˈlæbəreɪt/' },
  empirical: { zh: '经验的；实证的', phonetic: '/ɪmˈpɪrɪkəl/' },
  enhance: { zh: '增强', phonetic: '/ɪnˈhæns/' },
  explicit: { zh: '明确的', phonetic: '/ɪkˈsplɪsɪt/' },
  facilitate: { zh: '促进；使便利', phonetic: '/fəˈsɪlɪteɪt/' },
  framework: { zh: '框架', phonetic: '/ˈfreɪmwɜːrk/' },
  hypothesis: { zh: '假设', phonetic: '/haɪˈpɑːθəsɪs/' },
  integrate: { zh: '整合', phonetic: '/ˈɪntɪɡreɪt/' },
  interpret: { zh: '解释；口译', phonetic: '/ɪnˈtɜːrprɪt/' },
  justify: { zh: '证明……正当', phonetic: '/ˈdʒʌstɪfaɪ/' },
  legitimate: { zh: '合法的；合理的', phonetic: '/lɪˈdʒɪtɪmət/' },
  perceive: { zh: '察觉；理解', phonetic: '/pərˈsiːv/' },
  pursue: { zh: '追求', phonetic: '/pərˈsuː/' },
  aesthetic: { zh: '审美的', phonetic: '/esˈθetɪk/' },
  arbitrary: { zh: '任意的', phonetic: '/ˈɑːrbɪtreri/' },
  compelling: { zh: '令人信服的', phonetic: '/kəmˈpelɪŋ/' },
  concise: { zh: '简洁的', phonetic: '/kənˈsaɪs/' },
  contemplate: { zh: '沉思', phonetic: '/ˈkɑːntəmpleɪt/' },
  conventional: { zh: '传统的', phonetic: '/kənˈvenʃənəl/' },
  cumulative: { zh: '累积的', phonetic: '/ˈkjuːmjələtɪv/' },
  deteriorate: { zh: '恶化', phonetic: '/dɪˈtɪriəreɪt/' },
  dilemma: { zh: '两难困境', phonetic: '/dɪˈlemə/' },
  discern: { zh: '辨别', phonetic: '/dɪˈsɜːrn/' },
  disparate: { zh: '迥然不同的', phonetic: '/ˈdɪspərət/' },
  elusive: { zh: '难以捉摸的', phonetic: '/iˈluːsɪv/' },
  exemplify: { zh: '作为例证', phonetic: '/ɪɡˈzemplɪfaɪ/' },
  feasible: { zh: '可行的', phonetic: '/ˈfiːzəbəl/' },
  fluctuate: { zh: '波动', phonetic: '/ˈflʌktʃueɪt/' },
  hierarchy: { zh: '等级制度', phonetic: '/ˈhaɪərɑːrki/' },
  inevitable: { zh: '不可避免的', phonetic: '/ɪnˈevɪtəbəl/' },
  infer: { zh: '推断', phonetic: '/ɪnˈfɜːr/' },
  intricate: { zh: '错综复杂的', phonetic: '/ˈɪntrɪkət/' },
  intrinsic: { zh: '内在的', phonetic: '/ɪnˈtrɪnzɪk/' },
  nuanced: { zh: '细微差别的', phonetic: '/ˈnuːɑːnst/' },
  obsolete: { zh: '过时的', phonetic: '/ˌɑːbsəˈliːt/' },
  paradox: { zh: '悖论', phonetic: '/ˈpærədɑːks/' },
  plausible: { zh: '看似合理的', phonetic: '/ˈplɔːzəbəl/' },
  sophisticated: { zh: '复杂精密的；老练的', phonetic: '/səˈfɪstɪkeɪtɪd/' },
};

const GREETINGS = new Set(['hello', 'hi', 'bye', 'yes', 'no', 'please', 'sorry', 'thanks', 'name']);
const VERBS = new Set([
  'play', 'run', 'jump', 'read', 'write', 'like', 'want', 'travel', 'celebrate', 'communicate',
  'improve', 'practice', 'prepare', 'discuss', 'explain', 'suggest', 'agree', 'achieve', 'consider',
  'contribute', 'convince', 'determine', 'establish', 'evaluate', 'maintain', 'participate', 'respond',
  'assume', 'acknowledge', 'advocate', 'allocate', 'contradict', 'demonstrate', 'derive', 'distinguish',
  'elaborate', 'enhance', 'facilitate', 'integrate', 'interpret', 'justify', 'perceive', 'pursue',
  'contemplate', 'deteriorate', 'discern', 'exemplify', 'fluctuate', 'infer', 'recycle',
]);
const ADJECTIVES = new Set([
  'red', 'blue', 'big', 'small', 'happy', 'sunny', 'rainy', 'cold', 'hot', 'possible', 'necessary',
  'relevant', 'significant', 'critical', 'diverse', 'efficient', 'ambiguous', 'coherent', 'comprehensive',
  'controversial', 'crucial', 'empirical', 'explicit', 'legitimate', 'aesthetic', 'arbitrary', 'compelling',
  'concise', 'conventional', 'cumulative', 'elusive', 'feasible', 'inevitable', 'intricate', 'intrinsic',
  'nuanced', 'obsolete', 'plausible', 'sophisticated',
]);

export function normalizeCefrLevel(input: string): CefrCurriculumLevel {
  const value = input.trim().toLowerCase().replace(/[\s_]/g, '-');
  if (value === 'pre-a' || value === 'prea1' || value === 'pre-a1') return 'pre-A1';
  if (value === 'a' || value === 'a1') return 'A1';
  if (value === 'a2') return 'A2';
  if (value === 'b' || value === 'b1') return 'B1';
  if (value === 'b2') return 'B2';
  if (value === 'c' || value === 'c1') return 'C1';
  if (value === 'c2') return 'C2';
  throw new Error(`不支持的 CEFR 等级：${input}`);
}

export function normalizeWordList(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split(/[\r\n,，;；]+/);
  const seen = new Set<string>();
  const words: string[] = [];
  for (const item of raw) {
    const word = item.trim().replace(/^\d+[.)、]\s*/, '').replace(/^[-*]\s*/, '');
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words.slice(0, 500);
}

export function buildCefrCurriculum(input: {
  title: string;
  level: string;
  words: string | string[];
  source?: 'preset' | 'textbook' | 'package';
  packageId?: string;
  unitSize?: number;
  generatedAt?: string;
}): CefrCurriculumPackage {
  const level = normalizeCefrLevel(input.level);
  const words = normalizeWordList(input.words);
  if (!words.length) throw new Error('单词表为空，无法生成课程');
  // 契约最多 100 个单元；词表很大时自动放大每单元词数，保证 JSON 可校验。
  const requestedUnitSize = input.unitSize ?? 6;
  const unitSize = Math.min(20, Math.max(3, requestedUnitSize, Math.ceil(words.length / 100)));
  const units = buildUnits(level, words, unitSize);
  return {
    schemaVersion: 2,
    packageId: input.packageId || `cefr-${input.source || 'textbook'}-${level.toLowerCase()}-${Date.now()}`,
    title: input.title,
    source: input.source || 'textbook',
    generatedAt: input.generatedAt || new Date().toISOString(),
    levels: [{
      code: level,
      nameZh: CEFR_LEVEL_NAMES[level],
      canDo: CEFR_CAN_DO[level],
      units,
    }],
  };
}

export function buildCefrPreset(): CefrCurriculumPackage {
  return {
    schemaVersion: 2,
    packageId: 'cefr-preset-v2',
    title: 'CEFR 儿童英语长期课程（预置）',
    source: 'preset',
    generatedAt: '2026-11-12T00:00:00.000Z',
    levels: (Object.keys(CEFR_PRESET_WORDS) as CefrCurriculumLevel[]).map((level) => ({
      code: level,
      nameZh: CEFR_LEVEL_NAMES[level],
      canDo: CEFR_CAN_DO[level],
      units: buildUnits(level, CEFR_PRESET_WORDS[level], 5, level.toLowerCase().replace(/[^a-z0-9]/g, '')),
    })),
  };
}

function buildUnits(level: CefrCurriculumLevel, words: string[], unitSize: number, prefix?: string): CefrUnit[] {
  const units: CefrUnit[] = [];
  const levelPrefix = prefix || level.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let offset = 0; offset < words.length; offset += unitSize) {
    const chunk = words.slice(offset, offset + unitSize);
    const unitNo = Math.floor(offset / unitSize) + 1;
    const code = `${levelPrefix}-u${String(unitNo).padStart(2, '0')}`;
    const vocabulary = chunk.map((word) => vocabularyFor(word, code));
    const patterns = chunk.slice(0, 2).map((word) => patternFor(word));
    units.push({
      code,
      title: `${CEFR_LEVEL_NAMES[level]} · 第 ${unitNo} 单元`,
      order: unitNo - 1,
      objectives: [
        `能听懂并说出 ${chunk.slice(0, 3).join('、')} 等 ${chunk.length} 个词`,
        '能在图片和简单情境中理解词义',
        '能跟着老师完成一次短句表达',
      ],
      vocabulary,
      patterns,
      lessons: buildLessons(code, chunk, vocabulary, patterns, level),
    });
  }
  return units;
}

function vocabularyFor(word: string, unitCode: string): CefrVocabularyEntry {
  const entry = LEXICON[word.toLowerCase()];
  const example = exampleFor(word);
  return {
    word,
    phonetic: entry?.phonetic || '',
    meaningZh: entry?.zh || '',
    syllables: splitSyllables(word),
    difficultPhonemes: difficultPhonemes(word),
    phrases: [word, example.en],
    exampleSentences: [{ en: example.en, zh: example.zh }],
    image: {
      key: `img:${unitCode}:${slug(word)}`,
      targetWord: word,
      query: `${word} children flashcard illustration`,
      alt: `${word} 的儿童教学图片`,
    },
  };
}

function buildLessons(
  unitCode: string,
  words: string[],
  vocabulary: CefrVocabularyEntry[],
  patterns: Array<{ en: string; zh: string }>,
  level: CefrCurriculumLevel,
): CefrLesson[] {
  const lessons: CefrLesson[] = [];
  for (const [index, item] of vocabulary.entries()) {
    const word = item.word;
    const example = item.exampleSentences[0]?.en || word;
    const scenario = GREETINGS.has(word.toLowerCase()) ? 'greeting_scene' : 'object_pic_scene';
    lessons.push(makeLesson({
      id: `${unitCode}:${lessons.length}`,
      title: `听一听：${word}`,
      taskType: 'listening_comprehension',
      scenario,
      skillNodeIds: ['LA.LISTEN.word_recognition'],
      targetWords: [word],
      teacherUtteranceZh: `听一听，选出你听到的词：${word}。`,
      demonstrationText: word,
      requiresPronunciationAssessment: false,
      requiresAsr: false,
      assessment: { acceptedTexts: [word] },
      difficulty: levelDifficulty(level),
      imageKeys: [item.image?.key || ''],
    }), makeLesson({
      id: `${unitCode}:${lessons.length + 1}`,
      title: `跟着说：${word}`,
      taskType: 'word_mimicry',
      scenario,
      skillNodeIds: ['LA.SPEAK.imitation'],
      targetWords: [word],
      teacherUtteranceZh: `跟着老师慢慢说：${word}。`,
      demonstrationText: word,
      requiresPronunciationAssessment: true,
      requiresAsr: false,
      assessment: { acceptedTexts: [word] },
      difficulty: levelDifficulty(level),
      imageKeys: [item.image?.key || ''],
    }), makeLesson({
      id: `${unitCode}:${lessons.length + 2}`,
      title: `试着说一句：${word}`,
      taskType: 'sentence_pattern',
      scenario: index % 2 === 0 ? 'self_intro_scene' : 'object_pic_scene',
      skillNodeIds: ['LA.SPEAK.simple_sentences'],
      targetWords: [word],
      teacherUtteranceZh: `试着用 ${word} 说一句话。`,
      demonstrationText: example,
      requiresPronunciationAssessment: false,
      requiresAsr: true,
      assessment: { acceptedTexts: [example] },
      difficulty: Math.min(5, levelDifficulty(level) + 1),
      imageKeys: [item.image?.key || ''],
    }));
  }
  const reviewWords = words.slice(0, 6);
  lessons.push(makeLesson({
    id: `${unitCode}:${lessons.length}`,
    title: '单元复习：听词辨义',
    taskType: 'listening_comprehension',
    scenario: 'review_scene',
    skillNodeIds: ['LA.LISTEN.word_recognition'],
    targetWords: reviewWords,
    teacherUtteranceZh: '我们复习这一组词。听一听，选出你听到的词。',
    demonstrationText: reviewWords[0] || '',
    requiresPronunciationAssessment: false,
    requiresAsr: false,
    assessment: { acceptedTexts: reviewWords },
    difficulty: levelDifficulty(level),
    imageKeys: vocabulary.slice(0, 6).map((item) => item.image?.key || ''),
  }));
  const pattern = patterns[0]?.en || `This is ${words[0]}.`;
  lessons.push(makeLesson({
    id: `${unitCode}:${lessons.length}`,
    title: '单元复习：情境表达',
    taskType: 'situational_dialogue',
    scenario: 'free_chat_scene',
    skillNodeIds: ['LA.COMM.dialogue'],
    targetWords: [pattern],
    teacherUtteranceZh: '试着和老师说一说这句话。',
    demonstrationText: pattern,
    requiresPronunciationAssessment: false,
    requiresAsr: true,
    assessment: { acceptedTexts: [pattern] },
    difficulty: Math.min(5, levelDifficulty(level) + 1),
    imageKeys: vocabulary.slice(0, 2).map((item) => item.image?.key || ''),
  }));
  return lessons;
}

function makeLesson(input: {
  id: string;
  title: string;
  taskType: CefrLesson['taskType'];
  scenario: CefrLesson['scenario'];
  skillNodeIds: string[];
  targetWords: string[];
  teacherUtteranceZh: string;
  demonstrationText: string;
  requiresPronunciationAssessment: boolean;
  requiresAsr: boolean;
  assessment: { acceptedTexts?: string[]; acceptedImageIds?: string[]; requiredPhrases?: string[]; openResponse?: boolean };
  difficulty: number;
  imageKeys: string[];
}): CefrLesson {
  const speechText = [input.teacherUtteranceZh, input.demonstrationText].filter(Boolean).join(' ');
  return {
    id: input.id,
    title: input.title,
    taskType: input.taskType,
    scenario: input.scenario,
    skillNodeIds: input.skillNodeIds,
    targetWords: input.targetWords,
    teacherUtteranceZh: input.teacherUtteranceZh,
    demonstrationText: input.demonstrationText,
    requiresPronunciationAssessment: input.requiresPronunciationAssessment,
    requiresAsr: input.requiresAsr,
    assessment: {
      acceptedImageIds: input.assessment.acceptedImageIds || [],
      acceptedTexts: input.assessment.acceptedTexts || [],
      requiredPhrases: input.assessment.requiredPhrases || [],
      openResponse: input.assessment.openResponse || false,
    },
    difficulty: input.difficulty,
    media: {
      speechKey: input.id,
      speechText,
      imageKeys: [...new Set(input.imageKeys.filter(Boolean))],
    },
  };
}

function patternFor(word: string): { en: string; zh: string } {
  const lower = word.toLowerCase();
  if (VERBS.has(lower)) return { en: `I can ${word}.`, zh: `我能${meaningOf(word)}。` };
  if (ADJECTIVES.has(lower)) return { en: `It is ${word}.`, zh: `它是${meaningOf(word)}的。` };
  return { en: `This is ${article(word)} ${word}.`, zh: `这是${meaningOf(word)}。` };
}

function exampleFor(word: string): { en: string; zh: string } {
  const lower = word.toLowerCase();
  if (GREETINGS.has(lower)) {
    if (lower === 'hello' || lower === 'hi') return { en: 'Hello! I am Anna.', zh: '你好！我是安娜。' };
    if (lower === 'bye') return { en: 'Bye! See you tomorrow.', zh: '再见！明天见。' };
    return { en: `${capitalize(word)}!`, zh: meaningOf(word) };
  }
  if (VERBS.has(lower)) return { en: `I can ${word}.`, zh: `我能${meaningOf(word)}。` };
  if (ADJECTIVES.has(lower)) return { en: `It is ${word}.`, zh: `它是${meaningOf(word)}的。` };
  return { en: `This is ${article(word)} ${word}.`, zh: `这是${meaningOf(word)}。` };
}

function meaningOf(word: string): string {
  return LEXICON[word.toLowerCase()]?.zh || word;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function slug(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function splitSyllables(word: string): string[] {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length <= 3) return [clean];
  const parts = clean.match(/[^aeiou]*[aeiou]+(?:[^aeiou](?=[^aeiou]*[aeiou])|$)/g);
  return parts && parts.length > 1 ? parts : [clean];
}

function difficultPhonemes(word: string): string[] {
  const lower = word.toLowerCase();
  const result: string[] = [];
  if (/th/.test(lower)) result.push('/θ/ 或 /ð/');
  if (/r/.test(lower)) result.push('/r/');
  if (/l/.test(lower)) result.push('/l/');
  if (/v/.test(lower)) result.push('/v/');
  if (/[ʃʒ]|sh|ch/.test(lower)) result.push('/ʃ/ 或 /tʃ/');
  return result.slice(0, 3);
}

function levelDifficulty(level: CefrCurriculumLevel): number {
  return ({ 'pre-A1': 1, A1: 2, A2: 2, B1: 3, B2: 3, C1: 4, C2: 4 } as Record<CefrCurriculumLevel, number>)[level];
}

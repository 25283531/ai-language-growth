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

/** 中文释义里出现这些词时，删掉该义项；若全部被删则整词不进入词库。 */
const UNSAFE_ZH = [
  '性交', '性欲', '性骚扰', '色情', '强奸', '猥亵', '裸体', '裸照', '杀人', '谋杀', '自杀',
  '武器', '枪械', '枪支', '弹药', '炸弹', '毒品', '海洛因', '可卡因', '大麻', '鸦片',
  '妓女', '卖淫', '嫖娼', '淫秽', '阴茎', '阴道', '肛门', '性行为',
  '恶妇', '坏蛋', '混蛋', '婊子', '屎', '尿', '地狱', '纳粹', '种族歧视',
];

/**
 * 儿童课程需要回避的词。
 *
 * `UNSAFE_WORDS` 仍负责把明显成人/辱骂词挡在词库外；这里处理的是
 * “词形本身可入库，但不适合直接进入儿童课程”的词，统一标为
 * `childSafe=false`，由后续查询/编排入口过滤。
 */
const CHILD_UNSAFE_WORDS = new Set([
  ...UNSAFE_WORDS,
  'dead', 'deadly', 'death', 'die', 'died', 'dies', 'dying', 'blood', 'bloody', 'wound',
  'war', 'warfare', 'warrior', 'fight', 'fighting', 'shoot', 'shooting', 'knife', 'knives',
  'cigarette', 'cigar', 'tobacco', 'smoke', 'smoking', 'alcohol', 'alcoholic', 'beer', 'wine',
  'drunk', 'sexual', 'sexuality', 'pregnant', 'pregnancy', 'cancer', 'prison', 'prisoner',
  'jail', 'crime', 'criminal', 'violence', 'violent', 'terror', 'terrorism', 'terrorist',
  'ghost', 'hell', 'devil', 'witch', 'killing', 'killer', 'murder', 'murderer', 'suicide',
  'rape', 'gun', 'rifle', 'weapon', 'drug', 'drugs', 'cocaine', 'heroin', 'marijuana',
  'naked', 'nude', 'porn', 'pornography', 'combat', 'hunting', 'slaughter', 'massacre',
  'steal', 'stealing', 'attack', 'slave', 'slavery', 'rob', 'robbery',
]);

/** 含有敏感词形但实际为儿童安全词的例外（如 deadline 不是 death，tuna 不是枪械）。 */
const CHILD_SAFE_WORDS = new Set(['deadline', 'tuna']);

/** 处理 killing/killer、sexual、pregnancy 等派生/屈折形式；精确集合不够用。 */
const CHILD_UNSAFE_PATTERNS = [
  /^kill/, /^murder/, /^suicid/, /^rape/, /^sexual/, /^porn/,
  /^blood/, /^dead/, /^death/, /^die(?:d|s|ing)?$/, /^war(?:fare|rior)?$/,
  /^fight/, /^shoot/, /^weapon/, /^gun/, /^rifle/, /^knife|^knives/, /^violen/,
  /^terror/, /^prison/, /^jail/, /^crime$|^criminal$/, /^alcohol/, /^beer$/, /^wine$/,
  /^drunk/, /^cigarette/, /^tobacco/, /^smok/, /^pregnan/, /^cancer/, /^ghost/,
  /^hell$/, /^devil/, /^witch/, /^drug/, /^naked/, /^nude/, /^hunt/, /^combat/, /^slaughter/, /^massacre/,
  /^steal/, /^attack/, /^slave/, /^rob(?:s|bed|bing|bery)?$/,
];

/** 释义里出现这些中文词时，同样视为不适合儿童课程。 */
const CHILD_UNSAFE_ZH = [
  '死亡', '死者', '尸体', '血腥', '血', '战争', '战场', '打仗', '战斗', '打架', '暴力', '殴打',
  '射击', '狩猎', '枪', '刀', '匕首', '武器', '弹药', '炸弹', '酒精', '醉酒', '酗酒', '啤酒',
  '葡萄酒', '白酒', '饮酒', '喝酒', '香烟', '烟草', '吸烟', '毒品', '吸毒', '海洛因', '可卡因',
  '大麻', '性行为', '性交', '性欲', '性骚扰', '色情', '裸体', '裸照', '强奸', '怀孕', '妊娠',
  '癌', '恶性肿瘤', '监狱', '监禁', '犯罪', '罪犯', '罪行', '恐怖', '鬼', '地狱', '恶魔',
  '自杀', '谋杀', '杀人', '凶杀', '葬礼', '坟墓',
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

/**
 * 已入选词族的语义等价拼写/屈折别名。
 *
 * 只用于英式拼写和不规则复数这类不会改变词义的形态差异；
 * 复合词（blackboard、schoolbag）不能挂到组成词上，否则会伪造词族。
 */
export const SAFE_FORM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  behavior: ['behaviour'],
  center: ['centre'],
  color: ['colour'],
  favorite: ['favourite'],
  honor: ['honour'],
  labor: ['labour'],
  meter: ['metre'],
  neighbor: ['neighbour'],
  practice: ['practise'],
  program: ['programme'],
  realize: ['realise'],
  theater: ['theatre'],
  stair: ['stairs'],
  yourself: ['yourselves'],
};

/**
 * 扩展层教材优先词：优先补小学教材常见、但被频率排序挤出 5,000 的词。
 *
 * 这些词只进入扩展层；构建时从扩展层尾部移除同等数量的低排名词，
 * 不改变 3,000 核心层。复合词必须独立成词，不能映射到组成词。
 */
export const EXTENSION_PRIORITY_WORDS_BATCH_1 = new Set([
  'blackboard', 'schoolbag', 'crayon', 'dictionary', 'fridge', 'postcard',
  'postman', 'raincoat', 'scarf', 'toothbrush', 'toothpaste', 'trousers',
  'hamburger', 'pancake', 'dumpling', 'sausage', 'biscuit', 'cabbage',
  'lemonade', 'toothache', 'zebra', 'giraffe', 'kite', 'volleyball',
  'violin', 'chess', 'grammar', 'pronunciation', 'handwriting', 'housework',
]);

/** 第二批：P0 34 个 + clap；clap 虽在 P1，但本轮明确要求一并入库。 */
export const EXTENSION_PRIORITY_WORDS_BATCH_2 = new Set([
  'granddaughter', 'grandson', 'granny', 'queen',
  'bamboo', 'camel', 'fox', 'hen',
  'chalk', 'cinema', 'hobby', 'recite', 'retell', 'riddle',
  'chopsticks', 'cooker', 'ham',
  'ache', 'cough', 'deaf', 'dentist',
  'handbag', 'overcoat', 'passport', 'railway',
  'careless', 'lazy', 'sleepy', 'snowy', 'tidy', 'mend', 'fetch', 'rubbish', 'litter',
  'clap',
]);

export const EXTENSION_PRIORITY_WORDS = new Set([
  ...EXTENSION_PRIORITY_WORDS_BATCH_1,
  ...EXTENSION_PRIORITY_WORDS_BATCH_2,
]);

const DOMAIN_WORDS: Record<LexiconDomain, string[]> = {
  self_family: [
    'age', 'arm', 'aunt', 'baby', 'birthday', 'body', 'boy', 'brother', 'child', 'children',
    'cousin', 'dad', 'daddy', 'daughter', 'ear', 'eye', 'face', 'family', 'father', 'finger',
    'foot', 'friend', 'girl', 'grandchild', 'granddaughter', 'grandfather', 'grandma',
    'grandmother', 'grandpa', 'grandparent', 'grandson', 'hair', 'hand', 'head', 'husband',
    'kid', 'knee', 'leg', 'man', 'mom', 'mommy', 'mother', 'mouth', 'name', 'neck', 'nose',
    'parent', 'people', 'person', 'shoulder', 'sister', 'son', 'stomach', 'tooth', 'uncle',
    'wife', 'woman', 'beautiful', 'big', 'blouse', 'cap', 'clothes', 'coat', 'dress', 'fat',
    'glove', 'handsome', 'hat', 'jacket', 'long', 'old', 'pants', 'pretty', 'scarf', 'shirt',
    'shoe', 'short', 'skirt', 'small', 'sock', 'strong', 'sweater', 'tall', 'thin', 'trousers',
    'ugly', 'uniform', 'weak', 'young',
  ],
  food: [
    'apple', 'banana', 'bean', 'beef', 'bread', 'breakfast', 'broccoli', 'butter', 'cabbage',
    'cake', 'candy', 'carrot', 'cheese', 'cherry', 'chicken', 'chocolate', 'coffee', 'cookie',
    'corn', 'cream', 'dessert', 'dinner', 'drink', 'egg', 'fish', 'food', 'fruit', 'grape',
    'hamburger', 'hungry', 'ice', 'jam', 'juice', 'lemon', 'lunch', 'mango', 'meat', 'milk',
    'mushroom', 'noodle', 'nut', 'onion', 'orange', 'peach', 'pear', 'pea', 'pepper', 'pie',
    'pineapple', 'pizza', 'pork', 'potato', 'rice', 'salad', 'salt', 'sandwich', 'sauce',
    'soup', 'sour', 'spicy', 'strawberry', 'sugar', 'sweet', 'taste', 'tea', 'thirsty',
    'tomato', 'vegetable', 'water', 'watermelon', 'yogurt', 'bottle', 'chef', 'diet', 'dish',
    'flour', 'fridge', 'honey', 'meal', 'oil', 'pan', 'picnic', 'plate', 'pot', 'recipe',
    'snack', 'spoon', 'stove',
  ],
  animals: [
    'animal', 'ant', 'bear', 'bee', 'bird', 'butterfly', 'cat', 'chicken', 'cow', 'deer',
    'dog', 'dolphin', 'duck', 'elephant', 'fish', 'fox', 'frog', 'giraffe', 'goat', 'horse',
    'insect', 'lion', 'monkey', 'mouse', 'panda', 'pig', 'rabbit', 'rat', 'shark', 'sheep',
    'snake', 'spider', 'tiger', 'turtle', 'whale', 'wolf', 'zebra', 'zoo', 'cage', 'pet', 'wild',
  ],
  school: [
    'art', 'bag', 'blackboard', 'book', 'chair', 'chinese', 'class', 'classroom', 'computer',
    'crayon', 'desk', 'dictionary', 'english', 'eraser', 'exam', 'geography', 'history',
    'homework', 'learn', 'lesson', 'library', 'math', 'music', 'notebook', 'pen', 'pencil',
    'pupil', 'read', 'ruler', 'school', 'science', 'student', 'study', 'teacher', 'test',
    'write', 'draw', 'answer', 'calendar', 'college', 'grade', 'language', 'paper', 'question',
    'schoolbag', 'sentence', 'subject', 'university', 'word',
  ],
  home: [
    'apartment', 'bathroom', 'bed', 'bedroom', 'blanket', 'bowl', 'box', 'chair', 'clean',
    'clock', 'cup', 'dish', 'door', 'floor', 'fork', 'furniture', 'garden', 'glass', 'home',
    'house', 'key', 'kitchen', 'lamp', 'mirror', 'plate', 'room', 'sofa', 'spoon', 'table',
    'television', 'towel', 'toy', 'tv', 'wall', 'wash', 'window', 'appliance', 'basket',
    'bottle', 'brush', 'carpet', 'comb', 'curtain', 'drawer', 'fridge', 'oven', 'pan', 'picture',
    'pillow', 'pot', 'shelf', 'sheet', 'soap', 'stove', 'toothbrush', 'toothpaste', 'umbrella',
  ],
  actions: [
    'answer', 'ask', 'begin', 'bring', 'build', 'buy', 'call', 'carry', 'catch', 'change',
    'clean', 'climb', 'close', 'come', 'cook', 'count', 'cry', 'cut', 'dance', 'draw',
    'drink', 'drive', 'eat', 'fall', 'feel', 'find', 'finish', 'fly', 'follow', 'get',
    'give', 'go', 'grow', 'help', 'hold', 'hope', 'jump', 'keep', 'know', 'laugh', 'learn',
    'leave', 'let', 'like', 'listen', 'look', 'love', 'make', 'meet', 'need', 'open', 'play',
    'put', 'read', 'rest', 'ride', 'run', 'say', 'see', 'sell', 'send', 'show', 'sing', 'sit',
    'sleep', 'smile', 'speak', 'stand', 'start', 'stop', 'study', 'swim', 'take', 'talk',
    'teach', 'tell', 'think', 'throw', 'touch', 'try', 'turn', 'understand', 'use', 'wait',
    'walk', 'want', 'wash', 'watch', 'work', 'write', 'accept', 'achieve', 'add', 'admit',
    'agree', 'allow', 'announce', 'appear', 'apply', 'argue', 'arrange', 'arrive', 'attend',
    'avoid', 'become', 'believe', 'bend', 'borrow', 'breathe', 'celebrate', 'choose', 'collect',
    'combine', 'compare', 'complain', 'consider', 'contain', 'continue', 'create', 'decide',
    'declare', 'deny', 'depend', 'describe', 'develop', 'discover', 'discuss', 'divide',
    'encourage', 'enter', 'establish', 'examine', 'expect', 'explain', 'explore', 'extend',
    'fail', 'fill', 'forget', 'happen', 'imagine', 'improve', 'include', 'increase', 'investigate',
    'join', 'lose', 'manage', 'mean', 'move', 'occur', 'perform', 'prepare', 'prevent', 'produce',
    'protect', 'prove', 'provide', 'publish', 'pull', 'push', 'realize', 'receive', 'recognize',
    'reduce', 'reflect', 'refuse', 'relate', 'remain', 'remember', 'remove', 'reply', 'represent',
    'require', 'respond', 'result', 'return', 'reveal', 'seek', 'seem', 'serve', 'share', 'succeed',
    'suffer', 'suggest', 'travel', 'visit', 'win',
  ],
  emotions: [
    'afraid', 'angry', 'bored', 'brave', 'calm', 'careful', 'cry', 'excited', 'feel', 'glad',
    'happy', 'hate', 'kind', 'laugh', 'lonely', 'love', 'mad', 'nice', 'proud', 'sad',
    'scared', 'shy', 'smile', 'sorry', 'surprised', 'tired', 'worry', 'worried', 'care',
    'feeling', 'fear', 'funny', 'jealous', 'mood', 'nervous', 'serious',
  ],
  colors_numbers: [
    'black', 'blue', 'brown', 'circle', 'color', 'eight', 'eighteen', 'eighty', 'eleven',
    'fifteen', 'fifty', 'first', 'five', 'forty', 'four', 'fourteen', 'green', 'grey', 'gray',
    'hundred', 'million', 'nine', 'nineteen', 'ninety', 'number', 'one', 'orange', 'pink',
    'purple', 'red', 'round', 'seven', 'seventeen', 'seventy', 'shape', 'six', 'sixteen',
    'sixty', 'square', 'ten', 'thirteen', 'thirty', 'thousand', 'three', 'triangle', 'twelve',
    'twenty', 'two', 'white', 'yellow', 'zero', 'dozen', 'double', 'half', 'pair', 'quarter',
  ],
  weather_time: [
    'afternoon', 'april', 'august', 'autumn', 'cloud', 'cloudy', 'cold', 'cool', 'day',
    'december', 'evening', 'fall', 'february', 'friday', 'hot', 'hour', 'january', 'july',
    'june', 'march', 'monday', 'month', 'morning', 'night', 'november', 'now', 'october',
    'rain', 'rainy', 'saturday', 'season', 'second', 'september', 'snow', 'spring', 'storm',
    'summer', 'sun', 'sunday', 'sunny', 'thursday', 'time', 'today', 'tomorrow', 'tuesday',
    'warm', 'weather', 'wednesday', 'week', 'wind', 'windy', 'winter', 'year', 'yesterday',
    'calendar', 'date', 'festival', 'holiday', 'vacation', 'weekend',
  ],
  community_transport: [
    'airplane', 'airport', 'bank', 'bicycle', 'bike', 'boat', 'bridge', 'bus', 'car', 'city',
    'community', 'doctor', 'driver', 'farm', 'farmer', 'hospital', 'hotel', 'library', 'market',
    'museum', 'neighbour', 'neighborhood', 'nurse', 'park', 'plane', 'police', 'restaurant',
    'road', 'ship', 'shop', 'station', 'store', 'street', 'subway', 'supermarket', 'taxi',
    'town', 'train', 'truck', 'van', 'village', 'worker', 'zoo', 'business', 'cinema', 'company',
    'country', 'factory', 'government', 'group', 'member', 'office', 'place', 'program', 'service',
    'society', 'team', 'theatre', 'theater', 'university', 'way', 'world',
  ],
};

const DOMAIN_ZH: Record<LexiconDomain, string[]> = {
  self_family: [
    '家庭', '家人', '爸爸', '妈妈', '父亲', '母亲', '兄弟', '姐妹', '孩子', '男孩', '女孩',
    '朋友', '名字', '身体', '头', '脸', '眼睛', '耳朵', '鼻子', '嘴', '手', '胳膊', '腿',
    '脚', '头发', '牙齿', '阿姨', '叔叔', '爷爷', '奶奶', '外公', '外婆', '表兄弟', '表姐妹',
    '丈夫', '妻子', '儿子', '女儿', '生日', '年龄', '衣服', '衬衫', '裙子', '鞋', '帽子',
    '外套', '袜子', '毛衣', '裤子', '手套', '围巾', '制服', '外貌', '身高', '体重', '年轻',
    '年老', '强壮', '瘦', '胖',
  ],
  food: [
    '食物', '食品', '水果', '蔬菜', '苹果', '香蕉', '面包', '牛奶', '水', '米饭', '蛋', '鱼',
    '肉', '果汁', '蛋糕', '早餐', '午餐', '晚餐', '吃', '喝', '饿', '渴', '甜', '酸', '辣', '咸',
    '饮料', '零食', '正餐', '味道', '好吃', '好喝', '厨师', '做饭', '面粉', '蜂蜜', '油',
  ],
  animals: [
    '动物', '猫', '狗', '鸟', '鱼', '猪', '牛', '羊', '马', '兔', '大象', '猴子', '老虎',
    '狮子', '熊猫', '长颈鹿', '蛇', '青蛙', '乌龟', '蜜蜂', '蝴蝶', '昆虫', '宠物', '野生',
    '笼子',
  ],
  school: [
    '学校', '老师', '教师', '学生', '书', '笔', '铅笔', '书包', '课', '学习', '读', '写',
    '教室', '作业', '考试', '图书馆', '数学', '英语', '语文', '音乐', '美术', '科学', '教育',
    '课程', '学科', '知识', '单词', '句子', '答案', '问题', '大学', '学院', '年级', '科目',
  ],
  home: [
    '房子', '住宅', '床', '桌子', '椅子', '门', '窗户', '房间', '厨房', '客厅', '浴室', '沙发',
    '灯', '杯子', '盘子', '勺子', '玩具', '干净', '打扫', '家具', '家电', '日用品', '家务',
    '枕头', '毯子', '窗帘', '架子', '抽屉', '冰箱', '烤箱', '锅', '篮子',
  ],
  actions: [
    '跑', '跳', '走', '吃', '喝', '看', '听', '说', '读', '写', '玩', '睡', '洗', '打开',
    '关闭', '开始', '结束', '帮助', '买', '卖', '给', '拿', '放', '坐', '站', '笑', '哭',
    '唱', '跳舞', '游泳', '学习', '工作', '做', '使', '进行', '发生', '成为', '认为', '表示',
    '提供', '包括', '增加', '减少', '改变', '选择', '决定', '相信', '记得', '忘记', '需要',
    '希望', '服务', '保护', '准备', '接受', '发现', '创造', '建立', '发展', '使用', '移动',
    '参加', '到达', '离开', '继续', '出现', '成功', '失败', '解释', '描述', '比较', '讨论',
    '建议', '同意', '拒绝', '允许', '要求',
  ],
  emotions: [
    '高兴', '快乐', '伤心', '难过', '生气', '害怕', '累', '爱', '喜欢', '惊讶', '担心', '无聊',
    '骄傲', '勇敢', '安静', '害羞', '孤独', '讨厌', '感觉', '心情', '情绪', '感情', '恐惧',
    '担心', '开心', '幽默',
  ],
  colors_numbers: [
    '颜色', '红色', '蓝色', '黄色', '绿色', '白色', '黑色', '粉色', '紫色', '棕色', '灰色',
    '橙色', '数字', '形状', '圆形', '方形', '三角形', '数量', '计算', '一半', '一双', '一对',
    '双倍',
  ],
  weather_time: [
    '天气', '下雨', '雨', '下雪', '雪', '风', '晴天', '云', '热', '冷', '暖', '早上', '上午',
    '下午', '晚上', '今天', '明天', '昨天', '春天', '夏天', '秋天', '冬天', '时间', '小时',
    '分钟', '星期', '月份', '日期', '日历', '假期', '节日', '周末', '过去', '未来', '现在',
    '气候',
  ],
  community_transport: [
    '公共汽车', '公交车', '汽车', '火车', '飞机', '船', '自行车', '地铁', '出租车', '卡车',
    '医院', '医生', '护士', '警察', '商店', '超市', '市场', '公园', '车站', '机场', '图书馆',
    '银行', '旅馆', '饭店', '街道', '马路', '桥', '城市', '村庄', '社区', '邻居', '路',
    '路线', '国家', '地方', '地点', '公司', '政府', '生意', '办公室', '服务', '队', '组',
    '世界', '社会', '公共', '交通', '职业', '法律', '工厂', '电影院', '剧院', '邮局', '消防',
  ],
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

  const rankedCandidates = [...byWord.values()].sort(compareCandidates);
  const candidatePoolEntries = new Map<string, Candidate>();
  for (const candidate of rankedCandidates.slice(0, candidatePool)) {
    candidatePoolEntries.set(candidate.word, candidate);
  }
  // 扩展层优先词可能没有 frq/bnc，必须显式加入分组，不能依赖候选池截断。
  for (const candidate of rankedCandidates) {
    if (EXTENSION_PRIORITY_WORDS.has(candidate.word)) candidatePoolEntries.set(candidate.word, candidate);
  }
  const families = groupFamilies([...candidatePoolEntries.values()].sort(compareCandidates));
  families.sort((left, right) => left.rank - right.rank);

  const selected = families.slice(0, maxFamilies);
  const selectedCore = selected.slice(0, coreFamilies);
  const selectedExtension = selected.slice(coreFamilies, maxFamilies);
  const familyByForm = new Map<string, (typeof families)[number]>();
  for (const family of families) {
    for (const form of family.forms) {
      if (!familyByForm.has(form)) familyByForm.set(form, family);
    }
  }

  // 已选中的词族不重复添加；优先词只占扩展层名额。
  const selectedSet = new Set(selected);
  const priorityFamilies: typeof families = [];
  for (const word of EXTENSION_PRIORITY_WORDS) {
    const family = familyByForm.get(word);
    if (!family || selectedSet.has(family)) continue;
    selectedSet.add(family);
    priorityFamilies.push(family);
  }

  // 扩展层从尾部替换：优先词只替换未带 zk/gk 标签的低排名词，
  // 避免把 motorcycle 这类已被旧扩展层覆盖的课标词挤出词库。
  const isPriorityFamily = (family: (typeof families)[number]) => (
    family.forms.some((form) => EXTENSION_PRIORITY_WORDS.has(form))
  );
  const isTargetTagged = (family: (typeof families)[number]) => (
    family.members.some((member) => member.tags.includes('zk') || member.tags.includes('gk'))
  );
  const selectedPriority = selectedExtension.filter(isPriorityFamily);
  const selectedProtected = selectedExtension.filter((family) => (
    !isPriorityFamily(family) && isTargetTagged(family)
  ));
  const selectedRemovable = selectedExtension.filter((family) => (
    !isPriorityFamily(family) && !isTargetTagged(family)
  ));
  const extensionLimit = maxFamilies - coreFamilies;
  const keptRemovable = selectedRemovable.slice(0, Math.max(
    0,
    extensionLimit - selectedPriority.length - selectedProtected.length - priorityFamilies.length,
  ));
  const extensionFamilies = [
    ...selectedPriority,
    ...selectedProtected,
    ...keptRemovable,
    ...priorityFamilies,
  ].slice(0, extensionLimit);

  const toEntry = (
    family: (typeof families)[number],
    index: number,
    isCore: boolean,
  ): LexiconRecord => {
    // 扩展优先词做代表词，保证教材词条以单数/常用形式出现（如 dumpling 而不是 dumplings）。
    const representative = (!isCore
      ? family.members.find((member) => EXTENSION_PRIORITY_WORDS.has(member.word))
      : undefined) ?? family.members[0]!;
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
      childSafe: assessChildSafety(representative.word, representative.meaningZh),
      isCore,
      isFunctionWord: representative.isFunctionWord,
      textbookUnitIds: [],
    };
  };

  const entries: LexiconRecord[] = [
    ...selectedCore.map((family, index) => toEntry(family, index, true)),
    ...extensionFamilies.map((family, index) => toEntry(family, coreFamilies + index, false)),
  ];

  const aliasedEntries = applySafeFormAliases(entries);
  return {
    version: 1,
    source: 'ECDICT',
    license: 'MIT',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    totalFamilies: aliasedEntries.length,
    coreFamilies: Math.min(coreFamilies, aliasedEntries.length),
    entries: aliasedEntries,
  };
}

/** 把安全别名挂到已入选词族，不新增词族，也不改变 isCore。 */
function applySafeFormAliases(entries: LexiconRecord[]): LexiconRecord[] {
  const knownForms = new Set<string>();
  for (const entry of entries) {
    knownForms.add(entry.word);
    for (const variant of entry.variants) knownForms.add(variant);
  }

  let changed = false;
  const aliased = entries.map((entry) => {
    const aliases = SAFE_FORM_ALIASES[entry.word] ?? [];
    const additions = aliases.filter((alias) => !knownForms.has(alias));
    if (!additions.length) return entry;
    changed = true;
    return {
      ...entry,
      variants: [...new Set([...entry.variants, ...additions])].slice(0, 50),
    };
  });
  return changed ? aliased : entries;
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
  const extensionPriority = EXTENSION_PRIORITY_WORDS.has(word);
  if (!frequencyRank && !bncRank && !priority && !extensionPriority) return null;

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

  const parseLine = (line: string): string => {
    const body = line.replace(POS_PREFIX_RE, '').replace(/\[[^\]]*\]/g, '').trim();
    if (!HAN_RE.test(body)) return '';
    const senses = body
      .split(/[,，;；]/)
      .map((sense) => sense.trim())
      .filter((sense) => sense && HAN_RE.test(sense))
      .filter((sense) => !UNSAFE_ZH.some((word) => sense.includes(word)));
    if (!senses.length) return '';
    const value = [...new Set(senses)].slice(0, 2).join('；');
    return value.length > 300 ? '' : value;
  };

  // 普通义项优先。不能因为正文里出现“计算机”就丢弃整行：
  // computer 的常用释义正是“电脑, 电子计算机”。
  for (const line of lines) {
    if (line.startsWith('[') || line.includes('网络用语')) continue;
    const value = parseLine(line);
    if (value) return value;
  }

  // 只有 [计] 等标签行时，去掉标签后作为兜底，避免 internet 被误删。
  for (const line of lines) {
    if (!line.startsWith('[') || line.includes('网络用语')) continue;
    const value = parseLine(line);
    if (value) return value;
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
  // 英文词表精确匹配优先；只有完全没命中时才用中文释义兜底，
  // 避免“国家”命中 home、“性别”命中 colors 这类跨义项误标。
  const exact = new Set<LexiconDomain>();
  for (const [domain, words] of Object.entries(DOMAIN_WORDS) as Array<[LexiconDomain, string[]]>) {
    if (words.includes(word)) exact.add(domain);
  }
  if (exact.size) return [...exact].slice(0, 4);

  const inferred: LexiconDomain[] = [];
  for (const [domain, keywords] of Object.entries(DOMAIN_ZH) as Array<[LexiconDomain, string[]]>) {
    if (keywords.some((keyword) => meaningZh.includes(keyword))) inferred.push(domain);
    if (inferred.length >= 4) break;
  }
  return inferred;
}

/**
 * 儿童安全判定。
 *
 * 返回 false 的词仍可保留在词库中供教师/管理端检索，但儿童课程查询与
 * 编排入口必须过滤。抽象高频词允许 `domains=[]`，安全判定不受此影响。
 */
export function assessChildSafety(word: string, meaningZh: string): boolean {
  const normalized = (word || '').trim().toLowerCase();
  if (!normalized) return false;
  if (CHILD_SAFE_WORDS.has(normalized)) return true;
  if (CHILD_UNSAFE_WORDS.has(normalized)) return false;
  if (CHILD_UNSAFE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;

  // 只看实际义项，忽略“（表示惊讶、恐怖……）”这类用法说明；
  // 多义词只要有一个儿童可用义项，就保留，不因次要义项整词误杀。
  const safetyMeaning = (meaningZh || '').replace(/[（(][^）)]*[）)]/g, '');
  const senses = safetyMeaning
    .split(/[；;]/)
    .map((sense) => sense.trim())
    .filter(Boolean);
  if (senses.length && senses.every((sense) => CHILD_UNSAFE_ZH.some((keyword) => sense.includes(keyword)))) {
    return false;
  }
  return true;
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

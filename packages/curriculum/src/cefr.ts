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
  CefrImageRequirement,
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

/** 预置词库：每个级别 25 个核心词，按每单元 5 词生成 5 个单元。 */
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

/** 拓展词库：在核心词之外按级别追加 1 个拓展词单元，不改变已发布的核心词单元。 */
export const CEFR_EXTENSION_WORDS: Record<CefrCurriculumLevel, string[]> = {
  'pre-A1': ['hand', 'eye', 'nose', 'mouth', 'ear'],
  A1: ['rice', 'noodles', 'chicken', 'fish', 'juice'],
  A2: ['airport', 'hotel', 'restaurant', 'cinema', 'beach'],
  B1: ['volunteer', 'community', 'transport', 'schedule', 'goal'],
  B2: ['innovation', 'sustainable', 'priority', 'negotiate', 'impact'],
  C1: ['pragmatic', 'resilient', 'substantiate', 'undermine', 'prevalent'],
  C2: ['ubiquitous', 'meticulous', 'candid', 'profound', 'vindicate'],
};

type DailyExpression = {
  en: string;
  zh: string;
  scene: CefrLesson['scenario'];
  query: string;
};

/**
 * 日常用语库：按级别覆盖问候、自我介绍、请求、购物、出行、就医、观点、协商等
 * 大多数真实生活场景。预置课程会在每个级别的词汇单元之后追加“日常用语”单元。
 */
export const CEFR_DAILY_EXPRESSIONS: Record<CefrCurriculumLevel, DailyExpression[]> = {
  'pre-A1': [
    { en: 'Hello! I am Anna.', zh: '你好！我是安娜。', scene: 'greeting_scene', query: 'children greeting each other illustration' },
    { en: 'What is your name?', zh: '你叫什么名字？', scene: 'greeting_scene', query: 'children asking name illustration' },
    { en: 'My name is Ben.', zh: '我叫本。', scene: 'self_intro_scene', query: 'child introducing himself illustration' },
    { en: 'How old are you?', zh: '你几岁了？', scene: 'self_intro_scene', query: 'children talking about age illustration' },
    { en: 'I am six.', zh: '我六岁。', scene: 'self_intro_scene', query: 'six year old child illustration' },
    { en: 'Yes, please.', zh: '好的，请给我。', scene: 'object_shop_scene', query: 'child politely asking illustration' },
    { en: 'No, thank you.', zh: '不用了，谢谢。', scene: 'object_shop_scene', query: 'child politely declining illustration' },
    { en: 'Thank you.', zh: '谢谢你。', scene: 'greeting_scene', query: 'child saying thank you illustration' },
    { en: "You're welcome.", zh: '不客气。', scene: 'greeting_scene', query: 'children being polite illustration' },
    { en: "I'm sorry.", zh: '对不起。', scene: 'greeting_scene', query: 'child apologizing illustration' },
    { en: 'Can I have some water?', zh: '我可以喝点水吗？', scene: 'object_shop_scene', query: 'child asking for water illustration' },
    { en: 'I need help.', zh: '我需要帮助。', scene: 'free_chat_scene', query: 'child asking teacher for help illustration' },
    { en: 'Good morning!', zh: '早上好！', scene: 'greeting_scene', query: 'morning greeting children illustration' },
    { en: 'Good night!', zh: '晚安！', scene: 'greeting_scene', query: 'bedtime good night illustration' },
    { en: 'Good afternoon!', zh: '下午好！', scene: 'greeting_scene', query: 'afternoon greeting children illustration' },
    { en: 'I like this toy.', zh: '我喜欢这个玩具。', scene: 'object_pic_scene', query: 'child holding toy illustration' },
    { en: 'Where is my bag?', zh: '我的包在哪里？', scene: 'free_chat_scene', query: 'child looking for bag illustration' },
    { en: 'Come here, please.', zh: '请过来。', scene: 'free_chat_scene', query: 'teacher calling child illustration' },
    { en: 'Sit down, please.', zh: '请坐下。', scene: 'free_chat_scene', query: 'children sitting down classroom illustration' },
    { en: "Let's play together.", zh: '我们一起玩吧。', scene: 'free_chat_scene', query: 'children playing together illustration' },
    { en: 'I am happy today.', zh: '我今天很开心。', scene: 'self_intro_scene', query: 'happy child illustration' },
  ],
  A1: [
    { en: 'This is my family.', zh: '这是我的家人。', scene: 'self_intro_scene', query: 'child showing family photo illustration' },
    { en: 'I have a brother.', zh: '我有一个兄弟。', scene: 'self_intro_scene', query: 'brother and sister illustration' },
    { en: 'I like apples.', zh: '我喜欢苹果。', scene: 'object_pic_scene', query: 'child eating apple illustration' },
    { en: 'I want a red ball.', zh: '我想要一个红球。', scene: 'object_shop_scene', query: 'child choosing red ball illustration' },
    { en: 'I can swim.', zh: '我会游泳。', scene: 'free_chat_scene', query: 'child swimming illustration' },
    { en: 'Where is the bathroom?', zh: '洗手间在哪里？', scene: 'free_chat_scene', query: 'child asking for bathroom illustration' },
    { en: 'What time is it?', zh: '现在几点了？', scene: 'free_chat_scene', query: 'child asking time clock illustration' },
    { en: 'It is sunny today.', zh: '今天天气晴朗。', scene: 'free_chat_scene', query: 'sunny weather children illustration' },
    { en: 'How much is this?', zh: '这个多少钱？', scene: 'object_shop_scene', query: 'child asking price shop illustration' },
    { en: 'Turn left at the school.', zh: '在学校那里左转。', scene: 'free_chat_scene', query: 'children following directions illustration' },
    { en: 'Can you help me?', zh: '你能帮我吗？', scene: 'free_chat_scene', query: 'child asking friend for help illustration' },
    { en: "I'm hungry.", zh: '我饿了。', scene: 'free_chat_scene', query: 'child feeling hungry illustration' },
    { en: 'Can I go out and play?', zh: '我可以出去玩吗？', scene: 'free_chat_scene', query: 'child asking to play outside illustration' },
    { en: 'See you tomorrow.', zh: '明天见。', scene: 'greeting_scene', query: 'children saying goodbye illustration' },
    { en: 'My favorite color is blue.', zh: '我最喜欢的颜色是蓝色。', scene: 'self_intro_scene', query: 'child pointing to blue color illustration' },
    { en: 'I get up at seven.', zh: '我七点起床。', scene: 'free_chat_scene', query: 'child waking up at seven illustration' },
    { en: 'I go to school by bus.', zh: '我坐公共汽车去学校。', scene: 'free_chat_scene', query: 'child taking school bus illustration' },
    { en: 'There is a cat under the table.', zh: '桌子下面有一只猫。', scene: 'object_pic_scene', query: 'cat under table illustration' },
    { en: 'How many books do you have?', zh: '你有多少本书？', scene: 'free_chat_scene', query: 'children counting books illustration' },
    { en: 'May I come in?', zh: '我可以进来吗？', scene: 'free_chat_scene', query: 'child asking to enter classroom illustration' },
    { en: 'Have a nice day!', zh: '祝你今天愉快！', scene: 'greeting_scene', query: 'friendly greeting illustration' },
  ],
  A2: [
    { en: 'I went to the park yesterday.', zh: '我昨天去了公园。', scene: 'story_scene', query: 'children playing in park illustration' },
    { en: 'I am going to visit my grandma.', zh: '我要去看奶奶。', scene: 'story_scene', query: 'child visiting grandmother illustration' },
    { en: 'Can I have the menu, please?', zh: '请给我菜单好吗？', scene: 'object_shop_scene', query: 'child in restaurant menu illustration' },
    { en: 'I would like a glass of milk.', zh: '我想要一杯牛奶。', scene: 'object_shop_scene', query: 'child ordering milk restaurant illustration' },
    { en: 'Where is the train station?', zh: '火车站在哪里？', scene: 'free_chat_scene', query: 'child asking train station illustration' },
    { en: 'How long does it take?', zh: '要花多长时间？', scene: 'free_chat_scene', query: 'child asking travel time illustration' },
    { en: "I don't feel well.", zh: '我不舒服。', scene: 'free_chat_scene', query: 'child feeling sick illustration' },
    { en: 'I have a headache.', zh: '我头疼。', scene: 'free_chat_scene', query: 'child with headache illustration' },
    { en: 'Could you say that again?', zh: '你能再说一遍吗？', scene: 'free_chat_scene', query: 'child asking repeat illustration' },
    { en: 'What do you think?', zh: '你觉得怎么样？', scene: 'free_chat_scene', query: 'children sharing opinions illustration' },
    { en: 'I prefer the blue one.', zh: '我更喜欢蓝色的那个。', scene: 'object_shop_scene', query: 'child choosing blue item illustration' },
    { en: "Let's meet at six.", zh: '我们六点见吧。', scene: 'greeting_scene', query: 'children meeting at six illustration' },
    { en: "I'm looking for a jacket.", zh: '我在找一件夹克。', scene: 'object_shop_scene', query: 'child shopping for jacket illustration' },
    { en: 'Is there a supermarket near here?', zh: '这附近有超市吗？', scene: 'free_chat_scene', query: 'child asking supermarket location illustration' },
    { en: 'I usually walk to school.', zh: '我通常步行去学校。', scene: 'free_chat_scene', query: 'child walking to school illustration' },
    { en: 'We had a great time at the beach.', zh: '我们在海滩玩得很开心。', scene: 'story_scene', query: 'children happy at beach illustration' },
    { en: 'Could I try this jacket on?', zh: '我可以试穿这件夹克吗？', scene: 'object_shop_scene', query: 'child trying on jacket illustration' },
    { en: "I'm allergic to milk.", zh: '我对牛奶过敏。', scene: 'free_chat_scene', query: 'child refusing milk allergy illustration' },
    { en: "What's the weather like tomorrow?", zh: '明天天气怎么样？', scene: 'free_chat_scene', query: 'children checking tomorrow weather illustration' },
    { en: "Let's take a photo here.", zh: '我们在这里拍张照吧。', scene: 'free_chat_scene', query: 'children taking photo illustration' },
    { en: "I'll be back in ten minutes.", zh: '我十分钟后回来。', scene: 'free_chat_scene', query: 'child leaving and returning illustration' },
  ],
  B1: [
    { en: 'In my opinion, this is a good idea.', zh: '在我看来，这是个好主意。', scene: 'free_chat_scene', query: 'children discussing ideas illustration' },
    { en: 'I agree with you because it is fair.', zh: '我同意你，因为这样公平。', scene: 'free_chat_scene', query: 'children agreeing discussion illustration' },
    { en: "I'm not sure about that.", zh: '我不太确定。', scene: 'free_chat_scene', query: 'child uncertain discussion illustration' },
    { en: 'Have you ever been to a museum?', zh: '你去过博物馆吗？', scene: 'free_chat_scene', query: 'children visiting museum illustration' },
    { en: 'I used to play football.', zh: '我以前踢足球。', scene: 'story_scene', query: 'child playing football past illustration' },
    { en: 'If I have time, I will join you.', zh: '如果我有时间，我会加入你们。', scene: 'free_chat_scene', query: 'children making plans illustration' },
    { en: 'You should try again.', zh: '你应该再试一次。', scene: 'free_chat_scene', query: 'child encouraging friend illustration' },
    { en: 'What would you do if you were me?', zh: '如果你是我，你会怎么做？', scene: 'free_chat_scene', query: 'children giving advice illustration' },
    { en: "I'm calling to ask about the course.", zh: '我打电话是想咨询课程。', scene: 'free_chat_scene', query: 'child making phone call illustration' },
    { en: 'Could you tell me how to get there?', zh: '你能告诉我怎么去那里吗？', scene: 'free_chat_scene', query: 'child asking directions illustration' },
    { en: 'The reason is that I was busy.', zh: '原因是我当时很忙。', scene: 'free_chat_scene', query: 'child explaining reason illustration' },
    { en: 'Although it was difficult, I finished it.', zh: '虽然很难，但我完成了。', scene: 'story_scene', query: 'child finishing difficult task illustration' },
    { en: "I'm looking forward to the trip.", zh: '我很期待这次旅行。', scene: 'free_chat_scene', query: 'child excited about trip illustration' },
    { en: 'That sounds like a good idea.', zh: '听起来是个好主意。', scene: 'free_chat_scene', query: 'children liking an idea illustration' },
    { en: 'It reminded me of my hometown.', zh: '它让我想起了家乡。', scene: 'story_scene', query: 'child remembering hometown illustration' },
    { en: "I'm thinking of joining the club.", zh: '我在考虑加入俱乐部。', scene: 'free_chat_scene', query: 'child considering joining club illustration' },
    { en: 'Could you give me some advice?', zh: '你能给我一些建议吗？', scene: 'free_chat_scene', query: 'child asking for advice illustration' },
    { en: "I'd rather stay at home tonight.", zh: '今晚我宁愿待在家里。', scene: 'free_chat_scene', query: 'child choosing to stay home illustration' },
    { en: 'The meeting has been put off.', zh: '会议被推迟了。', scene: 'free_chat_scene', query: 'postponed meeting calendar illustration' },
    { en: "It's not as easy as it looks.", zh: '这并不像看起来那么容易。', scene: 'free_chat_scene', query: 'child facing difficult task illustration' },
    { en: "I'm afraid I can't make it.", zh: '恐怕我去不了。', scene: 'free_chat_scene', query: 'child politely declining invitation illustration' },
  ],
  B2: [
    { en: 'From my perspective, the benefits are clear.', zh: '从我的角度看，好处很明显。', scene: 'free_chat_scene', query: 'children presenting ideas illustration' },
    { en: "I'd like to point out that the cost is high.", zh: '我想指出成本很高。', scene: 'free_chat_scene', query: 'child making a point discussion illustration' },
    { en: 'There is evidence that reading helps.', zh: '有证据表明阅读有帮助。', scene: 'free_chat_scene', query: 'children reading evidence illustration' },
    { en: 'This may lead to a bigger problem.', zh: '这可能导致更大的问题。', scene: 'free_chat_scene', query: 'children discussing consequences illustration' },
    { en: 'I see your point, but I disagree.', zh: '我明白你的意思，但我不同意。', scene: 'free_chat_scene', query: 'children debating illustration' },
    { en: 'To what extent do you agree?', zh: '你在多大程度上同意？', scene: 'free_chat_scene', query: 'classroom discussion illustration' },
    { en: 'We need to prioritize the most important task.', zh: '我们需要优先处理最重要的任务。', scene: 'free_chat_scene', query: 'children planning priorities illustration' },
    { en: 'What are the pros and cons?', zh: '利弊是什么？', scene: 'free_chat_scene', query: 'children weighing pros and cons illustration' },
    { en: "I'd like to propose a different plan.", zh: '我想提出一个不同的计划。', scene: 'free_chat_scene', query: 'child proposing plan illustration' },
    { en: 'Could you clarify what you mean?', zh: '你能说明一下你的意思吗？', scene: 'free_chat_scene', query: 'child asking clarification illustration' },
    { en: 'In the long run, it will save money.', zh: '从长远看，这会省钱。', scene: 'free_chat_scene', query: 'children thinking long term illustration' },
    { en: 'It depends on the weather.', zh: '这取决于天气。', scene: 'free_chat_scene', query: 'children checking weather illustration' },
    { en: "I'm not entirely convinced.", zh: '我不完全信服。', scene: 'free_chat_scene', query: 'child skeptical discussion illustration' },
    { en: "Let's reach a compromise.", zh: '我们各退一步吧。', scene: 'free_chat_scene', query: 'children reaching agreement illustration' },
    { en: 'This trend has become increasingly common.', zh: '这种趋势越来越普遍。', scene: 'free_chat_scene', query: 'students discussing a trend illustration' },
    { en: 'The figures suggest a steady decline.', zh: '数据显示持续下降。', scene: 'free_chat_scene', query: 'students reading a declining chart illustration' },
    { en: 'We need to weigh the risks against the benefits.', zh: '我们需要权衡风险与收益。', scene: 'free_chat_scene', query: 'students weighing risks and benefits illustration' },
    { en: "I'd like to build on that point.", zh: '我想在那个观点上继续展开。', scene: 'free_chat_scene', query: 'student building on an argument illustration' },
    { en: "It's worth considering the alternative.", zh: '值得考虑另一种选择。', scene: 'free_chat_scene', query: 'students considering alternatives illustration' },
    { en: 'That may not be the whole story.', zh: '那可能不是全部情况。', scene: 'free_chat_scene', query: 'student questioning a simple explanation illustration' },
    { en: "Let's put this into perspective.", zh: '我们把这个放在全局中看。', scene: 'free_chat_scene', query: 'students putting issue in perspective illustration' },
  ],
  C1: [
    { en: 'It could be argued that the policy is effective.', zh: '可以说这项政策是有效的。', scene: 'free_chat_scene', query: 'students debating policy illustration' },
    { en: 'This raises the question of fairness.', zh: '这引出了公平性的问题。', scene: 'free_chat_scene', query: 'students discussing fairness illustration' },
    { en: "I'd like to nuance that claim.", zh: '我想对这个说法做一点细微修正。', scene: 'free_chat_scene', query: 'student nuanced argument illustration' },
    { en: 'The underlying assumption is questionable.', zh: '这个潜在假设值得商榷。', scene: 'free_chat_scene', query: 'student questioning assumption illustration' },
    { en: 'To put it another way, the plan is risky.', zh: '换句话说，这个计划有风险。', scene: 'free_chat_scene', query: 'student rephrasing idea illustration' },
    { en: 'This is consistent with the earlier findings.', zh: '这与早先的发现一致。', scene: 'free_chat_scene', query: 'students comparing findings illustration' },
    { en: 'We should take into account the long-term effects.', zh: '我们应该考虑长期影响。', scene: 'free_chat_scene', query: 'students considering long term effects illustration' },
    { en: 'I would contend that the evidence is weak.', zh: '我认为证据不足。', scene: 'free_chat_scene', query: 'student evaluating evidence illustration' },
    { en: 'The evidence is inconclusive.', zh: '证据尚无定论。', scene: 'free_chat_scene', query: 'student reviewing inconclusive evidence illustration' },
    { en: 'With all due respect, I disagree.', zh: '恕我直言，我不同意。', scene: 'free_chat_scene', query: 'polite disagreement illustration' },
    { en: 'That said, the idea has merit.', zh: '话虽如此，这个想法有价值。', scene: 'free_chat_scene', query: 'balanced discussion illustration' },
    { en: 'It is worth noting that the sample is small.', zh: '值得注意的是样本很小。', scene: 'free_chat_scene', query: 'students noting sample size illustration' },
    { en: "I'm inclined to agree, provided that we test it.", zh: '如果测试过，我倾向于同意。', scene: 'free_chat_scene', query: 'conditional agreement illustration' },
    { en: 'Let me reframe the issue.', zh: '让我重新表述这个问题。', scene: 'free_chat_scene', query: 'student reframing issue illustration' },
    { en: 'The proposal is fraught with difficulties.', zh: '这项提议充满困难。', scene: 'free_chat_scene', query: 'students examining a difficult proposal illustration' },
    { en: 'We should not lose sight of the broader context.', zh: '我们不应忽视更广泛的背景。', scene: 'free_chat_scene', query: 'students discussing broader context illustration' },
    { en: 'This lends weight to the argument.', zh: '这为论点提供了支持。', scene: 'free_chat_scene', query: 'student supporting an argument illustration' },
    { en: 'I would hesitate to draw a firm conclusion.', zh: '我不会急于下定论。', scene: 'free_chat_scene', query: 'student pausing before conclusion illustration' },
    { en: 'The two explanations are not mutually exclusive.', zh: '这两种解释并不互斥。', scene: 'free_chat_scene', query: 'student comparing two explanations illustration' },
    { en: 'It is tempting, but ultimately unconvincing.', zh: '这很诱人，但最终缺乏说服力。', scene: 'free_chat_scene', query: 'student rejecting a tempting argument illustration' },
    { en: 'Let us examine the premises more closely.', zh: '让我们更仔细地审视前提。', scene: 'free_chat_scene', query: 'students examining premises illustration' },
  ],
  C2: [
    { en: 'There is a fine line between confidence and arrogance.', zh: '自信与傲慢之间只有一线之隔。', scene: 'free_chat_scene', query: 'abstract confidence arrogance illustration' },
    { en: 'That is a rather sweeping generalization.', zh: '那是一个相当笼统的概括。', scene: 'free_chat_scene', query: 'student challenging generalization illustration' },
    { en: 'I take your point, not least because the data support it.', zh: '我接受你的观点，尤其是因为数据支持它。', scene: 'free_chat_scene', query: 'student conceding with data illustration' },
    { en: 'The distinction is subtle but important.', zh: '这个区别很细微但很重要。', scene: 'free_chat_scene', query: 'student explaining subtle distinction illustration' },
    { en: 'One could argue, albeit cautiously, that it works.', zh: '可以谨慎地说，它是有效的。', scene: 'free_chat_scene', query: 'cautious argument illustration' },
    { en: 'This begs the question of who is responsible.', zh: '这引出了谁该负责的问题。', scene: 'free_chat_scene', query: 'student raising responsibility question illustration' },
    { en: 'The irony is not lost on me.', zh: '我并非没有察觉其中的讽刺。', scene: 'free_chat_scene', query: 'subtle irony illustration' },
    { en: 'I would stop short of saying it is perfect.', zh: '我不会说它完美。', scene: 'free_chat_scene', query: 'measured judgment illustration' },
    { en: 'It would be an overstatement to call it a failure.', zh: '称之为失败言过其实。', scene: 'free_chat_scene', query: 'student qualifying statement illustration' },
    { en: 'By the same token, we should not ignore the risks.', zh: '同样地，我们也不应忽视风险。', scene: 'free_chat_scene', query: 'balanced risk discussion illustration' },
    { en: 'That is not to say that the criticism is unfounded.', zh: '这并不是说批评没有根据。', scene: 'free_chat_scene', query: 'nuanced criticism illustration' },
    { en: 'Insofar as it concerns children, the rule is too strict.', zh: '就涉及儿童而言，这条规则太严了。', scene: 'free_chat_scene', query: 'child policy discussion illustration' },
    { en: 'The nuance here is easy to miss.', zh: '这里的细微差别很容易被忽略。', scene: 'free_chat_scene', query: 'student highlighting nuance illustration' },
    { en: 'We may be conflating two different issues.', zh: '我们可能把两个不同的问题混为一谈。', scene: 'free_chat_scene', query: 'student separating two issues illustration' },
    { en: 'The argument rests on a dubious premise.', zh: '这个论点建立在一个可疑的前提上。', scene: 'free_chat_scene', query: 'student questioning a premise illustration' },
    { en: 'Such a reading strains credulity.', zh: '这样的解读难以令人信服。', scene: 'free_chat_scene', query: 'student skeptical of an interpretation illustration' },
    { en: 'The parallels are suggestive rather than conclusive.', zh: '这些相似之处只是暗示性的，而非结论性的。', scene: 'free_chat_scene', query: 'student comparing suggestive parallels illustration' },
    { en: 'I would resist that characterization.', zh: '我不认同那种描述。', scene: 'free_chat_scene', query: 'student rejecting a characterization illustration' },
    { en: 'The caveat is by no means trivial.', zh: '这个保留意见绝非小事。', scene: 'free_chat_scene', query: 'student emphasizing a caveat illustration' },
    { en: 'His rejoinder was measured but firm.', zh: '他的反驳克制而坚定。', scene: 'free_chat_scene', query: 'measured but firm reply illustration' },
    { en: 'The evidence, such as it is, points the other way.', zh: '现有证据虽然有限，却指向相反方向。', scene: 'free_chat_scene', query: 'student interpreting limited evidence illustration' },
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
  hand: { zh: '手', phonetic: '/hænd/' },
  eye: { zh: '眼睛', phonetic: '/aɪ/' },
  nose: { zh: '鼻子', phonetic: '/noʊz/' },
  mouth: { zh: '嘴', phonetic: '/maʊθ/' },
  ear: { zh: '耳朵', phonetic: '/ɪr/' },
  rice: { zh: '米饭', phonetic: '/raɪs/' },
  noodles: { zh: '面条', phonetic: '/ˈnuːdəlz/' },
  chicken: { zh: '鸡肉', phonetic: '/ˈtʃɪkɪn/' },
  fish: { zh: '鱼', phonetic: '/fɪʃ/' },
  juice: { zh: '果汁', phonetic: '/dʒuːs/' },
  airport: { zh: '机场', phonetic: '/ˈerpɔːrt/' },
  hotel: { zh: '酒店', phonetic: '/hoʊˈtel/' },
  restaurant: { zh: '餐馆', phonetic: '/ˈrestərɑːnt/' },
  cinema: { zh: '电影院', phonetic: '/ˈsɪnəmə/' },
  beach: { zh: '海滩', phonetic: '/biːtʃ/' },
  volunteer: { zh: '志愿者', phonetic: '/ˌvɑːlənˈtɪr/' },
  community: { zh: '社区', phonetic: '/kəˈmjuːnəti/' },
  transport: { zh: '交通', phonetic: '/ˈtrænspɔːrt/' },
  schedule: { zh: '日程安排', phonetic: '/ˈskedʒuːl/' },
  goal: { zh: '目标', phonetic: '/ɡoʊl/' },
  innovation: { zh: '创新', phonetic: '/ˌɪnəˈveɪʃən/' },
  sustainable: { zh: '可持续的', phonetic: '/səˈsteɪnəbəl/' },
  priority: { zh: '优先事项', phonetic: '/praɪˈɔːrəti/' },
  negotiate: { zh: '协商', phonetic: '/nɪˈɡoʊʃieɪt/' },
  impact: { zh: '影响', phonetic: '/ˈɪmpækt/' },
  pragmatic: { zh: '务实的', phonetic: '/præɡˈmætɪk/' },
  resilient: { zh: '有韧性的', phonetic: '/rɪˈzɪliənt/' },
  substantiate: { zh: '证实', phonetic: '/səbˈstænʃieɪt/' },
  undermine: { zh: '削弱', phonetic: '/ˌʌndərˈmaɪn/' },
  prevalent: { zh: '普遍的', phonetic: '/ˈprevələnt/' },
  ubiquitous: { zh: '无处不在的', phonetic: '/juːˈbɪkwɪtəs/' },
  meticulous: { zh: '一丝不苟的', phonetic: '/məˈtɪkjələs/' },
  candid: { zh: '坦率的', phonetic: '/ˈkændɪd/' },
  profound: { zh: '深刻的', phonetic: '/prəˈfaʊnd/' },
  vindicate: { zh: '证明……正确', phonetic: '/ˈvɪndɪkeɪt/' },
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
    levels: (Object.keys(CEFR_PRESET_WORDS) as CefrCurriculumLevel[]).map((level) => {
      const prefix = level.toLowerCase().replace(/[^a-z0-9]/g, '');
      const wordUnits = buildUnits(level, CEFR_PRESET_WORDS[level], 5, prefix);
      const extensionUnits = buildUnits(level, CEFR_EXTENSION_WORDS[level], 5, `${prefix}-x`);
      extensionUnits.forEach((unit, index) => {
        unit.title = `${CEFR_LEVEL_NAMES[level]} · 拓展词 ${index + 1}`;
        unit.order = wordUnits.length + index;
      });
      return {
        code: level,
        nameZh: CEFR_LEVEL_NAMES[level],
        canDo: CEFR_CAN_DO[level],
        units: [
          ...wordUnits,
          ...extensionUnits,
          ...buildExpressionUnits(
            level,
            CEFR_DAILY_EXPRESSIONS[level],
            prefix,
            wordUnits.length + extensionUnits.length,
          ),
        ],
      };
    }),
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

function buildExpressionUnits(
  level: CefrCurriculumLevel,
  expressions: DailyExpression[],
  prefix: string,
  startOrder: number,
): CefrUnit[] {
  const units: CefrUnit[] = [];
  const unitSize = 7;
  for (let offset = 0; offset < expressions.length; offset += unitSize) {
    const chunk = expressions.slice(offset, offset + unitSize);
    const unitNo = Math.floor(offset / unitSize) + 1;
    const code = `${prefix}-d${String(unitNo).padStart(2, '0')}`;
    const vocabulary = chunk.map((expression, index) => expressionVocabulary(expression, code, index));
    const patterns = chunk.slice(0, 2).map((expression) => ({ en: expression.en, zh: expression.zh }));
    units.push({
      code,
      title: `${CEFR_LEVEL_NAMES[level]} · 日常用语 ${unitNo}`,
      order: startOrder + unitNo - 1,
      objectives: [
        `能在真实情境中听懂并回应：${chunk.slice(0, 2).map((item) => item.zh).join('、')}`,
        '能把日常用语和场景图片对应起来',
        '能在角色对话中主动说出目标表达',
      ],
      vocabulary,
      patterns,
      lessons: buildExpressionLessons(code, chunk, vocabulary, level),
    });
  }
  return units;
}

function expressionVocabulary(expression: DailyExpression, unitCode: string, index: number): CefrVocabularyEntry {
  return {
    word: expression.en,
    phonetic: '',
    meaningZh: expression.zh,
    syllables: [],
    difficultPhonemes: difficultPhonemes(expression.en),
    phrases: [expression.en],
    exampleSentences: [{ en: expression.en, zh: expression.zh }],
    image: {
      key: `img:${unitCode}:expr:${index}`,
      kind: 'scene',
      targetText: expression.en,
      query: expression.query,
      alt: `${expression.zh} 的情境图片`,
    },
  };
}

function buildExpressionLessons(
  unitCode: string,
  expressions: DailyExpression[],
  vocabulary: CefrVocabularyEntry[],
  level: CefrCurriculumLevel,
): CefrLesson[] {
  const lessons: CefrLesson[] = [];
  for (const [index, expression] of expressions.entries()) {
    const image = vocabulary[index]?.image;
    const sceneImage = image ? [image] : [];
    lessons.push(makeLesson({
      id: `${unitCode}:${lessons.length}`,
      title: `听一听：${expression.zh}`,
      taskType: 'listening_comprehension',
      scenario: expression.scene,
      skillNodeIds: ['LA.LISTEN.instruction'],
      targetWords: [expression.en],
      teacherUtteranceZh: '听一听，选出正确的日常用语。',
      demonstrationText: expression.en,
      requiresPronunciationAssessment: false,
      requiresAsr: false,
      assessment: { acceptedTexts: [expression.en] },
      difficulty: levelDifficulty(level),
      imageRequirements: sceneImage,
    }), makeLesson({
      id: `${unitCode}:${lessons.length + 1}`,
      title: `跟着说：${expression.zh}`,
      taskType: 'word_mimicry',
      scenario: expression.scene,
      skillNodeIds: ['LA.SPEAK.imitation'],
      targetWords: [expression.en],
      teacherUtteranceZh: '跟着老师慢慢说这句话。',
      demonstrationText: expression.en,
      requiresPronunciationAssessment: true,
      requiresAsr: false,
      assessment: { acceptedTexts: [expression.en] },
      difficulty: levelDifficulty(level),
      imageRequirements: sceneImage,
    }), makeLesson({
      id: `${unitCode}:${lessons.length + 2}`,
      title: `情境表达：${expression.zh}`,
      taskType: 'situational_dialogue',
      scenario: expression.scene,
      skillNodeIds: ['LA.COMM.dialogue'],
      targetWords: [expression.en],
      teacherUtteranceZh: `在「${expression.zh}」的情境里，试着这样说。`,
      demonstrationText: expression.en,
      requiresPronunciationAssessment: false,
      requiresAsr: true,
      assessment: { acceptedTexts: [expression.en] },
      difficulty: Math.min(5, levelDifficulty(level) + 1),
      imageRequirements: sceneImage,
    }));
  }
  lessons.push(makeLesson({
    id: `${unitCode}:${lessons.length}`,
    title: '日常用语复习：听辨',
    taskType: 'listening_comprehension',
    scenario: 'review_scene',
    skillNodeIds: ['LA.LISTEN.instruction'],
    targetWords: expressions.map((item) => item.en),
    teacherUtteranceZh: '我们复习这一组日常用语。听一听，选出正确的表达。',
    demonstrationText: expressions[0]?.en || '',
    requiresPronunciationAssessment: false,
    requiresAsr: false,
    assessment: { acceptedTexts: expressions.map((item) => item.en) },
    difficulty: levelDifficulty(level),
    imageRequirements: vocabulary.slice(0, 7).flatMap((item) => item.image ? [item.image] : []),
  }));
  const pattern = expressions[0]?.en || '';
  lessons.push(makeLesson({
    id: `${unitCode}:${lessons.length}`,
    title: '日常用语复习：情境对话',
    taskType: 'situational_dialogue',
    scenario: 'free_chat_scene',
    skillNodeIds: ['LA.COMM.dialogue'],
    targetWords: [pattern],
    teacherUtteranceZh: '现在换你来说。请根据情境回应老师。',
    demonstrationText: pattern,
    requiresPronunciationAssessment: false,
    requiresAsr: true,
    assessment: { acceptedTexts: expressions.map((item) => item.en) },
    difficulty: Math.min(5, levelDifficulty(level) + 1),
    imageRequirements: vocabulary[0]?.image ? [vocabulary[0].image] : [],
  }));
  return lessons;
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
      kind: 'word',
      targetWord: word,
      targetText: word,
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
      imageRequirements: item.image ? [item.image] : [],
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
      imageRequirements: item.image ? [item.image] : [],
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
      imageRequirements: [
        ...(item.image ? [item.image] : []),
        ...(index === 0 ? [phraseImageFor(unitCode, word, example, item.meaningZh)] : []),
      ],
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
    imageRequirements: vocabulary.slice(0, 6).flatMap((item) => item.image ? [item.image] : []),
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
    imageRequirements: [sceneImageFor(unitCode, pattern, patterns[0]?.zh || '')],
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
  imageRequirements: CefrImageRequirement[];
}): CefrLesson {
  const speechText = [input.teacherUtteranceZh, input.demonstrationText].filter(Boolean).join(' ');
  const imageRequirements = [...new Map(input.imageRequirements.map((item) => [item.key, item])).values()];
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
    imageRequirements,
    media: {
      speechKey: input.id,
      speechText,
      imageKeys: imageRequirements.map((item) => item.key),
    },
  };
}

function phraseImageFor(unitCode: string, word: string, example: string, meaningZh: string): CefrImageRequirement {
  return {
    key: `img:${unitCode}:phrase:${slug(word)}`,
    kind: 'phrase',
    targetWord: word,
    targetText: example,
    query: `${example} children illustration`.slice(0, 300),
    alt: `${meaningZh || example} 的短句配图`.slice(0, 300),
  };
}

function sceneImageFor(unitCode: string, pattern: string, meaningZh: string): CefrImageRequirement {
  return {
    key: `img:${unitCode}:scene`,
    kind: 'scene',
    targetText: pattern,
    query: `${pattern} children scene illustration`.slice(0, 300),
    alt: `${meaningZh || pattern} 的情境配图`.slice(0, 300),
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

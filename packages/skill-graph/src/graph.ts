/**
 * 能力知识图谱。
 *
 * 依据：D-006「学习者智能引擎：核心资产，自主开发」——
 *      第一版用 PostgreSQL 关系表实现能力图谱，核心表为 skill_nodes、
 *      skill_dependencies、learner_skill_states、learning_evidence。
 *      不引入图数据库，保留孩子的已有优势（依赖不能僵化）。
 *
 * 本文件提供 M1 首批能力节点（问候 / 自我介绍 / 身边物品三主题），
 * 以及依赖关系的查询与教学解锁判定。
 */
import type {
  DependencyType,
  GrowthStage,
  SkillDependency,
  SkillNode,
} from '@alg/shared-contracts';

/** M1 首批能力节点（种子数据）。 */
export const M1_SKILL_NODES: SkillNode[] = [
  // —— 阶段 0：语言启蒙与适应 ——
  {
    id: 'LA.LISTEN.greeting_core',
    code: 'LA.LISTEN.greeting_core',
    name: '高频表达听辨',
    abilityCategory: 'listening',
    growthStage: 0,
    track: 'language_acquisition',
    dimensions: [],
    objective: '听懂 Hello、Bye、Yes、No 等高频表达并做出反应',
    masteryCriteria: '在两个不同场景中独立听辨并作出正确反应，且隔天无提示仍能听懂',
    m1Scope: true,
  },
  {
    id: 'LA.SPEAK.imitation',
    code: 'LA.SPEAK.imitation',
    name: '模仿发声',
    abilityCategory: 'speaking',
    growthStage: 0,
    track: 'language_acquisition',
    dimensions: [],
    objective: '愿意听、愿意模仿，能跟读单个词',
    masteryCriteria: '在提示下能跟读目标词发音',
    m1Scope: true,
  },
  {
    id: 'LA.LISTEN.instruction',
    code: 'LA.LISTEN.instruction',
    name: '简单指令理解',
    abilityCategory: 'listening',
    growthStage: 0,
    track: 'language_acquisition',
    dimensions: [],
    objective: '听懂「Touch the apple」这类简单指令并做出动作',
    masteryCriteria: '在两个不同场景中独立听懂简单指令并执行，且隔天无提示仍可执行',
    m1Scope: true,
  },
  {
    id: 'LA.PRON.short_vowels',
    code: 'LA.PRON.short_vowels',
    name: '短元音发音',
    abilityCategory: 'pronunciation',
    growthStage: 2,
    track: 'language_acquisition',
    dimensions: [],
    objective: '稳定发出常见短元音 /ɪ/ /e/ /æ/ 等',
    masteryCriteria: '发音评估在两个不同场景中均达标且隔天无提示回忆仍达标',
    m1Scope: true,
  },

  // —— 阶段 1：听力理解与语言反应 ——
  {
    id: 'LA.LISTEN.word_recognition',
    code: 'LA.LISTEN.word_recognition',
    name: '词汇听辨',
    abilityCategory: 'listening',
    growthStage: 1,
    track: 'language_acquisition',
    dimensions: ['heard_identify'],
    objective: '听到单词能识别对应图片或物体',
    masteryCriteria: '在两个不同场景中独立听辨正确，且隔天无提示仍能听辨',
    m1Scope: true,
  },
  {
    id: 'LA.VOCAB.receptive',
    code: 'LA.VOCAB.receptive',
    name: '被动词汇',
    abilityCategory: 'vocabulary',
    growthStage: 1,
    track: 'language_acquisition',
    dimensions: ['heard_identify'],
    objective: '积累能听懂的日常词',
    masteryCriteria: '在两个不同场景中独立听懂并指认，且隔天无提示仍可',
    m1Scope: true,
  },

  // —— 阶段 2：声音辨别与发音形成 ——
  {
    id: 'LA.PRON.phonemes',
    code: 'LA.PRON.phonemes',
    name: '目标音素发音',
    abilityCategory: 'pronunciation',
    growthStage: 2,
    track: 'language_acquisition',
    dimensions: [],
    objective: '对目标词中的困难音素能单独发音并合成进单词',
    masteryCriteria: '困难音单独评估与进词评估均达标，且跨场景稳定',
    m1Scope: true,
  },
  {
    id: 'LA.PRON.syllable',
    code: 'LA.PRON.syllable',
    name: '音节切分与拼合',
    abilityCategory: 'pronunciation',
    growthStage: 2,
    track: 'language_acquisition',
    dimensions: [],
    objective: '能把单词按音节拆开逐个示范，再合起来，最后恢复自然语速',
    masteryCriteria: '两个不同场景中音节切分与拼合均稳定',
    m1Scope: true,
  },

  // —— 阶段 3：词汇理解与主动表达 ——
  {
    id: 'LA.VOCAB.expressive',
    code: 'LA.VOCAB.expressive',
    name: '主动词汇',
    abilityCategory: 'vocabulary',
    growthStage: 3,
    track: 'language_acquisition',
    dimensions: ['seen_speak', 'heard_pronounce'],
    objective: '看到图片能主动说出单词',
    masteryCriteria: '在两个不同场景中独立说出，且隔天无提示仍能说出',
    m1Scope: true,
  },
  {
    id: 'LA.SPEAK.single_words',
    code: 'LA.SPEAK.single_words',
    name: '单词表达',
    abilityCategory: 'speaking',
    growthStage: 3,
    track: 'language_acquisition',
    dimensions: [],
    objective: '能用单个英文词表达需求',
    masteryCriteria: '两个不同场景中独立用词表达，隔天无提示仍可',
    m1Scope: true,
  },
  {
    id: 'LA.VOCAB.context_use',
    code: 'LA.VOCAB.context_use',
    name: '情境中词汇使用',
    abilityCategory: 'vocabulary',
    growthStage: 3,
    track: 'language_acquisition',
    dimensions: ['use_in_sentence', 'use_in_new_context'],
    objective: '能在句子与新情境中主动使用已学词',
    masteryCriteria: '两个不同场景中独立使用，且隔天无提示仍能使用',
    m1Scope: true,
  },

  // —— 阶段 4：短语与完整句子 ——
  {
    id: 'LA.SPEAK.phrases',
    code: 'LA.SPEAK.phrases',
    name: '短语表达',
    abilityCategory: 'speaking',
    growthStage: 4,
    track: 'language_acquisition',
    dimensions: [],
    objective: '能用两词组合或固定短语表达',
    masteryCriteria: '两个不同场景中独立使用短语，隔天无提示仍可',
    m1Scope: true,
  },
  {
    id: 'LA.SPEAK.simple_sentences',
    code: 'LA.SPEAK.simple_sentences',
    name: '简单句表达',
    abilityCategory: 'speaking',
    growthStage: 4,
    track: 'language_acquisition',
    dimensions: [],
    objective: '能说主谓结构的简单句',
    masteryCriteria: '两个不同场景中独立造句，隔天无提示仍可',
    m1Scope: true,
  },
  {
    id: 'LA.GRAM.basic_pattern',
    code: 'LA.GRAM.basic_pattern',
    name: '基本句型',
    abilityCategory: 'grammar',
    growthStage: 4,
    track: 'language_acquisition',
    dimensions: [],
    objective: '理解 I am / This is / I like 的结构',
    masteryCriteria: '两个不同场景中正确替换内容使用，隔天无提示仍可',
    m1Scope: true,
  },

  // —— 阶段 5：对话与语言组织 ——
  {
    id: 'LA.COMM.dialogue',
    code: 'LA.COMM.dialogue',
    name: '情景对话',
    abilityCategory: 'communication',
    growthStage: 5,
    track: 'language_acquisition',
    dimensions: [],
    objective: '在自我介绍、购物等场景中双向交流',
    masteryCriteria: '两个不同场景中独立完成对话，隔天无提示仍可',
    m1Scope: false,
  },
  {
    id: 'LA.COMM.respond',
    code: 'LA.COMM.respond',
    name: '回应提问',
    abilityCategory: 'communication',
    growthStage: 5,
    track: 'language_acquisition',
    dimensions: [],
    objective: '能听懂并回应简单提问',
    masteryCriteria: '两个不同场景中独立回应，隔天无提示仍可',
    m1Scope: false,
  },

  // —— 阶段 6：自主日常交流 ——
  {
    id: 'LA.COMM.free_talk',
    code: 'LA.COMM.free_talk',
    name: '自主日常交流',
    abilityCategory: 'communication',
    growthStage: 6,
    track: 'language_acquisition',
    dimensions: [],
    objective: '能谈当天发生的事，讲简单经历',
    masteryCriteria: '两个不同场景中独立展开话题，隔天无提示仍可',
    m1Scope: false,
  },

  // —— 学校英语轨（贯穿所有阶段，M1 只做字母认知的最小部分）——
  {
    id: 'SE.SCHOOL.letters',
    code: 'SE.SCHOOL.letters',
    name: '字母认知',
    abilityCategory: 'school_english',
    growthStage: 1,
    track: 'school_english',
    dimensions: [],
    objective: '认识 26 个字母，区分大小写',
    masteryCriteria: '两个不同场景中独立辨认，且隔天无提示仍可',
    m1Scope: true,
  },
  {
    id: 'SE.SCHOOL.word_reading',
    code: 'SE.SCHOOL.word_reading',
    name: '单词识读',
    abilityCategory: 'school_english',
    growthStage: 3,
    track: 'school_english',
    dimensions: [],
    objective: '看到印刷单词能读出',
    masteryCriteria: '两个不同场景中独立识读，隔天无提示仍可',
    m1Scope: true,
  },
  {
    id: 'SE.SCHOOL.phonics',
    code: 'SE.SCHOOL.phonics',
    name: '自然拼读',
    abilityCategory: 'school_english',
    growthStage: 4,
    track: 'school_english',
    dimensions: [],
    objective: '建立字母与语音的联系，能拼读简单词',
    masteryCriteria: '两个不同场景中独立拼读，隔天无提示仍可',
    m1Scope: false,
  },
  {
    id: 'SE.SCHOOL.spelling',
    code: 'SE.SCHOOL.spelling',
    name: '拼写',
    abilityCategory: 'school_english',
    growthStage: 4,
    track: 'school_english',
    dimensions: [],
    objective: '能拼写已学单词',
    masteryCriteria: '两个不同场景中独立拼写，隔天无提示仍可',
    m1Scope: false,
  },
  {
    id: 'SE.SCHOOL.reading',
    code: 'SE.SCHOOL.reading',
    name: '基础阅读理解',
    abilityCategory: 'school_english',
    growthStage: 5,
    track: 'school_english',
    dimensions: [],
    objective: '能读懂短句与小故事',
    masteryCriteria: '两个不同场景中独立理解，隔天无提示仍可',
    m1Scope: false,
  },
  {
    id: 'SE.SCHOOL.writing',
    code: 'SE.SCHOOL.writing',
    name: '基础写作',
    abilityCategory: 'school_english',
    growthStage: 6,
    track: 'school_english',
    dimensions: [],
    objective: '能书写字母与单词',
    masteryCriteria: '两个不同场景中独立书写，隔天无提示仍可',
    m1Scope: false,
  },
];

/**
 * M1 首批能力依赖关系。
 *
 * 语义（评审确定）：
 *  - dependency_type = 'prerequisite' 且 required = true → 硬前置，未达成则该能力暂不排课
 *  - dependency_type = 'related' / 'parallel' → 仅供教学参考，**永不作为前置门槛**，
 *    否则会把「相关」误当「必须先学」，把能力图谱变成刚性关卡（D-004 明确阶段不是关卡）
 *  - dependency_type = 'parallel' → 显式表达双轨并行，两条轨互不阻塞（D-002）
 *
 * 依赖方向：dependsOn 是「更早、更基础」的能力，不得反向。
 */
export const M1_SKILL_DEPENDENCIES: SkillDependency[] = [
  // —— 语言习得轨：声音与意义 ——
  { id: 'dep-01', skillNodeId: 'LA.LISTEN.greeting_core', dependsOnSkillNodeId: 'LA.LISTEN.instruction', dependencyType: 'prerequisite', required: true },
  { id: 'dep-02', skillNodeId: 'LA.LISTEN.word_recognition', dependsOnSkillNodeId: 'LA.LISTEN.greeting_core', dependencyType: 'prerequisite', required: true },
  { id: 'dep-03', skillNodeId: 'LA.SPEAK.imitation', dependsOnSkillNodeId: 'LA.LISTEN.greeting_core', dependencyType: 'prerequisite', required: true },
  { id: 'dep-04', skillNodeId: 'LA.PRON.syllable', dependsOnSkillNodeId: 'LA.SPEAK.imitation', dependencyType: 'prerequisite', required: true },
  { id: 'dep-05', skillNodeId: 'LA.PRON.phonemes', dependsOnSkillNodeId: 'LA.PRON.syllable', dependencyType: 'prerequisite', required: true },
  { id: 'dep-06', skillNodeId: 'LA.PRON.short_vowels', dependsOnSkillNodeId: 'LA.PRON.syllable', dependencyType: 'related', required: false },

  // —— 语言习得轨：词汇与表达 ——
  { id: 'dep-07', skillNodeId: 'LA.VOCAB.receptive', dependsOnSkillNodeId: 'LA.LISTEN.word_recognition', dependencyType: 'prerequisite', required: true },
  { id: 'dep-08', skillNodeId: 'LA.VOCAB.expressive', dependsOnSkillNodeId: 'LA.VOCAB.receptive', dependencyType: 'prerequisite', required: true },
  { id: 'dep-09', skillNodeId: 'LA.SPEAK.single_words', dependsOnSkillNodeId: 'LA.VOCAB.expressive', dependencyType: 'prerequisite', required: true },
  { id: 'dep-10', skillNodeId: 'LA.VOCAB.context_use', dependsOnSkillNodeId: 'LA.VOCAB.expressive', dependencyType: 'prerequisite', required: true },
  { id: 'dep-11', skillNodeId: 'LA.SPEAK.phrases', dependsOnSkillNodeId: 'LA.SPEAK.single_words', dependencyType: 'prerequisite', required: true },
  { id: 'dep-12', skillNodeId: 'LA.SPEAK.simple_sentences', dependsOnSkillNodeId: 'LA.SPEAK.phrases', dependencyType: 'prerequisite', required: true },
  { id: 'dep-13', skillNodeId: 'LA.GRAM.basic_pattern', dependsOnSkillNodeId: 'LA.SPEAK.simple_sentences', dependencyType: 'related', required: false },

  // —— 语言习得轨：交流 ——
  { id: 'dep-14', skillNodeId: 'LA.COMM.respond', dependsOnSkillNodeId: 'LA.SPEAK.simple_sentences', dependencyType: 'prerequisite', required: true },
  { id: 'dep-15', skillNodeId: 'LA.COMM.dialogue', dependsOnSkillNodeId: 'LA.COMM.respond', dependencyType: 'prerequisite', required: true },
  { id: 'dep-16', skillNodeId: 'LA.COMM.free_talk', dependsOnSkillNodeId: 'LA.COMM.dialogue', dependencyType: 'prerequisite', required: true },

  // —— 学校英语轨 ——
  { id: 'dep-17', skillNodeId: 'SE.SCHOOL.word_reading', dependsOnSkillNodeId: 'SE.SCHOOL.letters', dependencyType: 'prerequisite', required: true },
  { id: 'dep-18', skillNodeId: 'SE.SCHOOL.phonics', dependsOnSkillNodeId: 'SE.SCHOOL.letters', dependencyType: 'prerequisite', required: true },
  { id: 'dep-19', skillNodeId: 'SE.SCHOOL.spelling', dependsOnSkillNodeId: 'SE.SCHOOL.phonics', dependencyType: 'prerequisite', required: true },
  { id: 'dep-20', skillNodeId: 'SE.SCHOOL.reading', dependsOnSkillNodeId: 'SE.SCHOOL.word_reading', dependencyType: 'prerequisite', required: true },
  { id: 'dep-21', skillNodeId: 'SE.SCHOOL.writing', dependsOnSkillNodeId: 'SE.SCHOOL.spelling', dependencyType: 'prerequisite', required: true },
  { id: 'dep-22', skillNodeId: 'SE.SCHOOL.phonics', dependsOnSkillNodeId: 'LA.VOCAB.receptive', dependencyType: 'related', required: false },

  // —— 双轨并行：口语优势不得被字母进度锁住，反之亦然（D-002）——
  { id: 'dep-23', skillNodeId: 'LA.SPEAK.simple_sentences', dependsOnSkillNodeId: 'SE.SCHOOL.letters', dependencyType: 'parallel', required: false },
  { id: 'dep-24', skillNodeId: 'SE.SCHOOL.word_reading', dependsOnSkillNodeId: 'LA.VOCAB.receptive', dependencyType: 'parallel', required: false },
];

/** 能力图谱查询接口。 */
export class SkillGraph {
  private readonly nodes: Map<string, SkillNode>;
  private readonly byCode: Map<string, SkillNode>;
  private readonly dependencies: SkillDependency[];

  constructor(nodes: SkillNode[] = M1_SKILL_NODES, dependencies: SkillDependency[] = M1_SKILL_DEPENDENCIES) {
    this.nodes = new Map(nodes.map((n) => [n.id, n]));
    this.byCode = new Map(nodes.map((n) => [n.code, n]));
    this.dependencies = dependencies;
  }

  getNode(id: string): SkillNode | undefined {
    return this.nodes.get(id);
  }

  getNodeByCode(code: string): SkillNode | undefined {
    return this.byCode.get(code);
  }

  allNodes(): SkillNode[] {
    return [...this.nodes.values()];
  }

  /** 全部依赖关系。 */
  allDependencies(): SkillDependency[] {
    return [...this.dependencies];
  }

  m1Nodes(): SkillNode[] {
    return this.allNodes().filter((n) => n.m1Scope);
  }

  /** 直接前置能力。 */
  prerequisites(skillNodeId: string): SkillNode[] {
    return this.dependencies
      .filter((d) => d.skillNodeId === skillNodeId && d.dependencyType === 'prerequisite')
      .map((d) => this.nodes.get(d.dependsOnSkillNodeId))
      .filter((n): n is SkillNode => n !== undefined);
  }

  /** 直接后续能力。 */
  dependents(skillNodeId: string): SkillNode[] {
    return this.dependencies
      .filter((d) => d.dependsOnSkillNodeId === skillNodeId)
      .map((d) => this.nodes.get(d.skillNodeId))
      .filter((n): n is SkillNode => n !== undefined);
  }

  /** 某成长阶段的能力节点。 */
  nodesAtStage(stage: GrowthStage): SkillNode[] {
    return this.allNodes().filter((n) => n.growthStage === stage);
  }

  /**
   * 硬前置是否已达成。
   *
   * 只有 dependency_type='prerequisite' 且 required=true 的关系才构成门槛。
   * related / parallel 仅供教学参考，永不阻塞（D-004 阶段不是关卡）。
   *
   * usedStates: skillNodeId -> masteryState
   */
  prerequisitesMet(
    skillNodeId: string,
    usedStates: Record<string, string>,
  ): { met: boolean; blockedBy: string[] } {
    const blockers = this.dependencies
      .filter(
        (d) =>
          d.skillNodeId === skillNodeId &&
          d.dependencyType === 'prerequisite' &&
          d.required,
      )
      .filter((d) => {
        const state = usedStates[d.dependsOnSkillNodeId] ?? 'not_exposed';
        return state !== 'mastered' && state !== 'transferred';
      })
      .map((d) => d.dependsOnSkillNodeId);
    return { met: blockers.length === 0, blockedBy: blockers };
  }
}

export * from './mastery';
export type { DependencyType };

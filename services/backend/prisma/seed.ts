/**
 * M1 种子数据。
 *
 * 灌入内容：
 *  - scenarios：场景定义（「两个不同场景」硬规则的唯一载体）
 *  - assessment_thresholds：评估阈值（M1 全部 m1_provisional / uncalibrated）
 *  - curriculum_stages：七个成长阶段
 *  - skill_nodes + skill_dependencies：能力知识图谱（来自 @alg/skill-graph）
 *  - vocabulary_items / sentence_patterns：知识层内容（来自 @alg/curriculum）
 *  - teacher_profiles：固定人格（M1 只用固定人格 + 会话记忆）
 *
 * ⚠️ 课程内容全部标记 pending_review —— 发音与自然拼读必须经人工审核后发布（D-022）。
 */
import { PrismaClient } from '@prisma/client';
import { M1_SKILL_DEPENDENCIES, M1_SKILL_NODES } from '@alg/skill-graph';
import { M1_ACTIVITIES, M1_SENTENCE_PATTERNS, M1_TOPICS, M1_VOCABULARY } from '@alg/curriculum';

const prisma = new PrismaClient();

/** M1 场景定义。 */
const SCENARIOS = [
  { id: 'sc-greeting', code: 'greeting_scene', name: '问候情景', description: '打招呼与道别的情景交互', countsForTransfer: true },
  { id: 'sc-self-intro', code: 'self_intro_scene', name: '自我介绍情景', description: '介绍自己名字与年龄的情景', countsForTransfer: true },
  { id: 'sc-object-pic', code: 'object_pic_scene', name: '图片识别情景', description: '看图说词的情景', countsForTransfer: true },
  { id: 'sc-object-shop', code: 'object_shop_scene', name: '新情境用词', description: '在购物等新情境中使用已学词', countsForTransfer: true },
  { id: 'sc-free-chat', code: 'free_chat_scene', name: '自由交流情景', description: '孩子自由表达的情景', countsForTransfer: true },
  { id: 'sc-story', code: 'story_scene', name: '故事语境情景', description: '小故事语境中的理解与表达', countsForTransfer: true },
  { id: 'sc-review', code: 'review_scene', name: '复习场次', description: '间隔重复的复习场次，不计入无提示回忆', countsForTransfer: false },
  { id: 'sc-assessment', code: 'assessment_scene', name: '评估场次', description: '正式能力评估场次，不计入无提示回忆', countsForTransfer: false },
];

/**
 * M1 阈值配置。
 *
 * ⚠️ 全部标记 m1_provisional + uncalibrated：
 *    原型的 85 分只是示意值，正式阈值必须用真实 6-9 岁中国儿童录音标定
 *    （D-010 / 任务书第 9 章）。M1 不对外声称「已掌握」。
 */
const THRESHOLDS = [
  {
    taskType: 'word_mimicry',
    scenario: null,
    passScore: 85,
    minSamplesForming: 2,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'pronunciation_drill',
    scenario: null,
    passScore: 85,
    minSamplesForming: 2,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'listening_comprehension',
    scenario: null,
    passScore: 80,
    minSamplesForming: 2,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'image_identification',
    scenario: null,
    passScore: 80,
    minSamplesForming: 2,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'phrase_assembly',
    scenario: null,
    passScore: 80,
    minSamplesForming: 2,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'sentence_pattern',
    scenario: null,
    passScore: 80,
    minSamplesForming: 2,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'situational_dialogue',
    scenario: null,
    passScore: 80,
    minSamplesForming: 2,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'reading_story',
    scenario: null,
    passScore: 80,
    minSamplesForming: 1,
    minSamplesMastered: 2,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
  {
    taskType: 'free_response',
    scenario: null,
    passScore: 70,
    minSamplesForming: 2,
    minSamplesMastered: 3,
    minScenariosTransferred: 2,
    minIntervalTransferredMs: 86400000,
  },
];

/** 七个成长阶段。 */
const STAGES = [
  { id: 'stage-0', stage: 0, code: 'orientation', name: '语言启蒙与适应', objective: '熟悉英语声音与老师的声音，愿意听、愿意模仿' },
  { id: 'stage-1', stage: 1, code: 'listening_reaction', name: '听力理解与语言反应', objective: '建立声音与意义的联系' },
  { id: 'stage-2', stage: 2, code: 'sound_formation', name: '声音辨别与发音形成', objective: '听辨相似音、模仿发音、专业评估记录易错音' },
  { id: 'stage-3', stage: 3, code: 'vocabulary_expression', name: '词汇理解与主动表达', objective: '按主题建立有类别、有场景的词汇体系' },
  { id: 'stage-4', stage: 4, code: 'phrase_sentence', name: '短语与完整句子', objective: '从单词到短语、主谓结构、简单句' },
  { id: 'stage-5', stage: 5, code: 'dialogue_organization', name: '对话与语言组织', objective: '围绕生活场景进行双向交流' },
  { id: 'stage-6', stage: 6, code: 'autonomous_communication', name: '自主日常交流', objective: '谈当天发生的事，讲简单经历' },
];

async function main() {
  console.log('[seed] 开始灌入 M1 种子数据…');

  // —— 场景 ——
  for (const s of SCENARIOS) {
    await prisma.scenarios.upsert({
      where: { code: s.code },
      update: { name: s.name, description: s.description, countsForTransfer: s.countsForTransfer },
      create: s,
    });
  }
  console.log(`[seed] scenarios: ${SCENARIOS.length}`);

  // —— 阈值 ——
  for (const t of THRESHOLDS) {
    const data = {
      ...t,
      source: 'm1_provisional',
      calibrationStatus: 'uncalibrated',
      version: 'm1.1',
    };
    const existing = await prisma.assessment_thresholds.findFirst({
      where: { taskType: t.taskType, version: 'm1.1', scenario: t.scenario },
    });
    if (existing) {
      await prisma.assessment_thresholds.update({ where: { id: existing.id }, data });
    } else {
      await prisma.assessment_thresholds.create({ data });
    }
  }
  console.log(`[seed] assessment_thresholds: ${THRESHOLDS.length}`);

  // —— 成长阶段 ——
  for (const s of STAGES) {
    await prisma.curriculum_stages.upsert({
      where: { stage: s.stage },
      update: { code: s.code, name: s.name, objective: s.objective },
      create: s,
    });
  }
  console.log(`[seed] curriculum_stages: ${STAGES.length}`);

  // —— 能力节点 ——
  for (const n of M1_SKILL_NODES) {
    await prisma.skill_nodes.upsert({
      where: { id: n.id },
      update: {
        code: n.code,
        name: n.name,
        abilityCategory: n.abilityCategory,
        growthStage: n.growthStage,
        track: n.track,
        dimensions: n.dimensions,
        objective: n.objective,
        masteryCriteria: n.masteryCriteria,
        m1Scope: n.m1Scope,
      },
      create: {
        id: n.id,
        code: n.code,
        name: n.name,
        abilityCategory: n.abilityCategory,
        growthStage: n.growthStage,
        track: n.track,
        dimensions: n.dimensions,
        objective: n.objective,
        masteryCriteria: n.masteryCriteria,
        m1Scope: n.m1Scope,
      },
    });
  }
  console.log(`[seed] skill_nodes: ${M1_SKILL_NODES.length}`);

  // —— 能力依赖 ——
  for (const d of M1_SKILL_DEPENDENCIES) {
    await prisma.skill_dependencies.upsert({
      where: {
        skillNodeId_dependsOnSkillNodeId_dependencyType: {
          skillNodeId: d.skillNodeId,
          dependsOnSkillNodeId: d.dependsOnSkillNodeId,
          dependencyType: d.dependencyType,
        },
      },
      update: { required: d.required },
      create: {
        id: d.id,
        skillNodeId: d.skillNodeId,
        dependsOnSkillNodeId: d.dependsOnSkillNodeId,
        dependencyType: d.dependencyType,
        required: d.required,
      },
    });
  }
  console.log(`[seed] skill_dependencies: ${M1_SKILL_DEPENDENCIES.length}`);

  // —— 词条 ——
  for (const v of M1_VOCABULARY) {
    const i = v.item;
    await prisma.vocabulary_items.upsert({
      where: { id: i.id },
      update: {
        topicId: i.topicId,
        word: i.word,
        phonetic: i.phonetic,
        syllables: i.syllables,
        meaningZh: i.meaningZh,
        imageRef: i.imageRef,
        collocations: i.collocations,
        exampleSentences: i.exampleSentences,
        difficultPhonemes: i.difficultPhonemes,
        skillNodeIds: i.skillNodeIds,
        relatedWords: i.relatedWords,
        reviewStatus: v.reviewStatus,
      },
      create: {
        id: i.id,
        topicId: i.topicId,
        word: i.word,
        phonetic: i.phonetic,
        syllables: i.syllables,
        meaningZh: i.meaningZh,
        imageRef: i.imageRef,
        collocations: i.collocations,
        exampleSentences: i.exampleSentences,
        difficultPhonemes: i.difficultPhonemes,
        skillNodeIds: i.skillNodeIds,
        relatedWords: i.relatedWords,
        reviewStatus: v.reviewStatus,
      },
    });
  }
  console.log(`[seed] vocabulary_items: ${M1_VOCABULARY.length}`);

  // —— 句型 ——
  for (const s of M1_SENTENCE_PATTERNS) {
    const i = s.item;
    await prisma.sentence_patterns.upsert({
      where: { id: i.id },
      update: {
        topicId: i.topicId,
        pattern: i.pattern,
        zh: i.zh,
        examples: i.examples,
        skillNodeIds: i.skillNodeIds,
        reviewStatus: s.reviewStatus,
      },
      create: {
        id: i.id,
        topicId: i.topicId,
        pattern: i.pattern,
        zh: i.zh,
        examples: i.examples,
        skillNodeIds: i.skillNodeIds,
        reviewStatus: s.reviewStatus,
      },
    });
  }
  console.log(`[seed] sentence_patterns: ${M1_SENTENCE_PATTERNS.length}`);

  // —— 教学活动写入 learning_items（item_type = activity）——
  let activityCount = 0;
  for (const a of M1_ACTIVITIES) {
    const i = a.item;
    await prisma.learning_items.upsert({
      where: { id: i.id },
      update: {
        skillNodeId: i.skillNodeIds[0] ?? 'LA.LISTEN.greeting_core',
        itemType: 'activity',
        refId: i.id,
        content: i as unknown as object,
        topicId: i.topicId,
        reviewStatus: a.reviewStatus,
      },
      create: {
        id: i.id,
        skillNodeId: i.skillNodeIds[0] ?? 'LA.LISTEN.greeting_core',
        itemType: 'activity',
        refId: i.id,
        content: i as unknown as object,
        topicId: i.topicId,
        reviewStatus: a.reviewStatus,
      },
    });
    activityCount += 1;
  }
  console.log(`[seed] learning_items (activities): ${activityCount}`);

  // —— 固定教师人格 ——
  await prisma.teacher_profiles.upsert({
    where: { id: 'teacher-default' },
    update: {},
    create: {
      id: 'teacher-default',
      name: '小语老师',
      coreTraits: {
        // 固定人格，永不改变（D-020）
        patience: 'very_high',
        warmth: 'very_high',
        encouragement: 'always',
        never_mock: true,
        never_rush: true,
        honest_ai_identity: true,
      },
      adjustable: {
        // 可调人格，在边界内微调（D-020）
        liveliness: 60,
        humor: 50,
        encouragementFrequency: 80,
        curiosity: 75,
        expressionComplexity: 'adaptive',
      },
      style: 'gentle_early_tutor',
      stage: 0,
      version: 1,
    },
  });
  console.log('[seed] teacher_profiles: 1');

  console.log(`[seed] 主题：${M1_TOPICS.length} 个（M1 三主题）`);
  console.log('[seed] 完成');
}

main()
  .catch((e) => {
    console.error('[seed] 失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

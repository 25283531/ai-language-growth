/**
 * P3-02 回归：Planner 不得因单一能力领域未达标而返回 null。
 *
 * 任务书 §10.5：
 *  - 禁止跨领域全局门槛：活动只由自身能力节点的硬前置决定；
 *  - 候选池按领域补齐：当前主题候选不足时，从其他领域取可排活动；
 *  - 自由交流门槛只锁 `LA.COMM.free_talk` 本身，不锁其他交流活动；
 *  - rationale 可说明「本课重点领域」，但不得写入「未达到阶段 X，禁止学习 Y」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { M1_ACTIVITIES } from '@alg/curriculum';
import type { MasteryState, TeachingActivity } from '@alg/shared-contracts';
import { PlannerService, abilityDomainsOf } from '../src/planner/planner.service.ts';

const RANK: Record<MasteryState, number> = {
  not_exposed: 0,
  encountered: 1,
  forming: 2,
  mastered: 3,
  transferred: 4,
};

const BASE = M1_ACTIVITIES.find((entry) => entry.item.id === 'act-greet-listen-greeting')!.item;

function activity(overrides: Partial<TeachingActivity> & { id: string; topicId: string }): TeachingActivity {
  return { ...BASE, ...overrides } as TeachingActivity;
}

function freeTalk(topicId: string): TeachingActivity {
  return activity({
    id: 'act-topic-free-talk',
    topicId,
    skillNodeIds: ['LA.COMM.free_talk'],
    taskType: 'situational_dialogue',
    difficulty: 1,
    order: 1,
  });
}

function listening(topicId: string): TeachingActivity {
  return activity({
    id: 'act-other-listening',
    topicId,
    skillNodeIds: ['LA.LISTEN.instruction'],
    taskType: 'listening_comprehension',
    difficulty: 1,
    order: 1,
  });
}

function blockedVocabulary(topicId: string): TeachingActivity {
  return activity({
    id: 'act-topic-blocked-vocab',
    topicId,
    skillNodeIds: ['LA.VOCAB.expressive'],
    taskType: 'word_mimicry',
    difficulty: 1,
    order: 1,
  });
}

function plannerWith(options: {
  topicItems?: TeachingActivity[];
  otherItems?: TeachingActivity[];
  states?: Record<string, MasteryState>;
  disabled?: boolean;
  disabledTopics?: string[];
  onOtherTopicQuery?: () => void;
}) {
  const rows = (items: TeachingActivity[] = []) => items.map((content) => ({ content }));
  const prisma = {
    learning_items: {
      findMany: async (args: { where?: { topicId?: { not?: string } } }) => {
        if (args?.where?.topicId?.not) {
          options.onOtherTopicQuery?.();
          return rows(options.otherItems);
        }
        return rows(options.topicItems);
      },
    },
    learner_skill_states: {
      findMany: async () => Object.entries(options.states ?? {}).map(([skillNodeId, state]) => ({
        skillNodeId,
        masteryCode: RANK[state],
      })),
    },
    review_schedules: { findMany: async () => [] },
    curriculum_units: {
      findFirst: async () => (options.disabled ? { id: 'unit-disabled' } : null),
      findMany: async () => (options.disabledTopics ?? []).map((topicId) => ({ topicId })),
    },
  };
  return new PlannerService(prisma as never, {} as never, {} as never);
}

const input = (topicId: string) => ({
  topicId,
  learnerId: 'learner-p3-02',
  lessonSessionId: 'session-p3-02',
  excludeActivityIds: [],
});

describe('P3-02 Planner 跨领域补齐', () => {
  it('主题只剩自主交流且前提未达成时，从其他领域取可排活动而不是返回 null', async () => {
    const planner = plannerWith({
      topicItems: [freeTalk('topic-dialogue')],
      otherItems: [listening('topic-greetings')],
    });

    const step = await planner.planNext(input('topic-dialogue'));

    assert.ok(step, '单一领域全部阻塞时不得返回 null');
    assert.equal(step!.activity.id, 'act-other-listening');
    assert.match(step!.rationale, /本课重点领域：听力理解/);
    assert.match(step!.rationale, /其他能力领域/);
    assert.doesNotMatch(step!.rationale, /禁止/, 'rationale 不得写成关卡禁令');
    assert.equal(step!.isReview, false);
  });

  it('主题没有任何可下发活动时同样跨领域补齐', async () => {
    const planner = plannerWith({
      topicItems: [],
      otherItems: [listening('topic-greetings')],
    });

    const step = await planner.planNext(input('topic-empty'));

    assert.ok(step);
    assert.equal(step!.activity.id, 'act-other-listening');
    assert.equal(step!.activity.topicId, 'topic-greetings');
  });

  it('数据库没有其他主题时，内置 M1 课程仍可补入跨领域候选', async () => {
    const planner = plannerWith({
      topicItems: [freeTalk('topic-dialogue')],
      otherItems: [],
      states: { 'LA.LISTEN.instruction': 'mastered' },
    });

    const step = await planner.planNext(input('topic-dialogue'));

    assert.ok(step, '内置课程也应补入跨领域候选');
    assert.equal(step!.activity.id, 'act-greet-listen-greeting');
    assert.equal(step!.activity.topicId, 'topic-greetings');
    assert.match(step!.rationale, /其他能力领域/);
  });

  it('内置主题被停用时不得补入跨领域候选', async () => {
    const planner = plannerWith({
      topicItems: [freeTalk('topic-dialogue')],
      otherItems: [],
      states: { 'LA.LISTEN.instruction': 'mastered' },
      disabledTopics: ['topic-greetings'],
    });

    const step = await planner.planNext(input('topic-dialogue'));

    assert.equal(step, null, '停用的内置主题不能被跨领域候选中转下发');
  });

  it('停用主题即使存在残留已发布条目也不进入跨领域池', async () => {
    const planner = plannerWith({
      topicItems: [freeTalk('topic-dialogue')],
      otherItems: [listening('topic-greetings')],
      disabledTopics: ['topic-greetings'],
    });

    const step = await planner.planNext(input('topic-dialogue'));

    assert.equal(step, null, '停用状态优先于残留的已发布学习项');
  });

  it('跨领域只取硬前置已满足且在难度带内的活动', async () => {
    const tooHard = activity({
      id: 'act-other-too-hard',
      topicId: 'topic-objects-around',
      skillNodeIds: ['LA.SPEAK.simple_sentences'],
      taskType: 'sentence_pattern',
      difficulty: 3,
      order: 1,
    });
    const planner = plannerWith({
      topicItems: [],
      otherItems: [tooHard, listening('topic-greetings')],
    });

    const step = await planner.planNext(input('topic-empty'));

    assert.ok(step);
    assert.equal(step!.activity.id, 'act-other-listening');
  });

  it('主题被停用时不得借跨领域补齐绕开下架', async () => {
    let otherTopicQueried = false;
    const planner = plannerWith({
      topicItems: [],
      otherItems: [listening('topic-greetings')],
      disabled: true,
      onOtherTopicQuery: () => {
        otherTopicQueried = true;
      },
    });

    const step = await planner.planNext(input('topic-disabled'));

    assert.equal(step, null);
    assert.equal(otherTopicQueried, false, '停用主题不应再查询其他主题的活动');
  });

  it('主题内有可排活动时不查询其他主题', async () => {
    let otherTopicQueried = false;
    const planner = plannerWith({
      topicItems: [listening('topic-greetings')],
      otherItems: [listening('topic-objects-around')],
      onOtherTopicQuery: () => {
        otherTopicQueried = true;
      },
    });

    const step = await planner.planNext(input('topic-greetings'));

    assert.ok(step);
    assert.equal(step!.activity.id, 'act-other-listening');
    assert.equal(otherTopicQueried, false);
    assert.match(step!.rationale, /本课重点领域：听力理解/);
  });

  it('主题内被硬前置阻塞但仍有低门槛活动时留在本主题，保持课文情境连贯', async () => {
    const planner = plannerWith({
      topicItems: [blockedVocabulary('topic-objects-around')],
      otherItems: [listening('topic-greetings')],
    });

    const step = await planner.planNext(input('topic-objects-around'));

    assert.ok(step);
    assert.equal(step!.activity.id, 'act-topic-blocked-vocab');
    assert.equal(step!.activity.topicId, 'topic-objects-around');
  });

  it('排除项生效：已做过的跨领域活动不会被再次下发', async () => {
    const planner = plannerWith({
      topicItems: [freeTalk('topic-dialogue')],
      otherItems: [listening('topic-greetings')],
    });

    const step = await planner.planNext({
      ...input('topic-dialogue'),
      excludeActivityIds: ['act-other-listening'],
    });

    assert.equal(step, null);
  });
});

describe('P3-02 自由交流门槛只作用于自身', () => {
  type Internals = {
    applyProgressiveAccess(
      activities: TeachingActivity[],
      states: Record<string, MasteryState>,
    ): { activities: TeachingActivity[]; difficultyBand: number; freeConversationLocked: boolean };
  };

  it('独立交流基础未达成时只锁 LA.COMM.free_talk，不锁其他交流活动', () => {
    const planner = new PlannerService({} as never, {} as never, {} as never) as unknown as Internals;
    const dialogue = activity({
      id: 'act-dialogue-practice',
      topicId: 'topic-dialogue',
      skillNodeIds: ['LA.COMM.dialogue'],
      taskType: 'situational_dialogue',
      difficulty: 1,
      order: 2,
    });

    const scoped = planner.applyProgressiveAccess([freeTalk('topic-dialogue'), dialogue], {});

    assert.equal(scoped.freeConversationLocked, true);
    assert.deepEqual(scoped.activities.map((item) => item.id), ['act-dialogue-practice']);
  });

  it('自主交流基础达成后 free_talk 参与候选', () => {
    const planner = new PlannerService({} as never, {} as never, {} as never) as unknown as Internals;
    const states: Record<string, MasteryState> = {
      'LA.SPEAK.simple_sentences': 'mastered',
      'LA.COMM.dialogue': 'mastered',
    };

    const scoped = planner.applyProgressiveAccess([freeTalk('topic-dialogue')], states);

    assert.equal(scoped.freeConversationLocked, false);
    assert.deepEqual(scoped.activities.map((item) => item.id), ['act-topic-free-talk']);
  });

  it('自由交流基础未达成时，完整 Planner 仍排情景对话而不是自由交流', async () => {
    const dialogue = activity({
      id: 'act-dialogue-practice',
      topicId: 'topic-dialogue',
      skillNodeIds: ['LA.COMM.dialogue'],
      taskType: 'situational_dialogue',
      difficulty: 1,
      order: 2,
    });
    const planner = plannerWith({
      topicItems: [freeTalk('topic-dialogue'), dialogue],
      states: {
        'LA.SPEAK.simple_sentences': 'mastered',
        'LA.COMM.respond': 'mastered',
      },
    });

    const step = await planner.planNext(input('topic-dialogue'));

    assert.ok(step);
    assert.equal(step!.activity.id, 'act-dialogue-practice');
    assert.match(step!.rationale, /自主日常交流尚未开放/);
    assert.match(step!.rationale, /所属能力开放难度/);
  });

  it('一个领域阶段高不得被另一个领域阶段低拉低', () => {
    const planner = new PlannerService({} as never, {} as never, {} as never) as unknown as Internals;
    const listeningAdvanced = activity({
      id: 'act-listening-band3',
      topicId: 'topic-greetings',
      skillNodeIds: ['LA.LISTEN.word_recognition'],
      taskType: 'listening_comprehension',
      difficulty: 3,
      order: 1,
    });
    const pronunciationAdvanced = activity({
      id: 'act-pronunciation-band3',
      topicId: 'topic-greetings',
      skillNodeIds: ['LA.PRON.short_vowels'],
      taskType: 'pronunciation_drill',
      difficulty: 3,
      order: 2,
    });

    const scoped = planner.applyProgressiveAccess(
      [pronunciationAdvanced, listeningAdvanced],
      { 'LA.LISTEN.word_recognition': 'mastered' },
    );

    assert.equal(scoped.difficultyBand, 3);
    assert.deepEqual(scoped.activities.map((item) => item.id), ['act-listening-band3']);
  });
});

describe('P3-02 领域标签只用于解释', () => {
  it('按能力节点取领域中文名，跨轨也能识别', () => {
    assert.deepEqual(abilityDomainsOf(['LA.LISTEN.instruction']), ['听力理解']);
    assert.deepEqual(abilityDomainsOf(['SE.SCHOOL.letters']), ['学校英语']);
    assert.deepEqual(
      abilityDomainsOf(['LA.SPEAK.phrases', 'LA.GRAM.basic_pattern']),
      ['表达', '语法'],
    );
    assert.deepEqual(abilityDomainsOf(['unknown.node']), []);
  });
});

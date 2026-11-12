import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MasteryState, TeachingActivity } from '@alg/shared-contracts';
import { PlannerService } from '../src/planner/planner.service.ts';

type AdaptiveChoice = {
  chooseAdaptiveActivity(input: {
    activities: TeachingActivity[];
    learnerId: string;
    lessonSessionId: string;
    states: Record<string, MasteryState>;
  }): Promise<TeachingActivity>;
};

type Harness = {
  choose: AdaptiveChoice['chooseAdaptiveActivity'];
  routeCalls: Array<Record<string, unknown>>;
  gatewayCalls: number;
  usage: Array<Record<string, unknown>>;
  actions: TeachingActivity[];
};

const states: Record<string, MasteryState> = {
  'LA.VOCAB.receptive': 'not_exposed',
  'LA.LISTEN.greeting_core': 'not_exposed',
  'SE.SCHOOL.letters': 'forming',
  'LA.SPEAK.simple_sentences': 'mastered',
  'SE.SCHOOL.word_reading': 'mastered',
};

function activity(
  id: string,
  skillNodeId: string,
  taskType: string,
  order: number,
  difficulty = 1,
): TeachingActivity {
  return {
    id,
    skillNodeIds: [skillNodeId],
    targetWords: [id],
    difficulty,
    taskType,
    order,
  } as unknown as TeachingActivity;
}

function harness(output: { activityId?: string; invalid?: boolean } = {}): Harness {
  const routeCalls: Array<Record<string, unknown>> = [];
  const usage: Array<Record<string, unknown>> = [];
  const actions: TeachingActivity[] = [];
  let gatewayCalls = 0;
  const gateway = {
    llm: async () => {
      gatewayCalls += 1;
      if (output.invalid) {
        return {
          content: 'not-json',
          schemaValid: false,
          inputTokens: 12,
          outputTokens: 4,
          latencyMs: 3,
          providerAlias: 'free_llm',
          modelAlias: 'free_llm_01',
        };
      }
      return {
        content: JSON.stringify({ activityId: output.activityId }),
        schemaValid: true,
        inputTokens: 12,
        outputTokens: 4,
        latencyMs: 3,
        providerAlias: 'free_llm',
        modelAlias: 'free_llm_01',
      };
    },
  };
  const router = {
    route: async (input: Record<string, unknown>) => {
      routeCalls.push(input);
      return {
        level: 'L1',
        providerAlias: 'free_llm',
        modelAlias: 'free_llm_01',
        strategy: 'primary',
        fellBack: false,
        escalationSignals: [],
      };
    },
    recordUsage: async (record: Record<string, unknown>) => {
      usage.push(record);
    },
  };
  const planner = new PlannerService(
    {
      textbook_mappings: { findFirst: async () => null },
      learner_profiles: {
        findUnique: async () => ({ ageGroup: '6-9', entryLevel: 'pre_a1', target: 'daily' }),
      },
    } as never,
    gateway as never,
    router as never,
  );
  const choose = (planner as unknown as AdaptiveChoice).chooseAdaptiveActivity.bind(planner);
  return {
    choose: async (input) => {
      const selected = await choose(input);
      actions.push(selected);
      return selected;
    },
    routeCalls,
    usage,
    actions,
    get gatewayCalls() {
      return gatewayCalls;
    },
  } as Harness;
}

function chooseWith(
  current: Harness,
  activities: TeachingActivity[],
): Promise<TeachingActivity> {
  return current.choose({
    activities,
    learnerId: 'learner-p1-6',
    lessonSessionId: 'session-p1-6',
    states,
  });
}

describe('P1-6 chooseAdaptiveActivity: deterministic first, L1 only at boundary', () => {
  it('clear mastery gap uses deterministic winner without LLM or usage row', async () => {
    const current = harness();
    const selected = await chooseWith(current, [
      activity('low', 'LA.VOCAB.receptive', 'vocabulary', 1),
      activity('forming', 'SE.SCHOOL.letters', 'vocabulary', 2),
    ]);

    assert.equal(selected.id, 'low');
    assert.equal(current.routeCalls.length, 0);
    assert.equal(current.gatewayCalls, 0);
    assert.equal(current.usage.length, 0);
  });

  it('same-tier candidates with one task type use stable order without LLM', async () => {
    const current = harness();
    const selected = await chooseWith(current, [
      activity('first', 'LA.VOCAB.receptive', 'vocabulary', 1),
      activity('second', 'LA.LISTEN.greeting_core', 'vocabulary', 2),
    ]);

    assert.equal(selected.id, 'first');
    assert.equal(current.routeCalls.length, 0);
    assert.equal(current.gatewayCalls, 0);
    assert.equal(current.usage.length, 0);
  });

  it('all-mastered tie uses deterministic order without LLM', async () => {
    const current = harness();
    const selected = await chooseWith(current, [
      activity('mastered-one', 'LA.SPEAK.simple_sentences', 'review', 1),
      activity('mastered-two', 'SE.SCHOOL.word_reading', 'review', 2),
    ]);

    assert.equal(selected.id, 'mastered-one');
    assert.equal(current.routeCalls.length, 0);
    assert.equal(current.gatewayCalls, 0);
  });

  it('same-tier candidates at different difficulty keep the easier one without LLM', async () => {
    const current = harness();
    const selected = await chooseWith(current, [
      activity('easier-choice', 'LA.VOCAB.receptive', 'vocabulary', 1, 1),
      activity('harder-choice', 'LA.LISTEN.greeting_core', 'listening', 2, 2),
    ]);

    assert.equal(selected.id, 'easier-choice');
    assert.equal(current.routeCalls.length, 0);
    assert.equal(current.gatewayCalls, 0);
    assert.equal(current.usage.length, 0);
  });

  it('same-tier tie across different task types uses the L1 tiebreak route and records one row', async () => {
    const current = harness({ activityId: 'listening-choice' });
    const selected = await chooseWith(current, [
      activity('vocabulary-choice', 'LA.VOCAB.receptive', 'vocabulary', 1),
      activity('listening-choice', 'LA.LISTEN.greeting_core', 'listening', 2),
    ]);

    assert.equal(selected.id, 'listening-choice');
    assert.deepEqual(current.routeCalls, [
      { serviceKind: 'llm', taskRoute: 'llm.learning_plan_tiebreak' },
    ]);
    assert.equal(current.gatewayCalls, 1);
    assert.equal(current.usage.length, 1);
    assert.equal(current.usage[0]?.taskRoute, 'llm.learning_plan_tiebreak');
    assert.equal(current.usage[0]?.level, 'L1');
  });

  it('invalid boundary output falls back to the deterministic winner and still records the attempt', async () => {
    const current = harness({ invalid: true });
    const selected = await chooseWith(current, [
      activity('fallback-choice', 'LA.VOCAB.receptive', 'vocabulary', 1),
      activity('other-choice', 'LA.LISTEN.greeting_core', 'listening', 2),
    ]);

    assert.equal(selected.id, 'fallback-choice');
    assert.equal(current.gatewayCalls, 1);
    assert.equal(current.usage.length, 1);
  });

  it('single candidate never calls the router', async () => {
    const current = harness();
    const selected = await chooseWith(current, [
      activity('only', 'LA.VOCAB.receptive', 'vocabulary', 1),
    ]);

    assert.equal(selected.id, 'only');
    assert.equal(current.routeCalls.length, 0);
    assert.equal(current.gatewayCalls, 0);
  });
});

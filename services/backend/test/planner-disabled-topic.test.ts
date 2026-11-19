import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TeachingActivity } from '@alg/shared-contracts';
import { PlannerService } from '../src/planner/planner.service';

function plannerWith(options: { disabledUnit: boolean }) {
  const prisma = {
    learning_items: {
      findMany: async () => [],
    },
    curriculum_units: {
      findFirst: async () => (options.disabledUnit ? { id: 'unit-1' } : null),
    },
  };
  return new PlannerService(prisma as never, {} as never, {} as never) as unknown as {
    activitiesOf(topicId: string): Promise<TeachingActivity[]>;
  };
}

describe('停用课程不再回落到内置活动', () => {
  it('主题下存在停用单元且没有可下发 items 时返回空', async () => {
    const activities = await plannerWith({ disabledUnit: true }).activitiesOf('topic-greetings');
    assert.deepEqual(activities, []);
  });

  it('主题没有数据库课程时仍正常回落到内置 M1 活动', async () => {
    const activities = await plannerWith({ disabledUnit: false }).activitiesOf('topic-greetings');
    assert.ok(activities.length > 0);
  });
});

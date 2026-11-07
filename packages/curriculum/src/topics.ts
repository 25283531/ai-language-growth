/**
 * 主题与活动的查询接口。
 *
 * 主题定义「一个主题涉及哪些能力」，活动定义「有哪些教学活动可用」。
 * 教学顺序由 Planner 依据学习者状态决定，不在本文件预设（D-007）。
 */
import type { TeachingActivity, Topic } from '@alg/shared-contracts';
import { M1_ACTIVITIES } from './activities';
import { M1_TOPICS } from './content';
import type { Reviewed } from './content';

export { M1_TOPICS };

/** M1 主题 id 列表。 */
export const M1_TOPIC_IDS = M1_TOPICS.map((t) => t.id);

export class Curriculum {
  private readonly topics: Map<string, Topic>;
  private readonly activities: TeachingActivity[];

  constructor(
    topics: Topic[] = M1_TOPICS,
    activities: Reviewed<TeachingActivity>[] = M1_ACTIVITIES,
  ) {
    this.topics = new Map(topics.map((t) => [t.id, t]));
    this.activities = activities.map((a) => a.item);
  }

  getTopic(id: string): Topic | undefined {
    return this.topics.get(id);
  }

  allTopics(): Topic[] {
    return [...this.topics.values()];
  }

  /** M1 三主题。 */
  m1Topics(): Topic[] {
    return this.allTopics().filter((t) => t.m1Scope);
  }

  /** 某主题下的全部教学活动，按 order 排序。 */
  activitiesOf(topicId: string): TeachingActivity[] {
    return this.activities
      .filter((a) => a.topicId === topicId)
      .sort((a, b) => a.order - b.order);
  }

  /** M1 范围内的全部活动。 */
  m1Activities(): TeachingActivity[] {
    return this.activities.filter((a) => a.m1Scope);
  }

  /**
   * 某能力节点下的活动。
   * 用于把学习者档案映射回具体教学活动。
   */
  activitiesForSkill(skillNodeId: string): TeachingActivity[] {
    return this.activities.filter((a) => a.skillNodeIds.includes(skillNodeId));
  }

  getActivity(id: string): TeachingActivity | undefined {
    return this.activities.find((a) => a.id === id);
  }

  allActivities(): TeachingActivity[] {
    return [...this.activities];
  }
}

import type { TeachingActivity } from '@alg/shared-contracts';

export const MAX_REVIEW_INTERVAL_DAYS = 30;

/** First successful retrieval doubles the initial one-day interval to two days. */
export function nextReviewIntervalDays(previousSuccesses: number, succeeded: boolean): number {
  if (!succeeded) return 1;
  const nextSuccesses = Math.max(0, previousSuccesses) + 1;
  return Math.min(MAX_REVIEW_INTERVAL_DAYS, 2 ** nextSuccesses);
}

/** Prefer a context not used most recently, then the least-used available context. */
export function chooseReviewActivity(
  activities: TeachingActivity[],
  recentScenarios: string[],
): TeachingActivity | undefined {
  if (activities.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const scenario of recentScenarios) counts.set(scenario, (counts.get(scenario) ?? 0) + 1);
  const latestScenario = recentScenarios[0];

  return [...activities].sort((left, right) => {
    const leftIsLatest = left.scenario === latestScenario ? 1 : 0;
    const rightIsLatest = right.scenario === latestScenario ? 1 : 0;
    return leftIsLatest - rightIsLatest ||
      (counts.get(left.scenario) ?? 0) - (counts.get(right.scenario) ?? 0) ||
      left.difficulty - right.difficulty ||
      left.order - right.order;
  })[0];
}

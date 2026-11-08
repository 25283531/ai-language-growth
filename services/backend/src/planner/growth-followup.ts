export interface SkillSessionOutcome {
  skillNodeId: string;
  unsuccessfulAttempts: number;
  independentSuccesses: number;
}

/** Prioritize the skills with the largest unresolved gap from the previous lesson. */
export function selectFollowUpSkillNodeIds(
  outcomes: SkillSessionOutcome[],
  limit = 3,
): string[] {
  const seen = new Set<string>();
  return [...outcomes]
    .filter((outcome) => outcome.unsuccessfulAttempts > outcome.independentSuccesses)
    .sort((left, right) =>
      (right.unsuccessfulAttempts - right.independentSuccesses) -
      (left.unsuccessfulAttempts - left.independentSuccesses),
    )
    .flatMap((outcome) => {
      if (seen.has(outcome.skillNodeId)) return [];
      seen.add(outcome.skillNodeId);
      return [outcome.skillNodeId];
    })
    .slice(0, Math.max(0, limit));
}

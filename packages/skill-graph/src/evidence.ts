import type { AbilityCategory, SkillNode } from '@alg/shared-contracts';
import { M1_SKILL_NODES } from './graph';

export interface EvidenceTarget {
  skillNodeId: string;
  abilityCategory: AbilityCategory;
}

/** Resolve every ability measured by an activity to its canonical category. */
export function resolveEvidenceTargets(
  skillNodeIds: string[],
  nodes: SkillNode[] = M1_SKILL_NODES,
): EvidenceTarget[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const uniqueIds = Array.from(new Set(skillNodeIds));

  return uniqueIds.map((skillNodeId) => {
    const node = byId.get(skillNodeId);
    if (!node) throw new Error(`Unknown skill node for evidence: ${skillNodeId}`);
    return { skillNodeId, abilityCategory: node.abilityCategory };
  });
}

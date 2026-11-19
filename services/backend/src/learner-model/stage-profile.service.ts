/**
 * StageProfileService —— 七领域阶段画像。
 *
 * 依据：任务书 §10.4。
 *  - 每个领域取 `masteryCode >= forming` 的最高 `growthStage`；
 *  - 若没有 forming，取 `encountered` 的最高阶段；
 *  - 都没有则返回 0；
 *  - 同时返回当前阶段节点数与证据数，便于解释。
 *
 * 该服务只读 `skill_nodes`、`learner_skill_states`、`learning_evidence`，
 * 不写掌握状态、不参与访问控制。阶段低不得阻塞其他领域。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ABILITY_CATEGORY_TO_STAGE_DOMAIN,
  STAGE_PROFILE_DOMAINS,
  type AbilityCategory,
  type StageProfile,
  type StageProfileDomain,
} from '@alg/shared-contracts';
import { PrismaService } from '../prisma/prisma.service';

type DomainState = {
  formingStages: number[];
  encounteredStages: number[];
  nodeCountByStage: Map<number, number>;
  evidenceCount: number;
};

function emptyDomainState(): DomainState {
  return {
    formingStages: [],
    encounteredStages: [],
    nodeCountByStage: new Map(),
    evidenceCount: 0,
  };
}

@Injectable()
export class StageProfileService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async compute(learnerId: string): Promise<StageProfile> {
    const [nodes, states, evidenceCounts] = await Promise.all([
      this.prisma.skill_nodes.findMany({
        select: { id: true, abilityCategory: true, growthStage: true },
      }),
      this.prisma.learner_skill_states.findMany({
        where: { learnerId },
        select: { skillNodeId: true, masteryCode: true },
      }),
      this.prisma.learning_evidence.groupBy({
        by: ['skillNodeId'],
        where: { learnerId },
        _count: { _all: true },
      }),
    ]);

    const domains = Object.fromEntries(
      STAGE_PROFILE_DOMAINS.map((domain) => [domain, emptyDomainState()]),
    ) as Record<StageProfileDomain, DomainState>;

    const nodeById = new Map<string, { domain: StageProfileDomain; growthStage: number }>();
    for (const node of nodes) {
      const domain = domainOf(node.abilityCategory);
      if (!domain) continue;
      const bucket = domains[domain];
      const stage = clampStage(node.growthStage);
      bucket.nodeCountByStage.set(stage, (bucket.nodeCountByStage.get(stage) ?? 0) + 1);
      nodeById.set(node.id, { domain, growthStage: stage });
    }

    for (const state of states) {
      const node = nodeById.get(state.skillNodeId);
      if (!node) continue;
      // masteryCode 0/1 只算接触；2 及以上才算“正在形成”。
      if (state.masteryCode >= 2) {
        domains[node.domain].formingStages.push(node.growthStage);
      } else if (state.masteryCode >= 1) {
        domains[node.domain].encounteredStages.push(node.growthStage);
      }
    }

    for (const row of evidenceCounts) {
      const node = nodeById.get(row.skillNodeId);
      if (!node) continue;
      domains[node.domain].evidenceCount += row._count._all;
    }

    const stages = {} as StageProfile['stages'];
    const stageNodeCounts: Record<string, number> = {};
    const evidenceByDomain: Record<string, number> = {};

    for (const domain of STAGE_PROFILE_DOMAINS) {
      const bucket = domains[domain];
      const stage = bucket.formingStages.length
        ? Math.max(...bucket.formingStages)
        : bucket.encounteredStages.length
          ? Math.max(...bucket.encounteredStages)
          : 0;
      stages[domain] = stage;
      stageNodeCounts[domain] = bucket.nodeCountByStage.get(stage) ?? 0;
      evidenceByDomain[domain] = bucket.evidenceCount;
    }

    return {
      learnerId,
      stages,
      stageNodeCounts,
      evidenceCounts: evidenceByDomain,
      computedAt: new Date().toISOString(),
    };
  }
}

function domainOf(category: string): StageProfileDomain | null {
  if (!(category in ABILITY_CATEGORY_TO_STAGE_DOMAIN)) return null;
  return ABILITY_CATEGORY_TO_STAGE_DOMAIN[category as AbilityCategory] ?? null;
}

function clampStage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(6, Math.trunc(value)));
}

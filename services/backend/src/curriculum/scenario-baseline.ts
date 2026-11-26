import type { PrismaClient } from '@prisma/client';
import { EVIDENCE_SCENARIOS } from '@alg/shared-contracts';

/**
 * scenarios 是 learning_evidence.scenario / assessment_records.scenario 的外键目标。
 *
 * 生产与 staging 只执行 `migrate deploy`，不执行 seed；如果基础场景只存在于 seed，
 * 完形通过证据写 `story_scene` 时会在 `learning_evidence_scenario_fkey` 上失败。
 * 这里按共享契约的完整场景枚举做只读检查，确保目标库具备全部外键目标。
 */
export type ScenarioBaselinePrisma = Pick<PrismaClient, 'scenarios'>;

export async function findMissingScenarioBaseline(
  prisma: ScenarioBaselinePrisma,
  required: readonly string[] = EVIDENCE_SCENARIOS,
): Promise<string[]> {
  const codes = [...new Set(required)];
  const rows = await prisma.scenarios.findMany({
    where: { code: { in: codes } },
    select: { code: true },
  });
  const found = new Set(rows.map((row) => row.code));
  return codes.filter((code) => !found.has(code));
}

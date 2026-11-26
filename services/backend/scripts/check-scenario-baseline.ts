/**
 * 只读校验：目标库 scenarios 是否具备共享契约要求的全部场景。
 *
 * 主要用于生产/staging：这些环境只执行 `migrate deploy`，不执行 seed。
 * 重点保障 story_scene 存在，否则完形通过证据写 learning_evidence 时会因
 * learning_evidence.scenario 外键失败。
 */
import { PrismaClient } from '@prisma/client';
import { EVIDENCE_SCENARIOS } from '@alg/shared-contracts';
import { findMissingScenarioBaseline } from '../src/curriculum/scenario-baseline.ts';

const prisma = new PrismaClient();

async function main() {
  const missing = await findMissingScenarioBaseline(prisma);
  if (missing.length > 0) {
    console.error(
      `[scenario-baseline] 缺少 ${missing.length}/${EVIDENCE_SCENARIOS.length} 个场景：${missing.join(', ')}`,
    );
    if (missing.includes('story_scene')) {
      console.error(
        '[scenario-baseline] story_scene 缺失：完形通过证据会因 learning_evidence.scenario 外键失败。',
      );
    }
    console.error(
      '[scenario-baseline] 请先执行迁移；基础场景由 20261126120000_baseline_scenarios 保证，不能只依赖 seed。',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[scenario-baseline] OK：${EVIDENCE_SCENARIOS.length}/${EVIDENCE_SCENARIOS.length}，含 story_scene。`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      '[scenario-baseline] 检查失败：',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

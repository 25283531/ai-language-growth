/**
 * CEFR 参考档位 / 头像解锁推导的表驱动纯函数单测：零 DB / 零网络 / 零时间依赖。
 * 只测 packages/shared-contracts/src/cefr.ts，不触碰教学状态机与 mastery 判定。
 *
 * 新解锁曲线（用户裁定）：24 个基础头像（b00..b23）从档位 0 起全部可用；
 * 10 个 3D 头像（d00..d09）每 3 档解锁 2 个：
 *   extrasUnlocked = min(2 * ceil(tier / 3), 10)
 *   unlockedCount  = 24 + extrasUnlocked
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AVATAR_BASE_COUNT,
  AVATAR_BASE_UNLOCKED,
  AVATAR_EXTRA_COUNT,
  AVATAR_EXTRA_PER_STEP,
  AVATAR_EXTRA_STEPS,
  AVATAR_ORDER,
  AVATAR_TIER_MAX,
  AVATAR_TIER_PER_STEP,
  AVATAR_TOTAL,
  CEFR_BUCKETS,
  CEFR_DISPLAY_UNCALIBRATED,
  CEFR_LEVELS,
  CEFR_LEVEL_NOTICE,
  EVIDENCE_PER_STAGE,
  deriveAvatarLevel,
  isValidAvatarUrl,
  type CefrAbilityInput,
  type CefrEvidenceInput,
} from '../src/index.ts';

const CATEGORIES = [
  'listening',
  'pronunciation',
  'vocabulary',
  'grammar',
  'speaking',
  'communication',
  'school_english',
] as const;

function fromStages(stages: readonly number[], calibrated = false): CefrAbilityInput[] {
  return CATEGORIES.map((category, index) => ({
    category,
    stage: stages[index] ?? 0,
    calibrated,
  }));
}

function stagesForSum(total: number): number[] {
  const stages = [0, 0, 0, 0, 0, 0, 0];
  let remaining = total;
  for (let index = 0; index < stages.length && remaining > 0; index += 1) {
    const value = Math.min(4, remaining);
    stages[index] = value;
    remaining -= value;
  }
  return stages;
}

function evidenceFor(perCategory: number, succeeded = true): CefrEvidenceInput[] {
  return CATEGORIES.flatMap((category) =>
    Array.from({ length: perCategory }, () => ({ abilityCategory: category, succeeded })),
  );
}

/** 独立复算新曲线，避免测试与被测实现共用同一个 bug。 */
function expectedExtras(tier: number): number {
  return Math.min(AVATAR_EXTRA_PER_STEP * Math.ceil(tier / AVATAR_TIER_PER_STEP), AVATAR_EXTRA_COUNT);
}

describe('deriveAvatarLevel · 表驱动主规则（新 24 + 10 曲线）', () => {
  const cases: Array<{ sum: number; tier: number; level: string; unlocked: number }> = [
    { sum: 0, tier: 0, level: 'pre_a1', unlocked: 24 },
    { sum: 1, tier: 0, level: 'pre_a1', unlocked: 24 },
    { sum: 2, tier: 1, level: 'pre_a1', unlocked: 26 },
    { sum: 5, tier: 2, level: 'pre_a1', unlocked: 26 },
    { sum: 6, tier: 3, level: 'a1', unlocked: 26 },
    { sum: 7, tier: 3, level: 'a1', unlocked: 26 },
    { sum: 8, tier: 4, level: 'a1', unlocked: 28 },
    { sum: 11, tier: 5, level: 'a1', unlocked: 28 },
    { sum: 12, tier: 6, level: 'a2', unlocked: 28 },
    { sum: 13, tier: 6, level: 'a2', unlocked: 28 },
    { sum: 14, tier: 7, level: 'a2', unlocked: 30 },
    { sum: 17, tier: 8, level: 'a2', unlocked: 30 },
    { sum: 18, tier: 9, level: 'b1', unlocked: 30 },
    { sum: 20, tier: 10, level: 'b1', unlocked: 32 },
    { sum: 23, tier: 11, level: 'b1', unlocked: 32 },
    { sum: 24, tier: 12, level: 'b2', unlocked: 32 },
    { sum: 26, tier: 13, level: 'b2', unlocked: 34 },
    { sum: 27, tier: 13, level: 'b2', unlocked: 34 },
    { sum: 28, tier: 14, level: 'b2', unlocked: 34 },
  ];

  for (const { sum, tier, level, unlocked } of cases) {
    it(`S=${sum} → tier=${tier} / ${level} / unlocked=${unlocked}`, () => {
      const result = deriveAvatarLevel(fromStages(stagesForSum(sum)));
      assert.equal(result.progress.basis.sumStage, sum);
      assert.equal(result.avatarTier, tier);
      assert.equal(result.level, level);
      assert.equal(result.unlockedCount, unlocked);
      assert.equal(result.progress.unlockedCount, unlocked);
      assert.equal(result.progress.extrasUnlocked, expectedExtras(tier));
      assert.equal(result.progress.extrasUnlocked, unlocked - AVATAR_BASE_COUNT);
    });
  }

  it('6 个分段锚点：tier0→24 / 1-3→26 / 4-6→28 / 7-9→30 / 10-12→32 / 13-14→34', () => {
    const anchors: Array<[number[], number]> = [
      [[0, 0, 0, 0, 0, 0, 0], 24], // tier 0
      [[2, 0, 0, 0, 0, 0, 0], 26], // tier 1
      [[2, 2, 2, 0, 0, 0, 0], 26], // tier 3
      [[2, 2, 2, 2, 0, 0, 0], 28], // tier 4
      [[2, 2, 2, 2, 2, 2, 2], 30], // tier 7
      [[4, 4, 4, 4, 4, 0, 0], 32], // tier 10
      [[4, 4, 4, 4, 4, 4, 2], 34], // tier 13
      [[4, 4, 4, 4, 4, 4, 4], 34], // tier 14
    ];
    for (const [stages, unlocked] of anchors) {
      const result = deriveAvatarLevel(fromStages(stages));
      assert.equal(result.unlockedCount, unlocked, `stages=${stages.join(',')}`);
    }
  });

  it('题目锚点：全 0 → 24；7×stage2 → tier7/A2/30；全 4 → tier14/B2/34', () => {
    const zero = deriveAvatarLevel(fromStages([0, 0, 0, 0, 0, 0, 0]));
    assert.equal(zero.avatarTier, 0);
    assert.equal(zero.level, 'pre_a1');
    assert.equal(zero.unlockedCount, 24);
    assert.equal(zero.progress.extrasUnlocked, 0);

    const mid = deriveAvatarLevel(fromStages([2, 2, 2, 2, 2, 2, 2]));
    assert.equal(mid.progress.basis.sumStage, 14);
    assert.equal(mid.avatarTier, 7);
    assert.equal(mid.level, 'a2');
    assert.equal(mid.unlockedCount, 30);
    assert.equal(mid.progress.extrasUnlocked, 6);

    const max = deriveAvatarLevel(fromStages([4, 4, 4, 4, 4, 4, 4]));
    assert.equal(max.progress.basis.sumStage, 28);
    assert.equal(max.avatarTier, 14);
    assert.equal(max.level, 'b2');
    assert.equal(max.unlockedCount, 34);
    assert.equal(max.progress.extrasUnlocked, 10);
  });

  it('unlockedCount 随 S 单调不减，恒在 [24,34]，5 步解锁完 10 个 3D', () => {
    let previous = -1;
    for (let sum = 0; sum <= 28; sum += 1) {
      const result = deriveAvatarLevel(fromStages(stagesForSum(sum)));
      assert.ok(result.unlockedCount >= previous);
      assert.ok(result.unlockedCount >= AVATAR_BASE_COUNT);
      assert.ok(result.unlockedCount <= AVATAR_TOTAL);
      previous = result.unlockedCount;
    }
    assert.equal(AVATAR_EXTRA_STEPS, 5);
    assert.equal(AVATAR_BASE_UNLOCKED, 24);
    assert.equal(expectedExtras(0), 0);
    assert.equal(expectedExtras(1), 2);
    assert.equal(expectedExtras(13), 10);
    assert.equal(expectedExtras(14), 10);
  });
});

describe('契约常量与档位表', () => {
  it('AVATAR_ORDER 长度 34：前 24 基础（b00..b23）+ 后 10 个 3D（d00..d09），无重复', () => {
    assert.equal(AVATAR_TOTAL, 34);
    assert.equal(AVATAR_BASE_COUNT, 24);
    assert.equal(AVATAR_EXTRA_COUNT, 10);
    assert.equal(AVATAR_ORDER.length, 34);
    assert.equal(new Set(AVATAR_ORDER).size, 34);
    assert.equal(AVATAR_ORDER[0], 'preset://b00');
    assert.equal(AVATAR_ORDER[23], 'preset://b23');
    assert.equal(AVATAR_ORDER[24], 'preset://d00');
    assert.equal(AVATAR_ORDER[33], 'preset://d09');
    assert.ok(AVATAR_ORDER.slice(0, 24).every((id) => /^preset:\/\/b\d{2}$/.test(id)));
    assert.ok(AVATAR_ORDER.slice(24).every((id) => /^preset:\/\/d\d{2}$/.test(id)));
  });

  it('CEFR_BUCKETS 覆盖 tier 0–14，且 0-2/3-5/6-8/9-11/12-14 分档正确', () => {
    assert.equal(CEFR_BUCKETS.length, AVATAR_TIER_MAX + 1);
    assert.equal(new Set(CEFR_BUCKETS.slice(0, 3)).size, 1);
    assert.equal(CEFR_BUCKETS[0], 'pre_a1');
    assert.equal(CEFR_BUCKETS[3], 'a1');
    assert.equal(CEFR_BUCKETS[6], 'a2');
    assert.equal(CEFR_BUCKETS[9], 'b1');
    assert.equal(CEFR_BUCKETS[12], 'b2');
    assert.equal(CEFR_BUCKETS[14], 'b2');
    assert.ok(CEFR_BUCKETS.every((level) => CEFR_LEVELS.includes(level)));
  });

  it('最高档 tier14：next 为 null、progress=1、无奖励、34 全部解锁', () => {
    const result = deriveAvatarLevel(fromStages(stagesForSum(28)));
    assert.equal(result.progress.next.tier, null);
    assert.equal(result.progress.next.level, null);
    assert.equal(result.progress.next.progress, 1);
    assert.equal(result.progress.next.requirements, null);
    assert.equal(result.progress.next.reward, null);
    assert.equal(result.progress.next.unlockAhead, null);
    assert.match(result.progress.next.condition, /34 个头像已全部解锁/);
  });

  it('tier0 → 升一级即解锁 2 个 3D 头像（additionalUnlocks=2、reward.count=2）', () => {
    const result = deriveAvatarLevel(fromStages([0, 0, 0, 0, 0, 0, 0]));
    assert.equal(result.progress.next.tier, 1);
    assert.equal(result.progress.next.unlockedCount, 26);
    assert.equal(result.progress.next.additionalUnlocks, 2);
    assert.deepEqual(result.progress.next.reward, { type: 'avatar_unlock', count: 2 });
    assert.deepEqual(result.progress.next.unlockAhead, { tier: 1, inTiers: 1, additional: 2 });
    assert.match(result.progress.next.condition, /再升一级/);
  });

  it('非解锁档（tier7→8）additionalUnlocks=0、reward=null，并指出下一个解锁档位', () => {
    const result = deriveAvatarLevel(fromStages([2, 2, 2, 2, 2, 2, 2])); // tier 7
    assert.equal(result.progress.next.tier, 8);
    assert.equal(result.progress.next.unlockedCount, 30);
    assert.equal(result.progress.next.additionalUnlocks, 0);
    assert.equal(result.progress.next.reward, null);
    assert.deepEqual(result.progress.next.unlockAhead, { tier: 10, inTiers: 3, additional: 2 });
    assert.match(result.progress.next.condition, /本档不新增头像/);
    assert.match(result.progress.next.condition, /再升 3 档/);
  });

  it('tier13→14 时 3D 已全部解锁：additionalUnlocks=0、unlockAhead=null', () => {
    const result = deriveAvatarLevel(fromStages(stagesForSum(26))); // tier 13
    assert.equal(result.avatarTier, 13);
    assert.equal(result.unlockedCount, 34);
    assert.equal(result.progress.next.unlockedCount, 34);
    assert.equal(result.progress.next.additionalUnlocks, 0);
    assert.equal(result.progress.next.unlockAhead, null);
    assert.match(result.progress.next.condition, /3D 头像已全部解锁/);
  });
});

describe('calibrated 不是解锁开关，只影响展示措辞', () => {
  it('全未校准也能到最高档，且与全校准的 tier/level/unlocked 完全一致', () => {
    const uncalibrated = deriveAvatarLevel(fromStages(stagesForSum(28), false));
    const calibrated = deriveAvatarLevel(fromStages(stagesForSum(28), true));
    assert.equal(uncalibrated.avatarTier, 14);
    assert.equal(calibrated.avatarTier, uncalibrated.avatarTier);
    assert.equal(calibrated.level, uncalibrated.level);
    assert.equal(calibrated.unlockedCount, uncalibrated.unlockedCount);
    assert.equal(uncalibrated.progress.provisional, true);
    assert.equal(calibrated.progress.provisional, false);
  });

  it('现有数据分布（阈值全 uncalibrated）下 A1 仍可触发，且措辞不出现掌握类表述', () => {
    const result = deriveAvatarLevel(fromStages([2, 2, 1, 1, 1, 1, 1], false));
    assert.equal(result.progress.basis.sumStage, 9);
    assert.equal(result.avatarTier, 4);
    assert.equal(result.level, 'a1');
    assert.equal(result.unlockedCount, 28);
    assert.equal(result.progress.provisional, true);
    assert.equal(result.progress.displayLabel, CEFR_DISPLAY_UNCALIBRATED);
    assert.equal(result.progress.notice, CEFR_LEVEL_NOTICE);
    assert.ok(!result.progress.displayLabel.includes('已掌握'));
    assert.ok(!result.progress.notice.includes('已掌握'));
  });
});

describe('单调保护：降级不重新锁定头像', () => {
  it('abilities 全 0，但历史证据充足 → avatarTier 取历史档位、34 全部解锁', () => {
    const result = deriveAvatarLevel(
      fromStages([0, 0, 0, 0, 0, 0, 0]),
      evidenceFor(EVIDENCE_PER_STAGE * 4),
    );
    assert.equal(result.progress.currentTier, 0);
    assert.equal(result.progress.basis.historicalSumStage, 28);
    assert.equal(result.progress.historicalTier, 14);
    assert.equal(result.avatarTier, 14);
    assert.equal(result.unlockedCount, 34);
    assert.equal(result.progress.monotonic, true);
  });

  it('能力状态回落（当前 tier 低于历史 tier）时解锁数不下降', () => {
    const history = evidenceFor(EVIDENCE_PER_STAGE * 2); // 每类 12 条 → historicalS=14 → tier 7
    const before = deriveAvatarLevel(fromStages(stagesForSum(20)), history); // 当前 tier 10 → 32
    const after = deriveAvatarLevel(fromStages(stagesForSum(2)), history); // 回落到 tier 1
    assert.equal(before.avatarTier, 10);
    assert.equal(before.unlockedCount, 32);
    assert.equal(after.avatarTier, 7);
    assert.equal(after.unlockedCount, 30);
    assert.ok(after.unlockedCount >= AVATAR_BASE_COUNT);
  });

  it('无证据时历史档位为 0，不影响当前推导', () => {
    const result = deriveAvatarLevel(fromStages(stagesForSum(14)), []);
    assert.equal(result.progress.historicalTier, 0);
    assert.equal(result.avatarTier, 7);
    assert.equal(result.progress.basis.succeededEvidenceCount, 0);
  });

  it('失败证据与未知类别不计入历史累计', () => {
    const result = deriveAvatarLevel([], [
      ...evidenceFor(EVIDENCE_PER_STAGE, false),
      { abilityCategory: 'not_a_category', succeeded: true },
      { abilityCategory: null, succeeded: true },
    ]);
    assert.equal(result.progress.basis.succeededEvidenceCount, 0);
    assert.equal(result.progress.historicalTier, 0);
  });
});

describe('边界与确定性', () => {
  it('stage 越界 / 负数 / NaN / Infinity / 小数 / 字符串安全归一化', () => {
    const result = deriveAvatarLevel([
      { category: 'listening', stage: 99 },
      { category: 'pronunciation', stage: -7 },
      { category: 'vocabulary', stage: Number.NaN },
      { category: 'grammar', stage: Number.POSITIVE_INFINITY },
      { category: 'speaking', stage: 2.9 },
      { category: 'communication', stage: '3' as unknown as number },
      { category: 'school_english', stage: 0 },
    ]);
    assert.equal(result.progress.basis.sumStage, 4 + 0 + 0 + 0 + 2 + 3 + 0);
    assert.equal(result.avatarTier, 4);
    assert.equal(result.level, 'a1');
    assert.equal(result.unlockedCount, 28);
  });

  it('未知类别忽略、重复类别取最大 stage、缺失类别补 0', () => {
    const result = deriveAvatarLevel([
      { category: 'listening', stage: 1, calibrated: false },
      { category: 'listening', stage: 3, calibrated: true },
      { category: 'not_a_category', stage: 4, calibrated: true },
      { category: 'vocabulary', stage: 2 },
    ]);
    assert.equal(result.progress.basis.categoryCount, 7);
    assert.equal(result.progress.basis.sumStage, 5);
    assert.equal(result.progress.basis.calibratedCategories, 1);
    assert.equal(result.avatarTier, 2);
    assert.equal(result.unlockedCount, 26);
  });

  it('null / undefined / 空输入 → tier 0 / Pre-A1 / unlocked 24', () => {
    for (const result of [deriveAvatarLevel(null), deriveAvatarLevel(undefined), deriveAvatarLevel([])]) {
      assert.equal(result.avatarTier, 0);
      assert.equal(result.level, 'pre_a1');
      assert.equal(result.unlockedCount, 24);
    }
  });

  it('相同输入连续调用 100 次结果完全一致（幂等），且不修改入参', () => {
    const abilities = fromStages(stagesForSum(14), false);
    const evidence = evidenceFor(3);
    const snapshot = JSON.stringify({ abilities, evidence });
    const first = deriveAvatarLevel(abilities, evidence);
    for (let index = 0; index < 100; index += 1) {
      assert.deepEqual(deriveAvatarLevel(abilities, evidence), first);
    }
    assert.equal(JSON.stringify({ abilities, evidence }), snapshot);
  });

  it('progress 恒在 [0,1]，progressPercent 为 0–100 整数', () => {
    for (let sum = 0; sum <= 28; sum += 1) {
      const next = deriveAvatarLevel(fromStages(stagesForSum(sum))).progress.next;
      assert.ok(next.progress >= 0 && next.progress <= 1);
      assert.ok(Number.isInteger(next.progressPercent));
      assert.ok(next.progressPercent >= 0 && next.progressPercent <= 100);
    }
  });

  it('档位随 S 单调不回退', () => {
    let previous = -1;
    for (let sum = 0; sum <= 28; sum += 1) {
      const tier = deriveAvatarLevel(fromStages(stagesForSum(sum))).avatarTier;
      assert.ok(tier >= previous);
      previous = tier;
    }
  });
});

describe('isValidAvatarUrl · avatarUrl 契约', () => {
  it('允许 http(s):// 外链与 preset:// 本地资源标识（短写法与历史长写法）', () => {
    assert.equal(isValidAvatarUrl('https://cdn.example.com/a.png'), true);
    assert.equal(isValidAvatarUrl('http://localhost:3001/avatar.webp'), true);
    assert.equal(isValidAvatarUrl('preset://b00'), true);
    assert.equal(isValidAvatarUrl('preset://d09'), true);
    assert.equal(isValidAvatarUrl('preset://avatar/basic_01'), true);
    assert.equal(isValidAvatarUrl('preset://avatar/3d_10'), true);
  });

  it('拒绝空值、其它协议、非法 preset 标识与裸字符串', () => {
    assert.equal(isValidAvatarUrl(''), false);
    assert.equal(isValidAvatarUrl('   '), false);
    assert.equal(isValidAvatarUrl('ftp://example.com/a.png'), false);
    assert.equal(isValidAvatarUrl('preset://'), false);
    assert.equal(isValidAvatarUrl('preset://avatar/UPPER space'), false);
    assert.equal(isValidAvatarUrl('just-a-string'), false);
    assert.equal(isValidAvatarUrl('javascript:alert(1)'), false);
  });

  it('AVATAR_ORDER 的每个标识都能通过校验', () => {
    for (const id of AVATAR_ORDER) assert.equal(isValidAvatarUrl(id), true);
  });
});

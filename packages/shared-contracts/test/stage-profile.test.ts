import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ABILITY_CATEGORY_TO_STAGE_DOMAIN,
  STAGE_PROFILE_DOMAINS,
  stageProfileSchema,
} from '../src/index.ts';

describe('七领域阶段画像契约', () => {
  it('七个领域固定，且能力分类映射完整', () => {
    assert.deepEqual(STAGE_PROFILE_DOMAINS, [
      'listening',
      'pronunciation',
      'vocabulary',
      'grammar',
      'speaking',
      'communication',
      'schoolEnglish',
    ]);
    assert.equal(ABILITY_CATEGORY_TO_STAGE_DOMAIN.school_english, 'schoolEnglish');
    assert.equal(new Set(Object.values(ABILITY_CATEGORY_TO_STAGE_DOMAIN)).size, 7);
  });

  it('接受完整画像并拒绝越界阶段', () => {
    const valid = stageProfileSchema.parse({
      learnerId: 'learner-a',
      stages: {
        listening: 3,
        pronunciation: 0,
        vocabulary: 3,
        grammar: 2,
        speaking: 1,
        communication: 1,
        schoolEnglish: 2,
      },
      stageNodeCounts: { listening: 2 },
      evidenceCounts: { listening: 8 },
      computedAt: new Date().toISOString(),
    });
    assert.equal(valid.stages.listening, 3);

    assert.throws(() =>
      stageProfileSchema.parse({
        ...valid,
        stages: { ...valid.stages, listening: 7 },
      }),
    );
    assert.throws(() =>
      stageProfileSchema.parse({
        ...valid,
        stages: { ...valid.stages, listening: -1 },
      }),
    );
  });
});

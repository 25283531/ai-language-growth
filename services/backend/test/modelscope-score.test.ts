import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calibrateModelscopeScore } from '@alg/ai-provider-sdk';

/**
 * openpronounce 分数标定：中文母语成人朗读原始分约 40，按 40 → 95 拉伸；
 * 孩子原始 20 对应 48，需要再清楚一点才能过 50 分门禁。
 */
describe('modelscope 评测分标定', () => {
  it('成人 40 分标定为 95 分', () => {
    assert.equal(calibrateModelscopeScore(40), 95);
    assert.equal(calibrateModelscopeScore(30), 71);
    assert.equal(calibrateModelscopeScore(20), 48);
    assert.equal(calibrateModelscopeScore(10), 24);
    assert.equal(calibrateModelscopeScore(0), 0);
  });

  it('超过 42 分直接满分，负数不越界', () => {
    assert.equal(calibrateModelscopeScore(42), 100);
    assert.equal(calibrateModelscopeScore(100), 100);
    assert.equal(calibrateModelscopeScore(-5), 0);
    assert.equal(calibrateModelscopeScore(Number.NaN), 0);
  });
});

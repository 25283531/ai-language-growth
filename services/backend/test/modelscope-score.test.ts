import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calibrateModelscopeScore, scoreSingleWordAudio } from '@alg/ai-provider-sdk';

/**
 * openpronounce 分数标定：中文母语者 40 分按母语水平标为 95；
 * 40 分以下压降（一般 57、含糊 27），只有原始满分才显示 100。
 */
describe('modelscope 评测分标定', () => {
  it('40 分是母语者水平，标定为 95', () => {
    assert.equal(calibrateModelscopeScore(40), 95);
  });

  it('40 分以下明显压降，避免读得一般也拿高分', () => {
    assert.equal(calibrateModelscopeScore(0), 0);
    assert.equal(calibrateModelscopeScore(10), 8);
    assert.equal(calibrateModelscopeScore(20), 27);
    assert.equal(calibrateModelscopeScore(30), 57);
  });

  it('40 分以上平缓上升，满分只给原始满分', () => {
    assert.equal(calibrateModelscopeScore(50), 96);
    assert.equal(calibrateModelscopeScore(100), 100);
    assert.notEqual(calibrateModelscopeScore(60), 100);
  });

  it('越界与非法输入不越界', () => {
    assert.equal(calibrateModelscopeScore(-5), 0);
    assert.equal(calibrateModelscopeScore(Number.NaN), 0);
  });
});

/** 单个单词没有「读错一个词」的中间态，按音素距离给部分分。 */
describe('modelscope 单词评测分', () => {
  it('读对给 100，差一个音仍能过 50 分门禁', () => {
    assert.equal(scoreSingleWordAudio(0), 100);
    assert.equal(scoreSingleWordAudio(1), 80);
    assert.equal(scoreSingleWordAudio(2), 60);
    assert.equal(scoreSingleWordAudio(3), 40);
  });

  it('差太多给 0 分，不出现负分', () => {
    assert.equal(scoreSingleWordAudio(5), 0);
    assert.equal(scoreSingleWordAudio(9), 0);
    assert.equal(scoreSingleWordAudio(-1), 100);
  });
});

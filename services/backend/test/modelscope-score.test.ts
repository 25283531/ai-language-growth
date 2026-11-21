import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calibrateModelscopeScore, scoreSingleWordAudio } from '@alg/ai-provider-sdk';

/**
 * openpronounce 分数标定：中文母语者 40 分按母语水平标为 95；
 * 40 分以下压降（一般 62、含糊 34），只有原始满分才显示 100。
 */
describe('modelscope 评测分标定', () => {
  it('40 分是母语者水平，标定为 95', () => {
    assert.equal(calibrateModelscopeScore(40), 95);
  });

  it('40 分以下压降，读得一般不会拿到高分', () => {
    assert.equal(calibrateModelscopeScore(0), 0);
    assert.equal(calibrateModelscopeScore(10), 12);
    assert.equal(calibrateModelscopeScore(20), 34);
    assert.equal(calibrateModelscopeScore(30), 62);
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

/** 单个单词没有「读错一个词」的中间态，改为综合音素距离与音素错误率。 */
describe('modelscope 单词评测分', () => {
  it('读对给 100，差一个音仍能过 50 分门禁', () => {
    assert.equal(scoreSingleWordAudio(0, null, 'mother'), 100);
    assert.equal(scoreSingleWordAudio(1, null, 'mother'), 80);
    assert.equal(scoreSingleWordAudio(2, null, 'mother'), 60);
    assert.equal(scoreSingleWordAudio(3, null, 'mother'), 40);
  });

  it('同一段发音不再跳到 0 分：距离大时给 30 分底', () => {
    assert.equal(scoreSingleWordAudio(5, null, 'mother'), 30);
    assert.equal(scoreSingleWordAudio(9, null, 'mother'), 30);
  });

  it('音素错误率更低时取较高分，避免距离波动导致 0/100', () => {
    assert.equal(scoreSingleWordAudio(3, 0.4, 'mother'), 60);
    assert.equal(scoreSingleWordAudio(4, 0.2, 'mother'), 80);
  });

  it('完全没听到声音才是 0 分', () => {
    assert.equal(scoreSingleWordAudio(1, null, ''), 0);
    assert.equal(scoreSingleWordAudio(1, null, '   '), 0);
  });
});

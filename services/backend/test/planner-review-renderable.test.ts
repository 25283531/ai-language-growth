/**
 * 回归：复习候选只能是「复习形态可渲染」的活动。
 *
 * 缺陷（2026-11-16 真机）：苹果图片题答完后，规划器给了一个到期的问候复习项
 * （act-greet-listen-greeting / listening_comprehension）。复习轮为避免提前给答案
 * 会清空 targetWords 与 demonstrationText，客户端因此只剩一张没有单词的空跟读卡，
 * 题目区整片空白。
 *
 * 约束：复习轮不清空图片选择题的选项与目标词（tap_image 是唯一可作答形态），
 * 所以规划器必须在选路阶段就排除不可渲染的类型，而不是靠客户端兜底。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { M1_ACTIVITIES } from '@alg/curriculum';
import { isReviewRenderable } from '../src/planner/planner.service.ts';

const activityById = (id: string) => {
  const found = M1_ACTIVITIES.find((entry) => entry.item.id === id);
  assert.ok(found, `内容库里缺少活动 ${id}`);
  return found!.item;
};

describe('复习形态可渲染判定', () => {
  it('带选项的图片选择题可渲染：复习轮保留选项与目标词，孩子能作答', () => {
    assert.equal(isReviewRenderable(activityById('act-obj-pick-pictures')), true);
  });

  it('没有选项的图片选择题不可渲染：客户端会退化成空跟读卡（真机卡住的 act-greet-tap-picture）', () => {
    assert.equal(isReviewRenderable(activityById('act-greet-tap-picture')), false);
  });

  it('听力理解不可渲染：复习轮清空目标词与示范文本', () => {
    assert.equal(isReviewRenderable(activityById('act-greet-listen-greeting')), false);
  });

  it('跟读类不可渲染：复习轮同样清空目标词', () => {
    assert.equal(isReviewRenderable(activityById('act-greet-repeat-hello')), false);
  });

  it('未知类型一律按不可渲染处理，避免新增类型默认泄漏到复习轮', () => {
    assert.equal(isReviewRenderable({ taskType: 'brand_new_task_type' }), false);
  });
});

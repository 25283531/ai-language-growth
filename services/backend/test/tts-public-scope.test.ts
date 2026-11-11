/**
 * 固定课程语音的公共缓存判定。
 *
 * 业务要求：第一个孩子调用后生成，后续孩子直接复用；但只有“发布态固定文本”
 * 才能公开，孩子本轮错误导出的示范、上一主题问候、复习轮都必须留在 PRIVATE。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolvePublicCurriculum } from '../src/orchestrator/orchestrator.service.ts';

describe('固定课程 PUBLIC 判定', () => {
  it('发布态教师话语 + 固定示范文本可跨用户复用', () => {
    assert.equal(resolvePublicCurriculum({
      teacherUtteranceFromPublishedContent: true,
      dynamicTeacherUtterance: false,
      dynamicDemonstration: false,
    }), true);
  });

  it('孩子本轮错误导出的示范保持 PRIVATE', () => {
    assert.equal(resolvePublicCurriculum({
      teacherUtteranceFromPublishedContent: true,
      dynamicTeacherUtterance: false,
      dynamicDemonstration: true,
    }), false);
  });

  it('上一主题问候 / 复习轮保持 PRIVATE', () => {
    assert.equal(resolvePublicCurriculum({
      teacherUtteranceFromPublishedContent: true,
      dynamicTeacherUtterance: true,
      dynamicDemonstration: false,
    }), false);
    assert.equal(resolvePublicCurriculum({
      teacherUtteranceFromPublishedContent: false,
      dynamicTeacherUtterance: false,
      dynamicDemonstration: false,
    }), false);
  });
});

/**
 * P0-4 静态守卫：生产 Web 只读评估，不提供开课入口。
 *
 * 边界：证明 Web 源码默认 fail-closed，开课请求封装在未启用时直接拒绝；
 * 不证明浏览器端无法绕过 JS 直接调用后端（后端仍服务 Android 正式课堂）。
 * 真正的运行时验收仍需 `next build` 后用生产模式打开页面检查按钮/导航。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { isLessonStartEnabled } from '../../../apps/web/app/runtime-config';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const page = read('apps/web/app/page.tsx');
const api = read('apps/web/app/api.ts');
const dockerfile = read('apps/web/Dockerfile');

describe('Web 评估模式：开课入口默认关闭', () => {
  it('1. 只有显式 true 才启用；未设置/空串/false 一律关闭', () => {
    assert.equal(isLessonStartEnabled(undefined), false);
    assert.equal(isLessonStartEnabled(''), false);
    assert.equal(isLessonStartEnabled('false'), false);
    assert.equal(isLessonStartEnabled('1'), false);
    assert.equal(isLessonStartEnabled('true'), true);
  });

  it('2. 工作台不再默认进入课堂，且课堂预览按钮受开关控制', () => {
    assert.match(page, /useState\(LESSON_START_ENABLED\)/, 'classroomMode 未绑定运行开关');
    assert.ok(!/useState\(true\)/.test(page), '页面仍存在默认 true 的课堂状态');
    assert.match(page, /LESSON_START_ENABLED\s*&&\s*<button[\s\S]{0,200}课堂联调预览/, '课堂预览按钮未受开关控制');
    assert.match(page, /!LESSON_START_ENABLED\s*&&[\s\S]{0,200}生产评估模式/, '关闭态缺少可见说明');
  });

  it('3. 开课按钮隐藏，请求封装在关闭时直接拒绝', () => {
    assert.match(page, /LESSON_START_ENABLED\s*\?\s*\(/, '开课按钮未做条件渲染');
    assert.match(page, /生产评估模式 · 已关闭 Web 开课/, '缺少关闭态提示');
    assert.match(page, /if\s*\(!LESSON_START_ENABLED\)[\s\S]{0,160}pushLog\('err'/, '页面开课函数缺少二次守卫');
    assert.match(api, /if\s*\(!LESSON_START_ENABLED\)\s*\{[\s\S]{0,160}Promise\.reject/, 'startLesson 未在关闭态拒绝请求');
  });

  it('4. 生产镜像构建参数默认 false，不靠运行时环境变量误开启', () => {
    assert.match(
      dockerfile,
      /ARG NEXT_PUBLIC_ENABLE_LESSON_START=false/,
      'Dockerfile 未把开课开关默认值固定为 false',
    );
    assert.match(
      dockerfile,
      /ENV NEXT_PUBLIC_ENABLE_LESSON_START=\$\{NEXT_PUBLIC_ENABLE_LESSON_START\}/,
      'Dockerfile 未把构建参数传给 Next.js',
    );
  });
});

/**
 * Web 端运行模式。
 *
 * 生产构建默认关闭「开课 / 课堂联调」入口，Web 只作为教学评估与证据查看端；
 * 本地联调或受控演示可在构建时显式设置 `NEXT_PUBLIC_ENABLE_LESSON_START=true`。
 *
 * 注意：这是 Web 客户端边界，不是后端授权边界。Android/后端正式课堂 API 不受影响；
 * 后端仍以登录态、学习者归属和课堂会话校验为准。
 */
export function isLessonStartEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_ENABLE_LESSON_START,
): boolean {
  return value === 'true';
}

export const LESSON_START_ENABLED = isLessonStartEnabled();

# apps/web — 教学评估台

Next.js 内部评估端，不是孩子实际使用的学习端。正式课堂在 Android 客户端完成。

## 默认行为

- 生产构建默认 **只读评估模式**：不显示课堂预览、不显示开课按钮，`startLesson` 在请求封装层直接拒绝。
- 仍可查看：后端健康状态、能力档案、证据时间线、成长档案、用量与成本、课堂指令/评估结果。
- 学习者接口需要登录态；Web 通过 `authRequest` 附加 Bearer。

这是 Web 客户端边界，不是后端授权边界；Android 与后端正式课堂 API 不受影响，后端仍校验登录态、学习者归属和课堂会话。

## 本地教学联调

只有显式设置环境变量才开启课堂入口：

```bash
NEXT_PUBLIC_ENABLE_LESSON_START=true npm run dev --workspace @alg/web
```

或构建时：

```bash
NEXT_PUBLIC_ENABLE_LESSON_START=true npm run build --workspace @alg/web
```

未设置、空串、`false`、`1` 等其他值一律按关闭处理（fail-closed）。

## 约束

- 教学决策全部由后端返回；Web 只渲染 `directive`、采集作答、展示证据，不自行判断对错或掌握状态。
- 不把 Web 做成孩子学习端，不对外投放。
- 不暴露供应商/模型原始名称。

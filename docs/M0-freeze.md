# M0 技术基线冻结记录

冻结日期：2026-11-08  
冻结范围：V1.1 原型阶段的接口、数据、Provider 协议和语音端云边界。

这份记录关闭“没有统一基线”的 M0 缺口。它冻结的是可继续开发的技术边界，
不代表监护人合规、真实儿童样本、真实供应商质量和商业发布已经验收。

## 冻结对象

| 对象 | 冻结来源 | 状态 |
| --- | --- | --- |
| 教学与能力模型 | `DECISIONS.md` D-001 至 D-026、V1.1 设计任务书 | 已冻结为当前开发依据 |
| PostgreSQL 数据结构 | `services/backend/prisma/schema.prisma` 与已提交迁移 | 已冻结为迁移先行；后续变更必须追加 migration |
| HTTP 契约 | [`docs/api/README.md`](api/README.md)、`packages/shared-contracts` | 已冻结为原型快照；字段变更必须同步 schema 和 CI |
| Provider 协议 | `packages/ai-provider-sdk` 的 LLM/TTS/ASR/发音评测接口 | 已冻结为四路独立适配器 |
| 路由与网关边界 | `packages/model-router`、`services/backend/src/ai-gateway` | 已冻结：Router 选择，Gateway 调用 |
| 语音端云架构 | `DECISIONS.md` D-026 | 已冻结：客户端处理媒体，服务端管理决策、密钥和额度 |
| Android M1 原型 | `apps/android-audio-prototype` | 已冻结为录音、上传、开课、回合、播放、慢速、重播链路 |

## 当前已知未完成项

- Guardian 注册、监护人单独同意、按关系鉴权、撤回和删除链路；
- OpenAPI 生成、统一错误码、分页和正式版本兼容策略；
- 原型上传缓存的自动过期、对象存储和正式访问控制；
- 真实儿童样本标定、真实供应商质量、真实账单和 1–2 秒延迟目标；
- 课程内容人工审核与正式发布流程。

这些项目保留为后续里程碑的明确缺口，不再阻止 M0 技术基线冻结。

## 变更规则

接口或数据结构变更必须同时更新契约、迁移、实现和 CI 证据；Provider 变更只能新增或替换适配器，
不能让教学业务直接依赖供应商名称；安全与隐私边界发生变化时必须追加 `DECISIONS.md` 修订记录。

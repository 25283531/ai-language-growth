# HTTP API 契约（实现快照）

> **状态：M0 冻结快照（原型范围）。** 本文从当前 NestJS controller 与
> `packages/shared-contracts` 整理，用于联调；冻结版本、数据库迁移和已知缺口见
> [`docs/M0-freeze.md`](../M0-freeze.md)。代码新增接口时必须同步本文并由 CI 覆盖。
> 当前没有生成式 OpenAPI 文档，认证和监护人授权仍未实现。

## 基本约定

- Base URL：`/api/v1`；JSON 请求使用 `Content-Type: application/json`。
- 输入验证由 Zod schema 执行；不合法输入通常返回 HTTP 400，结构为 Nest `message`（可能是字符串或对象）、`error`、`statusCode`。不同 controller 的异常包装尚未完全统一。
- 教学领域 ID 使用 JSON 字符串；日期时间使用 ISO-8601。
- **当前除管理 API 外均无身份认证和监护人归属检查。** `x-admin-token` 仅保护 `/admin/*`，不得将该实现视为儿童数据权限系统。未完成 guardian auth 前仅可在隔离开发/CI 环境使用。
- 语音 `audioRef` 是协议引用。Android 原型通过 `POST /media/audio/uploads` 上传
  `.m4a` 字节后使用服务端引用；该端点仅为原型缓存，尚未接入对象存储和自动过期。
- 能力阈值状态为未校准的内部教学信号，不是掌握承诺。

## 教学与学习者

| Method / path | 请求 | 成功响应 / 行为 | 认证 |
| --- | --- | --- | --- |
| `POST /lessons/start` | `lessonStartRequestSchema`: `{ learnerId: string, topicId?: string }` | `lessonStartResponseSchema`: session/topic、首条 `directive`、`speech`、`degradation`、`learnerState.masteryStates` | 无 |
| `POST /lessons/{id}/turn` | `turnRequestSchema`: `{ learnerId, response, idempotencyKey, clientTimestamp? }`。`response` 见下 | `turnResponseSchema`: `lessonSessionId`, `turnIndex`, `directive`, `speech`, `assessment`, `evidence[]`, `stateChanges[]`, `routing`, `degradation`, `intent`, `lessonFinished`, `summary`。相同幂等键返回原结果 | 无 |
| `POST /lessons/{id}/finish` | `{ learnerId: string }` | 结课摘要、有效目标、成本、能力变化与待复习项；生成成长归档 | 无 |
| `GET /lessons/{id}` | 无 | session 与按 turnIndex 排序的交互事件 | 无 |
| `GET /learners` | 无 | 学习者列表（id、displayName、ageGroup、entryLevel、currentTopic、createdAt） | 无 |
| `GET /learners/{id}/profile` | 无 | learner profile 与 preferences | 无 |
| `GET /learners/{id}/abilities` | 无 | 能力状态与未校准提示 | 无 |
| `GET /learners/{id}/evidence?skillNodeId=...` | 可选筛选 | 最近最多 100 条学习证据 | 无 |
| `GET /learners/{id}/growth` | 无 | 最近成长快照、最多 30 条未过期记忆、最多 30 条待复习计划及未校准提示 | 无 |

`response` 字段来自 `learnerResponseSchema`：`text?: string|null`、`audioRef?: string|null`、`audioDurationMs?: integer|null`（0–120000）、`selectedImageId?: string|null`、`requestedSlower?: boolean`、`requestedRepeat?: boolean`、`freeUtterance?: string|null`。schema 为缺省项提供默认值。

### 教学响应子结构

- `directive`：目标技能、任务类型、场景、老师话术、示范文本、逐音节/音素单元、期望回应、目标词、抽象语音参数、方法阶梯、连续失败计数与人格提示。
- `speech`：`audioRef`、`cached`、`teacherSpeed`、`voiceStyle`、`pauseAfterSentenceMs`、`pronunciationMode`。重复请求复用已存引用；慢速请求重新生成。
- `assessment`：是否调用 ASR/发音评测、分数、是否通过、错音单元、提示/独立标记与阈值版本。
- `evidence` 与 `stateChanges`：可审计学习证据和规则引擎状态变化。
- `routing`：任务路由、等级、策略、回退标记、供应商别名、升级信号、延迟及 token/字符/时长/评测调用数与估算费用。
- `degradation`：降级标记、原因、离线兜底状态与实际等级。

## 语音与用量

| Method / path | 请求 | 成功响应 / 行为 | 认证 |
| --- | --- | --- | --- |
| `POST /speech/synthesize` | `{ text, teacherSpeed?, voiceStyle?, pauseAfterSentenceMs?, pronunciationMode? }` | Gateway TTS 结果，内容缓存可避免重复计费 | 无 |
| `POST /speech/recognize` | `{ audioRef, highQuality? }` | ASR 转写结果；ASR 不等于发音准确度评估 | 无 |
| `POST /speech/evaluate` | `{ audioRef, targetText, granularity?: word\|syllable\|phoneme }` | 发音评测结果 | 无 |
| `GET /usage/summary?learnerId=...&lessonSessionId=...` | 可选筛选 | 持久化用量与 `pricingStatus: unpriced`；`costCny=0` 表示未计价，不代表免费 | 无 |
| `GET /health` | 无 | 状态、Gateway 模式、未校准标记、时间戳 | 无 |
| `GET /config/audit` | 无 | 脱敏供应商配置摘要；`NODE_ENV=production` 时 404 | 仅开发环境门槛，不是认证 |
| `GET /media/audio/{file}` | 内容指纹文件名 | 流式返回本地 TTS 文件，扩展名白名单检查 | 无 |
| `POST /media/audio/uploads` | 原始音频字节（`audio/mp4`、`audio/wav`、`audio/mpeg`，最大 10 MB） | 返回内容指纹 `audioRef`，供 ASR/发音评测读取 | 原型无认证 |

### 端侧语音额度租约

Android 端在调用受限的 ASR、云端 TTS 或音素评测 SDK 前，必须先向服务端申请短期额度租约：

| 路由 | 用途 |
|---|---|
| `GET /speech/quota/status?learnerId=...` | 查询当天各服务的上限、已用、预留和剩余秒数 |
| `POST /speech/quota/reserve` | `{ learnerId, serviceKind, seconds, idempotencyKey }`，原子预留，默认非会员每类 300 秒/自然日 |
| `POST /speech/quota/settle` | `{ reservationId, seconds }`，按供应商/SDK 返回的实际秒数结算 |
| `POST /speech/quota/release` | `{ reservationId }`，失败或取消时释放预留 |

租约默认有效 180 秒，服务端数据库是额度权威来源。Android 端在额度不足时不发起供应商请求；服务端对带有
`X-Learner-Id` 与 `X-Speech-Quota-Reservation` 是正式客户端访问语音媒体的必填请求头：

- ASR 录音上传必须同时携带两者；正式 Android 客户端在发送音频前先预留额度，服务端在落盘前再次校验租约，租约无效或额度耗尽时不会保存上传内容。
- 云端 TTS 音频下载也必须同时携带两者；Android 播放器先预留 TTS 额度，再用带请求头的下载请求读取音频，播放结束后按实际时长结算，失败则释放租约。
- ASR / 发音评测接口复用同一租约校验。客户端不得只依赖本地计时器。

端侧直连供应商时，供应商短期凭证也必须绑定同一租约；长期 API Key/AppSecret 不得放入 APK。课程缓存和旧 Web 原型的无租约读取只作为过渡兼容路径，正式客户端不使用该路径。

## 管理 API

以下端点以 `x-admin-token` 校验 `ADMIN_API_TOKEN`。该 token 是原型运维凭据，不授权家长读取儿童资料。

| Method / path | 请求 | 行为 |
| --- | --- | --- |
| `GET /admin/model-providers/catalog` | 无 | 读取预置供应商/模型目录（当前公开） |
| `GET /admin/model-providers/configs` | 无 | 列出已保存配置，Secret 脱敏 |
| `PUT /admin/model-providers/configs` | `ProviderConfigInput`，见 `provider-config.service.ts` | 保存模型接入并刷新对应运行时 provider |
| `GET /admin/model-providers/benchmarks?serviceKind=...` | 服务类型 | 查询性能/价格基准 |
| `POST /admin/model-providers/benchmarks` | benchmark JSON | 校验并记录基准，刷新 provider |
| `GET /admin/learning/learners/{learnerId}/memories` | 无 | 列出记忆 |
| `PUT /admin/learning/learners/{learnerId}/memories/{memoryId}` | `{ memoryType, content, importance?, expiresAt? }` | 修正记忆，标记来源为 `admin_corrected` |
| `DELETE /admin/learning/learners/{learnerId}/memories/{memoryId}` | 无 | 删除单条记忆 |
| `GET /admin/learning/teacher-profile` | 无 | 读取或初始化教师人格 |
| `PUT /admin/learning/teacher-profile` | `{ adjustable, style, reason }` | 更新受限人格参数并写入版本历史 |
| `GET /admin/learning/teacher-profile/history` | 无 | 查询最近人格版本记录 |
| `PUT /admin/learning/teacher-profile/rollback/{historyId}` | 无 | 校验历史参数后回滚并写新版本 |

## 当前契约缺口

1. OpenAPI 3 文档尚未生成；管理配置、结课和数据库响应仍缺统一的 Zod schema 与字段级响应约束。
2. 没有统一的错误码表、分页规范、速率限制和版本兼容策略。
3. Guardian 注册/登录、consent 记录、按监护关系鉴权、授权撤销和儿童数据删除 API 尚未实现。
4. 原型音频上传已实现，但短期保留、自动删除、对象存储和正式访问控制尚未实现。
5. 本 API 快照与 M0 冻结验收记录尚未建立，不能称为“contracts are locked in M0”。

## 代码来源

- 入参/教学回合：`packages/shared-contracts/src/teaching.ts`
- controller 路由：`services/backend/src/lessons/lessons.controller.ts`、`speech/speech.controller.ts`、`providers/provider-config.controller.ts`、`memory/memory-admin.controller.ts`、`media/media.controller.ts`
- provider 配置输入：`services/backend/src/providers/provider-config.service.ts`
- 数据模型：`services/backend/prisma/schema.prisma`

# HTTP API 契约（实现快照）

> **状态：M0 冻结快照（原型范围）。** 本文从当前 NestJS controller 与
> `packages/shared-contracts` 整理，用于联调；冻结版本、数据库迁移和已知缺口见
> [`docs/M0-freeze.md`](../M0-freeze.md)。代码新增接口时必须同步本文并由 CI 覆盖。
> 当前没有生成式 OpenAPI 文档；账户认证已实现，学习者接口仍需继续接入监护人归属校验。

## 基本约定

- Base URL：`/api/v1`；JSON 请求使用 `Content-Type: application/json`。
- 输入验证由 Zod schema 执行；不合法输入通常返回 HTTP 400，结构为 Nest `message`（可能是字符串或对象）、`error`、`statusCode`。不同 controller 的异常包装尚未完全统一。
- 教学领域 ID 使用 JSON 字符串；日期时间使用 ISO-8601。
- **当前除管理 API 外均无身份认证和监护人归属检查。** 管理 API 由部署管理员会话保护；不得将管理员登录视为儿童数据权限系统。未完成 guardian auth 前仅可在隔离开发/CI 环境使用。
- 语音 `audioRef` 是协议引用。固定课程 TTS 由服务端生成并缓存；儿童录音不再上传到服务端：Android 在本地保留录音供回放，提交回合时以 `learnerResponse.audioBase64` 随请求发送，服务端仅在本次请求内转 `data:` URI 给 ASR/发音适配器，不写磁盘。
- `POST /media/audio/uploads` 已停用，返回 `410 AUDIO_UPLOAD_DISABLED`。
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
| `GET /learners/{id}/reports/weekly?weekStart=YYYY-MM-DD` | 可选周一，默认本周，最多回看 8 周 | 家长周报：课堂数、学习时长估算、独立完成数、覆盖能力数、本周亮点、待巩固点、到期复习与下周确定性建议 | 会话（Bearer / Cookie） |

### 家长周报

`GET /learners/{id}/reports/weekly` 是只读周报，不生成诊断、不调用 LLM，也不写数据库。固定使用 `Asia/Shanghai` 时区、周一 00:00 为周起点，返回：

- `summary`：完成课堂数、未完成课堂数、学习时长、活跃天数、独立成功次数、覆盖能力数；
- `topics`：本周完成的主题及次数；
- `highlights`：按独立成功次数汇总的亮点（最多 3 项）；
- `needsPractice`：本周需要再练的能力、错误单元计数，以及 `priorIndependentSuccess`（此前独立完成过）；
- `reviews`：到期待复习数量、逾期数量、下一次复习时间与最多 3 个复习项；
- `nextWeek.suggestions`：最多 3 条确定性建议；
- `privacy`：`includesRawAudio` / `includesTranscript` / `includesProviderData` / `includesInternalCost` 固定为 `false`；
- `calibrationNotice`：说明周报只是学习记录，不构成能力结论。

`learningMinutes` 是按课堂 `startedAt` / `finishedAt` 计算的自然时长（wall-clock）估算，单节封顶 60 分钟，不是精确活跃时长。独立成功只取 `learning_evidence` 中 `succeeded && independent && contributesToPromotion` 且来源不是 `llm_judgement` 的记录；响应不返回原始音频、转写、供应商别名、成本、`skillNodeId` 或 `masteryCode`。

## 账户与会员

账户使用规范化后的邮箱作为用户名。密码至少 8 位，并拒绝连续数字、重复字符和常见简单密码。服务端只保存 bcrypt 哈希；登录会签发 30 天数据库会话，同时设置 HttpOnly `alg_session` Cookie。客户端也可用 `Authorization: Bearer <accessToken>` 访问接口。

| Method / path | 请求 | 成功响应 / 行为 |
| --- | --- | --- |
| `POST /auth/register` | `{ email, password, displayName? }` | 创建注册用户、免费会员学习者档案并返回会话 |
| `POST /auth/login` | `{ email, password }` | 返回用户资料和会话 |
| `GET /auth/me` | Cookie 或 Bearer | 当前用户资料 |
| `POST /auth/logout` | Cookie 或 Bearer | 撤销当前会话 |
| `POST /auth/forgot-password` | `{ email }` | 无论邮箱是否存在都返回统一提示；已注册邮箱发送 30 分钟一次性链接 |
| `POST /auth/reset-password` | `{ token, newPassword }` | 消费令牌、修改密码并撤销旧会话 |
| `GET /membership/me` | Cookie 或 Bearer | 当前账户等级、学习者、申请和变更记录 |
| `POST /membership/requests` | `{ tier?: "member", note? }` | 创建普通会员待审核申请；高级会员仅能由管理员在后台调整 |

SMTP 在管理后台“系统设置”页面配置并加密保存在数据库，不通过 API 返回密码。开发环境未配置 SMTP 时会把重置链接写入后端日志；生产环境必须配置完整 SMTP 信息，否则找回邮件无法发送。生产环境登录 Cookie 带 `Secure` 标记。

`response` 字段来自 `learnerResponseSchema`：`text?: string|null`、`audioRef?: string|null`、`audioBase64?: string|null`（≤20,000,000 字符，二选一）、`audioContentType?: string|null`、`audioDurationMs?: integer|null`（0–120000）、`selectedImageId?: string|null`、`requestedSlower?: boolean`、`requestedRepeat?: boolean`、`freeUtterance?: string|null`。schema 为缺省项提供默认值。服务端只在请求内使用音频，写 `interaction_events` 前剥除音频字段。

### 教学响应子结构

- `directive`：目标技能、任务类型、场景、老师话术、示范文本、逐音节/音素单元、期望回应、目标词、抽象语音参数、方法阶梯、连续失败计数与人格提示。
- `speech`：`audioRef`、`cached`、`teacherSpeed`、`voiceStyle`、`pauseAfterSentenceMs`、`pronunciationMode`、`segments[]`（整轮单次合成，通常只有 1 项）、可选 `scope`（本轮音频的课程级缓存作用域）。重复请求复用已存引用；慢速请求重新生成。
- `assessment`：是否调用 ASR/发音评测、分数、是否通过、错音单元、提示/独立标记与阈值版本。
- `evidence` 与 `stateChanges`：可审计学习证据和规则引擎状态变化。
- `routing`：任务路由、等级、策略、回退标记、供应商别名、升级信号、延迟及 token/字符/时长/评测调用数与估算费用。
- `degradation`：降级标记、原因、离线兜底状态与实际等级。

## 语音与用量

| Method / path | 请求 | 成功响应 / 行为 | 认证 |
| --- | --- | --- | --- |
| `POST /speech/synthesize` | `{ text, teacherSpeed?, voiceStyle?, pauseAfterSentenceMs?, pronunciationMode?, scope? }` | Gateway TTS 结果，课程级缓存可避免重复合成；成功调用写 `ai_usage_logs`（`ttsCharacters`），缓存重播写 0 字符但仍保留一行，保证调用次数可对账；`scope.lessonSessionId` 提供时必须属于该学习者，用于归集课程主题；`scope` 仅接受内容身份，服务端按 `PRIVATE_DYNAMIC` 处理，不信任客户端声明的归属 | Bearer + `X-Learner-Id` + 额度租约 |
| `POST /speech/cache/lookup` | `{ text, teacherSpeed?, voiceStyle?, pauseAfterSentenceMs?, pronunciationMode?, scope? }` | 只读查服务端缓存，不触发供应商、不需租约；命中返回可播放 `speech`，未命中返回 `{ cached:false, speech:null }` | Bearer + `X-Learner-Id` |
| `POST /speech/recognize` | `{ audioRef, highQuality?, lessonSessionId? }` | ASR 转写结果；ASR 不等于发音准确度评估；成功调用写 `ai_usage_logs`（`asrSeconds`），suspect 二次识别按两次 pass 各写一条；`lessonSessionId` 提供时必须属于该学习者 | Bearer + `X-Learner-Id` + 额度租约 |
| `POST /speech/evaluate` | `{ audioRef, targetText, granularity?: word\|syllable\|phoneme, lessonSessionId? }` | 发音评测结果；成功调用写 `ai_usage_logs`（`pronunciationCalls=1`）；`lessonSessionId` 提供时必须属于该学习者 | Bearer + `X-Learner-Id` + 额度租约 |
| `GET /usage/summary?learnerId=...&lessonSessionId=...` | 可选筛选 | 持久化用量与 `pricingStatus: unpriced`；`costCny=0` 表示未计价，不代表免费 | 无 |
| `GET /health` | 无 | 状态、Gateway 模式、未校准标记、时间戳 | 无 |
| `GET /admin/tts-cache` | 管理员 Cookie | TTS 缓存命中率、single-flight 合并数、合成字符数与最近一次清理统计；不返回音频路径或文本 | 管理员会话 |
| `GET /admin/usage/cost?from=...&to=...&learnerId=...&lessonSessionId=...&topicId=...` | 可选筛选；`from`/`to` 为 ISO 时间，默认最近 30 天，范围最大 366 天 | 按 learner/topic/day 汇总 TTS 字符、ASR 秒、发音次数、估算金额与 `unpricedCalls`；topic 取 `lesson_sessions.topicId`，未关联会话单列 null；只读 | 管理员会话 |
| `GET /admin/usage/budget` | 无 | 返回环境变量 `USAGE_BUDGET_CONFIG_JSON` 的生效快照：`learner_day` / `topic_month` 限额、80%/100% 阈值、`enforcement=advisory` | 管理员会话 |
| `GET /admin/usage/budget/evaluate?scope=learner_day&learnerId=...` 或 `?scope=topic_month&topicId=...` | `scope` 必填；对应作用域标识必填 | 只读聚合当前窗口并评估；80% `warning`、100% `exceeded`，均不阻断；未计价或未配置金额时 `displayMode=usage`，只返回字符/秒/次数 | 管理员会话 |
| `GET /config/audit` | 无 | 脱敏供应商配置摘要；`NODE_ENV=production` 时 404 | 仅开发环境门槛，不是认证 |
| `GET /media/audio/{file}` | 内容指纹文件名 + Bearer + `X-Learner-Id` + 额度租约 | 流式返回本地 TTS 文件；扩展名白名单 + `media_assets` 归属校验：`PUBLIC_CURRICULUM` / 旧资产按租约可读，`PRIVATE_DYNAMIC` / `PRIVATE_UPLOAD` 仅归属学习者可读，过期按 404 | 学习者归属 + 租约 |
| `POST /media/audio/uploads` | 已停用 | 返回 `410 AUDIO_UPLOAD_DISABLED`；录音改为 `POST /lessons/:id/turn` 的 `learnerResponse.audioBase64`（最大 20,000,000 字符），服务端不落盘 | — |

### 端侧语音额度租约

Android 端在调用受限的 ASR、云端 TTS 或音素评测 SDK 前，必须先向服务端申请短期额度租约：

| 路由 | 用途 |
|---|---|
| `GET /speech/quota/status?learnerId=...` | 查询当天各服务的上限、已用、预留和剩余秒数 |
| `POST /speech/quota/reserve` | `{ learnerId, serviceKind, seconds, idempotencyKey }`，原子预留；`guest` 为 0 秒，`free` 默认每类 300 秒，`member` 默认每类 1800 秒，`advanced` 不限 |
| `POST /speech/quota/settle` | `{ reservationId, seconds }`，按供应商/SDK 返回的实际秒数结算 |
| `POST /speech/quota/release` | `{ reservationId }`，失败或取消时释放预留 |

租约默认有效 180 秒，服务端数据库是额度权威来源。Android 端在额度不足时不发起供应商请求；服务端对带有
`X-Learner-Id` 与 `X-Speech-Quota-Reservation` 是正式客户端访问语音媒体的必填请求头：

- ASR/发音请求必须同时携带两者；正式 Android 客户端在提交音频前先预留额度，服务端在调用供应商前再次校验租约，租约无效或额度耗尽时不会转发音频。
- 云端 TTS 音频下载也必须同时携带两者；Android 播放器先预留 TTS 额度，再用带请求头的下载请求读取音频，播放结束后按实际时长结算，失败则释放租约。
- ASR / 发音评测接口复用同一租约校验。客户端不得只依赖本地计时器。

端侧直连供应商时，供应商短期凭证也必须绑定同一租约；长期 API Key/AppSecret 不得放入 APK。课程缓存和旧 Web 原型的无租约读取只作为过渡兼容路径，正式客户端不使用该路径。

### TTS 缓存作用域（D-014 / D-026）

- 一轮教师话语整轮单次合成，`segments` 通常只有 1 项，`audioRef === segments[0].audioRef`；不做固定字数 / 单词 / 短句的逐段合成，避免韵律顿挫。
- `PUBLIC_CURRICULUM`：仅发布态课程内容且无动态覆盖时启用，允许同一课程跨用户、跨时间复用；键中不含 `learnerId` / `lessonSessionId`。
- `PRIVATE_DYNAMIC`：默认 fail-closed；键中含学习者与课堂标识，音频文件与媒体资产按归属隔离，按 24 小时 TTL 失效。
- 缓存键包含 `contentVersion`、`voiceParamsHash`、`voiceProfileVersion`、`modelFamily`；发布内容、音色档案或模型族变更时旧音频不再命中。`pauseAfterSentenceMs` 属播放端行为，不进缓存键。

### TTS 缓存清理与可观测性

- `TtsCacheMaintenanceService` 默认每 6 小时执行一次，启动 10 分钟后首跑；只清理两类资源：`expiresAt` 已过的资产/索引，以及无任何活跃 `media_assets` / `.tts-*.json` 引用且超过宽限期的顶层音频文件。
- `PUBLIC_CURRICULUM` / `PRONUNCIATION` 永不按 TTL 删除；索引损坏、数据库删除失败时本轮不删音频；只识别 `24-hex.mp3|wav|m4a`，不碰 `uploads/` 与未知文件。
- 环境变量：`TTS_CACHE_CLEANUP_ENABLED`（默认 `true`）、`TTS_CACHE_CLEANUP_INTERVAL_MS`（默认 21600000）、`TTS_CACHE_CLEANUP_INITIAL_DELAY_MS`（默认 600000）、`TTS_CACHE_ORPHAN_GRACE_MS`（默认 604800000）。
- `GET /api/v1/admin/tts-cache` 返回进程内 TTS 缓存指标（请求、命中、single-flight 合并、miss、命中率、合成字符数）与最近一次清理统计；需要管理员 Cookie。

### 用量成本聚合（管理员只读）

- `GET /api/v1/admin/usage/cost`：需要管理员会话；`from` / `to` 为 ISO 时间，缺省为最近 30 天，区间必须小于等于 366 天；可选 `learnerId`、`lessonSessionId`、`topicId` 过滤。
- 响应为 `{ from, to, totals, byLearner, byTopic, byDay, note }`。每个桶包含 `calls`、`ttsCharacters`、`asrSeconds`、`pronunciationCalls`、`estimatedCostCny`、`unpricedCalls`；`byDay.date` 为 UTC 日期 `YYYY-MM-DD`。
- `topic` 维度取 `lesson_sessions.topicId`，未关联会话的账本行在 `byTopic` 中以 `topicId: null` 单列；不伪造 `courseId` / `lessonId`。
- `estimatedCostCny = 0` 可能是未计价而不是免费；`unpricedCalls > 0` 表示有计量单位但缺少模型或对应价格类型。接口不返回原始文本、音频或供应商凭据。

### 用量预算（管理员只读，P2-2D）

- 配置来源：环境变量 `USAGE_BUDGET_CONFIG_JSON`，JSON 对象包含 `learnerDay` 与 `topicMonth`；可配置 `ttsCharacters`、`asrSeconds`、`pronunciationCalls`、可选 `estimatedCostCny`。示例见 `deploy/docker/.env.example`。
- `GET /api/v1/admin/usage/budget` 返回生效快照，不返回环境变量原文或凭据。
- `GET /api/v1/admin/usage/budget/evaluate` 按 UTC 自然日 (`learner_day`) 或 UTC 自然月 (`topic_month`) 聚合 `ai_usage_logs`。80% 为 `warning`，100% 为 `exceeded`；当前 `enforcement=advisory`、`blocked=false`，不接 router 阻断。
- 未配置 `estimatedCostCny`，或窗口内存在 `unpricedCalls` 时，`displayMode=usage`，`cost=null`，只展示字符/秒/次数，不把 0 元当免费。

### 会员管理

管理端登录后通过 HttpOnly 会话 Cookie 调用以下接口，等级由服务端读取和保存，客户端不能自行传入等级：

| `GET /admin/learners/{id}/membership` | 读取学习者当前等级 |
| `PUT /admin/learners/{id}/membership` | `{ tier: "guest" | "free" | "member" | "advanced" }` |

读取会员接口同时返回 `speechQuota.byService`，包含 ASR、TTS、发音评测的当日上限、已用、预留和剩余秒数。新建档案默认等级为 `guest`；生产环境应仅由后台将注册学习者设置为 `free` 或更高等级。

`advanced` 仅供后台配置，手机客户端暂不提供购买或升级入口。

注册用户的账户级会员接口：

| `GET /admin/users?q=邮箱或名称` | 搜索注册用户并返回其学习者档案 |
| `GET /admin/users/membership-requests` | 查看待处理会员申请 |
| `PUT /admin/users/{userId}/membership` | `{ tier, note? }`，同步账户和其全部学习者，并写入变更记录 |
| `GET /admin/email/status` | 查看 SMTP 是否已配置，不返回任何密钥 |

管理员可将账户调整为 `guest`、`free`、`member` 或 `advanced`。新注册账户默认 `free`；`guest` 用于未注册访客，`advanced` 暂不提供手机客户端申请或购买入口。

## 管理 API

以下管理端点要求有效管理员会话。该会话是运维管理凭据，不授权家长读取儿童资料。

| Method / path | 请求 | 行为 |
| --- | --- | --- |
| `GET /admin/model-providers/catalog` | 无 | 读取预置供应商/模型目录（当前公开） |
| `GET /admin/model-providers/configs` | 无 | 列出已保存配置，Secret 脱敏 |
| `PUT /admin/model-providers/configs` | `ProviderConfigInput`，见 `provider-config.service.ts` | 保存模型接入并刷新对应运行时 provider |
| `GET /admin/model-providers/benchmarks?serviceKind=...&configId=...` | 服务类型、可选配置 ID | 查询最近 Benchmark 结果；返回 `latest` 与 `productionReady` |
| `POST /admin/model-providers/benchmarks/run` | `{ serviceKind, configId }` | 基于近 30 天真实账本运行一次运行准入 Benchmark 并写入 `ai_model_benchmarks`；mock 模式不调用供应商 |
| `POST /admin/model-providers/benchmarks` | benchmark JSON | 校验并记录手工 Benchmark，刷新 provider；生产门禁只认最近一次结果 |
| `GET /admin/learning/learners/{learnerId}/memories` | 无 | 列出记忆 |
| `PUT /admin/learning/learners/{learnerId}/memories/{memoryId}` | `{ memoryType, content, importance?, expiresAt? }` | 修正记忆，标记来源为 `admin_corrected` |
| `DELETE /admin/learning/learners/{learnerId}/memories/{memoryId}` | 无 | 删除单条记忆 |
| `GET /admin/learning/teacher-profile` | 无 | 读取或初始化教师人格 |
| `PUT /admin/learning/teacher-profile` | `{ adjustable, style, reason }` | 更新受限人格参数并写入版本历史 |
| `GET /admin/learning/teacher-profile/history` | 无 | 查询最近人格版本记录 |
| `PUT /admin/learning/teacher-profile/rollback/{historyId}` | 无 | 校验历史参数后回滚并写新版本 |

### 本轮补充登记

下列 5 组接口此前未在本快照登记，另有 1 个本轮新增的只读引用查询接口（`GET /admin/model-providers/configs/:id/references`），一并按当前 controller 登记；全部要求有效管理员会话（HttpOnly Cookie），不返回密钥明文。

1. `DELETE /admin/model-providers/configs/:id` — 删除单条模型接入配置。删除前可用配套只读接口 `GET /admin/model-providers/configs/:id/references`（本轮新增）查询任务路由对该配置的首选 / 备用引用；该接口不回读凭据。删除或停用后若该 `serviceKind` 不再有 `enabled=true` 配置，服务端默认返回 HTTP 400 并说明在课会话影响；显式 `?force=true`（`PUT` 为 body 内 `force: true`）才会继续，并在响应中给出 `runtimeNotice`。
2. `GET /admin/model-providers/runtime-scores?serviceKind=...` — 近 30 天按供应商别名 / 模型聚合的调用次数、平均延迟与运行速度分。
3. `GET /admin/model-providers/prices?serviceKind=...&configId=...` 与 `PUT /admin/model-providers/prices` — 读取 / 覆盖写入模型单价；写入体为 `{ serviceKind, configId, modelAlias, prices: [{ priceType, unitPrice }] }`。
4. `PUT /admin/email/settings` — 保存 SMTP 配置；密码字段留空表示保留已保存值，响应不返回密码明文。
5. `POST /admin/email/test` — 按当前保存的 SMTP 设置发起连接验证。

> 创建模型配置仍沿用既有 `PUT /admin/model-providers/configs` 的 upsert 语义（body 带 `id` 为更新、不带 `id` 为创建）；本轮评估后不新增 `POST /configs`，避免第二条创建路径与现有 Zod 校验产生漂移。

### 用户资料与等级字段契约（本轮补充登记）

- `PUT /user/profile` 的 `avatarUrl` **字段名不变**，值域放宽为：`http(s)://` 外链，或 `preset://` 本地头像资源标识（规范顺序 `preset://b00..b23` / `preset://d00..d09`；历史长写法 `preset://avatar/basic_NN` 等亦兼容）。此前 `z.string().url()` 不接受 `preset://`，本地头像无法保存；非 http(s) 协议、空串与非法标识仍返回 400。不改数据库 schema、不加 migration。
- `GET /user/dashboard` 新增以下 additive 字段；既有字段（`user` / `learner` / `textbook` / `abilities` / `stats` / `achievements` / `textbooks` / `calibrationNotice` / `profile`）一律不变。`learner.entryLevel` 仍为入学起点 `pre_a1`，客户端不得自行推导 CEFR：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `level` | CEFR 枚举字符串（pre_a1 / a1 / a2 / b1 / b2） | 参考档位，仅展示；阈值未校准时须使用「参考档位 · 未校准 · 不代表掌握」措辞 |
| `avatarTier` | 整数 0–14 | 头像解锁档位；取 `max(当前 abilities 推导值, learning_evidence 历史累计推导值)`，降级不重新锁定 |
| `unlockedCount` | 整数 24–34 | 可用头像数：`24 + min(2 * ceil(avatarTier / 3), 10)`。24 个基础头像（`b00..b23`）从档位 0 起全部可用；10 个 3D 头像（`d00..d09`）每 3 档解锁 2 个，5 步解锁完。分段锚点：tier 0→24；1–3→26；4–6→28；7–9→30；10–12→32；13–14→34 |
| `levelProgress` | 对象 | 下一档所需条件 / 进度 / 依据 / 免责说明；含 `next.requirements`、`next.progress`、`next.additionalUnlocks`（升到下一档新增数量，0 或 2）、`next.unlockAhead`（下一个真正新增头像的档位）、`next.reward`、`baseUnlockedCount`、`extrasUnlocked`、`displayLabel`、`notice` |

推导规则（服务端纯函数，客户端只展示）：`S = Σ clamp(abilities[].stage, 0, 4)`（7 类，缺失按 0），`tier = clamp(floor(S / 2), 0, 14)`，`level = CEFR_BUCKETS[tier]`（0-2 Pre-A1 / 3-5 A1 / 6-8 A2 / 9-11 B1 / 12-14 B2），`extrasUnlocked = min(2 * ceil(tier / 3), 10)`，`unlockedCount = 24 + extrasUnlocked`。并非每档都新增头像（每 3 档才 +2），客户端应使用 `next.unlockAhead` 而不是假定 `next` 一定解锁 2 个。`calibrated` 不作为解锁开关，只影响展示措辞；客户端不保存任何解锁状态，推导幂等。契约与纯函数单测见 `packages/shared-contracts/src/cefr.ts`。

### 课程生成与级别媒体预热（本轮补充登记）

| 接口 | 请求 | 行为 |
|---|---|---|
| `POST /admin/curriculum/textbook/generate` | `{ title, level, words, unitSize?, useAi?, persist? }` | 词表生成完整 `schemaVersion 2` JSON；默认按单元写入草稿；不生成图片/语音 |
| `GET /admin/curriculum/preset?level=A1` | 可选 `level` | 返回服务端预置 CEFR 纯 JSON；只读，不触库、不调用模型 |
| `POST /admin/curriculum/preset/import` | `{ level? }` | 预置课程按单元写入审核队列；不自动发布 |
| `POST /admin/curriculum/preset/warmup` | `{ level, maxImages?, maxSpeech? }` | 只处理该级别已发布课程；Openverse + Wikimedia Commons 搜索并缓存最合适的单词/短句/场景图，回填后预生成公共 TTS；返回 `missingImages`，`mock` 模式跳过语音 |
| `POST /admin/curriculum/images/upload` | multipart：`file`、`key`、`kind`、`targetText`，可选 `targetWord`/`license`/`attribution` | 管理员补传缺失图片；写入 `media_assets` 并挂到已发布活动，返回 `attached` |

完整结构与运维说明见 `docs/curriculum-generation.md`。

## 当前契约缺口

1. OpenAPI 3 文档尚未生成；管理配置、结课和数据库响应仍缺统一的 Zod schema 与字段级响应约束。
2. 没有统一的错误码表、分页规范、速率限制和版本兼容策略。
3. 学习者教学 API 仍需把已登录用户与 `guardianId` 归属校验接入所有读写路径；当前账户认证接口已具备。
4. 原型音频上传已实现，但短期保留、自动删除、对象存储和正式访问控制尚未实现。
5. 本 API 快照与 M0 冻结验收记录尚未建立，不能称为“contracts are locked in M0”。
6. 管理端 `admin/auth/*`（登录 / 登出 / 会话查询）、`admin/model-routing`、`admin/curriculum/*`（本轮已登记词表生成、预置读取/导入、预热、缺失图片上传五接口，其余仍待登记）、`admin/backups/*` 尚未在本快照逐条登记；Android 侧 `/user/*` 等接口同样未登记。以上如实记为已知登记缺口：本文仍保持「M0 冻结快照（原型范围）」定位，不改写为完整 API 手册。

## 代码来源

- 入参/教学回合：`packages/shared-contracts/src/teaching.ts`
- controller 路由：`services/backend/src/lessons/lessons.controller.ts`、`speech/speech.controller.ts`、`providers/provider-config.controller.ts`、`memory/memory-admin.controller.ts`、`media/media.controller.ts`
- provider 配置输入：`services/backend/src/providers/provider-config.service.ts`
- 数据模型：`services/backend/prisma/schema.prisma`

# V1.1 设计差距与下一步开发任务

> 依据：`docs/ai-language-growth-v1-1-design.pdf`、`../docs/taskbook-v1.1-extracted.txt`、`DECISIONS.md`。
> 本文件只记录“设计承诺”和“当前代码事实”的差距，不把待办写成已完成。
> 更新时间：2026-11-12。

## 1. 本轮已关闭的差距

| 设计承诺 | 代码事实 | 验证 |
|---|---|---|
| 掌握状态必须有证据，且区分“有提示”与“独立完成” | `orchestrator.service.ts` 把 `promptedAttempt` 真实传入 `assess`；发音/ASR/点选/文本分支以 `passed && !prompted` 才记为独立样本 | `npm run typecheck --workspace @alg/backend` 通过 |
| R4：跨场景 + 跨天回忆才可 `transferred` | `packages/skill-graph/src/mastery.ts` 从“第 N 个不同场景首次成立”起算 24 小时，旧场景证据不能补新场景的间隔 | `mastery.test.ts` 23/23 通过 |
| R6：只有真实回归才降级，且恢复需要新证据 | 失败必须晚于“首次 mastered 所需独立样本”才算回归；回归后需 N 个场景 + 跨天无提示回忆才恢复；没有回归时单一场景失败不降级 | 同上 |
| 固定课程 TTS 首调用生成、跨用户复用 | 仅“发布态固定教师话语 + 固定示范文本”进入 `PUBLIC_CURRICULUM`；动态纠错示范、复习轮、上一主题问候留在 `PRIVATE_DYNAMIC` | `prosody-contract.test.ts`、`tts-public-scope.test.ts` 通过 |
| 成本账本按千字符计价 | 新增 `per_1000_chars`（元/千字符）；历史 `per_character` 价格仍可读，二者不会重复计费 | `prisma-usage-ledger.test.ts` 通过 |
| 儿童录音只留手机端 | 客户端以一次性 base64 随课堂回合提交；服务端只在请求内转 `data:` URI 给 ASR/发音适配器，写事件前剥除音频字段；`POST /media/audio/uploads` 返回 410 | `@alg/backend` typecheck 通过；真机/编译待验证 |
| 发音结果交给文本模型并语音纠正 | 新增 `PronunciationCoachService`，发音未通过时把 `score/errorUnits/target` 交给 `llm.teaching_explanation`，生成一句 ≤60 字纠正，拼入下一轮 `teacherUtterance` 走 TTS；失败用确定性文案 | `pronunciation-coach.test.ts` 3/3 通过 |
| 教材单词表自动补全完整课程 | 新增 `schemaVersion 2` 纯 JSON 契约、确定性生成器、`POST /admin/curriculum/textbook/generate`、可选 AI 润色；词表按单元写入草稿，不自动发布 | `curriculum/test/cefr.test.ts` 4/4、`curriculum-generator.test.ts` 3/3 通过 |
| CEFR 全量内容预置服务端 | `packages/curriculum/data/cefr-curriculum.json` 预生成 7 级/49 单元/917 活动（核心词 + 日常用语/场景）；`GET /admin/curriculum/preset` 只读返回；`POST /preset/import` 导入审核队列 | 预置 JSON 通过 `cefrCurriculumPackageSchema` 校验 |
| 图片/语音只在到达级别后预热 | `CurriculumWarmupService` 在仪表盘推导级别后异步触发；先按单词/短句/场景需求从 Openverse + Wikimedia Commons 搜索并缓存最优图，找不到记录 `missingImages` 供管理员上传，再生成 `PUBLIC_CURRICULUM` TTS；`AI_GATEWAY_MODE=mock` 跳过语音 | `curriculum-generator.test.ts` 覆盖未发布级别不生成媒体；真实图片搜索与真机/真实供应商待验证 |
| 生产 Web 只读评估 | Web 默认关闭课堂预览与开课按钮；`startLesson` 在 `NEXT_PUBLIC_ENABLE_LESSON_START !== 'true'` 时直接拒绝；评估/证据/成本页保持可读；仅本地联调显式开启 | `web-evaluation-only.test.ts` 4/4 通过；生产 `next start` 首页 HTML 无开课按钮/课堂预览，含关闭态说明 |
| 公共 TTS 音频按 TTL 与孤儿文件清理 | `TtsCacheMaintenanceService` 默认每 6 小时清理：删除已到期 `media_assets` 与 `.tts-*.json` 索引；仅删除无任何活跃数据库/索引引用且超过 7 天宽限期的顶层音频。`PUBLIC_CURRICULUM`/`PRONUNCIATION` 永不按 TTL 删除；索引损坏或数据库删除失败时跳过音频删除 | `tts-cache-maintenance.test.ts` 5/5 通过（过期、公共保留、双引用、损坏索引、数据库失败、幂等）；`tts-cache.test.ts` 增加命中率/合成字符数断言 |

## 2. 仍未关闭的差距（按优先级）

### P0：影响“教学判定能成立”或“能安全上线”

| # | 差距 | 现状 | 下一步任务 | 验收 |
|---|---|---|---|---|
| P0-1 | Android 未编译、未真机听测 | 本机无 JDK/Gradle/kotlinc；改动只在源码层 | 走 `android-client.yml` 编译 + 真机走一遍“录音→提交→回放→发音纠正” | CI 绿；真机能回放本地录音；服务端无 `uploads/` 新文件 |
| P0-2 | 发音评分与掌握判定尚未用真实供应商校准 | 用户明确：真实录音校准只能在使用中观察，本轮不校准 | 保留为真实使用后的观察项；不把未校准分数单独当作 `mastered` 依据 | 用户决定，不阻塞本轮 |

### P1：影响产品闭环

| # | 差距 | 现状 | 下一步任务 |
|---|---|---|---|
| P1-1 | 课程内容只有 M1 三主题/约 20 活动 | 已新增 CEFR 7 级预置 917 活动与教材词表生成器；内容仍须人工审核 | 继续扩充预置词库、日常用语与教材版本；审核后按级别发布 |
| P1-2 | `curriculum_stages` 只有 schema | 代码未引用 | 用阶段表驱动 planner 的阶段边界与解锁，不再写死 M1 |
| P1-3 ✅ 已关闭 | 家长报告端点缺失 | 已新增只读 `GET /learners/:id/reports/weekly`：按 `Asia/Shanghai` 周一起算，聚合课堂时长估算、独立成功、覆盖能力、待巩固点、到期复习与确定性下周建议；空周/边界/鉴权/隐私单测通过 | 只读聚合，不写库、不调 LLM、不暴露原始录音/转写/供应商/成本；Android「我的账户」新增成长周报卡片；CI `43193274538` 与 Android `43193274548` 成功，提交 `0ef1231` |
| P1-4 ✅ 已实现，待 CI | Android 家长/孩子共用但角色边界弱 | 已增加两位数乘一位数的家长验证；家长区是独立解锁态，不复用儿童主题 | 孩子端隐藏注销、隐私协议与会员支付占位入口；解锁后才显示并受回调二次校验；重新打开应用或手动锁定后恢复孩子端；Android CI 编译验证中 |
| P1-5 | 计费/支付缺失 | 无 billing/payment | 先做额度与成本看板，不做支付；家庭内测阶段用管理员配额 |
| P1-6 ✅ 已关闭 | `chooseAdaptiveActivity` 无条件调 LLM | 已改为确定性优先：清晰胜者、同任务类型、难度不同和已掌握场景直接返回；只有同层同难度、不同任务类型且未掌握时走 `llm.learning_plan_tiebreak`（L1），失败回落规则胜者 | 4 个固定场景的 LLM 账本调用由 4 降到 1（-75%）；单测 7/7、一次性 PostgreSQL 账本探针通过；详见 `docs/P1-6-adaptive-planner.md` |
| P1-7 ✅ 已关闭 | 运行准入 Benchmark 只评估真实账本的可用性，不替代儿童教学质量 | 已实现基于近 30 天 `ai_usage_logs` 的运行准入：配置预检、样本量、平均延迟和 P95；写入 `${serviceKind}_runtime_readiness`，最近一次结果决定准入 | 管理端已加“运行 Benchmark”按钮、最近结果与生产准入提示；`AI_GATEWAY_MODE=live` 下未通过禁止启用配置和写入已启用路由，mock 不阻断；单测 11/11、全量 185/185、一次性 PostgreSQL 集成通过；CI `43187489013` 的 P1-7 步骤成功；详见 `docs/P1-7-benchmark-readiness.md` |
| P1-8 | `consent_records` 表存在但无引用 | 合规已明确忽略 | 不实现；在隐私政策说明“监护人陪同使用”，不写虚假 consent 流程 |

### P2：工程与可运维性

> P2-1 已关闭，保留在本表作为补证索引；P2-2 已关闭；其余项仍未关闭。

| # | 差距 | 下一步 |
|---|---|---|
| P2-1 ✅ 已关闭 | `m1-api.integration.test.ts` 需真实 Postgres，未在本机跑 | 2026-11-12 已在服务器 `152.136.230.132` 的 `alg-postgres` 容器创建一次性测试库，完成 21 个迁移 + seed，启动本地 mock 后端后运行测试：`1/1` 通过、`0` 失败（4580.5ms）；测试库已 `DROP DATABASE ... WITH (FORCE)`，生产库未写入测试数据。复现脚本：`tools/run_m1_remote_pg.py`；完整证明见 PR #2「P2-1 补证」。 |
| P2-2 ✅ 已关闭 | TTS/ASR/发音成本只有账本，无按课程/用户的预算看板 | 2026-11-12 已完成 P2-2A~E：直连 TTS/ASR/发音入账、管理员只读聚合、`/costs` 账本与 learner/day、topic/month 预算卡；一次性 PostgreSQL + mock 对账 9 次调用（TTS 3 / ASR 3 / 发音 3），账本、聚合 API、页面一致；详见 `docs/P2-2E-usage-reconciliation.md`。 |
| P2-3 | 发音供应商如果不支持“不留存”，隐私政策与实际不一致 | 选型时把“不用于训练/不保留”写进供应商清单；不支持则不接 |
| P2-4 | 音频格式/采样率在 Android 与供应商之间未做真机矩阵 | 至少验证 AAC 44.1k/单声道；不支持的格式服务端明确 415 |
| P2-5 | 生产 Docker 基础冒烟已完成（2026-11-12）：新镜像重建、迁移 `20261111120000_media_asset_scope_ownership` 应用、`/api/v1/health` 200、旧录音上传端点 410 | 生产仍为 `AI_GATEWAY_MODE=mock`；切 live 后需跑一课真实 TTS/ASR/发音并核对账本 |

#### P2-2 后续任务（全部完成）

> 现状：`/speech/synthesize`、`/speech/recognize`、`/speech/evaluate` 直连网关成功后写入 `ai_usage_logs`；TTS 缓存重播保留 0 字符行，ASR 按实际秒数、发音按调用次数计量。管理员可只读查询 `GET /api/v1/admin/usage/cost` 与预算快照/评估，`/costs` 已接入历史账本、learner/topic/day 明细和 learner/day、topic/month 预算卡。`lesson_sessions` 只有 `topicId`，没有独立 `courseId`/`lessonId`；课程维度按 session→topicId 聚合，若产品需要稳定课程 ID，再单独加字段/迁移。
>
> 价格口径：`estimatedCostCny=0` 且模型未配置价格时表示“未计价”，不是零成本；预算先支持字符/秒/次数与未计价计数，金额预算必须等 `ai_models.prices` 可用后启用。

| 顺序 | 任务 | 具体交付 | 验收 |
|---|---|---|---|
| 1 | **P2-2A ASR/发音/TTS 入账 ✅ 已完成** | 在 `/speech/synthesize`、`/speech/recognize`、`/speech/evaluate` 成功返回后写 `ai_usage_logs`：`serviceKind`、`taskRoute`、`learnerId`、可选 `lessonSessionId`、TTS 字符、ASR 秒数（用 `AsrResponse.seconds`）、发音次数、provider/model、latency；TTS 缓存重播写 0 字符但保留一行；ASR 二次高质量识别按实际两次 pass 分别入账；不写音频或目标文本。编排器仍通过 gateway 调用后自行写账，直连接口不复用该路径。 | 已实现；`speech-usage.test.ts` 5/5 通过（TTS 正常/缓存、ASR 单次/双 pass、发音单次）；`p2-2e-usage-flow.integration.test.ts` 在一次性 PostgreSQL 上通过；`@alg/backend` typecheck 通过。 |
| 2 | **P2-2B 课程/用户聚合 API ✅ 已完成** | 新增管理员只读端点 `GET /api/v1/admin/usage/cost`，按 `from/to` + 可选 `learnerId`/`lessonSessionId`/`topicId` 聚合；返回 TTS 字符、ASR 秒、发音次数、`estimatedCostCny`、`unpricedCalls`，按 learner/topic/day 分组；课程维度先取 `lesson_sessions.topicId`，不伪造 `lessonId`；无 `learnerId` 的记录单独归入 null 桶。`from`/`to` 缺省最近 30 天，范围上限 366 天。 | 已实现并通过 CI：`usage-cost.test.ts` 4/4，`@alg/backend` typecheck 通过；`usage-cost.integration.test.ts` 在 CI 一次性 PostgreSQL 上创建 2 个 learner × 2 个 topic 账本并核对聚合，通过；空区间返回 0，topic 过滤生效；仅管理员可读。 |
| 3 | **P2-2C `/costs` 接入账本 ✅ 已完成** | 保留现有进程内 TTS 缓存面板，新增“账本用量”区：日期范围、learner/topic 过滤，展示 TTS 字符、ASR 秒、发音次数、估算金额、未计价调用；按 learner/topic/day 三张只读表展开；进程指标与账本指标分栏标注，不把两者相加。 | 已实现：`admin-console-static-guard.test.ts` 10/10 通过，新增账本端点/日期与 learner/topic 字段/`unpricedCalls`/分栏不相加/无写请求断言；`@alg/admin-web` typecheck 与 build 通过。真实账本数据的浏览器数值对账已由 P2-2E 完成。 |
| 4 | **P2-2D 课程/用户预算 ✅ 已完成** | 已定义 `learner_day`（UTC 自然日 + learnerId）与 `topic_month`（UTC 自然月 + lesson_sessions.topicId）作用域；配置来源为环境变量 `USAGE_BUDGET_CONFIG_JSON`，管理员 `GET /admin/usage/budget` 可读回，`GET /admin/usage/budget/evaluate` 只读评估。80% `warning`、100% `exceeded`，`enforcement=advisory`、`blocked=false`；未配置金额或存在 `unpricedCalls` 时 `displayMode=usage`，只展示字符/秒/次数。`/costs` 已接入快照与按筛选 ID 的评估，未指定 learnerId/topicId 时只显示配置上限与提示。 | `usage-budget.test.ts` 11/11 通过（配置解析、UTC 窗口、79/80/100 边界、未计价金额省略、价格可用时的金额预算、缺少 learnerId/topicId 拒绝、管理员鉴权、两个 scope 的服务过滤）；`admin-console-static-guard.test.ts` 11/11 通过（预算只读接入、80/100、未计价只展示用量）；`@alg/backend` typecheck/build、`@alg/admin-web` typecheck/build 通过；不改变 router 现有 `dailyBudgetCny`。 |
| 5 | **P2-2E 回归与上线门槛 ✅ 已完成** | 用一次性 PostgreSQL + mock 跑完整链路：TTS、ASR、发音各若干次，核对账本、聚合 API、`/costs`；补测试与文档；不写生产库。 | 账本 9 行（TTS 3 / ASR 3 / 发音 3），TTS 字符 9、ASR 4.5 秒、发音 3；聚合 API 与 `/costs` 页面一致；`unpricedCalls=0`，`estimatedCostCny=0` 按未计价口径展示；一次性库已删除、端口已释放；CI 已加入 P2-2E 步骤。完整证据见 `docs/P2-2E-usage-reconciliation.md`。 |

复现（先 `npm ci && npm run build`）：`M1_REMOTE_PASSWORD='<password>' python tools/run_m1_remote_pg.py --host 152.136.230.132 --user root --test-file services/backend/test/p2-2e-usage-flow.integration.test.ts`；需要浏览器对账时加 `--serve`，详见 `docs/P2-2E-usage-reconciliation.md`。

## 3. 建议的开发顺序

1. **P0-1**：Android 真机听测（P0-3 发音教练回归测试已完成）。
2. **P1-1/P1-2**：课程与阶段表；审核并发布 CEFR 预置课程，补教材版本。
3. **P1-3/P1-4**：家长报告与家长门；家庭内测最小闭环。
4. **P1-7**：运行准入 Benchmark 与 live 生产门禁已完成；成本与模型切换治理继续按后续任务推进。
5. 真实发音校准按用户决定，只在真实使用中观察，不作为本轮开发前置。

## 4. 本轮不做的事情（明确边界）

- 不实现监护人 consent/授权流程：当前只在小范围亲属家庭使用，合规项按用户决定忽略；隐私政策只做事实说明。
- 不做支付/订阅：没有真实收费场景。
- 不把 Web 做成孩子学习端：Web 只保留评估与联调。
- 不把录音写到服务端磁盘、对象存储或数据库；服务端只做请求内转发。

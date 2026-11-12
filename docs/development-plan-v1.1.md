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
| P1-3 | 家长报告端点缺失 | 只有学习者进度/证据查询 | 增加家长周报：本周时长、独立样本数、退步点、下周建议；只读聚合，不暴露原始录音 |
| P1-4 | Android 家长/孩子共用但角色边界弱 | 同一客户端有“我/进度”，无家长锁 | 加简单家长门（PIN 或系统生物识别）保护注销/隐私/支付；孩子端不显示敏感操作 |
| P1-5 | 计费/支付缺失 | 无 billing/payment | 先做额度与成本看板，不做支付；家庭内测阶段用管理员配额 |
| P1-6 | `chooseAdaptiveActivity` 无条件调 LLM | 默认 premium L3，确定性 fallback 只在失败时用 | 改为确定性优先、LLM 只在边界情况 L1 调用；省成本且可复现 |
| P1-7 | `hasPassingBenchmark` 无调用、Admin 无 benchmark UI | 配置层有定义 | 加“运行 benchmark”按钮与最近结果；未通过禁止切生产 |
| P1-8 | `consent_records` 表存在但无引用 | 合规已明确忽略 | 不实现；在隐私政策说明“监护人陪同使用”，不写虚假 consent 流程 |

### P2：工程与可运维性

| # | 差距 | 下一步 |
|---|---|---|
| P2-1 | `m1-api.integration.test.ts` 需真实 Postgres，未在本机跑 | 生产 Docker 起 Postgres 后跑一遍；把结果写进 PR |
| P2-2 | TTS/ASR/发音成本只有账本，无按课程/用户的预算看板 | Admin 加日/周成本、缓存命中率、单课成本 |
| P2-3 | 发音供应商如果不支持“不留存”，隐私政策与实际不一致 | 选型时把“不用于训练/不保留”写进供应商清单；不支持则不接 |
| P2-4 | 音频格式/采样率在 Android 与供应商之间未做真机矩阵 | 至少验证 AAC 44.1k/单声道；不支持的格式服务端明确 415 |
| P2-5 | 生产 Docker 基础冒烟已完成（2026-11-12）：新镜像重建、迁移 `20261111120000_media_asset_scope_ownership` 应用、`/api/v1/health` 200、旧录音上传端点 410 | 生产仍为 `AI_GATEWAY_MODE=mock`；切 live 后需跑一课真实 TTS/ASR/发音并核对账本 |

## 3. 建议的开发顺序

1. **P0-1**：Android 真机听测（P0-3 发音教练回归测试已完成）。
2. **P1-1/P1-2**：课程与阶段表；审核并发布 CEFR 预置课程，补教材版本。
3. **P1-3/P1-4**：家长报告与家长门；家庭内测最小闭环。
4. **P1-6/P1-7**：成本与模型切换治理。
5. 真实发音校准按用户决定，只在真实使用中观察，不作为本轮开发前置。

## 4. 本轮不做的事情（明确边界）

- 不实现监护人 consent/授权流程：当前只在小范围亲属家庭使用，合规项按用户决定忽略；隐私政策只做事实说明。
- 不做支付/订阅：没有真实收费场景。
- 不把 Web 做成孩子学习端：Web 只保留评估与联调。
- 不把录音写到服务端磁盘、对象存储或数据库；服务端只做请求内转发。

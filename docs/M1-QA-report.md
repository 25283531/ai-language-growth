# M1 验收报告：Web 教学原型 + 基础模型路由

> 项目：成长型 AI 儿童英语语言习得平台
> 依据：`README.md` 里程碑定义、`DECISIONS.md`（25 条统一决策）、V1.1 设计任务书
> 验收目标：**「教、听、评估、调整、记录」五动作完整运行**，而不是语音聊天演示
> 报告日期：2026-11-07（首版）；2026-11-09 按收敛口径补充

---

## 0. Go / No-Go 结论

> **口径说明**：下文「GO（有条件通过，仅限 M1 原型范围）」及判定依据中的 15/15、28 项单测、5 项数据库硬约束、CI / Android 工作流 success 均为 **2026-11-07 M1 原型验收的历史结论**，仅作留档；本轮（2026-11-09）为验证入口的配置变更，不升级该结论、不作通过验收结论。

**结论（历史基线）：GO（有条件通过，仅限 M1 原型范围）**

判定依据（历史基线）：

- 验收目标「教、听、评估、调整、记录」五动作端到端 **15/15 通过**，且连续读错换方法这一验收红线由 L0 规则真实触发
- 三项硬约束均有代码与数据库层证据（教学决策在后端、模型可替换、状态变更可追溯到证据）
- **28 项单测**、**5 项数据库硬约束**、7 个 workspace 全量 typecheck 与构建全部通过
- CI 与 Android 两个 GitHub Actions 工作流**云端实测均 success**，Android 产出真实 APK
- **本轮（2026-11-09）实测**：`npm run build` / `npm run typecheck` 均 EXIT=0；纯单测 `npx tsx --test packages/*/test/*.test.ts` **70/70 PASS**；根 `npm test` 三种条件并列（详见 §9.6）：(a) 新启动 mock 后端进程 + `DATABASE_URL`(15434)/`REDIS_URL`(16381) **64 tests / 64 pass / 0 fail / EXIT 0**（本轮最终结论，35/35 + 19/19 + 10/10）、(b) 同一 3100 进程内重复跑 64/63/1（内存 TTS 缓存命中、属测试隔离 / 进程状态污染，新残余风险见 §9.6）、(c) 无 `DATABASE_URL` 注入 64/63/1（环境注入缺失），(b)(c) 均非代码回归；修订后 `verify_live_apis.py` live 全量重跑 **23 PASS / 21 FAIL**；`verify_m1_loop.sh` 含 15 条 `ok()` 断言、当前 HEAD **6 PASS / 9 FAIL**（历史 15/15 属旧 HEAD）；代码提交 `0fe159b` 已推送 `main`、CI run `42593265380` `completed / success`，文档提交的新 run 结论待补。详见 [`docs/M1-live-API-report.md`](./M1-live-API-report.md) §4.0 与本报告 §9.6。
- **2026-11-07 21:25:22 修订前脚本快照 48/48**（本轮新配置、腾讯云签名 TTS + `glm-5.3-flash` + 裸 MP3 `fff348c4`），**不是 2026-11-09 实测、不是旧配置基线**；旧配置历史基线为 34/34。

附带的强制条件（不得豁免）：

1. 阈值全部 `uncalibrated`，产品对外不得出现「已掌握」表述；Web 已做合规标注
2. 课程内容全部 `pending_review`，发音/音标/自然拼读未经人工审核不得面向儿童发布（D-022）
3. 延迟数据为 Mock 基线，**接入真实模型后必须重测**（首版于 2026-11-07 完成，本轮按新配置重测并登记，见 §9）
4. 未接真实模型、无真实儿童样本，不得据此做任何教学有效性宣称
5. M2 才能给出完整 L1–L3 动态升级、阈值标定与稳定迁移证据链
6. **【2026-11-09 修订】**单轮 1—2 秒目标当前未达标，不得宣称实时语音体验达标；**7.0s 仅为 QA 自设 Canary 预警线，不是受控文档中的设计 SLA**；计时口径未定义（N7 定义债，见 §9.1）
7. **【2026-11-09 补充】**修订后脚本 live 全量重跑 23 PASS / 21 FAIL、未达成全 PASS，不作通过验收 / 全绿结论；在有历史用量的库上无法复现 live 48/48，登记为残余风险（见 §9.6、live 报告 §8.15）

> **本轮补充（2026-11-09，收敛口径）**：本轮仅为**验证入口的配置变更**——TTS 切换为腾讯云 `TextToVoice`「自然语言 / 超自然大模型 1.0」档（`VoiceType=502001`）、LLM 切换为智谱 `glm-5.3-flash`（策略与取值全部由 `.env` 注入），ASR 保持硅基流动 `FunAudioLLM/SenseVoiceSmall`、发音评估保持 `mock_pronunciation`；不是供应商正式选型，不作通过验收 / 实时达标 / 零成本结论。
> **48/48 措辞**：`PASS=48 / FAIL=0` 是 2026-11-07 21:25:22 修订前脚本、**本轮新配置**的实测快照（结果文件 `tools/_live_results.json`，备份 `tools/_live_results_20261107_snapshot.json`），不是 2026-11-09 实测，也不是旧配置历史基线（旧基线是 34/34）。
> **23/21 措辞**：修订后脚本 live 全量重跑 **23 PASS / 21 FAIL**（结果文件 `tools/_live_results_20261109_head_contract.json`），未达成全 PASS；失败根因全部来自 `main` 推进到 `188d369` 之后的契约变化，与本轮 9 文件无关，详见 §9.6。
> 数字分层：纯单测 70/70、根 `npm test` 三种条件并列（(a) 新启动 mock 后端进程 + DB/Redis 注入 64 tests / 64 pass / 0 fail / EXIT 0 本轮最终结论；(b) 同一 3100 进程内重复跑 64/63/1 属测试隔离 / 进程状态污染；(c) 无 `DATABASE_URL` 注入 64/63/1 属环境注入缺失；(b)(c) 均非代码回归）、代码提交 `0fe159b` 的 CI run `42593265380` `completed / success`（文档提交的新 run 结论待补）、`51/51` 与 Mock 历史 15/15 为历史留档（`verify_m1_loop.sh` 含 15 条 `ok()` 断言，当前 HEAD 实跑 6 PASS / 9 FAIL，历史 15/15 属旧 HEAD）。`pricingStatus=unpriced` / `costCny=0` 表示未接价格表、不表示零成本；资源包为已付费 / 预付额度，不是免费；不同模型 / 音色档位资源包分别抵扣。
> Go/No-Go 的「有条件通过（仅限 M1 原型范围）」为历史结论，本轮不升级、不作通过验收结论。

---

## 1. 本阶段执行边界

| 项 | 本阶段选择 | 说明 |
| --- | --- | --- |
| 数据层 | 远程服务器 `152.136.230.132` 的 Docker | PostgreSQL 16 + Redis 7；云安全组仅放行 22/80/443，数据库经 SSH 隧道映射本机 `15433/16380` |
| AI 服务 | **Mock Provider Adapter** | 不接真实模型、不产生外部调用与费用；分级路由策略照常执行 |
| 教学逻辑 | 全部在 NestJS 后端 | Web 与 Android 只渲染后端返回的 `directive` |
| Android | 最小音频原型，由 GitHub Actions 构建 | 本机无 Android SDK，不做真机编译 |
| 交付 | 分阶段提交并推送 `main` | 工作流自行创建、自行测试 |

---

## 2. 交付清单

| 层 | 路径 | 内容 |
| --- | --- | --- |
| 契约 | `packages/shared-contracts/` | 掌握状态五态编码、证据模型、阈值配置、教学回合契约、路由接口、能力节点三段式编码 |
| 能力图谱 | `packages/skill-graph/` | R1–R7 掌握判定规则引擎、23 个能力节点、24 条依赖、硬前置门禁 |
| 课程 | `packages/curriculum/` | 三主题、33 词条、6 句型、20 个教学活动，全部 `pending_review` |
| 路由 | `packages/model-router/` | L0–L3 分级、多信号升级、方法阶梯、内存用量账本 |
| 适配层 | `packages/ai-provider-sdk/` | 统一 Provider 协议、注册表、四类 Mock 适配器 |
| 后端 | `services/backend/` | NestJS 模块化单体、36 张表 Prisma schema、迁移 SQL、种子、编排器与控制器 |
| Web | `apps/web/` | Next.js 教学实验台，纯 CSS、零 UI 库 |
| CI / Android | `.github/workflows/`、`apps/android-audio-prototype/` | CI 与 Android 最小音频链路原型 |
| 部署 | `deploy/docker/` | compose、backend Dockerfile、`.env.example` |

---

## 3. 三项硬约束落实情况

### 约束一：教学逻辑与客户端分离
`/lessons/{id}/turn` 是全局核心接口。一次调用在后端完成：意图分类 → 查当前目标 → 按需评估 → 写证据 → 重算掌握状态 → 方法阶梯调整 → 生成下一步教学指令 → TTS → 用量账本 → 落库 `interaction_events`。Web 端不含任何判断对错、决定下一活动或计算掌握状态的代码。

### 约束二：所有模型可替换
业务代码不含厂商名或具体模型名。Router 只选模型（配置别名）、Gateway 只调用 Provider Adapter。TTS 对外只暴露抽象参数 `teacherSpeed` / `voiceStyle` / `pauseAfterSentenceMs` / `pronunciationMode`。LLM / ASR / TTS / 发音评估四路独立路由，ASR 不等于发音评估。

### 约束三：教学数据必须有可靠证据
`learning_evidence` 仅允许 INSERT，由数据库触发器强制 UPDATE/DELETE 拒绝；`llm_judgement` 来源的证据可信度上限 0.4 且 `contributesToPromotion=false`，数据库 CHECK 约束兜底。掌握状态只由 R1–R7 规则引擎依据证据计算。「稳定迁移」要求两个不同场景独立使用 + 隔天无提示回忆；单条证据最多到 `encountered`。

---

## 4. 验收结果

### 4.1 五动作闭环端到端验证：`PASS=15 / FAIL=0`

> **历史基线（2026-11-07 M1 原型验收）**：本节 15/15 为当时的历史结果；当前 HEAD 同一 `tools/verify_m1_loop.sh` 照原样跑为 **6 PASS / 9 FAIL**（见 §9.6），不作本轮结论。

脚本：`tools/verify_m1_loop.sh`（工作区工具目录，非仓库文件）

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 开课成功、教学指令生成、抽象语速 0.52（未暴露厂商参数） | PASS ×3 |
| 2 | 语音生成、重复播放命中缓存 `cached=true`、缓存命中字符量为 0 | PASS ×3 |
| 3 | 发音评估返回得分 77 与 2 个音素单元；ASR 独立接口可用 | PASS ×2 |
| 4 | `/turn` 产生 1 条证据、1 次状态变更、生成本轮方法 | PASS ×2 |
| 5 | 同一 `idempotencyKey` 重复提交返回同一证据 id | PASS |
| 6 | 连续读错换方法（**验收红线**） | PASS |
| 7 | 能力档案带未校准声明、证据可查询 | PASS ×2 |
| 8 | 结课返回成本账本、`uncalibrated` | 通过（无断言） |
| 9 | 外部服务异常时仍返回教学指令，课程不中断 | PASS |

**连续失败时的方法阶梯（L0 规则驱动，非 LLM 决定）：**

| 连续失败 | 方法 | 抽象语速 |
| --- | --- | --- |
| 1 | `method_slow_clear` | 0.52 |
| 2 | `method_syllable_split` | 0.45 |
| 3 | `method_syllable_split` | 0.45 |
| 4 | `method_phoneme_focus` | 0.39 |

### 4.2 单元测试：28 项全部通过

> **历史基线**：本节 28 项为 2026-11-07 历史单测口径；本轮纯单测为 **70/70**（见 §9.6）。

| 套件 | 用例 | 结果 |
| --- | --- | --- |
| `packages/skill-graph/test/mastery.test.ts` | 17 | PASS（R1–R7、能力图谱依赖方向） |
| `packages/model-router/test/router.test.ts` | 11 | PASS（四路独立、升级信号、方法阶梯、厂商名禁用） |

### 4.3 数据库硬约束：5 项全部 PASS

脚本 `tools/verify_constraints.sql` 已改为**单事务 + ROLLBACK** 版本，可反复执行且不污染数据库（旧版清理段曾试图删除 seed 的能力节点，且证据表本就 append-only 不可清理，已修正）。

```
PASS: masteryCode 越界被 CHECK 约束拒绝
PASS: LLM 证据不得贡献晋级，CHECK 约束生效
PASS: 证据不可修改，触发器生效
PASS: 证据不可删除，触发器生效
PASS: 幂等键唯一约束生效
```

### 4.4 类型检查与构建

- 5 个共享包 `tsc` 构建全部通过
- `services/backend` `tsc --noEmit`：**0 errors**
- `apps/web` `tsc --noEmit`：通过；dev server 返回 200；生产构建见 CI 章节

### 4.5 延迟实测（Mock Provider 基线）

脚本 `tools/measure_latency.py`，20 轮教学回合，单位 ms。

| 接口 | n | avg | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| 开课 `/lessons/start` | 1 | 323.6 | 323.6 | — | 323.6 |
| **教学回合 `/lessons/{id}/turn`** | 20 | 397.3 | **394.2** | **438.2** | 438.2 |
| 幂等命中 `/turn` | 1 | 26.5 | 26.5 | — | 26.5 |
| TTS 首次生成 | 1 | 20.2 | 20.2 | — | 20.2 |
| TTS 缓存命中 | 10 | 6.4 | 2.6 | 25.7 | 25.7 |
| 发音评估 | 10 | 9.9 | 5.0 | 24.2 | 24.2 |
| ASR | 10 | 5.4 | 2.9 | 23.8 | 23.8 |
| 能力档案 | 5 | 46.5 | 46.4 | 48.0 | 48.0 |
| 证据查询 | 5 | 36.7 | 27.8 | 70.6 | 70.6 |
| 用量汇总 | 5 | 2.8 | 2.7 | 3.7 | 3.7 |
| 结课 | 1 | 71.3 | 71.3 | — | 71.3 |

**结论（Mock 基线，仅作对照）**：单轮编排 p50 394.2ms / p95 438.2ms。但必须明确：**这是 Mock 模式下的平台自身编排开销**（含经 SSH 隧道写远程 PostgreSQL 的往返），**不含真实 ASR/TTS/LLM 的网络与推理延迟**。

> ⚠️ **历史基线（2026-11-07 首版，仅作留档）**：接入真实服务后，ASR 单路 9.0—11.5 秒、TTS 3.2—4.7 秒、含 LLM 的回合约 6 秒，1—2 秒目标未达成，原文「有充足余量」不再成立。该组数据对应旧配置（glm-4-flash + 硅基 TTS 带 ID3 音频），与本轮新配置不可直接比较。本轮真实延迟口径见 [`docs/M1-live-API-report.md`](./M1-live-API-report.md) §4.1 与本报告 §9.1。

---

## 5. 本轮联调定位并修复的缺陷

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `/turn`、`/abilities`、`/evidence` 全部 500：`Cannot read properties of undefined (reading 'learner_skill_states')` | `tsx/esbuild` 不发射 Nest 的 `design:paramtypes` 元数据，`LearnerModelService` 漏加 `@Inject(PrismaService)` | 显式 `@Inject`，补齐所有服务的构造注入 |
| 2 | 重复播放永远不命中 TTS 缓存 | Gateway 只在 `!degraded` 时写缓存，而 Mock 模式每次都被判为降级 | 改为「拿到有效音频且非缓存命中即写缓存」 |
| 3 | 写证据会触发外键失败 | 课程活动用「媒体形式」场景（`audio_prompt` 等 5 值），而 `learning_evidence.scenario` 外键指向 `scenarios.code` 的「交际情境」8 值；契约层 `teaching.ts` 与 `skill-node.ts` 枚举也互相分裂 | 20 个活动按主题/交际情境映射到 6 个最终场景；`teachingActivitySchema.scenario` 统一为 `z.enum(EVIDENCE_SCENARIOS)`；重新 seed |
| 4 | 幂等与方法阶梯在验证脚本中假失败 | 脚本中 `E1` 用了恒假的 Python 表达式；`FINAL_METHOD` 未做非空判断 | 修正断言并增加错误体诊断输出 |
| 5 | 「假降级」：Router 报 L1 且 `degraded=false`，Gateway 却每次 fallback | Router 逻辑别名（`lowcost_tts` 等）在 Mock 模式下无对应已注册适配器 | 新增 `MOCK_PROVIDER_ALIASES`，Mock 模式下 Router 保留完整 level/strategy/fellBack 策略，仅把供应商别名指向真实存在的 Mock 适配器 |
| 6 | 降级上报不实 | `degradation` 只看 `routingDecision.fellBack`，对 Gateway 实际发生切换一无所知 | Gateway 新增 `ttsWithResult()`，编排器用真实调用链元数据填写 `degradation` |
| 7 | 「课程不中断」不成立 | `/turn` 异常时返回只有 `message/degraded` 的错误体，没有 `directive`，客户端其实无法继续上课 | 编排器新增 `offlineFallback()`，返回完整可渲染的固定课程 `TurnResponse`；兜底不写证据、不改状态、不计费 |
| 8 | 开课响应与契约漂移 | 缺 `learnerState`，多出 `characters`，`degradation` 硬编码 | 返回类型直接绑定 `LessonStartResponse`，补 `masteryStates`，降级信息取自真实调用链 |
| 9 | Web 幂等复验误报「不一致」 | 幂等响应由 PostgreSQL `jsonb` 反序列化，对象键顺序与首次响应不同，字符串比较失败 | Web 端用 `stableStringify` 做键排序后比较；后端幂等逻辑本身正常 |

---

## 6. 已知限制与未覆盖项（明确留给 M2）

1. **未接入任何真实模型**：全部为 Mock，成本账本金额恒为 0，不能用于真实成本核算。
2. **阈值全部 `uncalibrated`**：9 条阈值均为 `m1_provisional`，未经真实 6—9 岁儿童样本标定。**不得对外表述为「已掌握」**；Web 端已标注「内部原型状态 · 未校准 · 不代表掌握」并完整展示 `calibrationNotice`。
3. **`transferred` 状态未完成端到端演示**：需要两个不同场景独立使用 + 隔天无提示回忆，M1 的场景已铺好（6 个），但跨天回忆与迁移证据链尚未跑通。
4. **路由只实现 L0 / L1 / Fallback**：完整 L1–L3 动态升级、Benchmark、价格与限额表驱动、预算熔断留待 M2。
5. **记忆与人格**：M1 仅固定人格 + 会话记忆；长期记忆、人格演化、家长可见的成长档案在 M2。
6. **课程内容全部 `pending_review`**：发音、音标、自然拼读内容必须经人工审核后才能面向儿童发布（D-022）。
7. **Android 原型未在本机编译，但已在 CI 编译通过**：本机无 Android SDK/Gradle，仅做静态配置自检；GitHub Actions `assembleDebug` 已产出 APK（见 8.3）。原型仍只是音频链路演示：默认 `lesson_id` / `learner_id` 不对应真实数据、不上传音频字节、无身份校验、使用 HTTP 明文（正式客户端必须改 HTTPS）。
8. **延迟数据原不含真实模型往返**，见 4.5；首版（2026-11-07）已补真实模型实测、1—2 秒目标未达成；本轮按新配置重测仍未达标，计时口径未定义登记为定义债，见 `M1-live-API-report.md` §4.1 与本报告 §9.1。
9. **隐私与合规**：`consent_records` 表已在 schema 中，但 M1 未实现完整的监护人同意流、音频留存策略与数据导出/删除能力。
10. **演示数据累积**：`child-m1-demo` 学习者在多轮验证中累积了证据与状态；因证据表 append-only 不可清理，正式演示建议新建学习者档案。

---

## 7. 本地复现方式

```bash
# 0) 远程数据层已在 Docker 运行；本机建立 SSH 隧道
python tools/ssh_tunnel.py            # 15433 -> PG, 16380 -> Redis

# 1) 依赖与客户端
cd ai-language-growth
npm ci
npx prisma generate --schema services/backend/prisma/schema.prisma

# 2) 迁移与种子（DATABASE_URL 指向 127.0.0.1:15433）
cd services/backend && npx prisma migrate deploy && npx tsx prisma/seed.ts

# 3) 启动后端（AI_GATEWAY_MODE=mock）
npx tsx src/main.ts                  # :3100

# 4) 单测与端到端
npx tsx --test packages/skill-graph/test/mastery.test.ts \
                packages/model-router/test/router.test.ts
bash tools/verify_m1_loop.sh        # 历史期望 PASS=15 FAIL=0；当前 HEAD 为 6 PASS / 9 FAIL
python tools/measure_latency.py

# 5) Web 实验台
npm run dev:web                     # :3000

# 6) 数据库硬约束
python tools/ssh_run.py --put "tools/verify_constraints.sql:/tmp/v.sql"
python tools/ssh_run.py "docker exec -i alg-postgres psql -U alg -d ai_language_growth -f - < /tmp/v.sql"
```

---

## 8. CI / GitHub Actions 与 Android 原型

### 8.1 交付物

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/ci.yml` | push / PR 到 `main` 触发：`npm ci` → `prisma generate` → 按依赖顺序构建 6 个 workspace → 全量 `typecheck` → 28 项单测 |
| `.github/workflows/android-audio-prototype.yml` | `workflow_dispatch` 或 `apps/android-audio-prototype/**` 路径变更触发：JDK 17 + Gradle 8.7 → `assembleDebug` → 上传 APK artifact（保留 14 天） |
| `apps/android-audio-prototype/` | MediaRecorder 录音 / MediaPlayer 播放 / 把音频引用 POST 到 `/lessons/{id}/turn`；教学决策仍在后端 |
| `deploy/docker/backend.Dockerfile` | 多阶段构建，与 compose 的 `context: ../..`、`PORT=3000`、健康检查一致 |

两份工作流均为 `permissions: contents: read`；CI 只注入占位 `DATABASE_URL` 与 `AI_GATEWAY_MODE=mock`，不含任何真实凭据、厂商名或模型名。

### 8.2 推送前本机验证

- 两份 workflow YAML **按 YAML 1.2 语义**解析通过，逐项核对触发条件、权限、步骤与 artifact 路径。注意 PyYAML 依 YAML 1.1 会把 `on:` 解析成布尔 `True`，校验脚本必须覆盖 bool 构造器，否则会误判。
- 真实 `npm ci`：**PASS**（192 个包）；`npm ci --dry-run` EXIT=0。根 `package-lock.json` 已用 `npm install --package-lock-only` 收录 next/react（88KB → 120KB），满足 `npm ci` 的严格一致性校验——这是 CI 能否跑起来的前置条件。
- 按 `ci.yml` 的命令顺序做干净环境全链路复现：`prisma generate` → 6 个 workspace build → 全量 `typecheck`（7 个 workspace）→ 28 项单测，**全部 EXIT=0**。
- Web 生产构建 `next build`：**Compiled successfully**，4/4 静态页生成，0 errors。
- **唯一本地失败项**：在主工作副本跑 `prisma generate` 报 `EPERM: operation not permitted, rename ... query_engine-windows.dll.node`——Windows 上后端进程占用 Prisma 引擎文件造成的文件锁。在隔离的干净副本中同一步 **PASS**，故判定为本机环境干扰而非工作流缺陷；云端 runner 是干净 Linux 环境，实测也印证了这一点。
- backend Dockerfile 与 compose 的 `build.context: ../..`、`PORT=3000`、健康检查静态核对一致。构建上下文忽略采用三层：根目录 `.dockerignore`（Docker 默认读取）+ `deploy/docker/backend.Dockerfile.dockerignore`（Dockerfile 专用、优先级更高）+ `deploy/docker/.dockerignore`（说明与本地手工构建参考）。**本机 Docker daemon 未运行，`docker build` 未做实际验证。**
- Android：Gradle 8.7 / AGP 8.5.2 / Kotlin 1.9.24 / JDK 17 / compileSdk 34 / minSdk 26 静态自检通过。**本机无 Android SDK 与 Gradle，未做本机编译**，真实编译交给 runner。

### 8.3 推送后 GitHub Actions 实测（工作流自行测试）

分阶段推送共触发多轮 CI，经 GitHub Actions API 查询，关键轮次全部 success：

| 提交 | 工作流 | Run | 结论 |
| --- | --- | --- | --- |
| `715beca` | CI | `42354193275` | **success**（11 步） |
| `715beca` | Android Audio Prototype | `42354193269` | **success**（11 步） |
| `d975cbc` | CI | `42354443743` | **success**（11 步） |
| `413e31f` | CI | `42354578311` | **success**（11 步） |
| `29e42ec` | CI（新增 `Build web workbench`） | `42354638770` | **success**（12 步） |

Android 产物 artifact：`android-audio-prototype-debug`，**797,681 bytes**，`expired=false`，保留 14 天。

即：Android 最小音频原型**已在 GitHub Actions 上真实编译出 APK**（不只是本地配置自检）；CI 在干净的无数据库、无密钥环境中完整跑通安装、Prisma 生成、7 个 workspace 构建与类型检查、Web 生产构建、28 项单测。

> **本轮 CI 口径（2026-11-09）**：本轮第 1 个代码提交 `0fe159b`（6 个代码 / 配置 / 测试文件）已推送 `main`，触发 CI run `42593265380` / sha `0fe159b2` / `completed / success`、创建于 `2026-11-09T09:25:06Z`、更新于 `09:27:14Z`、链接 `https://github.com/25283531/ai-language-growth/actions/runs/42593265380`，job `build-and-test` `completed / success`。**注意边界**：该 run 只对应代码提交，覆盖 build / typecheck / 单测 / mock 集成用例，**不覆盖 live 全量端到端**（live 仍 23 PASS / 21 FAIL）；第 2 个仅文档提交推送后会另触发一个新 run，其结论待补，请写「文档提交的 CI run 待补」而不是笼统「本轮 CI 已全绿」。历史 CI run id `42565511080`、sha `188d369b` 及同批 `8a1bc53`、`b7bf54c` success 仍只作基线留档，不写成本轮通过、也不写「CI run 链接缺失」。

### 8.4 覆盖演进与剩余验证缺口

- 首轮 `ci.yml` 只跑 `typecheck`、未跑 Web 生产构建，已在 `29e42ec` 补入 `Build web workbench` 步骤，对应 CI run `42354638770` 12 步 success，**缺口已闭合**。
- **仍未在本机验证**：`docker build`（本机无 Docker daemon）、Android `assembleDebug`（本机无 Android SDK/Gradle）。前者留待部署阶段验证，后者已由云端 runner 编译成功。

---

## 9. 本轮收敛口径补充（2026-11-09）

> 本轮性质：**验证入口的配置变更**（TTS 腾讯云自然语言档 + LLM 智谱 glm-5.3-flash），非供应商正式选型、非达标 / 实时 / 免费 / 通过验收结论，不作「全绿 / 全部通过」宣称。以下为定义债、发布前置、残余风险、实测数据与未验证项的登记；历史基线数据（2026-11-07 首版旧配置 34/34）仅作留档，不与本轮新配置直接比较。

### 9.1 7.0s 性质与 N7 定义债

- 任务书只写「单轮语音交互目标 1—2 秒，须实测并记录」，**未定义首包 / 端到端 / 往返计时口径**。
- 项目自选 `/turn` 端到端完整响应到达作为计时口径。
- **7.0s 是 QA 自设 Canary 预警线，不是受控文档中的设计 SLA**；其性质与授权来源未书面确认，本轮只登记为 QA 自设预警线，不作已豁免结论。
- 2026-11-07 21:25:22 修订前脚本快照 `/turn` 端到端：普通作答 640ms、提问回合 5,660 / 5,523ms，**1—2 秒目标未达标**。
- 旧基线（glm-4-flash + 硅基 TTS + 带 ID3 音频）与新配置不可直接比较。
- **N7 登记：计时口径未定义，列为定义债**，待用户书面确认后补入 `DECISIONS.md`（见附录 A.1）。

### 9.2 N13 约束二边界（未定案）

约束二边界（只禁厂商名 / 模型名 / 音色名三类字面值，还是放宽到任何厂商专属标识）**尚未定案**；评审建议把协议常量与厂商值分层，但**不得写成已决定**。登记为定义债，待用户确认后补入 `DECISIONS.md`（见附录 A.1）。

- **实现侧自律 ≠ N13 裁定**：本轮 `config.ts` 把 `reasoning_effort` / `low` / `thinking` 等字段名与取值移出代码，是实现侧为保住「配置层一键回滚」自愿采取的更严格做法，不是对约束二边界的裁定；#13 只裁决 N27 工程策略，不裁 N13。文档描述本实现写「本实现把字段名与取值全部移到 .env，属实现侧选择」，不写「约束二已放宽 / 已收紧」「代码零厂商专属标识已达成」这类会被读成边界已裁定的表述。
- **`.env.example` 合规口径**：`deploy/docker/.env.example` 是配置示例，供应商相关取值本就应只出现在配置示例与部署编排中，属正确落点；按约束二窄解释（只禁厂商名 / 模型名 / 音色名三类字面值）通用协议字段名与枚举值不违规；但 N13 是否放宽到「任何厂商专属标识」仍未定案，故口径为「**当前按窄解释允许，边界待书面裁决**」，不得写成已确认合规。

### 9.3 N27 发布前置（代码侧已闭合 / 验证侧已实跑，未全部闭合）

`LLM_EXTRA_BODY_KV` / `LLM_MIN_MAX_TOKENS` 缺失或空串时启动期 fail-fast 不完整，属**潜在故障路径**，不是当前运行时状态。

- **代码侧已闭合**：`config.ts` 启动期 fail-fast 与 `llm-adapter.test.ts` 的 7 条负向用例已落地；本实现把字段名与取值全部移到 `.env`，属实现侧选择，代码只保留通用业务字段保护，policy 本身必需以防漏配，`LLM_EXTRA_POLICY=none` 即配置层一键回滚（键清单见 §9.7）。
- **验证侧**：本机纯单测 **70 / 70 PASS**（含 7 条负向用例）；源码级交叉验证 12/12、build / typecheck EXIT=0、根 `npm test` 64/64/0、live 两项配置回显探针 PASS、配置层回滚运行时探针 PASS、代码提交 `0fe159b` 的 CI success——**独立回归与代码提交 CI 已通过**；但 **live 端到端全 PASS 仍未达成（23 PASS / 21 FAIL）**、出站 body 运行时取证仍属 **M2 残余风险**（§9.4）。**不写「N27 已全部闭合」**。
- 作为发布前置项跟踪。

### 9.4 残余风险（两维：证据类型 × 来源可信度）

残余风险按两个**正交维度**分别登记，不得混为一谈：

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| 证据类型（只管归因） | ① 官方原文 ② 官方推导 ③ 实现建议（团队约定） | 结论来自哪一层，不决定可信度等级 |
| 来源可信度（另一维度） | A / B / C / D | 证据来源的强度等级，与三档正交 |

三档分层只管归因，**不剥夺**团队书面认可的 engineering hard gates 的门槛资格。把本轮取证按两维铺开，可以看到一个共同缺口（可信度等级为本轮按来源类型的登记，非官方评定）：

| 取证对象 | 证据类型 | 来源可信度 | 能证明 / 不能证明 |
| --- | --- | --- | --- |
| 腾讯云 TTS 502001 可用、2.0 档 `PkgExhausted` | ③ 实现建议 + 对照实验 | B | 档位归因仅为最高置信解释，非官方确认 |
| `/config/audit` | ③ 实现建议 | C | 只证明配置被读取；不证明出站 body 或档位采纳 |
| 单测（纯单测 70 / 70；根 `npm test` 三种条件：(a) 64 / 64 / 0 EXIT 0 本轮最终结论、(b) 同进程重复跑 64/63/1 测试隔离缺陷、(c) 无 DB 注入 64/63/1 环境依赖） | ③ 实现建议 | B | 只证明适配器组装逻辑与用例覆盖；不证明运行时链路；(b)(c) 两种 64/63/1 为条件性环境说明、非代码回归，详见 §9.6 |
| 独立裸 HTTP 直连 | ③ 实现建议（团队自建探测） | C | 团队自建裸调用实验，非官方材料；只证明上游行为基线，不证明业务链路运行时真实性 |
| 上游档位采纳回显 | —— | —— | 未验证 |
| 后端 → 上游 `/chat/completions` 出站 body / 原始响应 | —— | —— | **后端已注册 `HttpLlmAdapter` 并发起调用，但没有出站 body / 原始响应的落盘通道** |

结论：后端已注册 `HttpLlmAdapter`（`packages/ai-provider-sdk/src/protocol.ts` 定义、`config.ts` 注册表装配，向 `/chat/completions` 发起 fetch），但**没有**把该适配器发出的出站请求 body 与上游原始响应落盘的通道；`/config/audit` 只证明配置被读取，单测只证明适配器组装逻辑，独立裸 HTTP 直连只证明上游行为基线。M1 默认登记「出站取证」为残余风险；网络层抓包 / 中性结构化日志列 **M2**。

**证据效力边界（务必守住）**：凡涉及「回滚后出站 body 不再带推理字段」这类说法，只能写「配置层与适配器组装层证据表明不再注入」，证据来源是 `llm-adapter.test.ts` 的 `HttpLlmAdapter` 请求体断言 + `/config/audit` 的 `extraBodyKeys` 回显；**不得写「运行时出站 body 已取证」**。

**数据源可复核性差异（如实登记）**：

| 数据组 | 落盘结果文件 | 可复核性 |
| --- | --- | --- |
| 48/48 端到端快照（2026-11-07 21:25:22） | `tools/_live_results.json`（仓库外），备份 `tools/_live_results_20261107_snapshot.json` | 可按结果文件逐项复核 |
| 34/34 旧配置历史基线 | **无任何落盘结果文件**，只见于文档叙述 | 无法按结果文件复核 |
| 延迟拆解（LLM 5,466 / 6,593 / 8,197ms；TTS 669 / 355 / 270ms；外部合计约 6,948ms） | `tools/measure_breakdown.py` 只读凭据、直接 HTTP 探测、**不落盘结果文件**，数字来自会话输出 | 无法按结果文件复核；且不同轮采样不可与 `/turn` 相减（`-1,288ms` 为伪结论） |

### 9.5 未验证项清单（逐条，一律为「未验证」）

1. 资源包控制台余量 / 有效期 / 服务类型截图 — 未验证
2. 真人听感（含中英混读） — 未验证
3. 浏览器实际播放 duration / seek — 未验证
4. 24h 巡检 — 未验证
5. 401 / 403 负向实测 — 未验证
6. 上游档位采纳回显 — 未验证
7. 业务链 `reasoning_content` / `finish_reason` / 原始 `usage` 取证 — 未验证
8. 文档提交的 CI run 结论 — 未验证（代码提交 `0fe159b` 已推送 `main`，CI run `42593265380` / sha `0fe159b2` / `completed / success`、job `build-and-test` success，链接 `https://github.com/25283531/ai-language-growth/actions/runs/42593265380`；该 run 只覆盖 build / typecheck / 单测 / mock 集成用例，**不覆盖 live 全量端到端**（live 仍 23/21）；第 2 个仅文档提交推送后的新 run 结论待补；历史 CI run `42565511080` / `188d369b` 及同批 `8a1bc53`、`b7bf54c` success 仅作仓库基线留档；**不得写成「CI run 链接缺失」，也不得写「本轮 CI 已全绿」**）
9. 故障注入全量 — 未验证
10. Mock 回归在当前 HEAD 的完整通过 — 未验证（当前 HEAD `verify_m1_loop.sh` 6 PASS / 9 FAIL；历史 15/15 为旧 HEAD 结果）
11. 后端 → 上游出站 body 抓包 — 未验证
12. 修订后脚本在有历史用量库上的 live 全量通过 — 未验证（当前 23 PASS / 21 FAIL，根因见 §9.6；新残余风险见 live 报告 §8.15）
13. 回滚后运行时出站 body 取证 — 未验证（只有配置层与适配器组装层证据，见 §9.4、§9.7）

> 以上 13 项一律登记为「未验证」，不得写成通过。2 项配置回显探针在 11-07 快照零覆盖、在 11-09 重跑中均 PASS（见 §9.6），但只证明配置被读取、不证明出站 body；`51/51` 与 Mock 15/15 均为历史留档。 其中第 8 项的**代码提交部分已验证**（run `42593265380` success），仍未验证的是文档提交新 run 与 CI 未覆盖的 live 全量端到端。

### 9.6 本轮实测数据、23/21 根因与 CI 口径

**最终数字（2026-11-09 实测）**：

- `npm run build` **EXIT=0**；`npm run typecheck` **EXIT=0**。
- 纯单测 `npx tsx --test packages/*/test/*.test.ts` **70 / 70 PASS**。
- 根 `npm test` **三种条件并列（缺一不可）**：(a) **新启动的 mock 后端进程** + 注入 `DATABASE_URL`(15434)/`REDIS_URL`(16381) → **64 tests / 64 pass / 0 fail / EXIT 0**（我方实测，本轮最终结论；三个 workspace 35/35 + 19/19 + 10/10）；(b) **同一 3100 进程内重复跑** → 64/63/1，唯一失败 `m1-api.integration.test.ts:75` 的 `assert.equal(firstSpeech.cached, false)` 实际 `cached=true`，根因 `ai-gateway.service.ts:71` 的 `ttsCache` 是进程内内存 Map、`:273-281` 的 `ttsCacheKey()` 只含 text/teacherSpeed/voiceStyle/pronunciationMode/pauseAfterSentenceMs/voiceIdentity，**不含 learnerId / runId / 供应商 / 协议 / 型号**，测试用固定文本 `Hello from the teacher.` 同进程第二次跑必然命中缓存，属**测试隔离性 / 进程状态污染，不是本轮 N27 / TTS / LLM 代码回归**，CI 的 "Start mock API" 每 run 是全新进程、结构上可过（**转绿条件**：重启 3100 清空内存 Map 后仅跑一次，或给 `ttsCacheKey` 增供应商 / 协议标识 + 测试用唯一文本；本条登记为新的残余风险——测试隔离缺陷）；(c) **无 `DATABASE_URL` 注入** → 64/63/1，失败在 `m1-api.integration.test.ts:29` 的 `prisma.users.create()` 报 `Environment variable not found: DATABASE_URL`，属环境注入缺失。(b)(c) 两种 64/63/1 均为条件性环境说明、非代码回归，不作本轮测试失败结论；本轮最终结论为 (a) 64/64/0。
- 修订后 `verify_live_apis.py` 的 live 全量重跑 **23 PASS / 21 FAIL**，结果落 `tools/_live_results_20261109_head_contract.json`；11-07 的 48/48 原始证据已备份为 `tools/_live_results_20261107_snapshot.json` 并恢复回 `_live_results.json`。
- `verify_m1_loop.sh` 含 **15 条独立 `ok()` 断言**（行 `:38/:41/:43/:49/:59/:60/:69/:73/:94/:96/:105/:119/:128/:132/:160`；`:12` 的 `check()` 为死代码、0 次调用）；当前 HEAD 实跑 **6 PASS / 9 FAIL**（历史 15/15 属旧 HEAD）。脚本「不校验」清单见 §9.7。

**48/48 定性**：`PASS=48 / FAIL=0` 是 2026-11-07 21:25:22 **修订前脚本**的实测快照，**属于本轮新配置**（腾讯云签名 TTS + `glm-5.3-flash` + 裸 MP3 `fff348c4`），不是 2026-11-09 实测、也不是旧配置基线；真正的旧配置历史基线是 34/34（glm-4-flash + 硅基 TTS + 60,415 bytes 带 ID3 头音频）。48/48 与 34/34 不混同，一律用「修订前脚本的实测快照」指 48/48，不用「历史基线 / 旧配置快照」。

**23/21 精确根因，不许笼统写「失败」**：全部来自并发会话把 `main` 推进到 `188d369` 之后的契约变化，与本轮 9 文件无关：

- `/speech/synthesize`、`/speech/recognize`、`/speech/evaluate` 现在强制要求 `X-Speech-Quota-Reservation` + `X-Learner-Id` + 登录态，否则 400「语音请求缺少额度租约或学习者标识」（`speech.controller.ts:114-128`）。
- `/lessons/:id/turn` 现在强制 `assertLearnerOwnership`，否则 401「请先登录」（`lessons.controller.ts` turn handler）。
- Model Router 的 `budgetExhausted` 判据含 `dailyUsage.unpricedCalls > 0`（`packages/model-router/src/router.ts:419-422`）；已产生当日未计价调用的库会把 `tts.dynamic_teaching` 压到 L0 `local_rules`，Gateway 再兜底到 `mock_tts`。因此**在有历史用量的库上无法复现 live 48/48**，这是本轮新残余风险，单列（见 live 报告 §8.15）。

**通过项与 2 项配置回显探针**：`/health` 200 `gatewayMode=live`；`/config/audit` 200 `ttsProtocol=signed_json_audio`、`liveServices=[llm,asr,tts]`；**两项新增配置回显探针均 PASS**：`minMaxTokens` 回显 `'256'` 解析值 256、`extraPolicy` 回显 `'required'`。这两项此前在 11-07 的 48 项中零覆盖（逐名称比对：`_live_results.json` 配置审计段 9 项、当前 `verify_live_apis.py:93-129` 共 11 项，多出 `:121` / `:125`，其余名称一一对应；`:125` 的 `extraPolicy` 回显依赖本轮 #13 才引入的 `LLM_EXTRA_POLICY`，11-07 时连被检查对象都不存在），现在有 live 证据；但**仍只证明配置被读取，不证明出站 body 生效**（见 §9.4 证据效力边界）。

**CI 口径**：本轮第 1 个代码提交 `0fe159b`（6 个代码 / 配置 / 测试文件）已推送 `main`，触发 CI run `42593265380` / sha `0fe159b2` / `completed / success`、创建于 `2026-11-09T09:25:06Z`、更新于 `09:27:14Z`、链接 `https://github.com/25283531/ai-language-growth/actions/runs/42593265380`，job `build-and-test` `completed / success`。**注意边界**：该 run 只对应代码提交，覆盖 build / typecheck / 单测 / mock 集成用例，**不覆盖 live 全量端到端**（live 仍 23 PASS / 21 FAIL）；第 2 个仅文档提交推送后会另触发一个新 run，其结论待补，写「文档提交的 CI run 待补」而非笼统「本轮 CI 已全绿」。历史 CI run id `42565511080`、sha `188d369b` 及同批 `8a1bc53`、`b7bf54c` success 仍只作基线留档，不写成本轮通过。

**单测数字分层并列**：① 纯单测 70/70；② 根 `npm test` 三种条件——(a) 新启动 mock 后端进程 + DB/Redis 注入 64/64/0 EXIT 0（本轮最终结论）、(b) 同一 3100 进程内重复跑 64/63/1（测试隔离缺陷、非代码回归）、(c) 无 `DATABASE_URL` 注入 64/63/1（环境注入缺失、非代码回归），三种条件缺一不可、不得只保留 (a)；③ 代码提交 `0fe159b` 的 CI run `42593265380` `completed / success`（不覆盖 live 全量端到端），文档提交的新 run 结论待补；④ `51/51` 降为历史留档、不作本轮结论；⑤ `verify_m1_loop.sh` 含 15 条 `ok()` 断言、当前 HEAD 实跑 6 PASS / 9 FAIL（历史 15/15 属旧 HEAD）。

### 9.7 配置层一键回滚与 Mock 零外部调用证据

**配置层一键回滚（键清单，措辞「只改配置即可，但不是只改一个开关」）**：回滚到非思考型模型需同步改多个 env 键——`LLM_MODEL`（改回非思考型模型）、`LLM_EXTRA_POLICY=none`、清空 / 改写 `LLM_EXTRA_BODY_KV` 与 `LLM_EXTRA_BODY_JSON`（`LLM_MIN_MAX_TOKENS` 可保留任意正整数）。原因：`policy=none` 只跳过 required 校验，**不会隐式丢弃配置里仍写着的 extraBody**；让代码静默吞掉显式配置比多改一个键更难排查。裁决是**不改代码**、由回滚预案写清键清单。本实现把字段名与取值全部移到 `.env`，属实现侧选择，不是对 N13 边界的裁定。

**运行时证据**：以 `LLM_EXTRA_POLICY=none` + `LLM_EXTRA_BODY_KV=` + `LLM_EXTRA_BODY_JSON=` 启动，后端正常 boot（`/health status=ok gatewayMode=live`），`/config/audit` 回显 `extraPolicy='none'`、`extraBodyKeys=[]`、`minMaxTokens='256'`、`liveServices=['llm','asr','tts']`。证明回滚只改配置、不改代码；同时印证 `.env.example` 里关于 `??` 回退到 `LLM_EXTRA_BODY_JSON` 别名的警告是必要的。证据效力按 §9.4：只证明配置层与适配器组装层「不再注入」，不证明运行时出站 body。

**Mock 零外部调用证据**：`/health` `gatewayMode=mock`、`/config/audit` `gatewayMode=mock, liveServices=[]`。补充断言（带登录态 + 额度租约）实测：`/speech/synthesize` → `mock_tts`、`/speech/recognize` → `mock_asr`、`/speech/evaluate` → `mock_pronunciation`，三者 `providerAlias` 全为 `mock_*`。**必须同时写明（QA 15 条只读复核）**：`verify_m1_loop.sh` 含 15 条独立 `ok()` 断言（行 `:38/:41/:43/:49/:59/:60/:69/:73/:94/:96/:105/:119/:128/:132/:160`；`:12` 的 `check()` 为死代码、0 次调用），当前 HEAD 实跑 6 PASS / 9 FAIL（历史 15/15 属旧 HEAD）。脚本**不校验**清单：不自启动后端、不读 `/health`、不设 / 不校验 `AI_GATEWAY_MODE` 与 `AI_GATEWAY_LIVE_SERVICES`、不校验 `providerAlias`、不校验零外部调用、不校验 `degraded`、不校验音频容器 / Content-Type、不设 `set -e` 且 curl 无 `--fail`、不落盘逐项 JSON。「零外部调用」由上述补充断言证明，脚本本身不校验。

> 裁决撤回的两条不写进文档：①「`config.ts` 注释与实现自相矛盾」——最终 diff 中注释已改为「必需键、允许取值、额外禁止键、以及策略本身全部来自 .env」，矛盾已消除；②「一键回滚需改代码、登记为已知限制」——已被 #13 消除，现在回滚只需改配置（但要同步改多个键，按本节键清单写）。

### 9.8 验证环境与隔离说明

- 主工作区被另一会话的在途 `schema.prisma`（`priority` / `timeoutMs`）+ 未应用迁移污染，共享 Prisma Client 会报 P2022。
- 本轮验证在 `git worktree` 干净 HEAD + 精确 9 文件上进行，用 `node_modules` 目录联接复用依赖；并只在 worktree 的**已编译 dist**（build 产物、绝不提交）里加了一个验证专用 shim：跳过管理端运行时供应商配置装载。
- **未修改共享数据库 schema、未应用他方迁移、未改共享 `node_modules`**。
- 隧道：原目标 `127.0.0.1:5433/6380` 已失效（远端容器不再发布主机端口）；新隧道 `15434→172.19.0.3:5432`（PG，SCRAM-SHA-256 握手通过）、`16381→172.19.0.2:6379`（Redis `+PONG`）。

**并发会话造成的本地提交分叉（事实登记）**：

- 本轮代码经**独立 `git worktree`** 以提交 `0fe159b`（6 个代码 / 配置 / 测试文件）推送 `main`，触发 CI run `42593265380` / sha `0fe159b2` / `completed / success`（见 §8.3、§9.6）。
- 但主工作区另有一次并发本地提交 `01c97f4`（`feat: add speech provider failover and Iflytek voice APIs`，parent `188d369`，17:24:43），把 **21 个文件一次性全部提交**——本轮 9 文件白名单与并发在途 12 文件混在同一 commit；该提交**未推送**，且与 `0fe159b` **分叉**（两者 parent 同为 `188d369`）。
- 后果如实写：`DECISIONS.md` 被同批提交，而本报告明载「为避免混提交，本轮不写入 `DECISIONS.md`」，该裁决在该提交中**未生效**；该提交 message 未提及 N27 / 验证入口配置变更。属**并发协调问题，需维护者裁决如何收敛（rebase 或补正 commit），不得 force-push 覆盖已推送的 `0fe159b`**。
- 明确：本轮 M1 结论以 `0fe159b` + 随后的文档提交为准；`01c97f4` 的提交事实**不改变任何实测数字**。

### 9.9 最终 QA 结论（Conditional-Go）

- **结论：`Conditional-Go`（有条件放行）**——仅放行「验证入口配置变更 + 实测登记 + 文档回改」进入发布准备；**不得**表述为供应商正式选型、验收通过或全绿发布。
- **Health Score：68 / 100**。
- **P0 发布前置硬项**（全绿前不实际放行）：① 修订后脚本 live 全量端到端达成全 PASS，或就 `188d369` 之后的新契约给出书面豁免；② 新契约（额度租约 / 登录态 / `assertLearnerOwnership` / `budgetExhausted`）下 `live→mock` 静默降级排查；③ `ttsCache` 进程内缓存导致的测试隔离缺陷修复或隔离；④ 后端 → 上游出站 body / 原始响应取证通道；⑤ 资源包控制台余量 / 服务类型截图；⑥ 401 / 403 负向实测；⑦ 文档提交触发的 CI run 回补。
- **QA 建议任务 #11（分阶段提交并推送 main）在 P0 全绿前暂缓正式发布**；本轮实际只推送代码提交 `0fe159b` 与本次文档回改提交，二者均属验证登记，**不触发正式发布 / 选型 / 验收结论**。
- M1 原型「有条件通过（仅限 M1 原型范围）」仍为历史结论，本轮不升级。

---

## 附录 A：待录入 DECISIONS.md 的条目（本轮未写入）

> **说明**：`DECISIONS.md` 在本轮**未写入**；但并发会话已在主工作区把 `DECISIONS.md` 随 21 个文件一并提交为本地 `01c97f4`（parent `188d369`、未推送），**该提交不包含本附录 A 的任何条目**，本轮「为避免混提交不写入 `DECISIONS.md`」的裁决在该提交中未生效（见 §9.8）。故本附录「待录入」状态不变。以下为可直接粘贴的原文与落位说明，待维护者统一录入。条目分三类：定义债、授权债、工程约定。录入前不得当作已确认决策执行。

### A.1 定义债 → 文末「尚未决定事项」表（新增两行）

落位：`DECISIONS.md` → `## 尚未决定事项` → 表格（列为 `| 事项 | 当前状态 | 定下来的条件 |`）。在表尾追加以下两行原文（可直接粘贴）：

```markdown
| N7 单轮语音交互计时口径 | 未定义（定义债）：任务书只写「单轮语音交互目标 1—2 秒，须实测并记录」，未定义首包 / 端到端 / 往返计时口径；项目暂自选 `/turn` 端到端完整响应到达 | 由用户确认受控计时口径（首包 / 端到端 / 往返）及对应 SLA 后，按本文件修改规则补入正文 |
| N13 约束二边界 | 未定案（定义债）：只禁厂商名 / 模型名 / 音色名三类字面值，还是放宽到任何厂商专属标识，尚未定案；评审建议协议常量与厂商值分层，但未决定 | 由用户确认约束二的字面值边界及协议常量 / 厂商值分层方案后，按本文件修改规则补入正文；若放宽到「任何厂商专属标识」，公开协议常量与协议名（`X-TC-*` 签名头、`TextToVoice`、`tts`、`signed_json_audio` 等）如何处理尚无结论，而签名型适配器必然要写这些常量，边界待书面裁决 |
```

（粘贴时只取两行数据，勿重复表头。N13 行「当前状态」保持「未定案」，仅「定下来的条件」列补充可核查理由。）

### A.2 授权债 → 「修订记录」表（新增一行）

落位：`DECISIONS.md` → `## 修订记录` → 表格（列为 `| 日期 | 编号 | 变更 |`）。追加以下一行原文（可直接粘贴）：

```markdown
| 2026-11-09 | 授权债登记 | 7.0s Canary 预警线的性质与授权来源未书面确认：本轮只登记为 QA 自设预警线，不作已豁免结论，也不作受控文档中的设计 SLA；待用户书面确认计时口径与预警线性质后补入正文。 |
```

### A.3 工程约定 → 「修订记录」表（新增三行）

落位同 A.2，追加以下三行原文（可直接粘贴）：

```markdown
| 2026-11-09 | 工程约定 | 证据分层三档（官方原文 / 官方推导 / 实现建议·团队约定）只管归因；来源可信度 A/B/C/D 为另一正交维度；三档不剥夺团队书面认可的 engineering hard gates 的门槛资格。 |
| 2026-11-09 | 工程约定 | 价格口径：`pricingStatus=unpriced`、`costCny=0` 表示未接价格表，不表示零成本；资源包为已付费 / 预付额度，不是免费；不同模型 / 音色档位资源包分别抵扣。 |
| 2026-11-09 | 工程约定 | 出站取证残余风险：后端已注册 `HttpLlmAdapter` 并调用上游 `/chat/completions`，但出站 body / 原始响应无落盘通道；M1 默认登记为残余风险，网络层抓包 / 中性结构化日志列 M2。 |
```

> 以上均为**待录入**条目，本轮未写入 `DECISIONS.md`；录入前不得当作已确认决策执行。

## 附录 B：策略变更留痕（2026-11-10）

- **策略变更（依据 `DECISIONS.md` D-030）**：真实儿童样本相关验收属开发关注项，不再作为强制审核标准；改为投入真实使用后，以实际使用数据持续验证并留痕。本报告正文、强制条件与历史结论均不改写，仅在此留痕。
- **性质**：验收时点后移，不是取消验证，也不构成任何验收结论。23 PASS / 21 FAIL、1—2 秒延迟未达标、阈值 `uncalibrated`、课程内容 `pending_review` 等历史审计结论按原文保留；宣称限制句亦按原文保留。
- **前置依赖（法定要求）**：监护人单独同意、授权撤回、访问控制与数据删除属于《中华人民共和国个人信息保护法》《儿童个人信息网络保护规定》的法定要求，不是项目可自行裁量的内部审核标准，投入真实儿童使用前应完成（D-023 不删）；本次生产测试只用隔离测试账号、不使用真实儿童数据。

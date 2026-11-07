# M1 验收报告：Web 教学原型 + 基础模型路由

> 项目：成长型 AI 儿童英语语言习得平台
> 依据：`README.md` 里程碑定义、`DECISIONS.md`（25 条统一决策）、V1.1 设计任务书
> 验收目标：**「教、听、评估、调整、记录」五动作完整运行**，而不是语音聊天演示
> 报告日期：2026-11-07

---

## 0. Go / No-Go 结论

**结论：GO（有条件通过，仅限 M1 原型范围）**

判定依据：

- 验收目标「教、听、评估、调整、记录」五动作端到端 **15/15 通过**，且连续读错换方法这一验收红线由 L0 规则真实触发
- 三项硬约束均有代码与数据库层证据（教学决策在后端、模型可替换、状态变更可追溯到证据）
- **28 项单测**、**5 项数据库硬约束**、7 个 workspace 全量 typecheck 与构建全部通过
- CI 与 Android 两个 GitHub Actions 工作流**云端实测均 success**，Android 产出真实 APK

附带的强制条件（不得豁免）：

1. 阈值全部 `uncalibrated`，产品对外不得出现「已掌握」表述；Web 已做合规标注
2. 课程内容全部 `pending_review`，发音/音标/自然拼读未经人工审核不得面向儿童发布（D-022）
3. 延迟数据为 Mock 基线，**接入真实模型后必须重测**（已于 2026-11-07 完成，见下）
4. 未接真实模型、无真实儿童样本，不得据此做任何教学有效性宣称
5. M2 才能给出完整 L1–L3 动态升级、阈值标定与稳定迁移证据链
6. **【2026-11-07 补充】接入真实模型后单轮延迟未达 1—2 秒目标，不得宣称实时语音体验达标**

> **后续补充（2026-11-07）**：本轮已接入真实 LLM / ASR / TTS 并完成端到端实测，
> 详见 [`docs/M1-live-API-report.md`](./M1-live-API-report.md)。真实 API 验证 34/34、
> Mock 回归 15/15，但 ASR 单路 9.0—11.5 秒、TTS 3.2—4.7 秒、含 LLM 回合约 6 秒，
> **本报告 §4.5 基于 Mock 基线的「有充足余量」判断已被推翻**。
> Go/No-Go 结论维持「有条件通过」，上述第 6 条为新增且不得豁免的强制条件。
> 另：两家均无免费音素级发音评估服务，发音评估仍为 Mock；TTS 计费状态未确认且无法用 API 证明零扣费。

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

> ⚠️ **该结论已被真实模型实测修正**：2026-11-07 接入真实服务后，ASR 单路 9.0—11.5 秒、
> TTS 3.2—4.7 秒、含 LLM 的回合约 6 秒，**1—2 秒目标未达成**，原文「有充足余量」不再成立。
> 详见 [`docs/M1-live-API-report.md`](./M1-live-API-report.md) §4.1。

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
8. **延迟数据原不含真实模型往返**，见 4.5；2026-11-07 已补真实模型实测，1—2 秒目标未达成，见 `M1-live-API-report.md` §4.1。
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
bash tools/verify_m1_loop.sh        # 期望 PASS=15 FAIL=0
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

### 8.4 覆盖演进与剩余验证缺口

- 首轮 `ci.yml` 只跑 `typecheck`、未跑 Web 生产构建，已在 `29e42ec` 补入 `Build web workbench` 步骤，对应 CI run `42354638770` 12 步 success，**缺口已闭合**。
- **仍未在本机验证**：`docker build`（本机无 Docker daemon）、Android `assembleDebug`（本机无 Android SDK/Gradle）。前者留待部署阶段验证，后者已由云端 runner 编译成功。

# M1 真实模型接入与实测报告

> 记录日期：2026-11-07（首版）；2026-11-09 按收敛口径修订
> 范围（本轮）：**验证入口的配置变更**——把 live 验证入口的 TTS 切换为腾讯云自然语言档、LLM 切换为智谱 glm-5.3-flash，并补做实测登记。本轮不是供应商正式选型，不是达标验收，不涉及实时能力或零成本宣称。
> 依据：`docs/ai-language-growth-v1-1-design.pdf` 第 7 章（技术架构）、第 9 章（验收标准）、`DECISIONS.md` D-011~D-015、D-024 三项硬约束。
>
> **本文件与 `docs/M1-QA-report.md` 配套阅读**。原 QA 报告的延迟结论基于 Mock 基线，接入真实模型后已被本报告的实测数据修正。
>
> **口径说明**：下文凡标注「历史基线」的段落，**专指** 2026-11-07 首版旧配置（智谱 glm-4-flash + 硅基流动 TTS/ASR、带 ID3 头音频、34/34）的实测，仅作历史留档。**本轮新配置的 48/48 是 2026-11-07 21:25:22「修订前脚本」的实测快照（腾讯云签名 TTS + `glm-5.3-flash` + 裸 MP3 `fff348c4`），既不是 2026-11-09 实测，也不是旧配置 / 历史基线**；两者不混同，48/48 一律用「修订前脚本的实测快照」表述，不用「历史基线 / 旧配置快照」指它。本轮不作「已正式选型 / 已达标 / 实时 / 免费 / 通过验收」结论，不作「全绿 / 全部通过」宣称。

---

## 0. 结论速览

| 项目 | 结果 |
| --- | --- |
| 本轮性质 | **验证入口的配置变更**（非供应商正式选型、非达标 / 实时 / 免费 / 通过验收宣称） |
| live 端到端（修订前脚本快照） | **PASS=48 / FAIL=0**，2026-11-07 21:25:22，**本轮新配置**的修订前脚本实测快照；结果文件 `G:/workbuddy/英语/tools/_live_results.json`（原始证据备份 `tools/_live_results_20261107_snapshot.json`）。**不是 2026-11-09 实测、不是旧配置基线** |
| live 端到端（2026-11-09 修订后脚本重跑） | **23 PASS / 21 FAIL**（结果文件 `tools/_live_results_20261109_head_contract.json`）。**未达成全 PASS**，根因为 `main` 推进至 `188d369` 后的契约变化、与本轮 9 文件无关，见 §4.0 / §8.15 |
| 单测（分层口径） | 纯单测 `npx tsx --test packages/*/test/*.test.ts` **70 / 70 PASS**；根 `npm test` 三种条件并列（详见 §4.0）：(a) 新启动 mock 后端 + 注入 `DATABASE_URL`(15434)/`REDIS_URL`(16381) **64 / 64 / 0、EXIT 0**（本轮最终结论，35/35 + 19/19 + 10/10）；(b) 同一 3100 进程内重复跑 64 / 63 / 1（`ttsCache` 内存 Map 命中 `cached=true`，属测试隔离 / 进程状态污染）；(c) 无 `DATABASE_URL` 注入 64 / 63 / 1（`prisma.users.create()` 报 `Environment variable not found: DATABASE_URL`，属环境注入缺失）；(b)(c) 均仅作条件性环境说明、**不写成本轮测试失败 / 代码回归**；`51/51` 为历史留档、不作本轮结论 |
| `npm run build` / `npm run typecheck` | 均 **EXIT=0** |
| CI | 本轮第 1 个代码提交 `0fe159b`（6 个代码 / 配置 / 测试文件）已推送 `main`，触发 CI run `42593265380` / sha `0fe159b2` / `completed / success`（创建 2026-11-09T09:25:06Z、更新 09:27:14Z，链接 `https://github.com/25283531/ai-language-growth/actions/runs/42593265380`），job `build-and-test` success；覆盖 build / typecheck / 单测 / mock 集成用例，**不含 live 全量端到端**（仍 23/21）；第 2 个仅文档提交推送后的新 run 结论待补（不作「本轮 CI 已全绿」宣称）。历史 CI run `42565511080` / sha `188d369b` 及同批 `8a1bc53`、`b7bf54c` success 早于本轮，仅作仓库基线留档 |
| Mock 回归 | `verify_m1_loop.sh` 含 **15 条 `ok()` 断言**（`:12` 的 `check()` 为死代码、0 次调用）；当前 HEAD 实跑 **6 PASS / 9 FAIL**（历史 15/15 属旧 HEAD）。脚本「不校验」清单见 §8.16 |
| 真实单轮延迟是否满足任务书 1—2 秒 | **未达标**；2026-11-07 21:25:22 快照 `/turn` 端到端（项目自选口径）提问回合 5,660 / 5,523ms、普通作答 640ms；计时口径未定义，见 §8.10 N7 |
| 价格口径 | `pricingStatus=unpriced`、`costCny=0` 表示**未接价格表**，不表示零成本；资源包是已付费 / 预付额度，不是免费；不同模型 / 音色档位资源包分别抵扣 |
| 发音评估是否接真实服务 | **否**，保持 `mock_pronunciation` |

> **历史基线（2026-11-07 首版，专指 34/34 旧配置，仅作留档）**：34 / 34 端到端、28 / 28 单测、ASR 9.0—11.5 秒、TTS 3.2—4.7 秒、Mock 回归 15 / 15，均对应旧配置（glm-4-flash + 硅基 TTS/ASR + 带 ID3 头音频）。与本轮新配置的 48/48 分属不同配置，**不混同、不相互取代**。

**Go / No-Go（本轮）**：本轮仅为验证入口的配置变更与实测登记，**不作通过验收、正式选型、实时达标或零成本结论**。修订后脚本 live 重跑 23 PASS / 21 FAIL、未达成全 PASS；M1 原型「有条件通过」的范围判断为历史结论，本轮不升级；单轮 1—2 秒目标未达标，7.0s 仅为 QA 自设 Canary 预警线而非设计 SLA。

---

## 1. 接入了什么

### 1.1 运行配置（凭据不入仓库）

真实凭据由本地脚本从 `G:/workbuddy/github-token.txt` 读入，只写入 `services/backend/.env`（已被 `.gitignore` 排除）。**key 未出现在任何被提交的文件、代码、日志或 CI 配置中**。

当前 `live` 验证入口的配置分工（本轮配置变更后的组合）：

| 服务 | 配置目标 | 用途 |
| --- | --- | --- |
| TTS | 腾讯云 `TextToVoice`（2019-08-23、`tts.tencentcloudapi.com`、TC3-HMAC-SHA256 签名头 + JSON 内 Base64 音频），本轮用「自然语言 / 超自然大模型 1.0」档 `VoiceType=502001` | 把后端教学指令合成为音频 |
| LLM | 智谱 `glm-5.3-flash`（强制思考，不支持 `thinking.type=disabled`），推理策略与取值全部由 `.env` 注入（`reasoning_effort:low`、`LLM_MIN_MAX_TOKENS=256`）；代码只保留通用业务字段保护 | 孩子突然提问时生成一句回应话术 |
| ASR | 硅基流动 `FunAudioLLM/SenseVoiceSmall` | 把孩子语音转成文本（保持不变） |
| 发音评估 | 留空 → `mock_pronunciation` | 保持 Mock，绝不用 ASR 转写冒充发音评分 |

> **历史基线（2026-11-07 首版）**：LLM 为智谱 `glm-4-flash`、TTS 为硅基流动 `/audio/speech`（`FunAudioLLM/CosyVoice2-0.5B`，带 ID3 头的 MP3）、ASR 同为硅基流动。该组合与本轮配置不可直接比较，详见 §3。

「普通 / 自然语言」不是两套 Action：共用同一个 `TextToVoice`，差别在 `VoiceType` 号段与资源包服务类型（详见 §8.2）。

可一键切换，不需要改代码：

```bash
AI_GATEWAY_MODE=mock                 # 全部回落 Mock，不产生外部调用与费用
AI_GATEWAY_MODE=live                 # 走真实服务
AI_GATEWAY_LIVE_SERVICES=llm,asr     # 去掉 tts，即可不产生 TTS 外部调用
```

`resolveLiveServices()` 要求「模式为 live + 在白名单内 + 对应 `*_BASE_URL` 已配置」三个条件同时成立；任一不满足，Router 别名与 Gateway 注册表会**一起**回落到 Mock，不会出现此前 M1 联调修过的「别名指向不存在的适配器 → 静默降级」。

### 1.2 代码改动

> **历史基线（2026-11-07 首版）**：下表为首次接入真实模型时的代码改动，描述仍然正确，仅作留档；本轮协议分离相关的新增改动见其后。

| 文件 | 改动 |
| --- | --- |
| `packages/ai-provider-sdk/src/http.ts`（新增） | `HttpTtsAdapter`、`HttpAsrAdapter`、`mapTeacherSpeed`、统一 `audioRef` 解析（data URI / http(s) / file:// / 本地路径） |
| `packages/ai-provider-sdk/src/config.ts` | live 服务开关、别名一致性判断、注册真实适配器；四个 Mock 适配器始终保留作兜底 |
| `packages/ai-provider-sdk/src/protocol.ts` | LLM 失败时带出响应体摘要，便于排障 |
| `packages/model-router/src/router.ts` | `mockAliases` 更名 `providerAliases`，语义从「Mock 专用」改为「Router 别名 → 实际适配器」 |
| `services/backend/src/app.module.ts` | 用 `resolveProviderAliases()` 统一 Router 与 Gateway 的判断 |
| `services/backend/src/media/media.controller.ts`（新增） | 只读音频路由 `/api/v1/media/audio/{指纹}.mp3`，文件名白名单防目录穿越 |
| `services/backend/src/orchestrator/orchestrator.service.ts` | **新增真实 LLM 调用点**（见 §2）；token 用量入账；LLM 降级如实上报 |
| `services/backend/src/speech/speech.controller.ts` | `/usage/summary` 增加 `pricingStatus: unpriced` |
| `apps/web/app/page.tsx` | 真实音频播放器；Mock 占位引用不渲染播放器 |
| `deploy/docker/.env.example`、`.gitignore`、`README.md` | 配置说明、音频缓存排除、状态更新 |

本轮（2026-11-09）协议分离相关的改动（详见 §8.1）：新增 `SignedJsonTtsAdapter` 承载 `signed_json_audio`（签名 JSON / Base64）协议；`signed-tts.ts` / `config.ts` / schema 对档位、签名、容器与 Codec 做拒绝或约束；`/config/audit` 提供本地诊断（见 §8.7）。另：`packages/ai-provider-sdk/src/protocol.ts:139` 定义并导出 `HttpLlmAdapter implements LlmAdapter`，`:157` 向 `/chat/completions` 发起 `fetch`，`config.ts` 注册表以 `registry.register('llm', new HttpLlmAdapter(config.llm))` 装配——**该适配器存在且真实发起调用**，详见 §8.11。

### 1.3 三项硬约束的落实

- **约束一（教学逻辑与客户端分离）**：LLM 只贡献一句可朗读的回应话术，追加到 `teacherUtterance`。评估、证据、掌握状态、方法阶梯、下一活动仍全部由后端 L0 规则与 Planner 决定。Web 只渲染、只播放。
- **约束二（模型可替换）**：所有 URL、模型名、音色名、凭据只在 `.env` 里；`packages/` 与 `services/` 业务代码零厂商名、零模型名。换供应商只改配置。验证入口：2026-11-07 21:25:22 修订前脚本快照 48/48（本轮新配置）；2026-11-09 修订后脚本重跑 23 PASS / 21 FAIL、未达成全 PASS；Mock 回归 `verify_m1_loop.sh` 含 15 条 `ok()` 断言、当前 HEAD 实跑 6 PASS / 9 FAIL（历史 15/15 属旧 HEAD）。**边界未定案（N13）**：约束二目前只禁厂商名 / 模型名 / 音色名三类字面值，是否放宽到「任何厂商专属标识」尚未定案；评审建议把协议常量与厂商值分层，但本轮不写成已决定。本实现把字段名与取值全部移到 `.env`，属实现侧选择，不是对 N13 边界的裁定（见 §8.10）。
- **约束三（教学数据有可靠证据）**：LLM 输出不写 `learning_evidence`、不参与 `evaluateMastery`、不触发状态变更；ASR 与发音评估严格分离；发音评估保持 Mock 且如实标注。

---

## 2. 补上的 LLM 调用点（重要）

> **历史基线（2026-11-07 首版）**：以下调用点链路描述仍然正确，仅作留档；本轮 LLM 侧的 `degraded` 判定与推理预算兜底补充见 §8.5。

M1 交付时编排器里**从未真正调用过 LLM**：`classifyIntent` 是纯 L0 规则，成本账本的 `llmInputTokens / llmOutputTokens` 恒为 0。只注册适配器不构成「接入」。

本次在「孩子突然提出新问题」路径（八项硬指标第四项）补了唯一一个合规调用点：

```
classifyIntent → question
  → router.route(llm.simple_dialogue)
  → gateway.llm(固定人格 system prompt)
  → 输出净化（去 emoji / markdown / 换行，截断 120 字）
  → 追加到 directive.teacherUtterance
  → 与教学文本一起送真实 TTS 合成
  → LLM token 写入 cost 与 ai_usage_logs
```

边界：

- 不评价对错、不判断掌握、不布置任务、不承诺教学结果、不解释科学原理；
- 被问及身份时诚实说明是 AI 老师；
- 真实适配器失败时 Gateway 回落 `mock_llm`，并把 `degraded` 与 `llm_fell_back_to_mock` 如实上报；
- 实测 `in=149 / out=21 tokens`，账本 `llm.calls=1`（历史基线实测值）。

> 2026-11-08 更正（历史基线）：本报告形成时，`ai_usage_logs` 尚未接入运行时，账本统计仅在进程内存中；M2 的持久化账本现已写入用量表。模型价格尚未与运行时供应商配置关联，`costCny=0` 仍代表未计价，不代表免费。本轮价格口径见 §8.6。

---

## 3. 两家能力实测矩阵（2026-11-07 打真实请求核对，历史基线）

> **历史基线（2026-11-07 首版，仅作留档）**：下表记录旧配置（智谱 glm-4-flash / 硅基流动 TTS+ASR、带 ID3 头 MP3）的探测结果，不代表本轮验证入口状态。表内「免费」均为 2026-11-07 旧资料 / 价格页标注的引用，本轮一律不沿用、不宣称免费；本轮供应商组合见 §1.1，本轮价格口径见 §3.1。

> 免费名单与额度会变，以下以**当日实测 HTTP 结果**为准；「免费」均为公开价格页 / 资料的标注，不等于合同，费用以供应商控制台账单为准。

| 服务 | 平台 | 模型标识 | 实测结果 | 免费状态 |
| --- | --- | --- | --- | --- |
| LLM | 智谱 | `glm-4-flash` | 200，约 0.9s，**旧版启用** | 公开资料标为永久免费（有并发限制） |
| LLM | 智谱 | `glm-4.7-flash` | 429「访问量过大」 | 免费但限流明显，未启用 |
| LLM | 硅基流动 | `THUDM/GLM-4-9B-0414` | 200，340ms | 价格页标为免费，未启用 |
| LLM | 硅基流动 | `Qwen/Qwen3-8B` | 200，3544ms | 价格页标为免费，未启用 |
| ASR | 硅基流动 | `FunAudioLLM/SenseVoiceSmall` | 200，**本项目启用**，准确转写合成语音 | 价格页标为免费 |
| ASR | 智谱 | `glm-asr-2512` | 200（纯音输入返回 `#`） | 付费模型，账户有资源包，未启用 |
| ASR | 智谱 | `glm-asr` | 429「余额不足或无可用资源包」 | 不可用 |
| TTS | 硅基流动 | `FunAudioLLM/CosyVoice2-0.5B` | 200，真实 MP3（ID3 头，约 60KB），**旧版启用** | **公开价格页标注付费**；账户当前有额度所以能调通 |
| TTS | 硅基流动 | `fnlp/MOSS-TTSD-v0.5` | 200，931ms，约 80KB | 同上，未启用 |
| TTS | 智谱 | `glm-tts` | 429「余额不足或无可用资源包，请充值」 | **无免费额度，不可免费使用** |
| 发音评估 | 两家 | — | 无音素级 GOP 服务 | 保持 `mock_pronunciation` |

**关于「免费 TTS」的诚实结论（历史基线）**：旧版两家都没有可确认免费的 TTS 模型。硅基 TTS 能调通是因为账户存在可用额度（赠送额度 / 资源包），但 `/v1/models` 不返回价格字段、`/v1/user/info` 已废弃（410），**无法用 API 证明零扣费**；智谱 TTS 明确报余额不足。因此本项目把 TTS 设为可一键关闭，不宣称免费。若要求严格零成本，用 `AI_GATEWAY_LIVE_SERVICES=llm,asr` 即可。

### 3.1 本轮供应商组合、档位归因与价格口径

**组合**：TTS 腾讯云 `TextToVoice` 自然语言 / 超自然大模型 1.0 档（`VoiceType=502001`）；LLM 智谱 `glm-5.3-flash`；ASR 硅基流动 `FunAudioLLM/SenseVoiceSmall`；发音评估 `mock_pronunciation`。

**档位归因（最高置信解释，非官方确认）**：「普通 / 自然语言」共用同一个 `TextToVoice`，差别在 `VoiceType` 号段与资源包服务类型；403000 / 403005（2.0 档）返回 `UnsupportedOperation.PkgExhausted`、502001 可用。归因只能写：**最高置信解释为「音色档位与资源包服务类型不匹配」，502001 对照实验佐证；不得写成官方确认**。

**智谱 TTS 历史探测（放弃，仅作历史记录）**：`glm-tts` 返回 429 / 1113（余额不足或无可用资源包）、mp3 格式不支持、流式返回空 body；本轮放弃智谱 TTS 作验证入口，不作选型结论。

**价格口径**：`pricingStatus=unpriced`、`costCny=0` 表示**未接价格表**，不表示零成本；资源包是**已付费 / 预付额度，不是免费**；不同模型 / 音色档位资源包**分别抵扣**。`characters` 为 Unicode 码点数（`[...text].length`），不是 UTF-8 字节数，也不等于供应商最终账单字符数。

---

## 4. 端到端实测结果

### 4.0 结果数据与时间归属（修订前脚本快照 / 修订后脚本重跑）

**修订前脚本实测快照（48/48）**：`tools/verify_live_apis.py`（仓库外工具目录）在 2026-11-07 21:25:22 产出的 **PASS=48 / FAIL=0**，结果文件 `G:/workbuddy/英语/tools/_live_results.json`（原始证据已备份为 `tools/_live_results_20261107_snapshot.json` 并恢复回 `_live_results.json`）。该快照**属于本轮新配置**（`signed_json_audio`、`tts.tencentcloudapi.com`、`signed-pair`、`glm-5.3-flash`、`['reasoning_effort']`、裸 MP3 `head=fff348c4 mp3=True wav=False`、`bytes=16416`），配置归属正确；错只在时间标签——它是**早于 2026-11-09 验证脚本修订的实测快照**，不是本轮（2026-11-09）实测，也**不是**旧配置 / 历史基线。真正的旧配置历史基线是 34/34（glm-4-flash + 硅基 TTS + 60,415 bytes 带 ID3 头音频），见本节末表格，两组数据不混同。链路仍为串起来的真实闭环：真实 TTS 合成 → 下载音频 → 把同一音频作为真实 ASR 输入 → 开课 → 正常作答 → 孩子突然提问触发 LLM → 幂等重放 → 用量账本 → 结课。

**48/48 是修订前脚本的 48 项检查结果；新增 2 项配置回显探针不属于该 48 项**，须以修订后脚本的重跑结果逐项确认，不得因保留 48/48 留档而被读成探针已获 live 证据。逐名称比对（非 48/50 数量相减）：`_live_results.json` 配置审计段共 9 项 check，当前 `verify_live_apis.py:93-129` 配置审计段共 11 项，多出的正好是 `:121`「LLM token 下限为正整数」与 `:125`「LLM 额外字段策略已声明」，其余名称一一对应。更硬的事实：`:125` 检查的 `llm_cfg.get('extraPolicy')` 回显来自 `speech.controller.ts:299` 的 `extraPolicy: env.LLM_EXTRA_POLICY ?? null`，而 `LLM_EXTRA_POLICY` 是本轮 #13 才引入的键，2026-11-07 时连被检查的回显对象都还不存在；`:121` 检查的 `minMaxTokens` 回显当时已存在，但该 check 本身是 11-09 新增。因此**这 2 项探针在 11-07 快照中零覆盖、从未获得任何 live 实测证据**。

**修订后脚本 live 全量重跑（23 PASS / 21 FAIL）**：2026-11-09 15:53 / 16:16 两次修订（新增上述 2 项配置回显探针）后，用修订后脚本做 live 全量重跑，结果为 **23 PASS / 21 FAIL**，结果落 `tools/_live_results_20261109_head_contract.json`。失败精确根因（**全部来自并发会话把 `main` 推进到 `188d369` 之后的契约变化，与本轮 9 文件无关**）：

- `/speech/synthesize`、`/speech/recognize`、`/speech/evaluate` 现在强制要求 `X-Speech-Quota-Reservation` + `X-Learner-Id` + 登录态，否则 400「语音请求缺少额度租约或学习者标识」（`speech.controller.ts:114-128`）。
- `/lessons/:id/turn` 现在强制 `assertLearnerOwnership`，否则 401「请先登录」（`lessons.controller.ts` turn handler）。
- Model Router 的 `budgetExhausted` 判据含 `dailyUsage.unpricedCalls > 0`（`packages/model-router/src/router.ts:419-422`）；已产生当日未计价调用的库会把 `tts.dynamic_teaching` 压到 L0 `local_rules`，Gateway 再兜底到 `mock_tts`。因此**在有历史用量的库上无法复现 live 48/48**，作为本轮新残余风险单列于 §8.15。

**通过项与配置回显探针**：`/health` 200 `gatewayMode=live`；`/config/audit` 200 `ttsProtocol=signed_json_audio`、`liveServices=[llm,asr,tts]`；**两项新增配置回显探针均 PASS**——`minMaxTokens` 回显 `'256'`、解析值 256，`extraPolicy` 回显 `'required'`。这两项此前在 11-07 快照零覆盖，现在有 live 证据；但按 §8.11 的证据效力边界，探针**仍只证明配置被读取，不证明出站 body 生效**。

**单测、构建与 CI 分层口径（2026-11-09 实测）**：

- `npm run build` **EXIT=0**；`npm run typecheck` **EXIT=0**。
- 纯单测 `npx tsx --test packages/*/test/*.test.ts`：**70 / 70 PASS**。
- 根 `npm test` 三种条件并列（2026-11-09 实测，缺一不可）：(a) **新启动 mock 后端进程** + 注入 `DATABASE_URL`(15434)/`REDIS_URL`(16381) → **64 tests / 64 pass / 0 fail / EXIT 0**（本轮最终结论，35/35 + 19/19 + 10/10）；(b) **同一 3100 进程内重复跑** → 64/63/1，唯一失败 `m1-api.integration.test.ts:75` 的 `assert.equal(firstSpeech.cached, false)` 实际 `cached=true`，根因 `ai-gateway.service.ts:71` 的 `ttsCache` 是进程内内存 Map、`:273-281` 的 `ttsCacheKey()` 只含 text/teacherSpeed/voiceStyle/pronunciationMode/pauseAfterSentenceMs/voiceIdentity、不含 learnerId/runId/供应商/协议/型号，固定文本 `Hello from the teacher.` 同进程第二次跑必命中缓存，属**测试隔离性 / 进程状态污染**，不是本轮 N27/TTS/LLM 代码回归；CI 的 "Start mock API" 每 run 是全新进程、结构上可过（新残余风险与转绿条件见 §8.15）；(c) **无 `DATABASE_URL` 注入** → 64/63/1，失败在 `m1-api.integration.test.ts:29` 的 `prisma.users.create()` 报 `Environment variable not found: DATABASE_URL`，属环境注入缺失。(b)(c) 均非代码回归、不写成本轮测试失败。
- **本轮 CI**：第 1 个代码提交 `0fe159b`（6 个代码 / 配置 / 测试文件）已推送 `main`，触发 run `42593265380` / sha `0fe159b2` / `completed / success`（创建 2026-11-09T09:25:06Z、更新 09:27:14Z，链接 `https://github.com/25283531/ai-language-growth/actions/runs/42593265380`），job `build-and-test` success；覆盖 build / typecheck / 单测 / mock 集成用例，**不含 live 全量端到端**（仍 23 PASS / 21 FAIL）。第 2 个仅文档提交推送后的新 run 结论待补（§8.13 第 8 项）。历史 CI run `42565511080` / sha `188d369b` 及同批 `8a1bc53`、`b7bf54c` success 早于本轮，仅作仓库基线留档；不写「本轮 CI 已全绿」。
- `51/51` 降为历史留档、不作本轮结论；Mock 回归 `verify_m1_loop.sh` 含 15 条 `ok()` 断言、当前 HEAD 实跑 **6 PASS / 9 FAIL**（历史 15/15 属旧 HEAD），脚本「不校验」清单见 §8.16。

> **历史基线（2026-11-07 首版旧配置，专指 34/34，仅作留档）**：下表 34 项检查组、60,415 bytes 带 `ID3` 头 MP3、`PASS=34 / FAIL=0` 均对应旧配置（glm-4-flash + 硅基 TTS 带 ID3 音频），与本轮新配置的 48/48 分属不同配置、不混同、不相互取代。

| 检查组 | 关键实测值（历史基线） |
| --- | --- |
| TTS | `/api/v1/media/audio/....mp3`，60,415 bytes，`ID3` 头，`audio/mpeg`，`live_tts`，模型为配置注入 |
| 重复播放 | 第二次 `cached=true`、`characters=0`、4ms（首次 3,177—4,650ms），未产生第二次外部调用 |
| ASR | 输入上一步合成的 MP3 → 转写 `"Hello, hello, listen and say hello."`，`seconds=4`，`live_asr`；响应不含 score/units |
| 发音评估 | `score=77`、`mock_pronunciation`，如实标注 |
| 开课 | 201，返回真实 MP3，`degraded=false`，教学指令由后端给出 |
| 正常作答 | `intent=learning_answer`，`passed=true`、`score=90`、evidence=1、stateChanges=1、方法 `method_slow_clear` |
| 幂等 | 同 key 重放 JSON 完全一致（27ms） |
| 突然提问 | `intent=question`，LLM `in=149 / out=21 tokens`，话术进入 `teacherUtterance`，`degraded=false`，evidence 仍由规则写入 |
| 用量账本 | `byService={tts:2, llm:1}`、`byLevel={L1:3}`、`pricingStatus=unpriced` |
| 结课 | `turns=2`、`calibrationStatus=uncalibrated` |

历史基线最终值：**PASS=34 / FAIL=0**；Mock 回归 **PASS=15 / FAIL=0** 为历史 HEAD 结果（当前 HEAD 为 6 PASS / 9 FAIL）。

### 4.1 修订前脚本快照的端到端延迟口径（单位 ms，2026-11-07 21:25:22）

| 环节 | 实测值 |
| --- | --- |
| health | 113 |
| config_audit | 4 |
| tts_first | 892 |
| audio_download | 26 |
| tts_cached | 4 |
| asr | 307 |
| pronunciation | 6 |
| start | 1061 |
| turn_answer | 640 |
| turn_replay | 29 |
| turn_question | 5660 |
| turn_question_2 | 5523 |
| usage | 5 |
| finish | 89 |

- 计时口径：项目自选 `/turn` 端到端完整响应到达（**N7**：任务书只写「单轮语音交互目标 1—2 秒，须实测并记录」，未定义首包 / 端到端 / 往返计时口径）。
- `turn_question` 5,660 / 5,523ms 超过 1—2 秒目标，**未达标**；7.0s 仅为 QA 自设 Canary 预警线，**不是受控文档中的设计 SLA**。
- 本组数字与 48/48 同为 2026-11-07 21:25:22 修订前脚本快照、属本轮新配置的实测，但**不是 2026-11-09 重跑**；旧基线（glm-4-flash + 硅基 TTS + 带 ID3 音频）与新配置**不可直接比较**，不据此推导优劣。独立拆解采样、数据源可复核性与「不可相减」见 §8.8。

> **历史基线（2026-11-07 首版两轮采样，仅作留档）**：TTS 首次 4,650 / 3,177ms、TTS 缓存命中 4 / 4ms、音频下载 29 / 6ms、ASR 真实识别 9,040 / 11,536ms、开课 2,203 / 4,090ms、普通作答 631 / 678ms、幂等重放 27 / 27ms、提问 `/turn` 6,357 / 6,153ms、结课 92 / 90ms；Mock 基线 p50 394.2ms / p95 438.2ms。这些是旧配置数据，与本轮不比较、不相减。

> 历史结论（2026-11-07 首版）曾提出 M2 需针对性处理：TTS 预生成与句级缓存、固定课程音频离线化、ASR 流式识别、LLM/ASR/TTS 并行化与超时预算、把慢调用移出关键路径。在这些优化与复测完成前，不得表述为「实时语音体验达标」。本轮维持该限制。

---

## 5. 本轮修掉的联调缺陷

> **历史基线（2026-11-07 首版）**：以下为首次接入真实模型时修掉的联调缺陷，描述仍然正确，仅作留档。

1. `freeUtterance` 契约是 `string | null`，测试脚本误传 boolean → `/turn` 400。
2. POST 接口在 Nest 下返回 201，验证脚本只接受 200 → 大量假失败。
3. **Git Bash / MSYS2 路径污染**：`AI_AUDIO_URL_PREFIX=/api/v1/media/audio` 传给 native 进程时被改写成 `D:/Program Files/.../api/v1/media/audio`，导致 `audioRef` 不可播放。改为平台内固定常量，不再经环境变量（也符合「这是平台路由，不是供应商配置」）。
4. `teacherSpeed` 在 `z.input` 下可选，`mapTeacherSpeed` 入报 TS2345 → 加默认值。
5. LLM 首轮输出带 emoji 与未校验的科普式因果（「因为太阳光里有蓝色」）→ 加输出净化（去 emoji/markdown）、prompt 明确禁止事实性解释、限定为温柔回应并把话题带回英语练习。
6. 成本账本 `costCny=0` 会被误读成「免费」→ `/usage/summary` 增加 `pricingStatus: unpriced` 与说明文字。
7. 真实音频合成后 Web 只能看到字符串 → 增加 `<audio controls>` 播放器，Mock 占位引用不渲染。

---

## 6. 已知限制与风险（不得豁免）

> 以下为仍然成立的限制与风险；本轮新增的残余风险与未验证项见 §8.11、§8.13、§8.15。

1. **延迟超标**：见 §4.1，1—2 秒目标未达成。
2. **TTS 计费未确认**：见 §3.1，资源包是已付费 / 预付额度、不是免费；`pricingStatus=unpriced` / `costCny=0` 表示未接价格表、不表示零成本；可用开关一键关闭 TTS 外部调用。
3. **发音评估仍是 Mock**：不能宣称系统已具备儿童发音评估能力；接真实 GOP 服务前必须做儿童发音 Benchmark（DECISIONS「尚未决定事项」）。
4. **LLM 话术质量**：实测仍会出现「因为天空很美哦」这类无意义因果。已禁止科普与 emoji，但尚无内容安全与事实校验层；LLM 输出不进入证据链，也不作为知识来源。
5. **阈值与内容状态不变**：全部 `uncalibrated`、课程全部 `pending_review`，不得对外表述「已掌握」，未经人工审核不得面向儿童发布。
6. **无真实儿童样本**：本次使用 TTS 合成语音做 ASR 输入，不是 6—9 岁儿童录音；未做教学有效性宣称。
7. **未做故障注入**：本轮未主动制造真实服务故障验证 live 降级链；Mock 模式离线兜底为历史记录，不能替代。
8. **凭据范围**：key 仅存本地 `.env`；CI 无密钥，默认 Mock，不会触发真实调用或产生费用。
9. **未验证**：`docker build` 本机无 Docker daemon；Android 真机编译由 GitHub Actions 完成。
10. **修订后脚本 live 重跑未达成全 PASS**：23 PASS / 21 FAIL，根因见 §4.0；在有历史用量的库上无法复现 live 48/48，新残余风险见 §8.15。

---

## 7. 复现方式

> **历史基线（2026-11-07 首版）**：以下脚本与期望值对应旧配置，仅作留档；本轮结果数据与时间归属见 §4.0，验证环境隔离见 §8.17。

```bash
# 1) 生成 live 配置（从本地凭据文件读 key，不回显、不入库）
python tools/setup_live_env.py

# 2) 启动后端
cd services/backend && set -a && . ./.env && set +a && npx tsx src/main.ts

# 3) 真实 API 端到端（首版 34 项；修订前脚本 48 项为 2026-11-07 21:25:22 快照；修订后脚本重跑 23/21，见 §4.0）
python tools/verify_live_apis.py

# 4) 切回 Mock 回归（首版 15 项；当前 HEAD 为 6 PASS / 9 FAIL）
export AI_GATEWAY_MODE=mock   # 重启后端
bash tools/verify_m1_loop.sh
```

`tools/` 下的探测与验证脚本位于仓库外，用于本地联调；它们不包含任何凭据，也未提交。本轮验证在隔离的 `git worktree` 干净 HEAD 上进行（见 §8.17）。

---

## 8. 本轮收敛口径补充（2026-11-09）

> 本轮性质：**验证入口的配置变更**（腾讯云 TTS 自然语言档 + 智谱 glm-5.3-flash），非供应商正式选型、非达标 / 实时 / 免费 / 通过验收结论，不作「全绿 / 全部通过」宣称。

### 8.1 协议分离与腾讯云 TTS 接入细节

- 两套协议：`openai_audio`（二进制音频响应）与 `signed_json_audio`（签名 JSON / Base64 音频响应）。本轮新增 `SignedJsonTtsAdapter` 承载后者。
- 腾讯云 `TextToVoice`（2019-08-23、`tts.tencentcloudapi.com`）：TC3-HMAC-SHA256 签名头 + JSON 内 Base64 音频；每次请求用 `randomUUID()` 生成 SessionId，**重试时重算签名**。
- **HTTP 200 也可能含 `Response.Error`，必须判错**，不能只看状态码。
- `Codec=mp3` 返回的是**无 ID3 头的裸 MP3 帧流**（实测起始字节 `ff f3 48 c4`），验证需用帧同步位掩码判定帧头，不能用 ID3 标签判断。
- 音频落盘做**容器与 Codec 一致性校验**（容器后缀 / MIME 与实际 Codec 一致）。
- `characters` 为 Unicode 码点数（`[...text].length`），不是 UTF-8 字节数，也不等于供应商最终账单字符数。

### 8.2 档位归因（最高置信解释，非官方确认）

- 「普通 / 自然语言」共用同一个 `TextToVoice` Action，差别在 `VoiceType` 号段与资源包服务类型，**不是两套 Action**。
- 403000 / 403005（2.0 档）返回 `UnsupportedOperation.PkgExhausted`；502001（自然语言 / 超自然大模型 1.0 档）本轮可用。
- 归因只能写：**最高置信解释为「音色档位与资源包服务类型不匹配」，502001 对照实验佐证；不得写成官方确认**。

### 8.3 智谱 TTS 历史探测（放弃，仅作历史记录）

`glm-tts` 返回 429 / 1113（余额不足或无可用资源包）、mp3 格式不支持、流式返回空 body；本轮放弃智谱 TTS 作验证入口，仅保留为历史记录，不作选型结论。

### 8.4 负向错误码矩阵

| 构造 | 实测返回 | 结论边界 |
| --- | --- | --- |
| 错误签名 | `AuthFailure.SignatureFailure` | 签名校验生效（负向实测） |
| 2.0 档音色（403000 / 403005） | `UnsupportedOperation.PkgExhausted` | 档位 / 资源包服务类型不匹配（见 §8.2） |
| 151 汉字、非法音色编号、裸 PCM 编码 | 在**直连上游脚本**中仍返回 `audio=True` | 只能说明是平台适配器 / 配置层的约束；**不能声称上游负向断言闭合**。平台层已在 `signed-tts.ts` / `config.ts` / schema 拒绝或约束 |

### 8.5 LLM 侧 degraded 判定

- 空 `content` 显式抛错。
- `finishReason` 非 `stop`、空清洗文本、命中固定兜底话术均纳入 `degraded`。
- 业务层 `maxTokens` 仍保持 **120**（不污染业务语义）；推理预算下限由适配层 `LLM_MIN_MAX_TOKENS` 取大值兜底（当前配置由 `.env` 注入 `reasoning_effort:low` 与 `LLM_MIN_MAX_TOKENS=256`，策略与取值均在配置层）。
- `glm-5.3-flash` 强制思考，不支持 `thinking.type=disabled`。

### 8.6 价格口径（unpriced）

- `pricingStatus=unpriced`、`costCny=0` 表示**未接价格表**，不表示零成本。
- 资源包是**已付费 / 预付额度，不是免费**；不同模型 / 音色档位的资源包**分别抵扣**。

### 8.7 /config/audit 边界

- 仅本地 / 非 production 可用，`NODE_ENV=production` 返回 **404**。
- **这不是安全 Guard**；公网 / 生产前需管理端鉴权或收敛字段。

### 8.8 延迟拆解不可相减与数据源可复核性

独立拆解采样（**与 §4.1 的 `/turn` 不是同一轮，禁止相减**）：

- LLM：5,466 / 6,593 / 8,197ms，中位 **6,593ms**。
- TTS：669 / 355 / 270ms，中位 **355ms**。
- 外部合计约 **6,948ms**。
- 把 `turn_question=5,660` 减去 6,948 得到 -1,288ms 是**伪结论**；两次采样不同轮，**不能相减得出平台耗时**。

**数据源可复核性差异（如实登记）**：

| 数据组 | 落盘结果文件 | 可复核性 |
| --- | --- | --- |
| 48/48 端到端快照（2026-11-07 21:25:22） | `tools/_live_results.json`（仓库外），原始证据备份 `tools/_live_results_20261107_snapshot.json` | 可按结果文件逐项复核 |
| 34/34 旧配置历史基线 | **无任何落盘结果文件**，只见于文档叙述 | 无法按结果文件复核 |
| 延迟拆解（LLM 5,466 / 6,593 / 8,197ms；TTS 669 / 355 / 270ms；外部合计约 6,948ms） | `tools/measure_breakdown.py` 只读凭据、直接 HTTP 探测，**不落盘结果文件**，数字来自会话输出 | 无法按结果文件复核 |

「不同轮采样不能相减、-1,288ms 为伪结论」的口径不变，仍正确。

### 8.9 证据分层（归因维度，不与来源可信度混淆）

- 三档只管**归因**：① 官方原文、② 官方推导、③ 实现建议（团队约定）。
- 来源可信度 **A / B / C / D** 是**另一个维度**，与三档正交。
- 三档分层**不剥夺**团队书面认可的 engineering hard gates 的门槛资格。

### 8.10 N7 / N13 / N27 登记

- **N7（定义债）**：任务书只写「单轮语音交互目标 1—2 秒，须实测并记录」，未定义首包 / 端到端 / 往返计时口径；项目自选 `/turn` 端到端完整响应到达；**7.0s 是 QA 自设 Canary 预警线，不是受控文档中的设计 SLA**；旧基线与新配置不可直接比较。计时口径未定义，登记为定义债。
- **N13（定义债，边界未定案）**：约束二边界（只禁厂商名 / 模型名 / 音色名三类字面值，还是放宽到任何厂商专属标识）**尚未定案**；评审建议把协议常量与厂商值分层，但不得写成已决定。#13 只裁决 N27 工程策略，**不裁 N13**；本实现把字段名与取值全部移到 `.env`，属实现侧为保住「配置层一键回滚」自愿采取的更严格做法，不是对约束二边界的裁定。
- **N13 与 `.env.example` 的合规口径**：`deploy/docker/.env.example` 是配置示例，供应商相关取值本就应只出现在配置示例与部署编排中，属正确落点；按约束二窄解释（只禁厂商名 / 模型名 / 音色名三类字面值）通用协议字段名与枚举值不违规；但 N13 是否放宽到「任何厂商专属标识」仍未定案，故口径为「**当前按窄解释允许，边界待书面裁决**」，不得写成已确认合规。
- **N27（发布前置，代码侧已闭合 / 验证侧已实跑，未全部闭合）**：`LLM_EXTRA_BODY_KV` / `LLM_MIN_MAX_TOKENS` 缺失或空串时启动期 fail-fast 不完整，属**潜在故障路径**，不是当前运行时状态。**代码侧已闭合**：`config.ts` 启动期 fail-fast 与 `llm-adapter.test.ts` 的 7 条负向用例已落地；本实现把字段名与取值全部移到 `.env`，属实现侧选择，代码只保留通用业务字段保护，policy 本身必需以防漏配，`LLM_EXTRA_POLICY=none` 即配置层一键回滚（键清单见 §8.14）。**验证侧**：本机纯单测 70 / 70 PASS（含 7 条负向用例）；源码级交叉验证 12/12、build / typecheck EXIT=0、根 `npm test` 64/64/0、live 两项配置回显探针 PASS、配置层回滚运行时探针 PASS、代码提交 `0fe159b` 的 CI success——**独立回归与代码提交 CI 已通过**；但 **live 端到端全 PASS 仍未达成（23 PASS / 21 FAIL）**、出站 body 运行时取证仍属 **M2 残余风险**（§8.11）。**不写「N27 已全部闭合」**。作为发布前置项跟踪。

### 8.11 出站取证残余风险（M1 默认登记，M2 处理）

- 后端已注册 `HttpLlmAdapter` 并向 `/chat/completions` 发起调用，但缺少把出站请求 body 与上游原始响应落盘的通道。
- `/config/audit` 只证明配置被读取；单测只证明适配器组装逻辑；独立裸 HTTP 直连只证明上游行为基线。
- **证据效力边界**：凡涉及「回滚后出站 body 不再带推理字段」这类说法，只能写「配置层与适配器组装层证据表明不再注入」，证据来源是 `llm-adapter.test.ts` 的 `HttpLlmAdapter` 请求体断言 + `/config/audit` 的 `extraBodyKeys` 回显；**不得写「运行时出站 body 已取证」**——当前没有把该适配器发出的出站 body / 上游原始响应落盘的通道，这是 M1 已登记残余风险。
- M1 默认登记为残余风险；网络层抓包 / 中性结构化日志列 **M2**。

### 8.12 撤回表述清单（已撤回 / 已否决，禁止出现或复用）

以下表述**已撤回并被否决**，不得再作为结论或论据复用，本文档不作事实陈述：

- 「退化 52–57%」
- 「供应商切换导致退化」
- 「9,651ms 已获豁免 / 可接受」
- 「更差的数据点」
- 「官方确认 max+120 当前正在运行」
- 「usage 反推档位为证明」
- 「独立裸直连等价业务链路运行时真实性」

### 8.13 未验证项清单（逐条，一律为「未验证」）

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
12. 修订后脚本在有历史用量库上的 live 全量通过 — 未验证（当前 23 PASS / 21 FAIL，根因见 §4.0；新残余风险见 §8.15）
13. 回滚后运行时出站 body 取证 — 未验证（只有配置层与适配器组装层证据，见 §8.11、§8.14）

> 以上 13 项一律登记为「未验证」，不得写成通过。2 项配置回显探针在 11-07 快照零覆盖、在 11-09 重跑中均 PASS（见 §4.0），但只证明配置被读取、不证明出站 body；`51/51` 与 Mock 15/15 均为历史留档。

### 8.14 配置层一键回滚：键清单与运行时证据

**措辞**：回滚到非思考型模型**只改配置即可，但不是只改一个开关**——需同步改多个 env 键：

| 键 | 处理 |
| --- | --- |
| `LLM_MODEL` | 改回非思考型模型 |
| `LLM_EXTRA_POLICY` | 设为 `none` |
| `LLM_EXTRA_BODY_KV` | 清空 / 改写 |
| `LLM_EXTRA_BODY_JSON` | 清空 / 改写（`.env.example` 已警告 `??` 会回退到此别名，故必须一并处理） |
| `LLM_MIN_MAX_TOKENS` | 可保留任意正整数 |

原因：`policy=none` 只跳过 required 校验，**不会隐式丢弃配置里仍写着的 extraBody**；让代码静默吞掉显式配置比多改一个键更难排查。裁决是**不改代码**、由回滚预案写清键清单。本实现把字段名与取值全部移到 `.env`，属实现侧选择，不是对 N13 边界的裁定（见 §8.10）。

**运行时证据**：以 `LLM_EXTRA_POLICY=none` + `LLM_EXTRA_BODY_KV=` + `LLM_EXTRA_BODY_JSON=` 启动，后端正常 boot（`/health status=ok gatewayMode=live`），`/config/audit` 回显 `extraPolicy='none'`、`extraBodyKeys=[]`、`minMaxTokens='256'`、`liveServices=['llm','asr','tts']`。证明回滚只改配置、不改代码，并印证 `.env.example` 里关于 `??` 回退到 `LLM_EXTRA_BODY_JSON` 别名的警告是必要的。

**证据效力边界**：以上只证明**配置层与适配器组装层**「不再注入」，不证明运行时出站 body 生效（见 §8.11）。

### 8.15 本轮新残余风险（两条）

**（1）有历史用量的库无法复现 live 48/48**：Model Router 的 `budgetExhausted` 判据含 `dailyUsage.unpricedCalls > 0`（`packages/model-router/src/router.ts:419-422`）。已产生当日未计价调用的库会把 `tts.dynamic_teaching` 压到 L0 `local_rules`，Gateway 再兜底到 `mock_tts`；叠加 `188d369` 之后的额度租约 / 登录态 / `assertLearnerOwnership` 契约门槛（见 §4.0），**在有历史用量的库上无法复现 live 48/48**。这是本轮新登记的残余风险，M1 默认登记，复现条件与网络层抓包 / 中性结构化日志列 **M2**。

**（2）根 `npm test` 的测试隔离缺陷（进程状态污染）**：见 §4.0 条件 (b)。`ai-gateway.service.ts:71` 的 `ttsCache` 是进程内内存 Map，`:273-281` 的 `ttsCacheKey()` 只含 text/teacherSpeed/voiceStyle/pronunciationMode/pauseAfterSentenceMs/voiceIdentity，**不含 learnerId / runId / 供应商 / 协议 / 型号**；集成用例用固定文本 `Hello from the teacher.`，同一 3100 进程内第二次跑必然命中缓存，使 `m1-api.integration.test.ts:75` 的 `assert.equal(firstSpeech.cached, false)` 实际 `cached=true`（64/63/1）。属**测试隔离性 / 进程状态污染，不是本轮 N27 / TTS / LLM 代码回归**；CI 的 "Start mock API" 每 run 是全新进程，结构上可过。**转绿条件**：重启 3100 清空内存 Map 后仅跑一次，或给 `ttsCacheKey` 增供应商 / 协议标识 + 测试用唯一文本。M1 默认登记为残余风险。

### 8.16 Mock 零外部调用证据

- `/health` → `gatewayMode=mock`；`/config/audit` → `gatewayMode=mock`、`liveServices=[]`。
- 补充断言（带登录态 + 额度租约）实测：`/speech/synthesize` → `mock_tts`、`/speech/recognize` → `mock_asr`、`/speech/evaluate` → `mock_pronunciation`，三者 `providerAlias` 全为 `mock_*`。
- **脚本本身的事实（QA 15 条只读复核）**：`verify_m1_loop.sh` 含 **15 条独立 `ok()` 断言**（行 `:38/:41/:43/:49/:59/:60/:69/:73/:94/:96/:105/:119/:128/:132/:160`），`:12` 的 `check()` 是死代码、0 次调用；当前 HEAD 实跑 **6 PASS / 9 FAIL**（历史 15/15 属旧 HEAD）。脚本**不校验**清单：不自启动后端、不读 `/health`、不设 / 不校验 `AI_GATEWAY_MODE` 与 `AI_GATEWAY_LIVE_SERVICES`、不校验 `providerAlias`、不校验零外部调用、不校验 `degraded`、不校验音频容器 / Content-Type、不设 `set -e` 且 curl 无 `--fail`、不落盘逐项 JSON。「零外部调用」由上述补充断言证明，脚本本身不校验。

### 8.17 验证环境与隔离说明

- 主工作区被另一会话的在途 `schema.prisma`（`priority` / `timeoutMs`）+ 未应用迁移污染，共享 Prisma Client 会报 P2022。
- 本轮验证在 `git worktree` 干净 HEAD + 精确 9 文件上进行，用 `node_modules` 目录联接复用依赖；并只在 worktree 的**已编译 dist**（build 产物、绝不提交）里加了一个验证专用 shim：跳过管理端运行时供应商配置装载。
- **未修改共享数据库 schema、未应用他方迁移、未改共享 `node_modules`**。
- 隧道：原目标 `127.0.0.1:5433/6380` 已失效（远端容器不再发布主机端口）；新隧道 `15434→172.19.0.3:5432`（PG，SCRAM-SHA-256 握手通过）、`16381→172.19.0.2:6379`（Redis `+PONG`）。
- **并发会话造成的本地提交分叉（事实登记）**：本轮代码 / 配置 6 文件在干净 `git worktree` 提交为 `0fe159b` 并已推送 `origin/main`（CI run `42593265380` `completed / success`）；主工作区另有并发本地提交 `01c97f4`（parent `188d369`、21 文件一次性提交、**未推送**），与 `0fe159b` 分叉。已核对本轮 6 个代码 / 配置文件在两提交中**逐字节相同**；未 force-push、未替对方改写历史。详见 `docs/M1-QA-report.md` §9.8。
- **`ttsCache` 测试隔离风险**：同一 3100 进程内重复跑根 `npm test` 会从 64/64/0 变 64/63/1，失败于 `m1-api.integration.test.ts:75` 的 `firstSpeech.cached`；登记为 M2 / 残余风险，**不是本轮 9 文件的代码回归**。受控复现日志 `tools/_npmtest_20261109_run1_fresh.log` / `_npmtest_20261109_run2_same_process.log`。

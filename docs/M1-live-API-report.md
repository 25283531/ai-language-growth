# M1 真实模型接入与实测报告

> 记录日期：2026-11-07
> 范围：在 M1 已交付的 Mock 闭环之上，接入真实免费的 LLM / ASR / TTS 并做端到端实测。
> 依据：`docs/ai-language-growth-v1-1-design.pdf` 第 7 章（技术架构）、第 9 章（验收标准）、`DECISIONS.md` D-011~D-015、D-024 三项硬约束。
>
> **本文件与 `docs/M1-QA-report.md` 配套阅读**。原 QA 报告的延迟结论基于 Mock 基线，接入真实模型后已被本报告的实测数据修正。

---

## 0. 结论速览

| 项目 | 结果 |
| --- | --- |
| 真实 API 端到端验证 | **34 / 34 PASS** |
| Mock 模式回归（证明可替换） | **15 / 15 PASS** |
| 全量 typecheck（7 个 workspace） | EXIT=0 |
| 单元测试 | 28 / 28 PASS |
| 真实单轮延迟是否满足任务书 1—2 秒 | **否**，ASR 9.0—11.5 秒、TTS 3.2—4.7 秒 |
| TTS 是否确认为免费 | **否**，公开价格页标注为付费模型，账户额度来源未核实 |
| 发音评估是否接真实服务 | **否**，两家均无免费音素级 GOP 服务，保持 Mock |

**Go / No-Go：维持「有条件通过」，并新增一条强制条件**——接入真实模型后单轮延迟未达 1—2 秒目标，不得对外宣称实时语音体验达标，必须做性能优化并复测。

---

## 1. 接入了什么

### 1.1 运行配置（凭据不入仓库）

真实凭据由本地脚本从 `G:/workbuddy/github-token.txt` 读入，只写入 `services/backend/.env`（已被 `.gitignore` 排除）。**key 未出现在任何被提交的文件、代码、日志或 CI 配置中**。

当前 `live` 配置分工：

| 服务 | 配置目标 | 用途 |
| --- | --- | --- |
| LLM | 智谱 OpenAI 兼容 `/chat/completions` | 孩子突然提问时生成一句回应话术 |
| ASR | 硅基流动 `/audio/transcriptions` | 把孩子语音转成文本 |
| TTS | 硅基流动 `/audio/speech` | 把后端教学指令合成真实 MP3 |
| 发音评估 | 留空 → Mock | 无免费音素级服务，绝不用 ASR 转写冒充发音评分 |

可一键切换，不需要改代码：

```bash
AI_GATEWAY_MODE=mock                 # 全部回落 Mock，零外部调用、零费用
AI_GATEWAY_MODE=live                 # 走真实服务
AI_GATEWAY_LIVE_SERVICES=llm,asr     # 去掉 tts，即可零 TTS 调用
```

`resolveLiveServices()` 要求「模式为 live + 在白名单内 + 对应 `*_BASE_URL` 已配置」三个条件同时成立；任一不满足，Router 别名与 Gateway 注册表会**一起**回落到 Mock，不会出现此前 M1 联调修过的「别名指向不存在的适配器 → 静默降级」。

### 1.2 代码改动

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

### 1.3 三项硬约束的落实

- **约束一（教学逻辑与客户端分离）**：LLM 只贡献一句可朗读的回应话术，追加到 `teacherUtterance`。评估、证据、掌握状态、方法阶梯、下一活动仍全部由后端 L0 规则与 Planner 决定。Web 只渲染、只播放。
- **约束二（模型可替换）**：所有 URL、模型名、音色名、凭据只在 `.env` 里；`packages/` 与 `services/` 业务代码零厂商名、零模型名。换供应商只改配置。验证：同一套测试在 live（34/34）与 mock（15/15）下都通过。
- **约束三（教学数据有可靠证据）**：LLM 输出不写 `learning_evidence`、不参与 `evaluateMastery`、不触发状态变更；ASR 与发音评估严格分离；发音评估保持 Mock 且如实标注。

---

## 2. 补上的 LLM 调用点（重要）

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
- 实测 `in=149 / out=21 tokens`，账本 `llm.calls=1`。

> 2026-11-08 更正：本报告形成时，`ai_usage_logs` 尚未接入运行时，账本统计仅在进程内存中；M2 的持久化账本现已写入用量表。模型价格尚未与运行时供应商配置关联，`costCny=0` 仍代表未计价，不代表免费。

---

## 3. 两家能力实测矩阵（2026-11-07 打真实请求核对）

> 免费名单与额度会变，以下以**当日实测 HTTP 结果**为准；「免费」均为公开价格页/资料的标注，不等于合同，费用以供应商控制台账单为准。

| 服务 | 平台 | 模型标识 | 实测结果 | 免费状态 |
| --- | --- | --- | --- | --- |
| LLM | 智谱 | `glm-4-flash` | 200，约 0.9s，**本项目启用** | 公开资料标为永久免费（有并发限制） |
| LLM | 智谱 | `glm-4.7-flash` | 429「访问量过大」 | 免费但限流明显，未启用 |
| LLM | 硅基流动 | `THUDM/GLM-4-9B-0414` | 200，340ms | 价格页标为免费，未启用 |
| LLM | 硅基流动 | `Qwen/Qwen3-8B` | 200，3544ms | 价格页标为免费，未启用 |
| ASR | 硅基流动 | `FunAudioLLM/SenseVoiceSmall` | 200，**本项目启用**，准确转写合成语音 | 价格页标为免费 |
| ASR | 智谱 | `glm-asr-2512` | 200（纯音输入返回 `#`） | 付费模型，账户有资源包，未启用 |
| ASR | 智谱 | `glm-asr` | 429「余额不足或无可用资源包」 | 不可用 |
| TTS | 硅基流动 | `FunAudioLLM/CosyVoice2-0.5B` | 200，真实 MP3（ID3 头，约 60KB），**本项目启用** | **公开价格页标注付费**；账户当前有额度所以能调通 |
| TTS | 硅基流动 | `fnlp/MOSS-TTSD-v0.5` | 200，931ms，约 80KB | 同上，未启用 |
| TTS | 智谱 | `glm-tts` | 429「余额不足或无可用资源包，请充值」 | **无免费额度，不可免费使用** |
| 发音评估 | 两家 | — | 无音素级 GOP 服务 | 保持 `mock_pronunciation` |

**关于「免费 TTS」的诚实结论**：两家都没有可确认免费的 TTS 模型。硅基 TTS 能调通是因为账户存在可用额度（赠送额度/资源包），但 `/v1/models` 不返回价格字段、`/v1/user/info` 已废弃（410），**无法用 API 证明零扣费**；智谱 TTS 明确报余额不足。因此本项目把 TTS 设为可一键关闭，不宣称免费。若要求严格零成本，用 `AI_GATEWAY_LIVE_SERVICES=llm,asr` 即可。

---

## 4. 端到端实测结果

脚本：`tools/verify_live_apis.py`（仓库外工具目录，结果落 `_live_results.json`）。

链路不是各自打点，而是**串起来的真实闭环**：真实 TTS 合成 → 下载 MP3 → 把同一个 MP3 作为真实 ASR 输入 → 开课 → 正常作答 → 孩子突然提问触发 LLM → 幂等重放 → 用量账本 → 结课。

| 检查组 | 关键实测值 |
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

最终 **PASS=34 / FAIL=0**；Mock 回归 **PASS=15 / FAIL=0**。

### 4.1 延迟实测（两轮，单位 ms）

| 环节 | 第 1 轮 | 第 2 轮 | 任务书目标 |
| --- | --- | --- | --- |
| TTS 首次合成 | 4,650 | 3,177 | — |
| TTS 缓存命中 | 4 | 4 | 重复播放不重新消耗 ✓ |
| 音频下载 | 29 | 6 | — |
| ASR 真实识别 | 9,040 | 11,536 | — |
| 开课（含真实 TTS） | 2,203 | 4,090 | — |
| 普通作答 `/turn` | 631 | 678 | 1—2 秒 |
| 幂等重放 | 27 | 27 | — |
| 提问 `/turn`（含真实 LLM + TTS） | 6,357 | 6,153 | 1—2 秒 |
| 结课 | 92 | 90 | — |

**这是本轮最重要的发现**：Mock 基线的 p50 394ms / p95 438ms 只代表平台编排开销；接入真实模型后，ASR 单路就近 10 秒、TTS 合成 3—5 秒、含 LLM 的回合约 6 秒，只有「纯文本作答且 TTS 缓存命中」的回合仍在 1 秒内。**单轮语音交互 1—2 秒目标当前未达成**，且为单次采样、波动明显。

M2 需针对性处理：TTS 预生成与句级缓存、固定课程音频离线化、ASR 流式识别、LLM/ASR/TTS 并行化与超时预算、把慢调用移出关键路径。在这些优化与复测完成前，不得表述为「实时语音体验达标」。

---

## 5. 本轮修掉的联调缺陷

1. `freeUtterance` 契约是 `string | null`，测试脚本误传 boolean → `/turn` 400。
2. POST 接口在 Nest 下返回 201，验证脚本只接受 200 → 大量假失败。
3. **Git Bash / MSYS2 路径污染**：`AI_AUDIO_URL_PREFIX=/api/v1/media/audio` 传给 native 进程时被改写成 `D:/Program Files/.../api/v1/media/audio`，导致 `audioRef` 不可播放。改为平台内固定常量，不再经环境变量（也符合「这是平台路由，不是供应商配置」）。
4. `teacherSpeed` 在 `z.input` 下可选，`mapTeacherSpeed` 入报 TS2345 → 加默认值。
5. LLM 首轮输出带 emoji 与未校验的科普式因果（「因为太阳光里有蓝色」）→ 加输出净化（去 emoji/markdown）、prompt 明确禁止事实性解释、限定为温柔回应并把话题带回英语练习。
6. 成本账本 `costCny=0` 会被误读成「免费」→ `/usage/summary` 增加 `pricingStatus: unpriced` 与说明文字。
7. 真实音频合成后 Web 只能看到字符串 → 增加 `<audio controls>` 播放器，Mock 占位引用不渲染。

---

## 6. 已知限制与风险（不得豁免）

1. **延迟超标**：见 §4.1，1—2 秒目标未达成。
2. **TTS 计费未确认**：见 §3，可用开关一键关闭；不要把 `costCny=0` 当作零成本。
3. **发音评估仍是 Mock**：不能宣称系统已具备儿童发音评估能力；接真实 GOP 服务前必须做儿童发音 Benchmark（DECISIONS「尚未决定事项」）。
4. **LLM 话术质量**：实测仍会出现「因为天空很美哦」这类无意义因果。已禁止科普与 emoji，但尚无内容安全与事实校验层；LLM 输出不进入证据链，也不作为知识来源。
5. **阈值与内容状态不变**：全部 `uncalibrated`、课程全部 `pending_review`，不得对外表述「已掌握」，未经人工审核不得面向儿童发布。
6. **无真实儿童样本**：本次使用 TTS 合成语音做 ASR 输入，不是 6—9 岁儿童录音；未做教学有效性宣称。
7. **未做故障注入**：本轮未主动制造真实服务故障验证 live 降级链；Mock 模式的离线兜底测试通过，但不能替代。
8. **凭据范围**：key 仅存本地 `.env`；CI 无密钥，默认 Mock，不会触发真实调用或产生费用。
9. **未验证**：`docker build` 本机无 Docker daemon；Android 真机编译由 GitHub Actions 完成。

---

## 7. 复现方式

```bash
# 1) 生成 live 配置（从本地凭据文件读 key，不回显、不入库）
python tools/setup_live_env.py

# 2) 启动后端
cd services/backend && set -a && . ./.env && set +a && npx tsx src/main.ts

# 3) 真实 API 端到端（34 项）
python tools/verify_live_apis.py

# 4) 切回 Mock 回归（15 项）
export AI_GATEWAY_MODE=mock   # 重启后端
bash tools/verify_m1_loop.sh
```

`tools/` 下的探测与验证脚本位于仓库外，用于本地联调；它们不包含任何凭据，也未提交。

# P1-7 模型运行准入 Benchmark 与生产门禁

> 日期：2026-11-12
> 范围：管理后台「模型接入」页的运行准入 Benchmark、最近结果，以及 `AI_GATEWAY_MODE=live` 时的生产门禁。

## 1. 边界

P1-7 不恢复 2026-11-09 取消的「手工填写儿童专项分数」门槛，也不把一次后台点击当成儿童教学质量结论。当前实现只做**运行准入评估**：

- 使用 `ai_usage_logs` 中该配置最近 30 天的真实成功调用；
- 检查配置完整性、调用样本量、平均延迟和 P95 延迟；
- 不调用供应商，不产生新费用；
- 明确标注「仅验证运行可用性，不替代儿童教学质量评估」。

真实儿童发音/教学质量仍按 D-030 在投入真实使用后持续验证，不因本功能重新变成上线前的强制人工评分。

## 2. 运行规则

`POST /api/v1/admin/model-providers/benchmarks/run`

请求：`{ "serviceKind": "llm|tts|asr|pronunciation", "configId": "<uuid>" }`

评估窗口为最近 30 天，最多取 2000 条账本样本。每次运行都会写入一条 `ai_model_benchmarks`：

- `benchmarkType = "<serviceKind>_runtime_readiness"`
- `score`：0–100
- `sampleCount`：实际读取的调用数
- `passed`：是否满足门槛
- `notes`：中文门槛与结果说明

| 服务 | 最少样本 | 平均延迟上限 | P95 上限 |
| --- | ---: | ---: | ---: |
| LLM | 5 | 8000 ms | 12000 ms |
| TTS | 3 | 12000 ms | 18000 ms |
| ASR | 3 | 15000 ms | 22500 ms |
| Pronunciation | 3 | 15000 ms | 22500 ms |

配置预检还会检查接入地址、模型名称、供应商预置和必需凭据。Embedding 尚未进入教学调用链，不生成可用结果。

没有真实调用时写入 `sampleCount=0`、`passed=false`，不会伪造通过。

## 3. 最近结果与生产门禁

`GET /api/v1/admin/model-providers/benchmarks?serviceKind=...&configId=...` 除原有最近 10 条结果外，新增：

- `latest`：最近一条结果；
- `productionReady`：配置已启用且最近一次结果通过、样本数大于 0。

生产门禁只在 `AI_GATEWAY_MODE=live` 生效：

1. **启用配置**：未通过最近一次 Benchmark 的模型不能保存为 `enabled=true`。新建模型必须先保存为停用，运行通过的 Benchmark，再启用。
2. **保存任务路由**：已启用路由中的 `configured_<serviceKind>_<configId>` 主/备模型必须有通过的 Benchmark。
3. **运行时刷新**：`AiGatewayService.refreshRuntimeProvider` 在 live 模式跳过未通过 Benchmark 的配置，优先回落 Mock，而不是把未验证模型投入生产。

`mock` 模式（当前生产与 CI）不阻断配置和路由保存，只展示准入结果，方便开发和演示；不会因此调用真实供应商。

## 4. 管理端

「模型接入」页当前配置下方新增「运行准入 Benchmark」区：

- 「运行 Benchmark」按钮；
- 最近一次通过/未通过、分数、样本数、时间；
- 门槛说明和历史结果摘要；
- `productionReady` 与 live 模式门禁说明。

页面加载只读查询，只有点击按钮才发送 POST；不会自动产生 benchmark 记录。

## 5. 验证

- `services/backend/test/provider-benchmark.test.ts`：11/11 通过，覆盖通过、样本不足、平均延迟/P95 超限、配置缺项、Embedding、TTS 门槛、最近一次失败覆盖旧通过、mock/live 门禁和 live 路由保存拒绝。
- `services/backend/test/admin-console-static-guard.test.ts`：新增运行按钮/最近结果/生产提示静态守卫，全部通过。
- `services/backend/test/p1-7-benchmark.integration.test.ts`：在一次性 PostgreSQL 上创建配置、模型和 5 条真实账本，运行 benchmark 后核对 `benchmarkType`、`sampleCount`、`latest`、`productionReady` 与 live 拒绝；通过后删除一次性库。
- 未调用真实供应商，未写入生产数据库。

## 6. 已知限制

- 运行准入依据「成功调用账本」，不验证儿童发音、语义质量或供应商内容安全；这些仍需要真实使用中的抽查与儿童样本评估。
- 新配置在没有任何真实调用前会得到「样本不足」，这是预期行为；需要先在受控环境产生调用，再运行 benchmark。
- 当前 `AI_GATEWAY_MODE=mock`，因此本机/CI 只能验证门禁逻辑与管理端展示，不能证明真实供应商的延迟门槛。

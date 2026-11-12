# P2-2E 语音用量与账本对账

> 日期：2026-11-12
> 范围：一次性 PostgreSQL + `AI_GATEWAY_MODE=mock`，验证 TTS、ASR、发音的真实 HTTP 链路、`ai_usage_logs`、管理员聚合 API 与 `/costs` 页面一致。
> 不写生产库；不调用真实供应商；不产生真实费用。

## 结论

P2-2E 已完成。一次性环境中的 9 次语音调用全部入账，账本行数、计量单位、管理员聚合和页面展示三方一致；金额为 0 且 `unpricedCalls=0`，按“未配置价格时 0 表示未计价”的口径展示，不当作免费。

| 项目 | 结果 |
|---|---|
| 一次性数据库 | `alg_ci_p2_2e_20261112_135123_32520`（已删除） |
| 网关模式 | `mock` / L0 |
| TTS | 3 次请求：`alpha`、`beta`、`alpha` 重播；入账 3 行，字符 5 + 4 + 0 = 9 |
| ASR | 3 次请求；每次 1.5 秒，合计 4.5 秒 |
| 发音评测 | 3 次请求；`pronunciationCalls=3` |
| 账本总行数 | 9 |
| 聚合 API totals | calls 9、TTS 字符 9、ASR 4.5 秒、发音 3、`estimatedCostCny=0`、`unpricedCalls=0` |
| `/costs` 页面 | 筛选后显示同一组 totals；learner/topic/day 三张表一致 |
| 预算接口 | learner/day、topic/month 均 200；`enforcement=advisory`、`blocked=false`、`displayMode=usage`、`cost=null` |
| 清理 | 一次性库已 `DROP`，后端/管理端端口已释放，state/stop/临时音频已删除 |

## 账本口径

- TTS 每次成功的 `POST /speech/synthesize` 都写一行账本。缓存重播写 `ttsCharacters=0`，因此“调用次数 = 账本行数”，但不会把缓存命中重复计算成合成字符或费用。
- `scope.lessonSessionId` 存在时，先校验该会话属于请求学习者；账本同时写入 `lessonSessionId`，管理员聚合通过 `lesson_sessions.topicId` 归到课程主题。
- ASR 按供应商返回的实际秒数入账；发音按调用次数入账；直连语音接口与编排器路径不重复写账。
- `estimatedCostCny=0` 只表示当前未配置可用于计价的模型价格；是否“未计价”看 `unpricedCalls`，不能把 0 元解释成免费。
- 进程内 TTS 缓存指标与历史账本分栏展示，二者不相加。

## 实测证据

### 集成测试

测试文件：`services/backend/test/p2-2e-usage-flow.integration.test.ts`

测试在一次性库上创建测试用户、学习者、课程会话和主题，登录测试管理员，随后：

1. 预留并调用 TTS 3 次（含一次缓存重播），断言缓存重播 `characters=0`；
2. 预留并调用 ASR 3 次，按返回秒数累计；
3. 预留并调用发音评测 3 次；
4. 直接查询 `ai_usage_logs`，断言 9 行、TTS 3 行、ASR 3 行、发音 3 行，且每行都有 `lessonSessionId`、`level=L0`、`estimatedCostCny=0`；
5. 调用 `GET /api/v1/admin/usage/cost`，断言 totals、`byLearner`、`byTopic`、`byDay` 与账本一致。

本次运行输出：

```text
✔ TTS/ASR/发音若干次后，账本行数、单位与管理员聚合一致 (6008.3156ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

fixture 摘要：

```json
{"runId":"ui-20261112-d","learnerId":"p2-2e-learner-ui-20261112-d","topicId":"p2-2e-topic-ui-20261112-d","lessonSessionId":"p2-2e-session-ui-20261112-d","expected":{"calls":9,"ttsCharacters":9,"asrSeconds":4.5,"pronunciationCalls":3}}
```

### 管理员聚合 API

使用与 `/costs` 页面相同的结束日边界（当天 23:59:59）查询：

```json
{
  "status": 200,
  "totals": {"calls":9,"ttsCharacters":9,"asrSeconds":4.5,"pronunciationCalls":3,"estimatedCostCny":0,"unpricedCalls":0},
  "byLearner": [{"learnerId":"p2-2e-learner-ui-20261112-d","calls":9,"ttsCharacters":9,"asrSeconds":4.5,"pronunciationCalls":3,"estimatedCostCny":0,"unpricedCalls":0}],
  "byTopic": [{"topicId":"p2-2e-topic-ui-20261112-d","calls":9,"ttsCharacters":9,"asrSeconds":4.5,"pronunciationCalls":3,"estimatedCostCny":0,"unpricedCalls":0}],
  "byDay": [{"date":"2026-11-12","calls":9,"ttsCharacters":9,"asrSeconds":4.5,"pronunciationCalls":3,"estimatedCostCny":0,"unpricedCalls":0}]
}
```

注意：只传 `to=2026-11-12` 会被解析为当天 00:00:00，因而排除当天记录；`/costs` 页面会把结束日期发送为当天 23:59:59.999（本地日期对应 UTC 边界），对账时应使用页面实际发送的范围。

### `/costs` 页面

在真实浏览器中登录管理端，填写 fixture 的 `learnerId` 和 `topicId` 后应用筛选，页面显示：

- 调用次数 9；
- TTS 字符 9；
- ASR 秒数 4.50 秒；
- 发音评测次数 3；
- 估算金额 ¥0.0000；
- 未计价调用 0；
- 按学习者、按课程主题、按日期（UTC）三张表均与上述 totals 一致；
- learner/day 与 topic/month 预算卡显示“未配置”，只展示字符/秒/次数，不把 0 元当作免费额度。

页面请求的资源记录包含 `/api/v1/admin/usage/cost?...` 和 `/api/v1/admin/usage/budget/evaluate?...`，对应接口均返回 200。

## 复现方式

前置条件：已 `npm ci && npm run build`；本地有可用的 SSH 凭据；测试管理员账号仅通过环境变量提供，不要写入仓库。

```powershell
$env:M1_REMOTE_PASSWORD = '<从本地密钥读取>'
$env:ADMIN_USERNAME = '<一次性测试管理员>'
$env:ADMIN_PASSWORD = '<一次性测试密码>'
$env:P2_2E_RUN_ID = 'ui-20261112-d'

python tools/run_m1_remote_pg.py `
  --host 152.136.230.132 --user root `
  --db-prefix alg_ci_p2_2e `
  --test-file services/backend/test/p2-2e-usage-flow.integration.test.ts `
  --serve --serve-timeout 1200 --admin-port 3001 `
  --state-file tools/_p2_2e_serve.json --stop-file tools/_p2_2e_stop
```

`--serve` 会在测试通过后保留 mock 后端和管理端，测试 fixture 也保留，便于浏览器对账；对账完成后在仓库根目录创建停止文件：

```powershell
New-Item -ItemType File -Path tools/_p2_2e_stop
```

runner 会停止两个进程、删除临时音频和一次性数据库，并清理 state/stop 文件。需要保留数据库排查时另加 `--keep-db`，不要用于日常验收。

CI 已加入对应步骤；CI 使用 PostgreSQL service 和固定的一次性测试管理员，不读取生产凭据。

## 相关代码

- `services/backend/src/speech/speech.controller.ts`
- `services/backend/src/ai-gateway/ai-gateway.service.ts`
- `services/backend/test/speech-usage.test.ts`
- `services/backend/test/p2-2e-usage-flow.integration.test.ts`
- `.github/workflows/ci.yml`
- `tools/run_m1_remote_pg.py`

# P1-6 自适应活动选择：确定性优先与 L1 边界裁决

> 日期：2026-11-12
> 范围：`PlannerService.chooseAdaptiveActivity` 的候选活动选择。目标是把无条件的 `llm.learning_plan` 调用改为规则优先，只在无法用规则稳定裁决的边界场景调用 L1 轻量模型。

## 选择策略

候选活动先经过既有的发布状态、硬前置和渐进难度过滤。之后：

1. **确定性排序**：按
   `最薄弱能力掌握等级 → 教材单元对齐 → 难度 → 课程顺序`
   排序，第一名即为确定性胜者。
2. **直接返回**：以下情况不再调用 LLM，也不写 `llm` 账本：
   - 只有 0 或 1 个候选；
   - 最高优先级只有唯一候选；
   - 同层候选的任务类型相同（用稳定的难度/顺序决定）；
   - 同层候选难度不同（取更容易的候选）；
   - 同层候选的能力已经达到 `mastered` 及以上（不需要教学裁决）。
3. **L1 边界裁决**：只有同时满足：
   - 最高优先级仍有多个候选；
   - 这些候选的掌握缺口、教材对齐和难度都相同；
   - 它们属于不同任务类型；
   - 掌握等级仍低于 `mastered`；
   
   才调用 `llm.learning_plan_tiebreak`。该路由主模型为 L1，备用模型也为 L1，预算独立为 20 元/日；不会走原来的 L3 `llm.learning_plan`。
4. **失败回落**：边界裁决超时、异常、输出非法或选中了候选集外的 ID 时，返回确定性胜者，课程不中断；这一次尝试仍按实际路由写账。

`llm.learning_plan` 仍保留给教材/课程生成等真正的长期规划任务，不受本改动影响。

## 账本对照

使用 `services/backend/test/p1-6-adaptive-ledger.integration.test.ts` 在一次性 PostgreSQL 上直接调用 `chooseAdaptiveActivity`，Router 使用真实 `PrismaUsageLedger`，LLM 使用本地 fake，避免真实供应商调用。四个场景：

1. 掌握缺口明显：应确定性选择；
2. 同层同任务类型：应确定性选择；
3. 同层不同任务类型：应走 L1 边界裁决；
4. 同层但均已掌握：应确定性选择。

### 改造前

```text
{"runId":"p1-6-baseline-20261112-b","scenarios":4,"llmCalls":4,"gatewayCalls":4,"routes":["llm.learning_plan","llm.learning_plan","llm.learning_plan","llm.learning_plan"],"levels":["L0","L0","L0","L0"]}
```

- 4 个场景全部调用 LLM；
- 4 条账本行全部是 `llm.learning_plan`；
- 路由规则原来主模型为 L3，备用 L2；
- 账本 `level=L0` 是因为测试使用 mock 适配器，按现有口径记为 L0；路由决策仍为 L3。

### 改造后

```text
{"runId":"p1-6-after-20261112-d","scenarios":4,"llmCalls":1,"gatewayCalls":1,"routes":["llm.learning_plan_tiebreak"],"levels":["L0"],"decisions":[{"level":"L1","providerAlias":"mock_llm"}]}
```

- 4 个场景只调用 1 次 LLM；
- 唯一一条账本行是 `llm.learning_plan_tiebreak`；
- 路由决策为 **L1**；
- 调用次数从 4 降到 1，减少 **75%**；另外 3 个场景完全由规则完成，没有 LLM 账本行。

> 统计口径：只统计 `chooseAdaptiveActivity` 触发的 LLM 调用，不包含教材生成等其它使用 `llm.learning_plan` 的路径。账本 `level=L0` 是 mock 适配器的显示口径，不能据此判断路由等级；路由等级以 `llm.learning_plan_tiebreak` 的 L1 决策为准。

## 测试与门禁

- `services/backend/test/planner-adaptive-choice.test.ts`：7 个离线单测，覆盖清晰胜者、同任务类型、难度不同、已掌握、边界裁决、非法输出回落和单候选。
- `services/backend/test/p1-6-adaptive-ledger.integration.test.ts`：一次性 PostgreSQL 账本探针，默认断言只允许 1 次边界调用，并核对账本行数、`taskRoute` 和 L1 决策。
- CI 新增 `P1-6 adaptive planner LLM call budget` 步骤；单测清单加入 `planner-adaptive-choice.test.ts`。
- 仍不写生产库、不调用真实供应商。

## 复现

单测：

```powershell
npx tsx --tsconfig services/backend/tsconfig.json --test services/backend/test/planner-adaptive-choice.test.ts
```

账本探针（一次性 PostgreSQL，mock 适配器）：

```powershell
$env:P1_6_DB_INTEGRATION = '1'
$env:P1_6_EXPECT_LLM_CALLS = '1'
python tools/run_m1_remote_pg.py `
  --host 152.136.230.132 --user root `
  --db-prefix alg_ci_p1_6 `
  --test-file services/backend/test/p1-6-adaptive-ledger.integration.test.ts
```

需要在改造前复现基线时，把 `P1_6_EXPECT_LLM_CALLS` 设为 `4`，同一条探针即可输出 4 次调用。

## 相关代码

- `services/backend/src/planner/planner.service.ts`
- `services/backend/test/planner-adaptive-choice.test.ts`
- `services/backend/test/p1-6-adaptive-ledger.integration.test.ts`
- `packages/shared-contracts/src/router.ts`
- `packages/model-router/src/router.ts`
- `.github/workflows/ci.yml`

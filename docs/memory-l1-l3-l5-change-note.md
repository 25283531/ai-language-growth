# L1/L3/L5 记忆与知识检索变更说明

> 日期：2026-11-26  
> 参考实现说明：[`docs/memory-architecture.md`](./memory-architecture.md)  
> 变更目标：补齐 L1 Redis 工作记忆、L3 Mem0 交互记忆、L5 课程知识 RAG 的代码链路，同时保持 PostgreSQL 为教学审计权威源。

## 1. 变更结论

本次已完成 L1/L3/L5 的代码、数据库结构、配置、管理入口和回归测试：

- L1：Redis 工作记忆已接入开课、回合和结课流程，Redis 不可用时回落数据库会话。
- L3：Mem0 REST 适配器已接入交互记忆写入、检索、修正和删除；外部命中必须回指本地 PostgreSQL 行，外部文本不能直接进入课堂。
- L5：已建立 `curriculum_knowledge_chunks` 知识块与“词法 + 可选 Embedding”检索链路，提供手动重建和只读检索入口。

本次不把“代码已接入”表述为“真实供应商已验证”。真实 Mem0/Embedding 实例、真实儿童课堂、staging 验证和生产迁移仍未执行。

## 2. 行为摘要

### 2.1 L1 Redis 工作记忆

- Redis key：`alg:l1:lesson:{lessonSessionId}`。
- 默认 TTL：6 小时，可用 `WORKING_MEMORY_TTL_SECONDS` 覆盖。
- 只保存当前活动、当前教学指令和最近 8 轮对话；单轮 `childText` / `teacherText` 最多 240 字。
- 不保存儿童音频、原始录音、TTS 语音对象或供应商凭据。
- 开课写初始快照；回合追加最近对话；结课清理；读取时校验 `lessonSessionId`，拒绝串课。
- Redis 未配置、连接失败或超时，直接回落 PostgreSQL 会话，不阻断教学；失败后 30 秒内避免反复重试。

### 2.2 L3 Mem0 交互记忆

- 结课后只从孩子明确表达的偏好/反馈中提取 0—3 条可纠正的教学偏好。
- 先写 PostgreSQL `interaction_memories`，再尽力写 Mem0；Mem0 只收到提取后的偏好文本和教学元数据，不收到原始对话、完整转写或音频。
- Mem0 命中必须带 `metadata.local_memory_id`，并能按 `id + learnerId + 未过期` 回指本地行；返回内容一律取本地行，不直接使用 Mem0 文本。
- Mem0 无命中、失败或全部未通过本地校验时，回落 PostgreSQL 关系表。
- 管理员修正/删除记忆时，以本地 PostgreSQL 为准，尽力同步/删除 Mem0；外部残留不会通过本地回指校验进入课堂。
- Mem0 连续失败熔断 60 秒；课堂检索单次最多等待 2.5 秒。

### 2.3 L5 课程知识 RAG

- 新增 `curriculum_knowledge_chunks`，按 `sourceType + sourceId` 唯一。
- 索引已发布且 `availability=active` 的课程单元、课文句子、词汇卡、句型、音素，以及 `childSafe=true` 的词库条目。
- 检索先做词法预筛，再有向量时使用 `0.65 * cosine + 0.35 * 归一化词法分`；无向量时只用词法分。
- Embedding 未配置、失败或超时只走词法检索，不生成假向量；内容变化且本轮无新向量时清空旧向量。
- 当前不使用 pgvector：向量以 JSON 数组存 PostgreSQL，余弦在 Node 内计算；这不是向量数据库方案。
- 管理端提供 `status`、`knowledge/reindex`、`knowledge/search`，全部沿用 `x-admin-token`，不新增匿名入口。

## 3. 改动文件

### 3.1 新增

**L1/L3/L5 核心实现**

- `services/backend/src/memory/working-memory.service.ts`
- `services/backend/src/memory/mem0.client.ts`
- `services/backend/src/memory/embedding.service.ts`
- `services/backend/src/memory/curriculum-knowledge.service.ts`
- `services/backend/src/memory/memory-architecture-admin.controller.ts`

**数据库迁移**

- `services/backend/prisma/migrations/20261126140000_memory_l1_l3_rag/migration.sql`

**回归测试**

- `services/backend/test/working-memory.test.ts`
- `services/backend/test/mem0-client.test.ts`
- `services/backend/test/curriculum-knowledge.test.ts`

**文档**

- `docs/memory-architecture.md`
- `docs/memory-l1-l3-l5-change-note.md`（本说明）

### 3.2 修改

**数据模型与后端装配**

- `services/backend/prisma/schema.prisma`
  - `interaction_memories` 增加 `externalId`、`externalProvider`。
  - 新增 `curriculum_knowledge_chunks` 模型、唯一约束和索引。
- `services/backend/src/app.module.ts`
  - 注册 L1/L3/L5 服务和管理控制器。
- `services/backend/src/config/config.module.ts`
  - 增加 `WORKING_MEMORY_TTL_SECONDS`、`MEM0_*`、`EMBEDDING_*` 配置解析和数值边界。

**编排与记忆集成**

- `services/backend/src/orchestrator/orchestrator.service.ts`
  - 开课写入 L1 快照，回合追加最近对话，结课清理。
  - 问答路径接入 L5 `searchForPrompt`。
- `services/backend/src/agents/memory-manager.service.ts`
  - L3 写入、检索、修正、删除接入 Mem0；保留本地权威校验和 PostgreSQL 回落。
- `services/backend/src/memory/memory-admin.controller.ts`
  - 管理员修正/删除记忆改为通过 `MemoryManagerService` 同步外部索引。

**供应商配置**

- `services/backend/src/providers/provider-config.service.ts`
  - 允许读取 `serviceKind=embedding` 的启用配置。
- `services/backend/src/providers/provider-benchmark.service.ts`
  - 更新 Embedding 尚未写入用量账本时的 Benchmark 提示，避免与“检索链路未启用”混淆。

**测试调整**

- `services/backend/test/prosody-contract.test.ts`
  - 适配 Orchestrator 新增依赖的构造函数参数。
- `services/backend/test/provider-benchmark.test.ts`
  - 更新 Embedding Benchmark 文案断言。

**后台页面**

- `apps/admin-web/app/providers-page.tsx`
  - 更新 Embedding 接入、降级和计量说明；移除“仅配置、检索链路尚未启用”的旧文案。

**部署配置**

- `deploy/docker/.env.example`
  - 增加 L1/L3/L5 配置示例。
- `deploy/docker/docker-compose.yml`
  - 透传 `WORKING_MEMORY_TTL_SECONDS`、`MEM0_*`、`EMBEDDING_*`。

**文档与决策记录**

- `DECISIONS.md`
  - 记录 D-019、D-029 的本次实施状态和未验证边界。
- `README.md`
  - 更新记忆与人格说明，指向 `docs/memory-architecture.md`。
- `docs/M2-audit.md`
  - 更新长期记忆条目，反映 L1/L3/L5 已接入。
- `docs/README.md`
  - 文档索引增加记忆架构说明。
- `docs/development-plan-v1.1.md`
  - 记录 L1/L3/L5 已关闭的代码差距和后续真实供应商验收项。
- `docs/taskbook-sections-1-5-audit.md`
  - 更新第 5 节审计结论、Embedding/Rerank 说明和后续顺序。

> 工作区中的 `apps/android/README.md` 修改在本轮工作前已存在，未纳入本次变更。

## 4. 数据库迁移

### 4.1 迁移内容

迁移目录：`services/backend/prisma/migrations/20261126140000_memory_l1_l3_rag/`

1. `interaction_memories`
   - 新增 `externalId TEXT`。
   - 新增 `externalProvider TEXT`。
   - 新增 `interaction_memories_externalId_idx`。
2. 新建 `curriculum_knowledge_chunks`
   - 字段：`id`、`sourceType`、`sourceId`、`topicId`、`title`、`content`、`metadata`、`embedding`、`embeddingModel`、`contentHash`、`createdAt`、`updatedAt`。
   - 唯一索引：`(sourceType, sourceId)`。
   - 普通索引：`topicId`、`updatedAt`。

该迁移是增量迁移，不删除既有表或列。

### 4.2 部署顺序

以下步骤本次均未执行，只作为提交后的部署/迁移清单：

1. **备份并验证可恢复性**
   - 按 `docs/deployment/staging-migration-checklist.md` 执行全量备份。
   - staging 使用独立数据库和独立 role；禁止 `prisma:seed`、集成测试和写测试。

2. **检查迁移状态**

   ```powershell
   $env:DATABASE_URL='postgresql://<user>:<password>@<host>:5432/<db>?schema=public'
   npx prisma migrate status --schema services/backend/prisma/schema.prisma
   ```

3. **应用迁移**

   ```powershell
   npx prisma migrate deploy --schema services/backend/prisma/schema.prisma
   npx prisma generate --schema services/backend/prisma/schema.prisma
   ```

4. **确认迁移结果**
   - `migrate status` 无 pending / failed。
   - 核对 `interaction_memories.externalId`、`externalProvider` 和新表 `curriculum_knowledge_chunks`、唯一索引及普通索引存在。
   - 确认后端镜像已包含新 Prisma Client；不要在新迁移完成前启动依赖新列的后端版本。

5. **配置环境变量并重启后端**
   - 至少确认数据库连接和 Redis URL 正确。
   - Redis、Mem0、Embedding 都是可选增强；未配置时分别回落数据库会话、PostgreSQL 关系表、词法检索。

6. **执行健康检查**

   ```http
   GET /api/v1/health
   GET /api/v1/admin/memory/status
   x-admin-token: <admin-token>
   ```

7. **首次建立 L5 知识索引**

   未配置 Embedding 时，只建文本索引：

   ```http
   POST /api/v1/admin/memory/knowledge/reindex
   x-admin-token: <admin-token>
   Content-Type: application/json

   { "embed": false, "prune": true }
   ```

   已配置 Embedding 时：

   ```http
   POST /api/v1/admin/memory/knowledge/reindex
   x-admin-token: <admin-token>
   Content-Type: application/json

   { "limit": 12000, "embed": true, "prune": true }
   ```

   - 首次部署、课程发布或下架后需要重新调用；未重建前知识块表为空，L5 检索返回空数组。
   - 全量重建会逐批调用 Embedding，块数多时可能耗时数分钟；可用较小的 `limit` 分批建立文本索引，但此时不会执行 prune。
   - `prune=true` 只在扫描了全部候选块时生效，避免截断扫描误删有效块。

8. **验证检索入口**

   ```http
   GET /api/v1/admin/memory/knowledge/search?q=apple&limit=5
   x-admin-token: <admin-token>
   ```

### 4.3 回滚说明

- 迁移本身是增量式；回滚应用版本时，新增列和新表可以保留，不影响旧代码读取既有表。
- 如需删除 `curriculum_knowledge_chunks`，应先确认无需保留索引数据并完成备份，不应作为自动回滚步骤。
- Redis/Mem0/Embedding 均可通过不配置对应环境变量关闭增强路径；关闭后 L1/L3/L5 分别回落数据库会话、关系表和词法检索。

## 5. 配置清单

### 5.1 L1

```dotenv
WORKING_MEMORY_TTL_SECONDS=21600
# 复用 REDIS_URL；未配置即回落数据库会话
```

### 5.2 L3

```dotenv
MEM0_BASE_URL=
MEM0_API_KEY=
MEM0_ADD_PATH=/v1/memories/
MEM0_SEARCH_PATH=/v1/memories/search/
MEM0_UPDATE_PATH=/v1/memories/{id}/
MEM0_DELETE_PATH=/v1/memories/{id}/
MEM0_TIMEOUT_MS=5000
```

未配置 `MEM0_BASE_URL` 时不会发出 Mem0 请求。

### 5.3 L5

```dotenv
EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
```

配置优先级：后台 `serviceKind=embedding` 的启用配置优先，其次使用上述环境变量。Embedding 调用目前未写入用量账本。

## 6. 验证结果

### 6.1 已执行并通过

- `npm run typecheck --workspace @alg/backend`：通过。
- `npm run build --workspace @alg/backend`：通过。
- `npm run typecheck --workspace @alg/admin-web`：通过。
- 记忆/契约定向回归：26/26 通过。
  - `working-memory.test.ts`：3 项。
  - `mem0-client.test.ts`：7 项。
  - `curriculum-knowledge.test.ts`：9 项。
  - `prosody-contract.test.ts`：7 项。
- Prisma schema `validate` / `generate`：通过。
- `git diff --check`：无空白错误，仅有既存的 CRLF 提示。

### 6.2 全量后端测试

```text
tests 470
pass 463
fail 1
skipped 6
```

唯一失败为 `services/backend/test/m1-api.integration.test.ts`：

```text
PrismaClientInitializationError
Environment variable not found: DATABASE_URL
```

该用例需要真实 PostgreSQL；本机未配置 `DATABASE_URL`，不是 L1/L3/L5 改动引入的回归。全量测试因此以环境原因退出 1，不能表述为“全绿”。

### 6.3 未执行 / 未验证

- 未使用真实 Mem0 实例做写入、检索、修正、删除和故障切换验收。
- 未使用真实 Embedding 供应商做知识库重建、混合召回和超大知识库召回率验收。
- 未执行 staging 验证和生产迁移（用户已明确取消本次执行）。
- 未实现监护人 consent/儿童数据删除闭环（用户已明确取消本次执行）。
- Embedding 调用尚未写入用量账本，暂不能生成运行准入 Benchmark。
- L5 使用 PostgreSQL JSON 向量 + Node 余弦，不是 pgvector；候选上限 1,200、默认索引上限 12,000，真实规模召回率仍需评估。

## 7. 风险与边界

- **教学权威不变**：L1/L3/L5 只提供上下文或事实参考，不修改掌握状态、不替代评估证据；下一步活动仍由后端规则/Planner 决定。
- **隐私边界**：Redis 只保留有限课堂上下文；Mem0 只接收提取后的教学偏好；L5 只索引已发布、儿童安全的课程内容。
- **故障边界**：Redis/Mem0/Embedding 任一不可用都不阻断教学，但会降低上下文或语义召回能力，并回落到既有数据库/词法路径。
- **部署风险**：新后端代码依赖新增列和表，必须先完成迁移再启动新版本；不要把“迁移成功”表述为“staging 或生产已验证”。
- **索引风险**：L5 首次部署后必须手动重建；课程发布/下架后需要重新建立索引，否则仍可能命中旧块或空结果。

## 8. 建议提交信息

```text
feat(memory): add L1 Redis working memory, L3 Mem0 adapter and L5 curriculum RAG

- add bounded Redis lesson working memory with PostgreSQL fallback
- add Mem0 REST adapter with local audit back-reference validation
- add curriculum knowledge chunks with lexical/optional-embedding retrieval
- add admin status, reindex and search endpoints
- add migration, env examples and regression tests

Refs: docs/memory-architecture.md
```

本变更说明可直接作为提交说明或 PR 描述使用；提交前请确认 `apps/android/README.md` 的既有改动不属于本次提交范围。
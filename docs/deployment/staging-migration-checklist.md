# Staging 迁移检查清单

> 依据：`DECISIONS.md` **D-033**、任务书 v1.1 **18.5 staging 验证（上线前）**。  
> 用途：每次生产迁移前，在独立 staging 环境完成验证并归档证据。  
> 使用方式：复制本模板为 `staging-migration-YYYYMMDD-<release>.md`，随变更单保存；不要直接在模板上填写发布记录。

**硬性边界：**

- staging 必须与生产使用**同大版本 PostgreSQL**，不能以本地 PostgreSQL 18.6 的结果替代。
- staging 使用**独立 database 和独立 role**，不得复用生产库、生产账号或生产 schema。
- `migrate deploy` 前必须先完成可恢复的全量备份。
- **禁止执行 `npm run prisma:seed`、`m1-api.integration.test.ts` 及任何写测试。**
- 本清单只做迁移验证、只读检查；不把 staging 通过表述为生产已批准。

---

## 1. 发布信息

| 项目 | 填写 |
|---|---|
| 发布版本 / commit | |
| 后端镜像 tag / digest | |
| 变更单 / 工单号 | |
| 目标生产环境 | |
| Staging 环境 / 地址 | |
| 生产 PostgreSQL 版本 | |
| Staging PostgreSQL 版本 | |
| 计划执行时间（含时区） | |
| 执行人 | |
| 复核人 | |
| 迁移文件列表 | |

---

## 2. 版本与隔离检查

- [ ] 已记录生产与 staging 的 `version()`，两者 **PostgreSQL 大版本一致**：生产 `__________` / staging `__________`。
- [ ] 已核对扩展及版本一致：`SELECT extname, extversion FROM pg_extension;`，差异：`__________`。
- [ ] 已核对 encoding、collation、timezone 一致：`__________`。
- [ ] 已核对连接参数一致（`sslmode`、`schema`、连接池等）：`__________`。
- [ ] staging 使用独立 database：`current_database()` = `__________`。
- [ ] staging 使用独立 role：`current_user` = `__________`；该 role 无生产库权限。
- [ ] 未在脚本、日志、仓库或本记录中写入生产凭据。
- [ ] 已确认 staging 主机/库不是生产库（DNS、连接串或平台信息）：`__________`。

**版本结论：** ☐ 通过　☐ 不通过  
**证据位置：** `__________`

---

## 3. 迁移前备份与恢复验证

- [ ] 备份在 `migrate deploy` **之前**完成，时间是 `__________`。
- [ ] 备份为全量备份（schema + data），工具/版本：`__________`。
- [ ] 备份文件/对象路径：`__________`。
- [ ] 备份文件大小：`__________`；SHA-256：`__________`。
- [ ] 已实际恢复到独立临时库，恢复完成时间：`__________`。
- [ ] 恢复后关键表可查询，行数与备份前基线一致或差异已解释：`__________`。
- [ ] 已记录备份保留位置与保留期限：`__________`。
- [ ] 备份失败或恢复验证失败时，已停止迁移：☐ 是　☐ 不适用

**备份/恢复结论：** ☐ 通过　☐ 不通过  
**证据位置：** `__________`

---

## 4. 迁移执行与状态检查

执行前（以下命令以仓库根目录为例；容器内路径按部署环境调整）：

```powershell
$env:DATABASE_URL='postgresql://<staging_user>:<password>@<staging_host>:5432/<staging_db>?schema=public'
npx prisma migrate status --schema services/backend/prisma/schema.prisma
```

- [ ] 已保存执行前 `migrate status` 输出，确认待应用迁移列表：`__________`。
- [ ] 已确认没有失败的 migration，也没有需要手工干预的状态。

执行迁移（只允许 deploy）：

```powershell
npx prisma migrate deploy --schema services/backend/prisma/schema.prisma
```

- [ ] 只执行了 `npx prisma migrate deploy`（或仓库脚本 `npm run prisma:migrate`）。
- [ ] 未执行 `prisma migrate dev`、`prisma db push` 或其他会改写迁移历史的命令。
- [ ] 迁移命令退出码为 0，完整日志已保存：`__________`。
- [ ] 已保存执行后 `migrate status`，显示无 pending / failed：`__________`。
- [ ] 已核对目标表、列、索引、约束存在：`__________`。
- [ ] 已核对关键表行数在预期范围内：`__________`。
- [ ] 已执行只读场景基线校验 `npm run check:scenario-baseline`，输出 `OK：8/8，含 story_scene`：`__________`。
- [ ] 应用使用新镜像启动成功，启动日志无 schema/查询错误：`__________`。

**迁移结论：** ☐ 通过　☐ 不通过  
**证据位置：** `__________`

---

## 5. 只读健康检查

只执行只读请求和只读 SQL，不创建用户、学习者、会话、证据或学习记录。

- [ ] `GET /api/v1/health` 返回 HTTP 200：`__________`。
- [ ] 健康检查中的 `gatewayMode` 与本次 staging 配置一致：`__________`。
- [ ] 已执行关键只读查询（表存在性、行数、索引/约束）：`__________`。
- [ ] 已检查应用错误日志，无迁移相关异常：`__________`。
- [ ] 未调用 `/lessons/start`、`/lessons/{id}/turn`、`/lessons/{id}/finish` 等写接口。
- [ ] 未执行 `npm run prisma:seed`。
- [ ] 未执行 `m1-api.integration.test.ts`。
- [ ] 未执行其他会创建用户、学习者、会话、证据或学习记录的写测试。
- [ ] 已确认 staging 中没有 `ci-m1-*` 测试账号/学习者（只读查询）：`__________`。

**只读健康结论：** ☐ 通过　☐ 不通过  
**证据位置：** `__________`

---

## 6. 异常与回滚

- [ ] 本次无失败项。
- [ ] 如有失败项，已记录失败步骤、错误信息和影响范围：`__________`。
- [ ] 未手工修改 `_prisma_migrations`。
- [ ] 已明确恢复路径：☐ 恢复备份　☐ 前向修复　☐ 其他：`__________`。
- [ ] 已保留失败日志和恢复记录：`__________`。

**异常处理结论：** ☐ 通过　☐ 不通过　☐ 无异常

---

## 7. 发布评审结论

- [ ] 版本与隔离检查通过
- [ ] 备份与恢复验证通过
- [ ] `migrate deploy` 与迁移状态检查通过
- [ ] 只读健康检查通过
- [ ] 禁止项均未执行
- [ ] 证据已归档到变更单

**结论：** ☐ 允许进入生产变更评审　☐ 不允许（No-Go）

| 角色 | 姓名 | 签字 / 日期 |
|---|---|---|
| 执行人 | | |
| 复核人 | | |
| 发布负责人 | | |

> staging 通过只代表迁移和只读兼容性验证完成；生产执行仍需变更审批、维护窗口、备份和回滚方案。

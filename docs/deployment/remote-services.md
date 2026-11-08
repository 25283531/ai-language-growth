# 远程联调服务

本文档记录项目共用的远程 PostgreSQL、Redis 和后端联调环境。远程环境用于数据库/API 联调，不代表真实供应商、真实儿童样本、模型质量、真实账单或 1–2 秒延迟目标已经验收。

## 环境

- 服务器：`152.136.230.132`
- Compose 工作目录：`/opt/ai-language-growth/deploy/docker`
- PostgreSQL 容器：`alg-postgres`
- Redis 容器：`alg-redis`
- 后端容器：`alg-backend`
- PostgreSQL 对外端口：`5433`，容器内端口：`5432`
- Redis 对外端口：`6380`，容器内端口：`6379`
- 后端对外端口：`3100`，容器内端口：`3000`
- 数据卷：`docker_pgdata`、`docker_redisdata`

服务器用户名、密码、数据库密码和供应商密钥不得写入 GitHub、代码、日志或本文档。使用服务器上的 `deploy/docker/.env` 或受控的密钥注入方式；本地如需读取 SSH 凭据，从工作目录外的安全文件读取。

## 连接变量

服务器外部客户端使用：

```text
DATABASE_URL=postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@152.136.230.132:5433/<POSTGRES_DB>?schema=public
REDIS_URL=redis://152.136.230.132:6380
AI_GATEWAY_MODE=mock
```

后端容器通过 Compose 网络访问服务，使用：

```text
DATABASE_URL=postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>?schema=public
REDIS_URL=redis://redis:6379
AI_GATEWAY_MODE=mock
```

远程联调默认使用 `mock` 网关，不产生供应商调用费用。需要验证真实供应商时，必须单独配置对应的 `AI_GATEWAY_LIVE_SERVICES` 和 Provider 环境变量，并在结果中区分 Mock 与真实供应商。

## 重建数据服务

以下命令只删除并重建两个目标容器，保留数据卷；不会删除服务器上的其他容器或卷：

```bash
cd /opt/ai-language-growth/deploy/docker
docker compose rm -sf postgres redis
docker compose up -d --force-recreate postgres redis
docker compose ps
```

等待两个服务显示 `healthy` 后验证：

```bash
docker exec alg-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select current_database()"'
docker exec alg-redis redis-cli ping
```

不要使用 `docker compose down -v`，除非已经明确批准清空 `docker_pgdata` 和 `docker_redisdata`。

## 后端迁移和 seed

后端镜像把 Prisma schema 放在 `/app/services/backend/prisma/schema.prisma`，因此迁移必须显式指定 schema：

```bash
cd /opt/ai-language-growth/deploy/docker
docker compose run --rm backend \
  npx prisma migrate deploy \
  --schema /app/services/backend/prisma/schema.prisma

docker compose run --rm backend \
  /app/node_modules/.bin/tsx /app/services/backend/prisma/seed.ts

docker compose up -d --build backend
```

确认后端健康：

```bash
curl --fail http://127.0.0.1:3100/api/v1/health
docker compose ps
```

## API 冒烟顺序

使用临时测试用户和学习者（不要使用真实儿童数据），按以下顺序验证：

1. `GET /api/v1/health`
2. `POST /api/v1/speech/synthesize`，重复同一请求，确认第二次 `cached=true`
3. `POST /api/v1/lessons/start`
4. `POST /api/v1/lessons/{id}/turn`，`requestedRepeat=true`
5. `POST /api/v1/lessons/{id}/turn`，`requestedSlower=true`
6. `POST /api/v1/lessons/{id}/turn`，提交提问并重复相同 `idempotencyKey`
7. 对两次提问响应做 JSON 结构比较，不能只比较原始文本键顺序
8. `POST /api/v1/lessons/{id}/finish`
9. `GET /api/v1/learners/{id}/growth`，确认返回成长快照、记忆和待复习计划字段

额度闸门必须用临时学习者额外验证，不能使用真实儿童数据：

1. `GET /api/v1/speech/quota/status?learnerId=<temporary-learner>`，确认 ASR、TTS、pronunciation 各自有独立剩余量。
2. `POST /api/v1/speech/quota/reserve` 预留不超过剩余额度的 ASR 秒数，记录返回的 `reservationId`。
3. 使用 `X-Learner-Id` 和 `X-Speech-Quota-Reservation` 上传音频；缺少任一请求头、租约过期或额度不足时必须返回错误，服务端不得保存音频。
4. 对云端 TTS 播放先预留 `tts` 租约，再用同样两个请求头读取音频；租约无效时媒体下载必须被拒绝。
5. `POST /api/v1/speech/quota/settle` 按实际秒数结算，或在失败时调用 `release`；再次查询 status，确认 `consumedSeconds`、`reservedSeconds` 和 `remainingSeconds` 正确变化。
6. 将 `ASR_DAILY_QUOTA_SECONDS`、`TTS_DAILY_QUOTA_SECONDS` 临时设为较小值，连续预留直到返回 HTTP 429，确认客户端在预留失败时不发送音频请求。

2026 年 11 月 8 日已在该服务器完成一次验证：PostgreSQL/Redis 健康，后端 `b4d1bf3` 镜像健康，以上流程全部通过。该记录只证明远程联调链路可用。

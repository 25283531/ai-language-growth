# syntax=docker/dockerfile:1
#
# M1 后端镜像（多阶段构建）。
#
# 构建上下文由 deploy/docker/docker-compose.yml 指定：
#   build.context: ../..                       → 仓库根目录
#   build.dockerfile: deploy/docker/backend.Dockerfile
# 因此本文件内所有 COPY 路径都相对「仓库根目录」，不要写成相对 deploy/docker/。
#
# 遵守 D-024 约束二：镜像中不写入任何服务商或模型名称，全部由环境变量注入。

# ---------------- 构建阶段 ----------------
FROM node:20-alpine AS builder

WORKDIR /app

# Prisma 6 在 Alpine 上需要 openssl
RUN apk add --no-cache openssl

# 先复制依赖清单与源码（node_modules / dist / .env 由 .dockerignore 排除）
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps

# 含全部 workspaces 的干净安装
RUN npm ci

# prisma generate 只生成 Prisma Client，不连接数据库；占位连接串即可。
ENV DATABASE_URL="postgresql://ci_placeholder:ci_placeholder@127.0.0.1:5432/ci_placeholder?schema=public"
RUN cd services/backend && npx prisma generate

# 按依赖顺序构建：shared-contracts 先产出 dist，其余 workspace 才能通过
# node_modules 软链解析到 @alg/* 的类型声明。后端镜像不需要构建 apps/web。
RUN npm run build --workspace @alg/shared-contracts \
 && npm run build --workspace @alg/ai-provider-sdk \
 && npm run build --workspace @alg/curriculum \
 && npm run build --workspace @alg/model-router \
 && npm run build --workspace @alg/skill-graph \
 && npm run build --workspace @alg/backend

# ---------------- 运行阶段 ----------------
FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production \
    PORT=3100 \
    AI_GATEWAY_MODE=mock

# 只带运行所需：依赖树（含 @alg/* workspace 软链目标）、各包 dist、后端 dist。
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/backend/package.json ./services/backend/package.json
COPY --from=builder /app/services/backend/dist ./services/backend/dist
COPY --from=builder /app/services/backend/prisma ./services/backend/prisma

EXPOSE 3100

# 端口跟随 PORT 环境变量：独立 docker run 时用默认 3100，
# compose 覆盖为 PORT=3000 时依旧命中（宿主 3100 → 容器 3000）。
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3100) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "services/backend/dist/main.js"]

# syntax=docker/dockerfile:1
#
# 单容器应用镜像：backend + curriculum-generator + admin-web + web。
# 目的：把原来的 4 个应用容器收成 1 个，减少部署步骤；数据库与 Redis 仍独立。
# 端口：3000 backend、3001 admin-web、3002 web、3200 curriculum-generator。

FROM node:22-alpine AS builder

WORKDIR /app
RUN apk add --no-cache openssl postgresql16-client

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps

RUN npm ci

ENV DATABASE_URL="postgresql://ci_placeholder:ci_placeholder@127.0.0.1:5432/ci_placeholder?schema=public"
RUN cd services/backend && npx prisma generate

# 同容器内前端通过回环访问 backend，构建时固定，避免运行时 rewrite 目标漂移。
ENV BACKEND_INTERNAL_URL=http://127.0.0.1:3000
ENV NEXT_PUBLIC_API_BASE=/api/v1
ENV NEXT_PUBLIC_ENABLE_LESSON_START=false

RUN npm run build --workspace @alg/shared-contracts \
 && npm run build --workspace @alg/ai-provider-sdk \
 && npm run build --workspace @alg/curriculum \
 && npm run build --workspace @alg/model-router \
 && npm run build --workspace @alg/skill-graph \
 && npm run build --workspace @alg/backend \
 && npm run build --workspace @alg/curriculum-generator \
 && npm run build --workspace @alg/admin-web \
 && npm run build --workspace @alg/web

FROM node:22-alpine AS runtime

WORKDIR /app
RUN apk add --no-cache openssl postgresql16-client ffmpeg

ENV NODE_ENV=production \
    PORT=3000 \
    AI_GATEWAY_MODE=mock \
    BACKEND_INTERNAL_URL=http://127.0.0.1:3000 \
    CURRICULUM_GENERATOR_URL=http://127.0.0.1:3200 \
    CURRICULUM_PACKAGE_DIR=/app/data/packages

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services ./services
COPY --from=builder /app/apps ./apps
COPY deploy/docker/app-start.sh ./app-start.sh
RUN chmod +x ./app-start.sh

EXPOSE 3000 3001 3002 3200

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["./app-start.sh"]

FROM node:20-alpine
WORKDIR /workspace
COPY . .
RUN npm ci
ARG NEXT_PUBLIC_API_BASE=/api/v1
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
# 生产默认只读评估；仅受控联调镜像显式传入 true。
ARG NEXT_PUBLIC_ENABLE_LESSON_START=false
ENV NEXT_PUBLIC_ENABLE_LESSON_START=${NEXT_PUBLIC_ENABLE_LESSON_START}
ENV BACKEND_INTERNAL_URL=http://backend:3000
RUN npm run build --workspace @alg/web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@alg/web"]

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
RUN npm ci
RUN npm run build --workspace @alg/curriculum-generator

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3200 CURRICULUM_PACKAGE_DIR=/app/data/packages
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/services/curriculum-generator/package.json ./services/curriculum-generator/package.json
COPY --from=builder /app/services/curriculum-generator/dist ./services/curriculum-generator/dist
RUN mkdir -p /app/data/packages
EXPOSE 3200
HEALTHCHECK --interval=15s --timeout=5s --retries=10 CMD node -e "fetch('http://127.0.0.1:3200/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/curriculum-generator/dist/main.js"]

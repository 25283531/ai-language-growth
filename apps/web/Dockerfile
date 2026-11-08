FROM node:20-alpine
WORKDIR /workspace
COPY . .
RUN npm ci
ARG NEXT_PUBLIC_API_BASE=http://localhost:3100/api/v1
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
RUN npm run build --workspace @alg/web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@alg/web"]

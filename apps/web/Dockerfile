FROM node:20-alpine
WORKDIR /workspace
COPY . .
RUN npm ci
ARG NEXT_PUBLIC_API_BASE=/api/v1
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
ENV BACKEND_INTERNAL_URL=http://backend:3000
RUN npm run build --workspace @alg/web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@alg/web"]

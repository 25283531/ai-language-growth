FROM node:20-alpine
WORKDIR /workspace
COPY . .
RUN npm ci
RUN npm run build --workspace @alg/admin-web
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "@alg/admin-web"]

# deploy/docker

Docker Compose starts the NestJS backend, PostgreSQL, Redis, and the operator model settings page. Copy `.env.example`, replace the admin token and generate a 32-byte `MODEL_CONFIG_ENCRYPTION_KEY` before saving any provider credentials. Never commit the populated `.env` file.

- Management console: `http://localhost:3001`
- Backend API: `http://localhost:3100`

After the database is available, apply migrations with `docker compose exec backend npx prisma migrate deploy --schema=services/backend/prisma/schema.prisma`. The admin page can list presets without a token; reading or saving configurations requires `ADMIN_CONFIG_TOKEN`.

# deploy/docker

Docker Compose starts the NestJS backend, PostgreSQL, Redis, the operator console, and the user web application. Copy `.env.example`, replace the admin token and generate a 32-byte `MODEL_CONFIG_ENCRYPTION_KEY` before saving any provider credentials. Never commit the populated `.env` file.

- Management console: `http://localhost:3001`
- Backend API: `http://localhost:3100`
- User account and learning workbench: `http://localhost:3002`

After the database is available, apply migrations with `docker compose exec backend npx prisma migrate deploy --schema=services/backend/prisma/schema.prisma`. The admin page can list presets without a token; reading or saving configurations requires `ADMIN_CONFIG_TOKEN`.

For account registration and password recovery, configure `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`, and `PASSWORD_RESET_URL` in the server's private `.env`. Do not commit SMTP credentials. `MAIL_DISABLED=true` is for development only and logs reset links instead of sending mail. The admin membership page shows whether SMTP is ready.

Set `NEXT_PUBLIC_API_BASE` to the backend URL reachable from users' browsers (including `/api/v1`) before building the web container. For a domain deployment, use the public HTTPS API address; the default `localhost` value is only suitable for local Docker use.

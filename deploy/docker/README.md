# deploy/docker

Docker Compose starts the NestJS backend, PostgreSQL, Redis, the operator console, and the user web application. The application containers are pulled from private GHCR images; log in to `ghcr.io` on the deployment server with a read-only package token before running Compose. Copy `.env.example`, set a private `ADMIN_USERNAME` and strong `ADMIN_PASSWORD`, and generate a 32-byte `MODEL_CONFIG_ENCRYPTION_KEY` before saving any provider credentials. Never commit the populated `.env` file.

- Management console: `http://localhost:3001`
- User account and learning workbench: `http://localhost:3002`
- Backend API is internal to the Compose network; both pages proxy `/api/v1` to it.

The management console requires the administrator account configured in `.env`. It creates an eight-hour HttpOnly session cookie after login; management APIs reject requests without a valid session. After the database is available, apply migrations with `docker compose exec backend npx prisma migrate deploy --schema=services/backend/prisma/schema.prisma`.

For account registration and password recovery, open the admin site's “系统设置” page and save the SMTP server, account, password, sender, and password-reset URL. The password is encrypted in the database and is never returned by the API. `MAIL_DISABLED=true` remains a development-only switch that logs reset links instead of sending mail. The admin membership page shows whether SMTP is ready.

The Compose build uses the relative `/api/v1` path and the Next.js containers proxy it to the internal backend. For a domain deployment, put the user Web and admin console behind the public HTTPS reverse proxy. The Android prototype should use the user Web origin plus `/api/v1`; it should not connect directly to the internal backend port.

课程生成由独立私有镜像 `ghcr.io/25283531/curriculum-generator:latest` 提供，包含在同一 Compose 文件中且不对外映射端口。服务器需先使用有该私有包读取权限的 GitHub 凭据登录 GHCR；凭据只保存在服务器 Docker 凭据库中，不得写进 `.env`、Compose 文件或仓库。部署时设置 `.env` 中的 `CURRICULUM_GENERATOR_TOKEN`。生成、下载、导入流程见 [`docs/curriculum-generator.md`](../../docs/curriculum-generator.md)。

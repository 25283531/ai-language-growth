#!/bin/sh
# 单容器内同时运行 4 个进程；backend 是核心，退出即让容器重启。
set -u

export BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://127.0.0.1:3000}"
export CURRICULUM_GENERATOR_URL="${CURRICULUM_GENERATOR_URL:-http://127.0.0.1:3200}"
mkdir -p "${CURRICULUM_PACKAGE_DIR:-/app/data/packages}" /app/.cache

node services/backend/dist/main.js &
backend=$!

PORT=3200 node services/curriculum-generator/dist/main.js &
generator=$!

(cd apps/admin-web && PORT=3001 ../../node_modules/.bin/next start) &
admin=$!

(cd apps/web && PORT=3002 ../../node_modules/.bin/next start) &
web=$!

shutdown() {
  kill "$backend" "$generator" "$admin" "$web" 2>/dev/null
  wait 2>/dev/null
}
trap shutdown INT TERM

wait "$backend"
status=$?
shutdown
exit "$status"

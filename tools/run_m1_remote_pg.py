#!/usr/bin/env python3
"""Run the M1 API integration test against a remote Docker PostgreSQL.

The script creates a disposable database inside the configured PostgreSQL
container, applies Prisma migrations and the reviewed seed, starts a local mock
backend through an SSH tunnel, runs the selected tsx test file, and drops the
disposable database afterwards. Production tables are never used or modified.
Use ``--serve`` to keep the backend and admin console alive for manual browser
verification after the test; create the stop file to end the stack.

Prerequisites in this repository:
  npm ci
  npm run build

Credentials are never stored in this file. Provide an SSH key or a password via
``M1_REMOTE_PASSWORD`` (or ``--password-file``/``--password-env``).

Example:
  M1_REMOTE_PASSWORD=... python tools/run_m1_remote_pg.py \
    --host 152.136.230.132 --user root

On Windows PowerShell:
  $env:M1_REMOTE_PASSWORD = "..."
  python tools/run_m1_remote_pg.py --host 152.136.230.132 --user root
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import paramiko
except ImportError as exc:  # pragma: no cover - dependency setup
    raise SystemExit("缺少 paramiko：python -m pip install paramiko") from exc

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
DEFAULT_LOCAL_PORT = 15433
DEFAULT_API_PORT = 3100


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=os.environ.get("M1_REMOTE_HOST"), help="SSH host (or M1_REMOTE_HOST)")
    parser.add_argument("--user", default=os.environ.get("M1_REMOTE_USER", "root"), help="SSH user")
    parser.add_argument("--port", type=int, default=int(os.environ.get("M1_REMOTE_SSH_PORT", "22")))
    parser.add_argument("--identity-file", default=os.environ.get("M1_REMOTE_IDENTITY_FILE"),
                        help="SSH private key file; preferred over a password")
    parser.add_argument("--password-env", default="M1_REMOTE_PASSWORD",
                        help="environment variable containing the SSH password")
    parser.add_argument("--password-file", help="file containing the SSH password (first line)")
    parser.add_argument("--container", default=os.environ.get("M1_REMOTE_PG_CONTAINER", "alg-postgres"),
                        help="PostgreSQL Docker container name")
    parser.add_argument("--local-port", type=int, default=DEFAULT_LOCAL_PORT,
                        help="local tunnel port for PostgreSQL")
    parser.add_argument("--api-port", type=int, default=DEFAULT_API_PORT,
                        help="local mock backend port")
    parser.add_argument("--db-prefix", default="alg_ci_m1", help="disposable database prefix")
    parser.add_argument("--test-file", default="services/backend/test/m1-api.integration.test.ts",
                        help="tsx test file to run against the disposable stack")
    parser.add_argument("--serve", action="store_true",
                        help="keep backend/admin running after the test for manual browser verification")
    parser.add_argument("--serve-timeout", type=int, default=1800,
                        help="seconds to keep the manual verification stack alive")
    parser.add_argument("--admin-port", type=int, default=3001,
                        help="local admin console port in --serve mode")
    parser.add_argument("--state-file", default="tools/_p2_2e_serve.json",
                        help="where --serve writes non-secret stack metadata")
    parser.add_argument("--stop-file", default="tools/_p2_2e_stop",
                        help="create this file to stop --serve mode")
    parser.add_argument("--report", help="optional UTF-8 test report path")
    parser.add_argument("--keep-db", action="store_true", help="keep the disposable database for debugging")
    parser.add_argument("--migrate-timeout", type=int, default=300)
    parser.add_argument("--test-timeout", type=int, default=300)
    return parser


def resolve_password(args: argparse.Namespace) -> str | None:
    if args.password_file:
        return Path(args.password_file).read_text(encoding="utf-8").splitlines()[0].strip()
    value = os.environ.get(args.password_env) if args.password_env else None
    if value:
        return value
    if args.identity_file:
        return None
    raise SystemExit(
        "未提供 SSH 凭据：请使用 --identity-file，或设置 "
        f"{args.password_env or 'M1_REMOTE_PASSWORD'}，或使用 --password-file。"
    )


def ssh_client(args: argparse.Namespace, password: str | None) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict[str, object] = {
        "hostname": args.host,
        "port": args.port,
        "username": args.user,
        "timeout": 20,
        "banner_timeout": 20,
        "auth_timeout": 20,
    }
    if password is not None:
        kwargs["password"] = password
    if args.identity_file:
        kwargs["key_filename"] = args.identity_file
    client.connect(**kwargs)
    return client


def ssh_exec(client: paramiko.SSHClient, command: str, timeout: int = 300) -> tuple[int, str, str]:
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err


class PortForward:
    def __init__(self, client: paramiko.SSHClient, remote_host: str, remote_port: int, local_port: int):
        self.client = client
        self.remote_host = remote_host
        self.remote_port = remote_port
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", local_port))
        self.server.listen(32)
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._accept, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def _accept(self) -> None:
        while not self.stopped.is_set():
            try:
                client_sock, _ = self.server.accept()
            except OSError:
                break
            try:
                channel = self.client.get_transport().open_channel(
                    "direct-tcpip", (self.remote_host, self.remote_port), ("127.0.0.1", 0)
                )
            except Exception:
                client_sock.close()
                continue
            threading.Thread(target=self._pipe, args=(client_sock, channel), daemon=True).start()
            threading.Thread(target=self._pipe, args=(channel, client_sock), daemon=True).start()

    @staticmethod
    def _pipe(src, dst) -> None:
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except Exception:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except Exception:
                pass

    def close(self) -> None:
        self.stopped.set()
        try:
            self.server.close()
        except OSError:
            pass


def redact(text: str, password: str | None) -> str:
    if not password:
        return text
    for value in {password, urllib.parse.quote(password, safe="")}:
        if value:
            text = text.replace(value, "***")
    return text


def run_local(command: list[str], env: dict[str, str], timeout: int, password: str | None) -> tuple[int, str]:
    result = subprocess.run(
        command,
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    output = redact((result.stdout or "") + (result.stderr or ""), password)
    return result.returncode, output


def require_build() -> None:
    required = [
        REPO / "node_modules" / ".bin" / "tsx",
        REPO / "node_modules" / ".bin" / "prisma",
        REPO / "services" / "backend" / "dist" / "main.js",
        REPO / "packages" / "curriculum" / "dist" / "index.js",
        REPO / "packages" / "skill-graph" / "dist" / "index.js",
    ]
    missing = [str(path.relative_to(REPO)) for path in required if not path.exists()]
    if missing:
        raise SystemExit(
            "缺少构建产物："
            + ", ".join(missing)
            + "\n请先执行 `npm ci && npm run build`（或至少构建 backend/curriculum/skill-graph）。"
        )


def local_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not args.host:
        parser.error("必须提供 --host 或设置 M1_REMOTE_HOST")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.container):
        parser.error("--container 名称不合法")
    if not re.fullmatch(r"[A-Za-z0-9_]+", args.db_prefix):
        parser.error("--db-prefix 只允许字母、数字、下划线")
    if local_port_in_use(args.local_port):
        parser.error(f"本地端口 {args.local_port} 已被占用，请用 --local-port 指定其他端口")
    if local_port_in_use(args.api_port):
        parser.error(f"本地端口 {args.api_port} 已被占用，请用 --api-port 指定其他端口")
    if args.serve and local_port_in_use(args.admin_port):
        parser.error(f"本地端口 {args.admin_port} 已被占用，请用 --admin-port 指定其他端口")
    if args.serve and not (REPO / "apps/admin-web/.next").exists():
        parser.error("--serve 需要先构建 admin-web（npm run build --workspace @alg/admin-web）")
    require_build()

    server_password = resolve_password(args)
    client = ssh_client(args, server_password)
    db_name = f"{args.db_prefix}_{time.strftime('%Y%m%d_%H%M%S')}_{os.getpid()}"
    db_user = "alg"
    tunnel: PortForward | None = None
    backend: subprocess.Popen | None = None
    audio_dir = tempfile.mkdtemp(prefix="alg-m1-remote-audio-")
    db_created = False
    pg_password: str | None = None
    backend_log = Path(tempfile.gettempdir()) / f"{db_name}_backend.log"
    admin_log = Path(tempfile.gettempdir()) / f"{db_name}_admin.log"
    state_path = REPO / args.state_file
    stop_path = REPO / args.stop_file
    admin: subprocess.Popen | None = None
    try:
        code, out, err = ssh_exec(client, f"docker exec {args.container} printenv POSTGRES_USER")
        if code == 0 and out.strip():
            db_user = out.strip()
        if not re.fullmatch(r"[A-Za-z0-9_]+", db_user):
            raise RuntimeError("数据库用户名不合法")

        code, out, err = ssh_exec(
            client,
            f"docker inspect -f '{{{{range .NetworkSettings.Networks}}}}{{{{.IPAddress}}}}{{{{end}}}}' {args.container}",
        )
        if code != 0 or not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", out.strip()):
            raise RuntimeError(f"无法解析 PostgreSQL 容器地址：{err.strip()}")
        pg_host = out.strip()

        code, out, err = ssh_exec(client, f"docker exec {args.container} printenv POSTGRES_PASSWORD")
        if code != 0 or not out.strip():
            raise RuntimeError("无法从容器读取 PostgreSQL 密码")
        pg_password = out.strip()

        code, out, err = ssh_exec(
            client,
            f'docker exec {args.container} psql -U {db_user} -d postgres -v ON_ERROR_STOP=1 '
            f'-c \'CREATE DATABASE "{db_name}"\'',
            timeout=60,
        )
        if code != 0:
            raise RuntimeError(redact(f"创建测试库失败：{err or out}", pg_password))
        db_created = True

        tunnel = PortForward(client, pg_host, 5432, args.local_port)
        tunnel.start()
        time.sleep(0.5)

        db_url = (
            f"postgresql://{urllib.parse.quote(db_user, safe='')}:"
            f"{urllib.parse.quote(pg_password, safe='')}@127.0.0.1:{args.local_port}/{db_name}?schema=public"
        )
        base_env = os.environ.copy()
        for key in list(base_env):
            if key.startswith(("LLM_", "TTS_", "ASR_", "PRONUNCIATION_")):
                base_env.pop(key, None)
        base_env.update({
            "DATABASE_URL": db_url,
            "NODE_ENV": "development",
            "PORT": str(args.api_port),
            "AI_GATEWAY_MODE": "mock",
            "MAIL_DISABLED": "true",
            "ADMIN_USERNAME": "ci-admin",
            "ADMIN_PASSWORD": "ci-admin-only",
            "AI_AUDIO_DIR": audio_dir,
        })
        base_env.pop("QUEUE_REDIS_URL", None)
        base_env.pop("REDIS_URL", None)

        print(f"[1/5] 创建一次性测试库：{db_name}", flush=True)
        code, output = run_local(
            ["npx.cmd" if os.name == "nt" else "npx", "prisma", "migrate", "deploy",
             "--schema", "services/backend/prisma/schema.prisma"],
            base_env,
            args.migrate_timeout,
            pg_password,
        )
        if code != 0:
            print(output[-6000:], flush=True)
            raise RuntimeError("prisma migrate deploy 失败")
        migration_count = len([
            path for path in (REPO / "services/backend/prisma/migrations").iterdir()
            if path.is_dir() and (path / "migration.sql").exists()
        ])
        print(f"[2/5] 迁移完成（{migration_count} 个）", flush=True)

        code, output = run_local(
            ["npx.cmd" if os.name == "nt" else "npx", "tsx", "services/backend/prisma/seed.ts"],
            base_env,
            args.migrate_timeout,
            pg_password,
        )
        if code != 0:
            print(output[-6000:], flush=True)
            raise RuntimeError("seed 失败")
        print("[3/5] reviewed seed 完成", flush=True)

        with backend_log.open("w", encoding="utf-8", errors="replace") as log:
            backend = subprocess.Popen(
                ["node", "services/backend/dist/main.js"],
                cwd=REPO,
                env=base_env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        healthy = False
        for _ in range(60):
            if backend.poll() is not None:
                break
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{args.api_port}/api/v1/health", timeout=2
                ) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                    healthy = response.status == 200 and payload.get("status") == "ok"
                    if healthy:
                        break
            except Exception:
                pass
            time.sleep(1)
        if not healthy:
            tail = redact(backend_log.read_text(encoding="utf-8", errors="replace")[-6000:], pg_password)
            print(tail, flush=True)
            raise RuntimeError("mock 后端未能在 60 秒内健康启动")
        print(f"[4/5] 本地 mock 后端健康：:{args.api_port}", flush=True)

        if args.serve:
            stop_path.unlink(missing_ok=True)
            with admin_log.open("w", encoding="utf-8", errors="replace") as log:
                admin = subprocess.Popen(
                    ["node", str(REPO / "node_modules/next/dist/bin/next"),
                     "start", "-p", str(args.admin_port)],
                    cwd=REPO / "apps/admin-web",
                    env=base_env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
            admin_ready = False
            for _ in range(60):
                if admin.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{args.admin_port}/costs", timeout=2
                    ) as response:
                        admin_ready = response.status == 200
                        if admin_ready:
                            break
                except Exception:
                    pass
                time.sleep(1)
            if not admin_ready:
                tail = redact(admin_log.read_text(encoding="utf-8", errors="replace")[-6000:], pg_password)
                print(tail, flush=True)
                raise RuntimeError("admin-web 未能在 60 秒内启动")
            state_path.write_text(json.dumps({
                "dbName": db_name,
                "apiUrl": f"http://127.0.0.1:{args.api_port}/api/v1",
                "adminUrl": f"http://127.0.0.1:{args.admin_port}",
                "audioDir": audio_dir,
                "testFile": args.test_file,
                "keepFixtures": True,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[serve] 管理端健康：http://127.0.0.1:{args.admin_port}", flush=True)

        test_env = base_env.copy()
        test_env.update({
            "M1_API_URL": f"http://127.0.0.1:{args.api_port}/api/v1",
            "GITHUB_RUN_ID": f"server-pg-{db_name}",
            **({
                "P2_2E_DB_INTEGRATION": "1",
                "P2_2E_KEEP_FIXTURES": "1",
                "P2_2E_API_URL": f"http://127.0.0.1:{args.api_port}/api/v1",
            } if args.serve else {}),
        })
        code, output = run_local(
            ["npx.cmd" if os.name == "nt" else "npx", "tsx",
             "--tsconfig", "services/backend/tsconfig.json",
             "--test", args.test_file],
            test_env,
            args.test_timeout,
            pg_password,
        )
        print(output, flush=True)
        if args.report:
            report = Path(args.report)
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(output, encoding="utf-8")
            print(f"[report] {report}", flush=True)
        if code != 0:
            raise RuntimeError(f"{args.test_file} 失败，退出码 {code}")
        print(f"[5/5] {args.test_file} 通过", flush=True)

        if args.serve:
            print(
                f"[serve] 等待手动核对；创建 {stop_path} 停止，最多 {args.serve_timeout} 秒",
                flush=True,
            )
            deadline = time.time() + args.serve_timeout
            while time.time() < deadline and not stop_path.exists():
                if admin is not None and admin.poll() is not None:
                    raise RuntimeError("admin-web 意外退出")
                if backend.poll() is not None:
                    raise RuntimeError("mock 后端意外退出")
                time.sleep(1)
            print("[serve] 收到停止信号或达到超时", flush=True)
        return 0
    finally:
        if admin is not None and admin.poll() is None:
            admin.terminate()
            try:
                admin.wait(timeout=15)
            except subprocess.TimeoutExpired:
                admin.kill()
                admin.wait(timeout=10)
        if backend is not None and backend.poll() is None:
            backend.terminate()
            try:
                backend.wait(timeout=15)
            except subprocess.TimeoutExpired:
                backend.kill()
                backend.wait(timeout=10)
        if tunnel is not None:
            tunnel.close()
        try:
            state_path.unlink(missing_ok=True)
            stop_path.unlink(missing_ok=True)
        except OSError:
            pass
        shutil.rmtree(audio_dir, ignore_errors=True)
        if db_created and not args.keep_db:
            code, out, err = ssh_exec(
                client,
                f'docker exec {args.container} psql -U {db_user} -d postgres -v ON_ERROR_STOP=1 '
                f'-c \'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)\'',
                timeout=60,
            )
            if code == 0:
                print(f"[cleanup] 已删除一次性测试库：{db_name}", flush=True)
            else:
                print(f"[cleanup] 删除测试库失败：{redact(err or out, pg_password or server_password).strip()}", flush=True)
        for log_path in (backend_log, admin_log):
            try:
                log_path.unlink(missing_ok=True)
            except OSError:
                pass
        client.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"\n[FAILED] {exc}", flush=True)
        sys.exit(1)

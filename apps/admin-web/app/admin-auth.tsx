'use client';

import { FormEvent, useEffect, useState } from 'react';

/** 管理端请求错误：携带 HTTP 状态码，便于页面区分会话过期与普通失败。 */
export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AdminApiError';
  }
}

function responseMessage(body: unknown, status: number, path: string): string {
  // /auth/login 的 401 是「账号或密码不正确」，不能被误写成会话过期。
  if ((status === 401 || status === 403) && !path.startsWith('/auth/')) {
    return '管理登录已失效，请重新登录管理后台。';
  }
  if (body && typeof body === 'object' && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('；');
  }
  return `请求失败（${status}）`;
}

/**
 * 管理端统一请求封装：HttpOnly 会话 Cookie、禁用缓存、统一 !ok 错误处理与 401 识别。
 * 所有管理页面应通过 adminFetch 调用 /api/v1/admin/*，避免裸 fetch 漏带凭据或缓存旧配置。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/admin${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new AdminApiError(responseMessage(body, response.status, path), response.status);
  return body as T;
}

export function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

export function AdminAuthGate({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void request<{ username: string }>('/auth/me')
      .then((result) => {
        setUsername(result.username);
        setLoggedIn(true);
      })
      .catch(() => setLoggedIn(false))
      .finally(() => setChecked(true));
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const result = await request<{ username: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setUsername(result.username);
      setPassword('');
      setLoggedIn(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  if (!checked) return <main className="auth-shell"><section className="panel"><p className="muted">正在检查管理登录状态…</p></section></main>;
  if (!loggedIn) {
    return (
      <main className="auth-shell">
        <form className="panel auth-panel" onSubmit={(event) => void login(event)}>
          <p className="eyebrow">AI LANGUAGE GROWTH</p>
          <h1>管理后台登录</h1>
          <p className="muted">请输入部署时配置的管理员账号和密码。</p>
          <label>管理员账号<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>管理员密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button disabled={busy || !username || !password}>{busy ? '登录中…' : '登录'}</button>
          {message && <p className="status">{message}</p>}
        </form>
      </main>
    );
  }
  return <>{children}</>;
}

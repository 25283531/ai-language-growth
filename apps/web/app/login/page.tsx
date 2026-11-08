'use client';

import Link from 'next/link';
import { useState } from 'react';
import { authRequest, saveAuth, type AuthUser } from '../auth-api';
import { AccountShell } from '../account-shell';

export default function LoginPage() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setMessage(''); try { const result = await authRequest<{ accessToken: string; user: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); saveAuth(result); window.location.href = '/account'; } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  return <AccountShell title="登录" subtitle="使用注册邮箱和密码登录。"><form className="account-form" onSubmit={submit}><label>邮箱<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label><label>密码<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label><button className="account-button" disabled={busy}>{busy ? '登录中…' : '登录'}</button>{message && <p className="account-error">{message}</p>}<div className="account-links"><Link href="/forgot-password">忘记密码</Link><Link href="/register">注册新账户</Link></div></form></AccountShell>;
}

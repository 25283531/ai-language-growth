'use client';

import Link from 'next/link';
import { useState } from 'react';
import { authRequest, saveAuth, type AuthUser } from '../auth-api';
import { AccountShell } from '../account-shell';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await authRequest<{ accessToken: string; user: AuthUser }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });
      saveAuth(result); window.location.href = '/account';
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <AccountShell title="注册账户" subtitle="邮箱作为登录名，注册后自动开通免费会员。"><form className="account-form" onSubmit={submit}><label>邮箱<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label><label>显示名称（可选）<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label><label>密码<input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /><small>至少 8 位；不接受连续数字、重复字符等最简单密码。</small></label><button className="account-button" disabled={busy}>{busy ? '提交中…' : '注册并进入账户'}</button>{message && <p className="account-error">{message}</p>}<p className="account-muted">已有账户？<Link href="/login">登录</Link></p></form></AccountShell>;
}

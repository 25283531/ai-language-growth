'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { authRequest } from '../auth-api';
import { AccountShell } from '../account-shell';

export default function ResetPasswordPage() {
  return <Suspense fallback={<AccountShell title="重置密码"><p>正在打开重置页面…</p></AccountShell>}><ResetPasswordForm /></Suspense>;
}

function ResetPasswordForm() {
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setResetToken(new URLSearchParams(window.location.search).get('token') ?? ''); }, []);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); try { const result = await authRequest<{ message: string }>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, newPassword: password }) }); setMessage(result.message); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  return <AccountShell title="重置密码" subtitle="设置一个至少 6 位且不简单的密码。"><form className="account-form" onSubmit={submit}><label>新密码<input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label><button className="account-button" disabled={busy || !resetToken}>{busy ? '保存中…' : '保存新密码'}</button>{message && <p className="account-success">{message}</p>}<p className="account-muted"><Link href="/login">返回登录</Link></p></form></AccountShell>;
}

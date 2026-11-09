'use client';

import Link from 'next/link';
import { useState } from 'react';
import { authRequest } from '../auth-api';
import { AccountShell } from '../account-shell';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); try { const result = await authRequest<{ message: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }); setMessage(result.message); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); } }
  return <AccountShell title="找回密码" subtitle="只有完成邮箱验证的账户才能找回密码。"><form className="account-form" onSubmit={submit}><label>注册邮箱<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><button className="account-button" disabled={busy}>{busy ? '发送中…' : '发送重置邮件'}</button>{message && <p className="account-success">{message}</p>}<p className="account-muted"><Link href="/login">返回登录</Link></p></form></AccountShell>;
}

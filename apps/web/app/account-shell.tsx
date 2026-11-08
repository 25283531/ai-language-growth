'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { authRequest, clearAuth, type AuthUser } from './auth-api';

export function AccountNav() {
  return <nav className="account-nav"><Link href="/">教学实验台</Link><Link href="/account">账户中心</Link><Link href="/login">登录</Link><Link href="/register">注册</Link></nav>;
}

export function AccountShell({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle?: string }) {
  return <main className="account-page"><AccountNav /><header><h1>{title}</h1>{subtitle && <p className="account-subtitle">{subtitle}</p>}</header>{children}</main>;
}

export function CurrentUser({ onUser }: { onUser?: (user: AuthUser) => void }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void authRequest<{ user: AuthUser }>('/auth/me').then((result) => {
      setUser(result.user);
      onUser?.(result.user);
    }).catch((e) => setError(e.message));
  }, [onUser]);
  if (error) return <p className="account-error">{error}，请先登录。</p>;
  if (!user) return <p className="account-muted">正在读取账户…</p>;
  return <div className="account-user"><b>{user.displayName}</b><span>{user.email}</span><span>当前等级：{user.membershipTier}</span><button className="account-button secondary" onClick={() => { clearAuth(); window.location.href = '/login'; }}>退出登录</button></div>;
}

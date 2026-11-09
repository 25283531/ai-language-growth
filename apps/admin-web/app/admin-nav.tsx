'use client';

import Link from 'next/link';
import { adminFetch } from './admin-auth';

export function AdminNav() {
  async function logout() {
    await adminFetch('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return <nav className="admin-nav">
    <Link href="/">后台首页</Link><Link href="/providers">模型接入</Link><Link href="/curriculum">课程管理</Link><Link href="/learning">学习与记忆</Link><Link href="/routing">任务路由</Link><Link href="/membership">会员管理</Link><Link href="/settings">系统设置</Link><Link href="/backups">备份还原</Link>
    <button className="secondary" type="button" onClick={() => void logout()}>退出登录</button>
  </nav>;
}

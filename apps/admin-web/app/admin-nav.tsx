'use client';

import Link from 'next/link';

export function AdminNav() {
  return <nav className="admin-nav">
    <Link href="/">后台首页</Link><Link href="/providers">模型接入</Link><Link href="/curriculum">课程管理</Link><Link href="/learning">学习与记忆</Link><Link href="/routing">任务路由</Link><Link href="/membership">会员管理</Link>
  </nav>;
}

import Link from 'next/link';

import { AdminNav } from './admin-nav';

export default function AdminHomePage() {
  return (
    <main className="shell">
      <AdminNav />
      <header className="topbar">
        <div>
          <p className="eyebrow">AI LANGUAGE GROWTH</p>
          <h1>后台管理</h1>
          <p className="muted">按业务大类进入独立页面，避免模型、学习和会员配置混在一起。</p>
        </div>
      </header>
      <section className="admin-grid">
        <Link className="admin-card" href="/providers"><strong>模型接入</strong><span>LLM、ASR、TTS 和发音评测</span></Link>
        <Link className="admin-card" href="/costs"><strong>成本与缓存</strong><span>账本用量、TTS 命中率与清理状态</span></Link>
        <Link className="admin-card" href="/learning"><strong>学习与记忆</strong><span>教师风格和长期记忆</span></Link>
        <Link className="admin-card" href="/routing"><strong>任务路由</strong><span>主备模型、并发和预算</span></Link>
        <Link className="admin-card" href="/membership"><strong>会员管理</strong><span>会员等级和语音额度</span></Link>
        <Link className="admin-card" href="/settings"><strong>系统设置</strong><span>SMTP 邮件服务</span></Link>
        <Link className="admin-card" href="/backups"><strong>备份还原</strong><span>定时备份、WebDAV 与数据库恢复</span></Link>
      </section>
    </main>
  );
}

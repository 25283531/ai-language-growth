'use client';

import { useState } from 'react';
import { AdminNav } from '../admin-nav';

type Settings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  replyTo: string;
  resetUrl: string;
  passwordConfigured: boolean;
};

function apiRoot() {
  return typeof window === 'undefined' ? '' : `${window.location.protocol}//${window.location.host}`;
}

export default function SettingsPage() {
  const [token, setToken] = useState('');
  const [settings, setSettings] = useState<Settings>({
    host: '', port: 587, secure: false, user: '', from: '', replyTo: '',
    resetUrl: `${typeof window === 'undefined' ? 'http://localhost:3002' : window.location.origin}/reset-password`,
    passwordConfigured: false,
  });
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    const response = await fetch(`${apiRoot()}/api/v1/admin/email/status`, {
      headers: { 'x-admin-token': token },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? '读取邮件配置失败');
    if (body.settings) setSettings(body.settings);
    setMessage(body.configured ? '邮件发送已就绪' : '请完成 SMTP 设置');
  }

  async function save() {
    const response = await fetch(`${apiRoot()}/api/v1/admin/email/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ ...settings, password: password || undefined }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? '保存失败');
    setSettings(body);
    setPassword('');
    setMessage('SMTP 配置已保存');
  }

  async function verify() {
    const response = await fetch(`${apiRoot()}/api/v1/admin/email/test`, {
      method: 'POST',
      headers: { 'x-admin-token': token },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? 'SMTP 连接验证失败');
    setMessage('SMTP 连接验证成功');
  }

  return <main className="shell">
    <AdminNav />
    <header className="topbar"><div><p className="eyebrow">SYSTEM SETTINGS</p><h1>系统设置</h1><p className="muted">邮箱凭据加密保存在数据库中，随数据库备份迁移。</p></div></header>
    <section className="panel">
      <label>后台管理令牌<input type="password" value={token} onChange={(event) => setToken(event.target.value)} /></label>
      <button className="secondary" disabled={!token} onClick={() => void load().catch((error) => setMessage(error.message))}>读取当前设置</button>
      <div className="fields">
        <label>SMTP 服务器<input value={settings.host} onChange={(event) => setSettings({ ...settings, host: event.target.value })} /></label>
        <label>端口<input type="number" min="1" max="65535" value={settings.port} onChange={(event) => setSettings({ ...settings, port: Number(event.target.value) })} /></label>
        <label>邮箱账号<input value={settings.user} onChange={(event) => setSettings({ ...settings, user: event.target.value })} /></label>
        <label>发件人地址<input value={settings.from} onChange={(event) => setSettings({ ...settings, from: event.target.value })} /></label>
        <label>回复地址<input value={settings.replyTo} onChange={(event) => setSettings({ ...settings, replyTo: event.target.value })} /></label>
        <label>密码<input type="password" autoComplete="new-password" placeholder={settings.passwordConfigured ? '已保存，留空则保持不变' : '输入 SMTP 密码'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>找回密码页面地址<input type="url" value={settings.resetUrl} onChange={(event) => setSettings({ ...settings, resetUrl: event.target.value })} /></label>
        <label className="switch"><input type="checkbox" checked={settings.secure} onChange={(event) => setSettings({ ...settings, secure: event.target.checked })} /><span>连接时启用 TLS</span></label>
      </div>
      <div className="row-actions"><button disabled={!token} onClick={() => void save().catch((error) => setMessage(error.message))}>保存配置</button><button className="secondary" disabled={!token} onClick={() => void verify().catch((error) => setMessage(error.message))}>测试连接</button></div>
      <p className="status">{message}</p>
    </section>
  </main>;
}

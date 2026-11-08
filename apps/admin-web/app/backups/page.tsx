'use client';

import { useState } from 'react';
import { AdminNav } from '../admin-nav';

type BackupSettings = {
  enabled: boolean;
  intervalHours: number;
  retention: number;
  target: 'local' | 'webdav';
  webdavUrl: string;
  webdavUser: string;
  webdavPath: string;
  passwordConfigured: boolean;
};
type BackupFile = { name: string; bytes: number; createdAt: string };

function apiRoot() {
  return typeof window === 'undefined' ? '' : `${window.location.protocol}//${window.location.host}`;
}

export default function BackupsPage() {
  const [token, setToken] = useState('');
  const [settings, setSettings] = useState<BackupSettings>({
    enabled: false, intervalHours: 24, retention: 7, target: 'local',
    webdavUrl: '', webdavUser: '', webdavPath: '/ai-language-growth', passwordConfigured: false,
  });
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(`${apiRoot()}/api/v1/admin/backups/${path}`, {
      ...init,
      headers: { 'x-admin-token': token, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message ?? `操作失败 (${response.status})`);
    }
    return response;
  }

  async function load() {
    const [configResponse, filesResponse] = await Promise.all([
      request('settings'), request('local'),
    ]);
    setSettings(await configResponse.json());
    setFiles(await filesResponse.json());
  }

  async function save() {
    const response = await request('settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...settings, webdavPassword: password || undefined }),
    });
    setSettings(await response.json());
    setPassword('');
    setMessage('备份设置已保存');
  }

  async function create() {
    setBusy(true);
    try {
      const response = await request('create', { method: 'POST' });
      const result = await response.json();
      setMessage(`备份完成：${result.name}，${result.target === 'webdav' ? '已上传 WebDAV' : '已保存在服务器'}`);
      await load();
    } finally { setBusy(false); }
  }

  async function download(name: string) {
    const response = await request(`local/${encodeURIComponent(name)}`);
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function restore() {
    if (!file) return;
    if (!window.confirm('还原会替换当前数据库内容。服务端会先自动备份当前数据库，确认继续吗？')) return;
    setBusy(true);
    try {
      await request('restore', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-restore-confirm': 'RESTORE' },
        body: file,
      });
      setMessage('数据库还原完成，请重新载入后台页面');
    } finally { setBusy(false); }
  }

  return <main className="shell">
    <AdminNav />
    <header className="topbar"><div><p className="eyebrow">BACKUP & RESTORE</p><h1>备份与还原</h1><p className="muted">备份包含数据库中的账户、配置、课程及学习记录，不包含音频缓存。</p></div></header>
    <section className="panel">
      <label>后台管理令牌<input type="password" value={token} onChange={(event) => setToken(event.target.value)} /></label>
      <button className="secondary" disabled={!token} onClick={() => void load().catch((error) => setMessage(error.message))}>读取备份设置</button>
      <div className="fields">
        <label>备份目标<select value={settings.target} onChange={(event) => setSettings({ ...settings, target: event.target.value as BackupSettings['target'] })}><option value="local">服务器本地</option><option value="webdav">WebDAV / OpenList</option></select></label>
        <label>保留最近份数<input type="number" min="1" max="100" value={settings.retention} onChange={(event) => setSettings({ ...settings, retention: Number(event.target.value) })} /></label>
        <label className="switch"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /><span>启用定时备份</span></label>
        <label>备份间隔（小时）<input type="number" min="1" max="168" value={settings.intervalHours} onChange={(event) => setSettings({ ...settings, intervalHours: Number(event.target.value) })} /></label>
      </div>
      {settings.target === 'webdav' && <div className="fields">
        <label>WebDAV 地址<input type="url" placeholder="https://example.com/dav" value={settings.webdavUrl} onChange={(event) => setSettings({ ...settings, webdavUrl: event.target.value })} /></label>
        <label>远端目录<input value={settings.webdavPath} onChange={(event) => setSettings({ ...settings, webdavPath: event.target.value })} /></label>
        <label>WebDAV 用户名<input value={settings.webdavUser} onChange={(event) => setSettings({ ...settings, webdavUser: event.target.value })} /></label>
        <label>WebDAV 密码<input type="password" autoComplete="new-password" placeholder={settings.passwordConfigured ? '已保存，留空则保持不变' : '输入密码'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      </div>}
      <p className="helper">百度网盘和阿里云盘可通过 OpenList 挂载后，填写 OpenList 提供的 WebDAV 地址。</p>
      <div className="row-actions"><button disabled={!token || busy} onClick={() => void save().catch((error) => setMessage(error.message))}>保存设置</button><button className="secondary" disabled={!token || busy} onClick={() => void create().catch((error) => setMessage(error.message))}>立即备份</button><button className="secondary" disabled={!token} onClick={() => void load().catch((error) => setMessage(error.message))}>刷新列表</button></div>
      <p className="status">{message}</p>
    </section>
    <section className="panel"><h2>服务器备份</h2>{files.length ? files.map((item) => <div className="helper" key={item.name}>{item.name} · {(item.bytes / 1024 / 1024).toFixed(1)} MB · {new Date(item.createdAt).toLocaleString()} <button className="secondary" onClick={() => void download(item.name).catch((error) => setMessage(error.message))}>下载</button></div>) : <p className="status">暂无本地备份。</p>}</section>
    <section className="panel"><h2>从备份文件还原</h2><label>项目备份压缩包<input type="file" accept=".zip,application/zip,application/octet-stream" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><button disabled={!token || !file || busy} onClick={() => void restore().catch((error) => setMessage(error.message))}>导入并还原</button></section>
  </main>;
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminNav } from '../admin-nav';
import { AdminApiError, adminFetch } from '../admin-auth';

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
type Tone = 'info' | 'success' | 'error';
type LoadState = 'loading' | 'ready' | 'error';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    host: '', port: 587, secure: false, user: '', from: '', replyTo: '',
    resetUrl: `${typeof window === 'undefined' ? 'http://localhost:3002' : window.location.origin}/reset-password`,
    passwordConfigured: false,
  });
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<Tone>('info');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  // 卸载后不再 setState；并发请求只认最后一次（防止旧的响应覆盖新数据）。
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const sessionExpiredRef = useRef(false);

  function notify(text: string, nextTone: Tone = 'info') {
    setMessage(text);
    setTone(nextTone);
    if (text.includes('登录已失效')) {
      sessionExpiredRef.current = true;
      setSessionExpired(true);
    }
  }

  /**
   * 页面挂载即自动读取已保存设置。AdminAuthGate 只在 /auth/me 确认登录后
   * 才挂载本组件，所以「进入页面」和「登录完成」两种情况都会走这里，
   * 不需要用户再点一次「加载」。手动刷新按钮仍然保留。
   */
  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    if (mountedRef.current) setLoadState('loading');
    try {
      const body = await adminFetch<{ configured?: boolean; settings?: Partial<Settings> }>('/email/status');
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      const payload = body;
      if (payload.settings) setSettings((old) => ({ ...old, ...payload.settings }));
      sessionExpiredRef.current = false;
      setSessionExpired(false);
      setLoadState('ready');
      setMessage(payload.configured
        ? '已自动读取保存的邮件配置：发送服务已就绪。'
        : '已自动读取保存的邮件配置：尚未完成 SMTP 设置，请填写并保存。');
      setTone(payload.configured ? 'success' : 'info');
    } catch (error) {
      if (!mountedRef.current || seq !== requestSeqRef.current) return;
      const text = error instanceof Error ? error.message : '读取邮件配置失败';
      const expired = error instanceof AdminApiError
        ? error.status === 401 || error.status === 403
        : text.includes('登录已失效');
      sessionExpiredRef.current = expired;
      setSessionExpired(expired);
      setLoadState('error');
      setMessage(text);
      setTone('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => { void load(); }, []);

  // 会话过期后，管理员在其它标签页重新登录或切回本页时自动重试，无需手动点「加载」。
  useEffect(() => {
    const retryAfterReauth = () => {
      if (document.visibilityState !== 'hidden' && sessionExpiredRef.current) void load();
    };
    window.addEventListener('focus', retryAfterReauth);
    document.addEventListener('visibilitychange', retryAfterReauth);
    return () => {
      window.removeEventListener('focus', retryAfterReauth);
      document.removeEventListener('visibilitychange', retryAfterReauth);
    };
  }, [load]);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const body = await adminFetch<Partial<Settings>>('/email/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...settings, password: password || undefined }),
      });
      setSettings((old) => ({ ...old, ...body }));
      setPassword('');
      notify('SMTP 配置已保存', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    setBusy(true);
    try {
      await adminFetch<unknown>('/email/test', { method: 'POST' });
      notify('SMTP 连接验证成功', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'SMTP 连接验证失败', 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const hasSavedSettings = Boolean(settings.host || settings.user || settings.passwordConfigured);

  return <main className="shell">
    <AdminNav />
    <header className="topbar">
      <div><p className="eyebrow">SYSTEM SETTINGS</p><h1>系统设置</h1><p className="muted">邮箱凭据加密保存在数据库中，随数据库备份迁移。进入页面会自动读取已保存的设置。</p></div>
      <button className="secondary" type="button" disabled={busy || loadState === 'loading'} onClick={() => void load()}>
        {loadState === 'loading' ? '读取中…' : '重新读取设置'}
      </button>
    </header>
    {sessionExpired && loadState === 'ready' && <div className="feedback error" role="alert">管理登录已失效，请重新登录后再保存或测试。<button className="secondary" type="button" onClick={() => window.location.reload()}>重新登录</button></div>}
    {loadState !== 'ready' ? <section className="panel">
      <p className={`status ${loadState === 'error' ? 'error' : ''}`}>
        {loadState === 'loading' ? '正在读取已保存的邮件设置…' : (message || '读取邮件配置失败')}
      </p>
      {loadState === 'error' && <div className="row-actions" style={{ marginTop: 14 }}>
        <button className="secondary" type="button" onClick={() => void load()}>重试读取</button>
        {sessionExpired && <button type="button" onClick={() => window.location.reload()}>重新登录</button>}
      </div>}
    </section> : <section className="panel">
      {!hasSavedSettings && <p className="helper">尚未保存过 SMTP 配置；填写下方信息后点击「保存配置」即可创建。凭据留空表示保留已保存值。</p>}
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
      <div className="row-actions" style={{ marginTop: 14 }}>
        <button type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存配置'}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => void verify()}>测试连接</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => void load()}>刷新设置</button>
      </div>
      <p className={`status ${tone}`}>{message}</p>
    </section>}
  </main>;
}

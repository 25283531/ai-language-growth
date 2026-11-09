'use client';

import { useEffect, useState } from 'react';
import { AccountShell, CurrentUser } from '../account-shell';
import { authRequest } from '../auth-api';

type Membership = { membershipTier: string; requests: Array<{ id: string; requestedTier: string; status: string; createdAt: string }>; learners: Array<{ id: string; displayName: string; membershipTier: string }> };

export default function AccountPage() {
  const [data, setData] = useState<Membership | null>(null); const [message, setMessage] = useState('');
  const [user, setUser] = useState<{ email: string; emailVerifiedAt: string | null } | null>(null);
  const [code, setCode] = useState('');
  async function load() { try { setData(await authRequest<Membership>('/membership/me')); } catch (e) { setMessage((e as Error).message); } }
  useEffect(() => { void load(); void authRequest<{ user: typeof user }>('/auth/me').then((result) => setUser(result.user)); }, []);
  async function requestMember() { try { await authRequest('/membership/requests', { method: 'POST', body: JSON.stringify({ tier: 'member' }) }); setMessage('会员开通申请已提交，请等待后台处理。'); await load(); } catch (e) { setMessage((e as Error).message); } }
  async function sendVerification() { try { const result = await authRequest<{ message: string }>('/auth/email-verification', { method: 'POST' }); setMessage(result.message); } catch (e) { setMessage((e as Error).message); } }
  async function verify() { try { await authRequest('/auth/verify-email', { method: 'POST', body: JSON.stringify({ code }) }); setUser((current) => current ? { ...current, emailVerifiedAt: new Date().toISOString() } : current); setMessage('邮箱验证完成。'); } catch (e) { setMessage((e as Error).message); } }
  return <AccountShell title="账户中心" subtitle="查看会员等级、学习者档案和会员开通申请。"><CurrentUser /><section className="account-panel"><h2>邮箱验证</h2><p>{user?.email ?? '读取中…'} · {user?.emailVerifiedAt ? '已验证' : '未验证'}</p>{!user?.emailVerifiedAt && <><button className="account-button secondary" onClick={() => void sendVerification()}>发送验证码</button><input value={code} maxLength={6} inputMode="numeric" placeholder="6 位验证码" onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /><button className="account-button" disabled={code.length !== 6} onClick={() => void verify()}>确认验证</button><p className="account-muted">只有验证邮箱后才能使用找回密码功能。</p></>}</section><section className="account-panel"><h2>会员</h2><p>当前等级：<b>{data?.membershipTier ?? '读取中…'}</b></p><button className="account-button" onClick={() => void requestMember()} disabled={data?.membershipTier === 'member' || data?.membershipTier === 'advanced'}>申请开通会员</button>{data?.requests.map((item) => <p className="account-muted" key={item.id}>申请 {item.requestedTier}：{item.status}</p>)}</section><section className="account-panel"><h2>学习者</h2>{data?.learners.map((learner) => <p key={learner.id}>{learner.displayName} · {learner.membershipTier}</p>)}</section>{message && <p className="account-success">{message}</p>}</AccountShell>;
}

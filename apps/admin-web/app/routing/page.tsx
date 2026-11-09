'use client';

import { useEffect, useState } from 'react';
import { AdminNav } from '../admin-nav';

function apiRoot() { return ''; }

export default function RoutingPage() {
  const [value, setValue] = useState(''); const [message, setMessage] = useState('');
  async function load() { const response = await fetch(`${apiRoot()}/api/v1/admin/model-routing`); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? `读取失败 (${response.status})`); setValue(JSON.stringify(body, null, 2)); }
  async function save() { const response = await fetch(`${apiRoot()}/api/v1/admin/model-routing`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: value }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? `保存失败 (${response.status})`); setValue(JSON.stringify(body, null, 2)); setMessage('路由规则已保存并立即生效'); }
  useEffect(() => { void load().catch((e) => setMessage(e.message)); }, []);
  return <main className="shell"><AdminNav /><header className="topbar"><div><p className="eyebrow">ROUTING</p><h1>任务路由</h1><p className="muted">模型等级、备选链、并发和每日预算集中在此页面。</p></div><button className="secondary" onClick={() => void load().catch((e) => setMessage(e.message))}>刷新</button></header><section className="panel"><div className="fields"><button onClick={() => void load().catch((e) => setMessage(e.message))}>读取规则</button><button disabled={!value} onClick={() => void save().catch((e) => setMessage(e.message))}>保存规则</button></div><textarea className="routing-editor" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} /><p className="status">{message}</p></section></main>;
}

// 开发者侧：生成 / 收回客户确认链接，看客户提交了什么，再按这份生成新版本
import { useState } from 'react'
import { Ic } from '../SketchIcon'
import { customNodes, plansOf, scopeConflicts, scopeView } from '../../shared/order-judge-scope'
import type { Project, Version } from '../../shared/order-judge-api'
import { FlowPreview } from './FlowPreview'
import { JudgeError, applyScope, createScope, logClient, pickPlan, revokeScope } from './api'

// 需求阶段：先看 AI 给的几个方向，发客户确认，或自己直接选一个进估价
export function PlanList({ project, latest, onSaved }: { project: Project; latest: Version; onSaved: (p: Project) => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const b = latest.brief
  const title = new Map(b.items.map(i => [i.id, i.title]))
  const pick = async (id: string): Promise<void> => {
    setBusy(true); setError('')
    try { onSaved(await pickPlan(project.id, id)) }
    catch (e) { logClient('order-judge:plan-pick', e); setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return (
    <div className="oj-sec">
      <h3><Ic name="doc" />需求方案</h3>
      <div className="oj-devplans">
        {plansOf(b).map(p => (
          <div key={p.id} className="oj-devplan">
            <b>{p.name}{p.recommended && <em>推荐</em>}</b>
            <span>{p.summary}</span>
            {p.fit && <span>{p.fit}</span>}
            <small>{p.itemIds.map(id => title.get(id)).filter(Boolean).join('、')}</small>
            {p.blocks?.length ? <small>不能同时要：{p.blocks.map(id => title.get(id)).filter(Boolean).join('、')}</small> : null}
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void pick(p.id)}>选这个去估价</button>
          </div>
        ))}
      </div>
      {error && <p className="oj-scope-warn" role="alert">{error}</p>}
    </div>
  )
}

export function ScopePanel({ project, latest, onSaved }: { project: Project; latest: Version; onSaved: (p: Project) => void }): JSX.Element {
  const link = project.scope
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [revoking, setRevoking] = useState(false)
  const stale = !!link && link.versionId !== latest.id
  const expired = !!link && Date.now() > link.expiresAt
  const base = link ? project.versions.find(v => v.id === link.versionId) : undefined
  const url = link ? `${window.location.origin}/#/scope/${link.token}` : ''

  const run = async (tag: string, action: () => Promise<Project>): Promise<void> => {
    setBusy(true); setNote(null)
    try { onSaved(await action()) }
    catch (e) {
      logClient(`order-judge:${tag}`, e)
      setNote({ ok: false, text: e instanceof JudgeError ? `${e.message}（${e.code}）` : e instanceof Error ? e.message : String(e) })
    } finally { setBusy(false); setRevoking(false) }
  }
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(url); setNote({ ok: true, text: '已复制' }) }
    catch (e) { logClient('order-judge:copy', e); setNote({ ok: false, text: '复制失败，请手动选中链接复制' }) }
  }

  const sub = link?.submission
  const items = base && sub ? scopeView(base.brief, link!).items : []
  const nodes = sub ? [...items, ...customNodes(sub.custom)] : []
  const picked = new Set(sub ? [...sub.picked, ...sub.custom.map(c => c.id)] : [])
  const conflicts = sub ? scopeConflicts(nodes, picked) : []
  const planName = sub && base ? scopeView(base.brief, link!).plans.find(p => p.id === sub.planId)?.name : ''

  return (
    <div className="oj-sec oj-scope-panel">
      <h3><Ic name="paste" />客户确认</h3>
      {!link ? (
        <div className="oj-qbtns">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run('scope-create', () => createScope(project.id))}>生成链接</button>
          {note && <span className={`oj-qnote left ${note.ok ? '' : 'bad'}`} role="status">{note.text}</span>}
        </div>
      ) : (
        <>
          {stale && <p className="oj-scope-warn">链接对应第 {base?.n ?? '?'} 版，清单已经更新，客户打不开了</p>}
          {!stale && expired && <p className="oj-scope-warn">链接已过期</p>}
          <input className="oj-qin oj-scope-url" readOnly aria-label="客户确认链接" value={url} onFocus={e => e.target.select()} />
          <div className="oj-qbtns oj-scope-btns">
            {stale || expired
              ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run('scope-create', () => createScope(project.id))}>重新生成</button>
              : <button type="button" className="btn btn-sm" onClick={() => void copy()}><Ic name="paste" cls="ic ic-sm" />复制</button>}
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { if (revoking) void run('scope-revoke', () => revokeScope(project.id)); else setRevoking(true) }}>{revoking ? '确认收回' : '收回'}</button>
            {!sub && !stale && !expired && <span className="faint small">等客户提交</span>}
            {note && <span className={`oj-qnote left ${note.ok ? '' : 'bad'}`} role="status">{note.text}</span>}
          </div>
          {sub && (
            <div className="oj-scope-sub">
              <p className="oj-scope-subhead">客户已提交{planName ? ` · ${planName}` : ''} · {sub.picked.length} 项{sub.custom.length ? `，新增 ${sub.custom.length} 项` : ''}</p>
              <FlowPreview nodes={nodes} picked={picked} />
              {conflicts.length > 0 && <ul className="oj-conflicts">{conflicts.map(c => <li key={c.id}><span>{c.title}需要先有{c.missing.map(m => m.title).join('、')}</span></li>)}</ul>}
              {sub.custom.length > 0 && <ul className="oj-plain">{sub.custom.map(c => <li key={c.id}>新增：{c.title}{c.detail ? `，${c.detail}` : ''}</li>)}</ul>}
              {sub.answers.length > 0 && <ul className="oj-plain">{sub.answers.map(a => <li key={a.q}>{a.q}：{a.a}</li>)}</ul>}
              {sub.note && <p className="oj-scope-note">备注：{sub.note}</p>}
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || stale} onClick={() => void run('scope-apply', () => applyScope(project.id))}>{busy ? '生成中…' : '按这份生成新版本'}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

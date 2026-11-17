// 客户确认需求页：免登录，不套 App 外壳。token 放在 hash 里，不进页面请求的日志和 Referer。
// 客户侧只拿 scopeView，没有价格和小时
import { useEffect, useMemo, useState } from 'react'
import { Ic, SketchSprite } from '../SketchIcon'
import { Select } from '../Select'
import { MAX_CUSTOM, blockedBy, customNodes, type ScopeEdge, flowLayers, recommendedPlan, scopeConflicts, type ScopeCustom, type ScopeNode, type ScopeView } from '../../shared/order-judge-scope'
import { FlowPreview } from './FlowPreview'
import { JudgeError, fetchScope, submitScope } from './api'

const NO_AFTER = '-'

function withPrerequisites(items: ScopeNode[], start: Iterable<string>): Set<string> {
  const byId = new Map(items.map(i => [i.id, i]))
  const out = new Set<string>()
  const add = (id: string): void => { if (out.has(id) || !byId.has(id)) return; out.add(id); byId.get(id)!.dependsOn.forEach(add) }
  for (const id of start) add(id)
  return out
}

export function ScopePage({ token }: { token: string }): JSX.Element {
  const [view, setView] = useState<ScopeView | null>(null)
  const [fatal, setFatal] = useState('')
  useEffect(() => {
    let live = true
    fetchScope(token).then(v => { if (live) setView(v) }).catch((e: unknown) => {
      console.error('[scope] 读取失败', e)
      if (live) setFatal(e instanceof Error ? e.message : String(e))
    })
    return () => { live = false }
  }, [token])
  return (
    <main className="oj-scope">
      <SketchSprite />
      {fatal ? <section className="panel oj-scope-msg"><Ic name="alert" />{fatal}</section>
        : view ? <ScopeForm token={token} initial={view} onGone={setFatal} />
        : <section className="panel oj-scope-msg">读取中…</section>}
    </main>
  )
}

function ScopeForm({ token, initial, onGone }: { token: string; initial: ScopeView; onGone: (m: string) => void }): JSX.Element {
  const view = initial
  const saved = initial.submission
  const first = recommendedPlan(view.plans)
  const [planId, setPlanId] = useState(saved?.planId ?? first?.id ?? '')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(saved?.picked ?? first?.itemIds ?? view.items.map(i => i.id)))
  const [custom, setCustom] = useState<ScopeCustom[]>(saved?.custom ?? [])
  const [answers, setAnswers] = useState<string[]>(() => view.questions.map(q => saved?.answers.find(a => a.q === q)?.a ?? ''))
  const [note, setNote] = useState(saved?.note ?? '')
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [after, setAfter] = useState(NO_AFTER)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(saved ? { ok: true, text: '已提交，还可以改了再提交' } : null)

  const baseNodes = useMemo(() => [...view.items, ...customNodes(custom)], [view.items, custom])
  const [edited, setEdited] = useState<ScopeNode[] | null>(null)
  const nodes = edited && edited.length === baseNodes.length ? edited : baseNodes
  const allPicked = useMemo(() => new Set([...picked, ...custom.map(c => c.id)]), [picked, custom])
  // 方案标了冲突、客户认为不冲突的条目：解锁后和普通条目一样勾选，提交时带上让开发者知道
  const [unblocked, setUnblocked] = useState<Set<string>>(() => new Set(saved?.unblocked ?? []))
  const plan = view.plans.find(p => p.id === planId)
  const blocked = useMemo(() => blockedBy(plan, view.items, unblocked), [plan, view.items, unblocked])
  const lockedByPlan = useMemo(() => blockedBy(plan, view.items), [plan, view.items])
  const unlock = (id: string): void => {
    if (!blocked.has(id)) return
    touch()
    // 它被锁可能是因为前置被锁，前置一起放开才勾得上
    const chain = [...withPrerequisites(view.items, [id])].filter(x => lockedByPlan.has(x))
    setUnblocked(s => new Set([...s, ...chain]))
    setPicked(s => new Set([...s, ...chain]))
  }
  const relock = (id: string): void => {
    touch()
    // 和解锁对称：当初连着前置一起放开的，恢复时也一起锁回去，不留一个「恢复了但没变化」的状态
    const chain = new Set([...withPrerequisites(view.items, [id])].filter(x => lockedByPlan.has(x)))
    const next = new Set([...unblocked].filter(x => !chain.has(x)))
    const again = blockedBy(plan, view.items, next)
    setUnblocked(new Set([...next].filter(x => !again.has(x))))
    setPicked(s => new Set([...s].filter(x => !again.has(x))))
  }
  const edges = (list: ScopeNode[]): string[] => list.flatMap(n => n.dependsOn.map(d => `${d}>${n.id}`))
  const links = useMemo(() => {
    const was = new Set(edges(baseNodes)), now = new Set(edges(nodes))
    const pair = (k: string): ScopeEdge => k.split('>') as ScopeEdge
    return { add: [...now].filter(k => !was.has(k)).map(pair), drop: [...was].filter(k => !now.has(k)).map(pair) }
  }, [baseNodes, nodes])
  const conflicts = scopeConflicts(nodes, allPicked)
  const stages = useMemo(() => {
    const m = new Map<string, ScopeNode[]>()
    // 按前置关系排，先看到登录这类起点；客户在图里调换了先后，清单的顺序跟着变
    const order = flowLayers(nodes).flat()
    const sorted = order.map(id => view.items.find(i => i.id === id)).filter((i): i is ScopeNode => !!i)
    for (const i of sorted) { const k = i.stage || '功能'; m.set(k, [...(m.get(k) ?? []), i]) }
    return [...m]
  }, [view.items, nodes])
  // 客户改过前置的条目在清单里写明现在排在谁后面，图和清单对得上
  const titleOf = new Map(nodes.map(n => [n.id, n.title]))
  const baseDeps = new Map(baseNodes.map(n => [n.id, n.dependsOn]))
  const movedAfter = (id: string): string => {
    const now = nodes.find(n => n.id === id)?.dependsOn ?? [], was = baseDeps.get(id) ?? []
    return now.length === was.length && now.every(d => was.includes(d)) ? '' : now.length ? `改为排在${now.map(d => `「${titleOf.get(d) ?? d}」`).join('、')}之后` : '改为不依赖别的功能'
  }

  const touch = (): void => setStatus(null)
  const toggle = (id: string): void => {
    if (!view.items.some(i => i.id === id) || blocked.has(id)) return
    touch()
    setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  const choosePlan = (id: string): void => {
    const plan = view.plans.find(p => p.id === id)
    if (!plan) return
    touch(); setPlanId(id); setPicked(new Set(plan.itemIds)); setUnblocked(new Set())
  }
  const restore = (ids: string[]): void => {
    touch()
    setPicked(s => new Set([...s, ...[...withPrerequisites(view.items, ids)].filter(id => !blocked.has(id))]))
  }
  const addCustom = (): void => {
    if (!title.trim() || custom.length >= MAX_CUSTOM) return
    touch()
    const used = new Set(custom.map(c => c.id))
    let n = custom.length + 1
    while (used.has(`c${n}`)) n++
    setCustom(c => [...c, { id: `c${n}`, title: title.trim(), detail: detail.trim(), after: after === NO_AFTER ? [] : [after] }])
    setTitle(''); setDetail(''); setAfter(NO_AFTER)
  }
  const submit = async (): Promise<void> => {
    setBusy(true); setStatus(null)
    try {
      await submitScope(token, { planId, picked: [...picked], custom, answers: answers.map((a, i) => ({ i, a })).filter(x => x.a.trim()), note, links, unblocked: [...unblocked] })
      setStatus({ ok: true, text: '已提交，还可以改了再提交' })
    } catch (e) {
      console.error('[scope] 提交失败', e)
      const message = e instanceof Error ? e.message : String(e)
      if (e instanceof JudgeError && /^SCOPE_(EXPIRED|APPLIED|OUTDATED|NOT_FOUND)$/.test(e.code)) onGone(message)
      else setStatus({ ok: false, text: message })
    } finally { setBusy(false) }
  }

  return (
    <>
      <header className="oj-scope-head">
        <h1 className="title-sketch">{view.title || '确认需求'}</h1>
        {view.outcome && <p>{view.outcome}</p>}
      </header>
      {view.plans.length > 1 && (
        <section className="panel oj-scope-sec">
          <h2>选一个方向</h2>
          <div className="oj-plans">
            {view.plans.map(p => (
              <button key={p.id} type="button" aria-pressed={planId === p.id} className={`oj-plan${planId === p.id ? ' on' : ''}`} onClick={() => choosePlan(p.id)}>
                <b>{p.name}{p.recommended && <em>推荐</em>}</b>
                <span>{p.summary}</span>{p.fit && <span className="fit">{p.fit}</span>}
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="oj-scope-cols">
        <section className="panel oj-scope-sec">
          <h2>要做的功能</h2>
          {stages.map(([stage, items]) => (
            <div key={stage} className="oj-stage">
              <h3>{stage}</h3>
              {items.map(i => blocked.has(i.id) ? (
                <div key={i.id} className="oj-pick lock ask">
                  <span className="box"><Ic name="x" cls="ic ic-sm" /></span>
                  <span className="txt"><b>{i.title}</b><small>和所选方案冲突</small><button type="button" className="oj-pick-undo" onClick={() => unlock(i.id)}>不冲突，仍然要</button></span>
                </div>
              ) : (
                <button key={i.id} type="button" role="checkbox" aria-checked={picked.has(i.id)} className={`oj-pick${picked.has(i.id) ? ' on' : ''}`} onClick={() => toggle(i.id)}>
                  <span className="box">{picked.has(i.id) && <Ic name="check" cls="ic ic-sm" />}</span>
                  <span className="txt"><b>{i.title}</b>{i.detail && <small>{i.detail}</small>}{movedAfter(i.id) && <small className="oj-pick-moved">{movedAfter(i.id)}</small>}{lockedByPlan.has(i.id) && <span role="button" tabIndex={0} className="oj-pick-undo" onClick={e => { e.stopPropagation(); relock(i.id) }} onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); relock(i.id) } }}>恢复为冲突</span>}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="oj-stage">
            <h3>还想加什么</h3>
            {custom.map(c => (
              <div key={c.id} className="oj-custom">
                <span className="txt"><b>{c.title}</b>{c.detail && <small>{c.detail}</small>}</span>
                <button type="button" className="btn btn-sm btn-ghost" aria-label={`删除${c.title}`} onClick={() => { touch(); setCustom(l => l.filter(x => x.id !== c.id).map(x => ({ ...x, after: x.after.filter(a => a !== c.id) }))); setAfter(a => (a === c.id ? NO_AFTER : a)) }}><Ic name="trash" cls="ic ic-sm" /></button>
              </div>
            ))}
            {custom.length < MAX_CUSTOM && (
              <div className="oj-custom-form">
                <input className="oj-qin" aria-label="功能名称" value={title} maxLength={80} placeholder="功能名称" onChange={e => setTitle(e.target.value)} />
                <input className="oj-qin" aria-label="功能说明" value={detail} maxLength={300} placeholder="想要它做什么" onChange={e => setDetail(e.target.value)} />
                <Select options={[{ id: NO_AFTER, text: '不接在别的功能后面' }, ...[...view.items, ...custom].map(i => ({ id: i.id, text: `接在「${i.title}」后面` }))]} value={after} onChange={setAfter} placeholder="接在哪一步后面" />
                <button type="button" className="btn btn-sm" disabled={!title.trim()} onClick={addCustom}><Ic name="plus" cls="ic ic-sm" />加上</button>
              </div>
            )}
          </div>
        </section>
        <section className="panel oj-scope-sec oj-scope-flow">
          <h2>功能怎么连起来</h2>
          <FlowPreview nodes={baseNodes} picked={allPicked} locked={blocked} onToggle={toggle} onPick={ids => { if (ids.length) restore(ids) }} onUnlock={unlock} editable onNodes={setEdited} initialLinks={saved?.links} />
          {conflicts.length > 0 && (
            <ul className="oj-conflicts">
              {conflicts.map(c => (
                <li key={c.id}>
                  <span>{c.title}需要先有{c.missing.map(m => m.title).join('、')}</span>
                  <button type="button" className="btn btn-sm" onClick={() => restore(c.missing.map(m => m.id))}>补回</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {view.questions.length > 0 && (
        <section className="panel oj-scope-sec">
          <h2>想请你回答</h2>
          {view.questions.map((q, i) => (
            <label key={q} className="oj-answer">
              <span>{q}</span>
              <textarea className="oj-qin" rows={2} maxLength={300} value={answers[i]} onChange={e => { touch(); setAnswers(a => a.map((x, j) => (j === i ? e.target.value : x))) }} />
            </label>
          ))}
        </section>
      )}
      <section className="panel oj-scope-sec">
        <label className="oj-answer">
          <h2>备注</h2>
          <textarea className="oj-qin" rows={3} maxLength={500} value={note} onChange={e => { touch(); setNote(e.target.value) }} />
        </label>
        <div className="oj-scope-submit">
          <button type="button" className="btn btn-primary" disabled={busy || (!picked.size && !custom.length)} onClick={() => void submit()}>{busy ? '提交中…' : '提交给开发者'}</button>
          {status && <span className={`oj-qnote ${status.ok ? '' : 'bad'}`} role="status">{status.text}</span>}
        </div>
      </section>
    </>
  )
}

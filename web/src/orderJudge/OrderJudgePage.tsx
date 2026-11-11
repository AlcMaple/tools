// 网页版接单评估：材料 → 需求清单。一单一个项目，客户每追加 / 调整一次就整理出一个新版本。
// 方案见 docs/ideas/021-接单评估重新定位.md。材料在浏览器里预处理（web/shared/order-judge-prepare.ts），服务端只收文字、JPEG 和附件；
// AI 跟随设置里「用谁的」：用服务器的由服务端自己准备连接；用自己的，整理前拿设置里存的 Key 接上助手同一条自配连接。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../auth'
import { Ic } from '../SketchIcon'
import { Select } from '../Select'
import { useIsWide } from '../useMediaQuery'
import { precheck } from '../../shared/order-judge'
import { BASIS_TEXT, CHOOSABLE_CLIENT_TYPES, PRIORITIES, WORK_KINDS, isChoosableClientType, type Brief as BriefType, type BriefItem, type ChoosableClientType } from '../../shared/order-judge-brief'
import { parseBudget, parseDeadline, ymd, type Expense, type QuoteSettings } from '../../shared/order-judge-quote'
import { COOPERATION_PLANS, MAINTENANCE_STATES, MAX_MAINT_EXPENSES, MAX_MONTHS, longTermClientText, longTermFee, maintenanceClientText, maintenanceSelfText, normalizeMaintenance, planOf, suggestFee, type CooperationPlan, type Maintenance, type MonthRecord } from '../../shared/order-judge-maintenance'
import { BONUS_RESULTS, CONFIDENCE_STEPS, DISCOUNT_STEPS, FEELINGS, bonusAllowed, type BonusTerms, MAX_EXPENSES, ITEM_MAX_DAYS, ITEM_MAX_HOURS, OUTCOMES, VERSION_STATUSES, buildSheet, calibFor, calibrateByType, latestType, clientText, freeze, normalizeQuote, selfText, marketLine, HOUR_SCALE_MAX, HOUR_SCALE_MIN, hourRows, hoursLabel, scaleLabel, selfSummary, type Calibrations, type HourRow, type QuoteState, type Sheet } from '../../shared/order-judge-sheet'
import { imageTileCount, kindOf, prepareMaterials } from '../../shared/order-judge-prepare'
import { expandArchive, isArchive } from './archive'
import { FlowPreview } from './FlowPreview'
import { PlanList, ScopePanel } from './ScopePanel'
import { inScoping, plansOf, recommendedPlan } from '../../shared/order-judge-scope'
import { readByokKey } from '../reviews/byok'
import type { JudgeState, Project, Version } from '../../shared/order-judge-api'
import { MAX_TEXT_CHARS, VERSION_LIMIT } from '../../shared/order-judge-api'
import {
  JudgeError, attachUrl, connectProvider, deleteProject, saveMaintenance, saveQuote, followJudgeChanges, imageUrl, loadState, logClient, organize, providerStatus,
  type ProviderStatus,
} from './api'

const ACCEPT = 'image/*,video/*,.pdf,.doc,.docx,.rtf,.odt,.pages,.html,.htm,.txt,.md,.xlsx,.xls,.csv,.zip,.rar'
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

interface Material {
  id: number
  file: File
  thumb: string | null
  note: string
  bad: boolean
}

type Tab = 'new' | 'projects'
type Stage = 'prep' | 'links' | 'ai'
type Outcome =
  | { kind: 'done'; project: Project; ms: number }
  | { kind: 'chat-record' }
  | { kind: 'error'; code: string; message: string; at: number }

const SETTINGS_CODES = new Set(['BYOK_REQUIRED', 'PROVIDER_CONNECTION_REQUIRED', 'PROVIDER_HTTP_401'])

function when(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

const errorOf = (e: unknown): { code: string; message: string } =>
  e instanceof JudgeError ? { code: e.code, message: e.message } : { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) }

const latest = (p: Project): Version => p.versions[p.versions.length - 1]

const TYPE_KEY = 'order-judge:client-type'
function readClientType(): ChoosableClientType | null {
  try { const v = localStorage.getItem(TYPE_KEY); return isChoosableClientType(v) ? v : null } catch { return null }
}
function saveClientType(t: ChoosableClientType): void {
  try { localStorage.setItem(TYPE_KEY, t) } catch { /* 记不住就每次再选 */ }
}

export function OrderJudgePage({ onLogin }: { onLogin: () => void }): JSX.Element | null {
  const { user, ready } = useAuth()
  if (!ready) return null
  if (!user) return <GuestCard onLogin={onLogin} />
  return <JudgeWorkspace key={user.id} />
}

function Head({ tab, onTab, count }: { tab: Tab; onTab: (t: Tab) => void; count: number | null }): JSX.Element {
  return (
    <div className="oj-head">
      <h1 className="title-sketch" style={{ fontSize: 34 }}>接单评估</h1>
      <div className="tools">
        <div className="seg oj-desk" role="group" aria-label="视图">
          <button type="button" className={tab === 'new' ? 'on' : ''} onClick={() => onTab('new')}>整理</button>
          <button type="button" className={tab === 'projects' ? 'on' : ''} onClick={() => onTab('projects')}>
            项目{count !== null ? <span className="n">{count}</span> : null}
          </button>
        </div>
        <div className="oj-mob oj-mode">
          <Select
            options={[{ id: 'new', text: '整理' }, { id: 'projects', text: count !== null ? `项目 · ${count}` : '项目' }]}
            value={tab}
            onChange={(id) => onTab(id === 'projects' ? 'projects' : 'new')}
            placeholder="整理"
          />
        </div>
      </div>
    </div>
  )
}

function JudgeWorkspace(): JSX.Element {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('new')
  const [state, setState] = useState<JudgeState | null>(null)
  const calib = { byType: state?.learned ?? calibrateByType(state?.projects ?? []), market: state?.market }
  const all = state?.projects ?? []
  const [loadError, setLoadError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [provider, setProvider] = useState<ProviderStatus | null>(null)
  const [target, setTarget] = useState<Project | null>(null)
  const [text, setText] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState<Stage>('prep')
  const [prepStats, setPrepStats] = useState('')
  const [linkCount, setLinkCount] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const [sec, setSec] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [tip, setTip] = useState(false)
  const [drag, setDrag] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [clientType, setClientType] = useState<ChoosableClientType | null>(readClientType)
  const [typeTip, setTypeTip] = useState(false)
  const [matOpen, setMatOpen] = useState(false)
  const wide = useIsWide()
  const nextId = useRef(1)
  const shotNo = useRef(1)
  const fileInput = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const materialsRef = useRef<Material[]>([])
  const refreshRef = useRef<Promise<void> | null>(null)
  const mountedRef = useRef(true)
  materialsRef.current = materials

  const refreshProvider = useCallback(() => {
    providerStatus().then(setProvider).catch((e: unknown) => {
      logClient('order-judge:provider', e)
      setProvider(null)
    })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    let queued = false
    const refresh = (): void => {
      if (refreshRef.current) { queued = true; return }
      const task = loadState().then(next => {
        if (mountedRef.current) { setState(old => !old || next.seq >= old.seq ? next : old); setLoadError('') }
      }).catch((e: unknown) => { if (mountedRef.current) setLoadError(errorOf(e).message) })
        .finally(() => { refreshRef.current = null; if (queued && mountedRef.current) { queued = false; refresh() } })
      refreshRef.current = task
    }
    refresh()
    const unfollow = followJudgeChanges(refresh, error => { logClient('order-judge:sync', error); if (mountedRef.current) setSyncError(errorOf(error).message) }, () => { if (mountedRef.current) setSyncError('') })
    refreshProvider()
    return () => {
      mountedRef.current = false; unfollow()
      abortRef.current?.abort()
      for (const m of materialsRef.current) if (m.thumb) URL.revokeObjectURL(m.thumb)
    }
  }, [refreshProvider])

  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setSec(Math.floor((Date.now() - startedAt) / 1000)), 500)
    return () => window.clearInterval(t)
  }, [running, startedAt])

  useEffect(() => {
    if (!tip) return
    const t = window.setTimeout(() => setTip(false), 2600)
    return () => window.clearTimeout(t)
  }, [tip])

  // 追加的目标项目在别处被删掉时，退回新项目
  useEffect(() => {
    if (target && state && !state.projects.some(p => p.id === target.id)) setTarget(null)
  }, [state, target])

  const ai = user?.aiConfig
  const byok = ai?.provider === 'byok'
  const noKey = byok && !readByokKey().trim()

  const addFiles = useCallback((files: File[]) => {
    const fresh: Material[] = files.map((file) => {
      const kind = kindOf(file)
      const probe = kind === 'video' ? document.createElement('video').canPlayType(file.type || 'video/mp4') : 'maybe'
      return {
        id: nextId.current++,
        file,
        thumb: kind === 'image' ? URL.createObjectURL(file) : null,
        note: isArchive(file) ? '待解包' : kind === 'video' && probe ? '12 帧' : '',
        bad: (kind === 'other' && !isArchive(file)) || (kind === 'video' && !probe),
      }
    })
    setMaterials((list) => [...list, ...fresh])
    for (const m of fresh) {
      const kind = kindOf(m.file)
      const setNote = (note: string): void => setMaterials((list) => list.map((x) => (x.id === m.id ? { ...x, note } : x)))
      if (m.bad) setNote('读不了')
      else if (kind === 'image') void imageTileCount(m.file).then((n) => { if (n && n > 1) setNote(`切 ${n} 块`) })
      else if (kind === 'pdf') {
        import('./pdf').then(({ pdfPageCount }) => pdfPageCount(m.file)).then((n) => setNote(`${n} 页`)).catch((e: unknown) => logClient('order-judge:pdf-pages', e))
      }
    }
  }, [])

  const pastedFiles = (items: File[]): File[] => items.map((f) => {
    if (f.name && f.name !== 'image.png') return f
    const ext = f.type.split('/')[1] || 'png'
    return new File([f], `截图${String(shotNo.current++).padStart(2, '0')}.${ext}`, { type: f.type })
  })

  // 整页接粘贴：焦点不在输入框时文字也粘进去，截图直接成为材料
  useEffect(() => {
    if (tab !== 'new' || deleteTarget) return
    const onPaste = (e: ClipboardEvent): void => {
      if (running || !e.clipboardData) return
      const files = [...e.clipboardData.files]
      if (files.length) {
        e.preventDefault()
        addFiles(pastedFiles(files))
        return
      }
      const pasted = e.clipboardData.getData('text')
      if (pasted && document.activeElement !== textRef.current) {
        const active = document.activeElement as HTMLElement | null
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
        e.preventDefault()
        setText((t) => (t ? `${t}\n${pasted}` : pasted))
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [tab, deleteTarget, running, addFiles])

  const pasteFromClipboard = async (): Promise<void> => {
    try {
      const items = await navigator.clipboard.read()
      const files: File[] = []
      let pasted = ''
      for (const item of items) {
        const img = item.types.find((t) => t.startsWith('image/'))
        if (img) files.push(new File([await item.getType(img)], 'image.png', { type: img }))
        else if (item.types.includes('text/plain')) pasted += await (await item.getType('text/plain')).text()
      }
      if (files.length) addFiles(pastedFiles(files))
      if (pasted) setText((t) => (t ? `${t}\n${pasted}` : pasted))
    } catch (e) {
      // 用户拒绝读取剪贴板，或浏览器不支持：留给输入框长按粘贴
      logClient('order-judge:clipboard', e)
      textRef.current?.focus()
    }
  }

  const removeMaterial = (id: number): void => {
    setMaterials((list) => {
      const m = list.find((x) => x.id === id)
      if (m?.thumb) URL.revokeObjectURL(m.thumb)
      return list.filter((x) => x.id !== id)
    })
  }

  const clearMaterials = (): void => {
    for (const m of materials) if (m.thumb) URL.revokeObjectURL(m.thumb)
    setMaterials([])
    setText('')
  }

  const startNew = (): void => {
    clearMaterials()
    setOutcome(null)
    setTarget(null)
    setMatOpen(false)
    setTab('new')
  }

  const appendTo = (project: Project): void => {
    clearMaterials()
    setOutcome(null)
    setTarget(project)
    setMatOpen(true)
    const kept = latest(project).brief.clientType
    if (isChoosableClientType(kept)) setClientType(kept)
    setTab('new')
    setMobileDetail(false)
    window.scrollTo({ top: 0 })
  }

  const run = async (): Promise<void> => {
    if (running) return
    const pre = precheck(text, materials.length)
    if (pre === 'empty') { setTip(true); return }
    if (pre === 'chat-record') { setOutcome({ kind: 'chat-record' }); return }
    if (!clientType) { setTypeTip(true); return }
    if (noKey) { window.location.hash = '#/settings/ai'; return }
    const controller = new AbortController()
    abortRef.current = controller
    const t0 = Date.now()
    setRunning(true)
    setStartedAt(t0)
    setSec(0)
    setStage('prep')
    setPrepStats('')
    setLinkCount(0)
    setOutcome(null)
    // 平板 / 手机整页切到整理过程，回到页顶看进度
    if (!wide) window.scrollTo({ top: 0 })
    try {
      const prepared = await prepareMaterials(text, materials.map((m) => m.file), {
        expandArchive: file => expandArchive(file, controller.signal),
        pdfText: async (file) => (await import('./pdf')).pdfText(file),
        onError: logClient,
      })
      if (controller.signal.aborted) return
      setMaterials((list) => list.map((m) => ({ ...m,
        bad: prepared.unreadable.includes(m.file.name),
        note: prepared.materialNotes[m.file.name] ?? (prepared.unreadable.includes(m.file.name) ? '读不了' : m.note),
      })))
      const failedArchives = materials.filter(m => isArchive(m.file) && prepared.unreadable.includes(m.file.name))
      if (failedArchives.length) throw new JudgeError('ARCHIVE_UNREADABLE', failedArchives.map(m => `${m.file.name}：${prepared.materialNotes[m.file.name]}`).join('；'))
      if (prepared.text.length > MAX_TEXT_CHARS) throw new JudgeError('MATERIAL_TEXT_TOO_LONG', '材料文字超过 20 万字，请拆分后再整理')
      setPrepStats(prepared.stats.join(' · '))
      if (byok && ai && !(provider?.ready && provider.source === 'byok')) {
        setProvider(await connectProvider(ai.endpoint, ai.model, readByokKey().trim()))
      }
      const project = await organize(target?.id ?? null, clientType, prepared.text, prepared.images, prepared.attachments, (e) => {
        if (e.stage === 'links') { setLinkCount(e.count); setStage('links') } else setStage('ai')
      }, controller.signal)
      if (controller.signal.aborted) return
      setState((s) => (s ? { ...s, projects: [project, ...s.projects.filter(p => p.id !== project.id)] } : s))
      setTarget(project)
      setSelected(project.id)
      clearMaterials()
      setMatOpen(false)
      setOutcome({ kind: 'done', project, ms: Date.now() - t0 })
    } catch (e) {
      if (controller.signal.aborted) return
      const { code, message } = errorOf(e)
      if (code === 'NETWORK') logClient('order-judge:organize', e)
      setOutcome({ kind: 'error', code, message, at: Date.now() })
      if (code === 'PROVIDER_CONNECTION_REQUIRED' || code === 'PROVIDER_HTTP_401') refreshProvider()
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setRunning(false)
      }
    }
  }

  // 取消只停掉这次请求，材料原样留在编辑区
  const cancel = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
    setOutcome(null)
  }

  // 详情拿的是整理或点开那一刻的对象，客户从链接提交只会经同步到达 state，要用更新的那份
  const fresh = (p: Project): Project => { const q = state?.projects.find(x => x.id === p.id); return q && q.updatedAt >= p.updatedAt ? q : p }
  const replaceProject = (p: Project): void => {
    setState((s) => (s ? { ...s, projects: s.projects.map((x) => (x.id === p.id ? p : x)) } : s))
    setOutcome((o) => (o?.kind === 'done' && o.project.id === p.id ? { ...o, project: p } : o))
    setTarget((t) => (t?.id === p.id ? p : t))
  }

  const removeProject = async (id: string): Promise<void> => {
    await deleteProject(id)
    if (!mountedRef.current) return
    setState((s) => (s ? { ...s, projects: s.projects.filter((p) => p.id !== id) } : s))
    if (selected === id) { setSelected(null); setMobileDetail(false) }
    if (target?.id === id) setTarget(null)
    if (outcome?.kind === 'done' && outcome.project.id === id) setOutcome(null)
  }

  // 平板 / 手机：整理中和出结果后不显示编辑区（CSS 只在 ≤960px 生效，桌面仍是两栏）
  const flow = running || outcome !== null
  const solo = !!target && !matOpen && !running && !text && materials.length === 0
  const head = <Head tab={tab} onTab={(t) => { setTab(t); setMobileDetail(false) }} count={state ? state.projects.length : null} />
  const deleting = deleteTarget && <DeleteProjectDialog project={deleteTarget} onDelete={removeProject} onClose={() => setDeleteTarget(null)} />

  if (tab === 'projects') {
    const list = state?.projects ?? []
    const current = list.find((p) => p.id === selected) ?? list[0] ?? null
    const sheet = current && <ProjectSheet key={`${current.id}:${latest(current).n}`} project={current} onAppend={() => appendTo(current)} onSaved={replaceProject} calib={calib} all={all} />
    return (
      <>
        {head}
        {(loadError || syncError) && <p className="nag mt16"><Ic name="alert" />{loadError || syncError}</p>}
        {list.length === 0 ? (
          <section className="panel oj-sheet blank mt24"><p className="muted">还没有整理过的项目</p></section>
        ) : !wide && mobileDetail && current ? (
          <div className="oj-hist">
            <button type="button" className="oj-back" onClick={() => setMobileDetail(false)}><Ic name="back" />返回项目</button>
            {sheet}
          </div>
        ) : (
          <div className="oj-hist">
            <section className="panel oj-rows">
              <span className="tape tl lav" />
              <div className="oj-rows-scroll">
              {list.map((p) => {
                const v = latest(p)
                return (
                  <div key={p.id} className={`oj-row${current?.id === p.id ? ' on' : ''}`}>
                    <button type="button" className="oj-row-main" onClick={() => { setSelected(p.id); setMobileDetail(true) }}>
                      <span className="oj-ver-badge">v{v.n}</span>
                      <span className="t">
                        <b>{p.title}</b>
                        <span>{when(p.updatedAt)} · {v.brief.clientType} · {v.brief.items.length} 条需求</span>
                      </span>
                    </button>
                    <button type="button" className="del" title="删除这个项目" aria-label="删除这个项目" onClick={() => setDeleteTarget(p)}>
                      <Ic name="trash" cls="ic ic-sm" />
                    </button>
                  </div>
                )
              })}
              </div>
            </section>
            {current && <div className="oj-desk">{sheet}</div>}
          </div>
        )}
        {deleting}
      </>
    )
  }

  const nextN = target ? latest(target).n + 1 : 1
  return (
    <>
      {head}
      {noKey && (
        <div className="nag mt16">
          <Ic name="alert" />设置里选了用你自己的 AI，但还没填 API key
          <button type="button" className="btn btn-sm" onClick={() => { window.location.hash = '#/settings/ai' }}>去设置</button>
        </div>
      )}
      {(loadError || syncError) && <p className="nag mt16"><Ic name="alert" />{loadError || syncError}</p>}
      <div className={`oj-grid${flow ? ' flow' : ''}${solo ? ' solo' : ''}`}>
        <section
          className={`panel oj-mat${solo ? ' solo' : ''}`}
          onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false) }}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            if (!running && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files])
          }}
        >
          <span className="tape tl teal" />
          <div className="panel-title oj-mat-title">
            <Ic name="clip" />
            <span className="oj-mat-name">{target ? `给「${target.title}」追加需求` : '客户材料'}</span>
            {target && !running && <button type="button" className="btn btn-sm btn-ghost" onClick={startNew}>{solo ? '新项目' : '改为新项目'}</button>}
            {solo && target && target.versions.length < VERSION_LIMIT && <button type="button" className="btn btn-sm" onClick={() => { setMatOpen(true); setTimeout(() => textRef.current?.focus(), 0) }}>追加需求</button>}
          </div>
          <div className="oj-type">
            <span className="oj-qlabel">客户类型</span>
            <div className="seg" role="group" aria-label="客户类型">
              {CHOOSABLE_CLIENT_TYPES.map(t => (
                <button key={t} type="button" disabled={running} className={clientType === t ? 'on' : ''} onClick={() => { setClientType(t); saveClientType(t); setTypeTip(false) }}>{t}</button>
              ))}
            </div>
            <span className={`oj-type-tip${typeTip && !clientType ? ' on' : ''}`} role="status">先选客户类型</span>
          </div>
          <div className={`oj-drop${drag ? ' drag' : ''}`}>
            <textarea
              ref={textRef}
              className="oj-text"
              value={text}
              disabled={running}
              placeholder={target ? '客户追加或改了什么，贴在这里' : '把客户的需求文字、网址贴在这里'}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="oj-over"><Ic name="clip" />松手放入</div>
          </div>
          {materials.length > 0 && (
            <div className="oj-files">
              {materials.map((m) => {
                const kind = kindOf(m.file)
                return (
                  <div key={m.id} className={`oj-file${m.bad ? ' bad' : ''}`} title={[m.file.name, m.note].filter(Boolean).join('：')}>
                    <div className="pic">
                      {m.thumb ? <img src={m.thumb} alt="" /> : <Ic name={m.bad ? 'alert' : kind === 'video' ? 'video' : 'doc'} />}
                      {m.note && <span className="note">{m.note}</span>}
                    </div>
                    <div className="name">{m.file.name}</div>
                    {!running && (
                      <button type="button" className="rm" aria-label={`移除 ${m.file.name}`} onClick={() => removeMaterial(m.id)}>
                        <Ic name="x" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles([...e.target.files])
              e.target.value = ''
            }}
          />
          <div className="oj-bar">
            <span className="hint oj-desk"><kbd>{isMac ? '⌘V' : 'Ctrl+V'}</kbd> 粘贴截图，文件拖进来或</span>
            <button type="button" className="btn btn-sm oj-desk" disabled={running} onClick={() => fileInput.current?.click()}>选择文件</button>
            <button type="button" className="btn btn-sm oj-mob" disabled={running} onClick={() => void pasteFromClipboard()}><Ic name="paste" cls="ic ic-sm" />粘贴</button>
            <button type="button" className="btn btn-sm oj-mob" disabled={running} onClick={() => fileInput.current?.click()}><Ic name="clip" cls="ic ic-sm" />添加文件</button>
            {(text || materials.length > 0) && (
              <button type="button" className="btn btn-sm btn-ghost" disabled={running} onClick={clearMaterials}>清空</button>
            )}
            <span className="go">
              <button type="button" className="btn btn-primary oj-go" disabled={running || nextN > VERSION_LIMIT} onClick={() => void run()}>
                {running ? `整理中 ${sec}s` : <><Ic name="judge" />{target ? `整理第 ${nextN} 版` : '整理需求'}</>}
              </button>
              {tip && <span className="bubble oj-tip" role="status">还没有放入内容</span>}
            </span>
          </div>
          <details className="oj-how" open={!text && materials.length === 0 && !target ? true : undefined}>
            <summary><Ic name="chev" cls="ic ic-sm" />不同材料怎么放</summary>
            <dl>
              <dt>文字、截图</dt>
              <dd>
                <span className="oj-desk">{isMac ? '⌘V' : 'Ctrl+V'} 粘贴，可连续添加截图，</span>
                <span className="oj-mob">点「粘贴」添加截图，</span>
                微信、QQ 聊天记录请展开后截图
              </dd>
              <dt>网址</dt><dd>粘贴网址，最多 10 个；截图中的网址不读取</dd>
              <dt>在线文档</dt><dd>公开腾讯文档请贴具体页网址，只读部分文字</dd>
              <dt>需登录访问的网站、小程序</dt><dd>请提供截图、长图或录屏</dd>
              <dt>视频</dt><dd>均匀取 12 帧，不识别声音；口述需求请补文字</dd>
              <dt>PDF、Word</dt><dd>只读文字；扫描件和文档配图请补截图</dd>
              <dt>ZIP、RAR</dt><dd>单包最多 32 MB；加密包先解密，内层压缩包单独添加</dd>
              <dt>Excel、CSV</dt><dd>Excel 读前 5 张表、每表 300 行；.xls 请转 .xlsx，CSV 可直接添加</dd>
            </dl>
          </details>
        </section>
        <div className="oj-result">
          {flow && !running && (
            <div className="oj-flowbar">
              <button type="button" className="oj-back" onClick={() => setOutcome(null)}><Ic name="back" />{outcome?.kind === 'done' ? '追加需求' : '返回修改'}</button>
              <button type="button" className="btn btn-sm" onClick={startNew}>新项目</button>
            </div>
          )}
          {running && <Brief text={text} materials={materials} />}
          {running ? (
            <section className="panel oj-sheet">
              <span className="tape tr gold" />
              <p className="oj-meta">开始于 {when(startedAt).replace(/^今天 /, '')}</p>
              <p className="oj-headline" style={{ paddingRight: 0 }}>{target ? `正在整理第 ${nextN} 版…` : '正在整理需求…'}</p>
              <ol className="oj-steps">
                <Step state={stage === 'prep' ? 'run' : 'done'} title="整理材料" sub={prepStats} />
                {(stage === 'links' || linkCount > 0) && <Step state={stage === 'links' ? 'run' : 'done'} title="打开网址" sub={`${linkCount} 个`} />}
                <Step state={stage === 'ai' ? 'run' : 'wait'} title={stage === 'ai' ? 'AI 整理中' : 'AI 整理'} sub={stage === 'ai' ? '一般 20～60 秒' : ''} />
              </ol>
              <div className="oj-cancel">
                <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}><Ic name="x" cls="ic ic-sm" />取消</button>
              </div>
            </section>
          ) : outcome?.kind === 'done' ? (
            <ProjectSheet key={`${outcome.project.id}:${latest(fresh(outcome.project)).n}`} project={fresh(outcome.project)} ms={outcome.ms} onSaved={replaceProject} calib={calib} all={all} />
          ) : outcome?.kind === 'chat-record' ? (
            <section className="panel oj-sheet">
              <span className="tape tl gold" />
              <p className="oj-meta">刚刚</p>
              <p className="oj-headline">只看到「[聊天记录]」几个字，读不到客户的需求</p>
              <div className="oj-sec">
                <h3><Ic name="edit" />怎么补</h3>
                <ol className="oj-list warn">
                  <li><span>转发的聊天记录要先点开，再截图粘贴进来；直接复制只会得到「[聊天记录]」</span></li>
                  <li><span>{isMac ? '⌘V' : 'Ctrl+V'} 或「粘贴」把截图放进来，可以连续粘贴多张</span></li>
                </ol>
              </div>
            </section>
          ) : outcome?.kind === 'error' ? (
            <section className="panel oj-sheet">
              <span className="tape tr gold" />
              <p className="oj-meta">{when(outcome.at)}</p>
              <p className="oj-headline oj-err-title" style={{ paddingRight: 0 }}><Ic name="alert" />{outcome.message}</p>
              <p className="oj-err"><code>{outcome.code}</code></p>
              {SETTINGS_CODES.has(outcome.code) && (
                <div className="oj-acts">
                  <button type="button" className="btn btn-sm" onClick={() => { window.location.hash = '#/settings/ai' }}><Ic name="settings" cls="ic ic-sm" />打开 AI 设置</button>
                </div>
              )}
            </section>
          ) : target ? (
            <ProjectSheet key={`${target.id}:${latest(fresh(target)).n}`} project={fresh(target)} onSaved={replaceProject} calib={calib} all={all} />
          ) : (
            <section className="panel oj-sheet blank oj-blank">
              <div className="empty" style={{ padding: '10px 0' }}>
                <img src="/assets/sagiri-avatar.webp" alt="" width={84} height={84} className="oj-avatar" />
                <div className="empty-say"><span className="bubble empty-bubble">材料放好后点「整理需求」，需求清单会写在这里</span></div>
              </div>
            </section>
          )}
          {flow && !running && outcome?.kind !== 'done' && <Brief text={text} materials={materials} fold />}
        </div>
      </div>
      {deleting}
    </>
  )
}

function Brief({ text, materials, fold = false }: { text: string; materials: Material[]; fold?: boolean }): JSX.Element {
  const strip = materials.length > 0 && (
    <div className="strip">
      {materials.map((m) => (m.thumb
        ? <img key={m.id} src={m.thumb} alt={m.file.name} />
        : <span key={m.id} title={m.file.name}><Ic name={kindOf(m.file) === 'video' ? 'video' : 'doc'} /></span>))}
    </div>
  )
  const meta = materials.length ? `${materials.length} 个附件` : '只有文字'
  if (fold) {
    return (
      <details className="panel oj-brief">
        <summary><Ic name="clip" />这次的材料<span className="meta">{meta}</span><Ic name="chev" cls="ic ic-sm" /></summary>
        {text && <p className="ex">{text}</p>}
        {strip}
      </details>
    )
  }
  return (
    <section className="panel oj-brief">
      <span className="tape tl teal" />
      <div className="panel-title" style={{ marginBottom: 8 }}><Ic name="clip" />这次的材料<span className="faint small" style={{ marginLeft: 'auto' }}>{meta}</span></div>
      {text && <p className="ex">{text}</p>}
      {strip}
    </section>
  )
}

const TEXT_PREVIEW = new Set(['md', 'txt', 'csv', 'html', 'htm', 'rtf'])
const fileExt = (file: string): string => file.slice(file.lastIndexOf('.') + 1)
const sizeOf = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function AttachList({ version }: { version: Version }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const preview = async (file: string): Promise<void> => {
    if (open === file) { setOpen(null); return }
    setOpen(file)
    setBody('')
    try {
      const res = await fetch(attachUrl(version.id, file), { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setBody((await res.text()).slice(0, 60_000))
    } catch (e) {
      logClient('order-judge:attach-preview', e)
      setBody('读不出这份文件，请改用下载')
    }
  }
  return (
    <div className="oj-attach">
      {version.files.map((f) => {
        const ext = fileExt(f.file)
        return (
          <div key={f.file} className="oj-attach-item">
            <div className="oj-attach-row">
              <Ic name="doc" cls="ic ic-sm" />
              <span className="oj-attach-name" title={f.name}>{f.name}</span>
              <span className="faint small">{sizeOf(f.size)}</span>
              {ext === 'pdf' && <a className="btn btn-sm" href={attachUrl(version.id, f.file)} target="_blank" rel="noreferrer">预览</a>}
              {TEXT_PREVIEW.has(ext) && <button type="button" className="btn btn-sm" onClick={() => void preview(f.file)}>{open === f.file ? '收起' : '预览'}</button>}
              <a className="btn btn-sm" href={attachUrl(version.id, f.file, true)} download={f.name}>下载</a>
            </div>
            {open === f.file && <pre className="oj-attach-pre">{body || '读取中…'}</pre>}
          </div>
        )
      })}
    </div>
  )
}

function Step({ state, title, sub }: { state: 'done' | 'run' | 'wait'; title: string; sub: string }): JSX.Element {
  return (
    <li className={state}>
      <span className="mk">{state === 'done' && <Ic name="check" />}</span>
      <div>{title}{sub && <small>{sub}</small>}</div>
    </li>
  )
}


// 一个项目：版本切换 + 这一版的需求清单 + 这一版放进来的材料
function ProjectSheet({ project, ms, onAppend, onSaved, calib, all }: { project: Project; ms?: number; onAppend?: () => void; onSaved: (p: Project) => void; calib: Calibrations; all: Project[] }): JSX.Element {
  const [n, setN] = useState(latest(project).n)
  const version = project.versions.find(v => v.n === n) ?? latest(project)
  const b = version.brief
  const marks = new Map<string, string>()
  for (const c of version.changes) if (c.type !== 'removed') marks.set(c.id, c.type === 'added' ? '新增' : '有改动')
  const removed = version.changes.filter((c): c is Extract<typeof c, { type: 'removed' }> => c.type === 'removed')
  const meta = [`第 ${version.n} 版`, when(version.at), b.clientType, ms ? `用时 ${Math.round(ms / 1000)} 秒` : ''].filter(Boolean).join(' · ')
  const facts: [string, string][] = [['客户在意的结果', b.outcome], ['客户预算', b.budget], ['截止', b.deadline]]
  const isLatest = version.id === latest(project).id
  const plan = planOf(project.maintenance, latest(project).brief.engagement)
  const dealt = project.versions.some(v => v.quote.status === '已成交')
  const scoping = inScoping(b, dealt, version.quote.status)
  const flowNodes = b.items.filter(i => i.dependsOn?.length || b.items.some(x => x.dependsOn?.includes(i.id)))
    .map(i => ({ id: i.id, title: i.title, detail: i.detail, stage: i.stage ?? '', dependsOn: i.dependsOn ?? [] }))
  const groups = PRIORITIES.map(p => ({ p, items: b.items.filter(i => i.priority === p) })).filter(g => g.items.length)
  return (
    <section className="panel oj-sheet">
      <span className="tape tl teal" />
      {project.versions.length > 1 && (
        <div className="oj-vers" role="tablist" aria-label="版本">
          {project.versions.map(v => (
            <button key={v.n} type="button" role="tab" aria-selected={v.n === version.n} className={v.n === version.n ? 'on' : ''} onClick={() => setN(v.n)}>v{v.n}</button>
          ))}
        </div>
      )}
      <p className="oj-meta" style={{ paddingRight: 0 }}>{meta}</p>
      <p className="oj-headline" style={{ paddingRight: 0 }}>{b.title || project.title}</p>
      <dl className="oj-facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={v ? '' : 'ask'}>{v || '待问'}</dd></div>)}
      </dl>
      {scoping ? (
        <div className="oj-cols">
          <div className="oj-col">
            {isLatest ? <PlanList project={project} latest={version} onSaved={onSaved} /> : <div className="oj-sec"><h3><Ic name="doc" />需求方案</h3><ul className="oj-plain">{plansOf(b).map(p => <li key={p.id}>{p.name}：{p.summary}{p.fit ? `；${p.fit}` : ''}</li>)}</ul></div>}
            {b.questions.length > 0 && (
              <div className="oj-sec">
                <h3><Ic name="edit" />要问客户的</h3>
                <ul className="oj-q">{b.questions.map((q, i) => <li key={i}><span>{q}</span></li>)}</ul>
              </div>
            )}
          </div>
          <div className="oj-col">
            {isLatest && <ScopePanel project={project} latest={version} onSaved={onSaved} />}
            {flowNodes.length > 0 && (
              <div className="oj-sec">
                <h3><Ic name="chev" />流程图 · {recommendedPlan(plansOf(b))?.name}</h3>
                <FlowPreview nodes={flowNodes} picked={new Set(recommendedPlan(plansOf(b))?.itemIds ?? [])} />
              </div>
            )}
          </div>
        </div>
      ) : (
      <div className="oj-cols">
      <div className="oj-col">
      {isLatest && project.scope && <ScopePanel project={project} latest={version} onSaved={onSaved} />}
      {b.confirmed && (
        <div className="oj-sec">
          <h3><Ic name="check" />{b.confirmed.by === 'developer' ? '已选定方案' : '客户已确认'}</h3>
          {b.confirmed.conflicts.length > 0 && <ul className="oj-conflicts">{b.confirmed.conflicts.map(c => <li key={c}><span>{c}</span></li>)}</ul>}
          {b.confirmed.answers.length > 0 && <ul className="oj-plain">{b.confirmed.answers.map(a => <li key={a.q}>{a.q}：{a.a}</li>)}</ul>}
          {b.confirmed.note && <p className="oj-scope-note">备注：{b.confirmed.note}</p>}
        </div>
      )}
      {flowNodes.length > 0 && (
        <details className="oj-sec oj-src">
          <summary><Ic name="chev" cls="ic ic-sm" />流程图</summary>
          <FlowPreview nodes={flowNodes} picked={new Set(b.items.filter(i => i.priority !== '不做').map(i => i.id))} />
        </details>
      )}
      {groups.map(g => (
        <div key={g.p} className="oj-sec">
          <h3><Ic name="check" />{g.p === '不做' ? '这次不做' : g.p}</h3>
          <ul className="oj-items">{g.items.map(item => <Item key={item.id} item={item} mark={marks.get(item.id)} />)}</ul>
        </div>
      ))}
      {removed.length > 0 && (
        <div className="oj-sec">
          <h3><Ic name="x" />这一版去掉了</h3>
          <ul className="oj-plain">{removed.map(r => <li key={r.id}>{r.title}</li>)}</ul>
        </div>
      )}
      {b.excluded.length > 0 && (
        <div className="oj-sec">
          <h3><Ic name="alert" />不包含</h3>
          <ul className="oj-plain">{b.excluded.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      {b.questions.length > 0 && (
        <div className="oj-sec">
          <h3><Ic name="edit" />要问客户的</h3>
          <ul className="oj-q">{b.questions.map((q, i) => <li key={i}><span>{q}</span></li>)}</ul>
        </div>
      )}
      </div>
      <div className="oj-col">
      <PlanBar project={project} plan={plan} onSaved={onSaved} />
      {(plan !== '长期' || dealt) && <QuotePanel key={version.id} project={project} version={version} onSaved={onSaved} calib={calib} />}
      {(plan === '长期' || dealt) && <MaintenancePanel key={`m:${project.id}:${plan}`} project={project} all={all} onSaved={onSaved} calib={calib} long={plan === '长期'} />}
      </div>
      </div>
      )}
      {(version.text || version.images.length > 0 || version.files.length > 0) && (
        <details className="oj-sec oj-src">
          <summary><Ic name="clip" cls="ic ic-sm" />第 {version.n} 版放进来的材料</summary>
          {version.text && <p className="oj-src-text">{version.text}</p>}
          {version.images.length > 0 && (
            <div className="oj-thumbs">
              {version.images.map(img => (
                <a key={img.file} href={imageUrl(version.id, img.file)} target="_blank" rel="noreferrer" title={img.name}><img src={imageUrl(version.id, img.file)} alt={img.name} loading="lazy" /></a>
              ))}
            </div>
          )}
          {version.files.length > 0 && <AttachList version={version} />}
        </details>
      )}
      {onAppend && project.versions.length < VERSION_LIMIT && (
        <div className="oj-acts">
          <button type="button" className="btn btn-sm" onClick={onAppend}><Ic name="edit" cls="ic ic-sm" />追加需求</button>
        </div>
      )}
    </section>
  )
}

const BONUS_INPUTS: [keyof BonusTerms, string, string][] = [
  ['metric', '看什么', '下单转化率、大促不掉单、退货率'],
  ['baseline', '现在', '改之前的数，如 1.2%'],
  ['target', '目标', '如 2%'],
  ['verify', '怎么算达标', '用哪里的数据、怎么算'],
  ['period', '考核期', '如上线后 3 个月'],
]

const thisMonth = (): string => new Date().toISOString().slice(0, 7)

function PlanBar({ project, plan, onSaved }: { project: Project; plan: CooperationPlan; onSaved: (p: Project) => void }): JSX.Element {
  const [error, setError] = useState('')
  const engagement = latest(project).brief.engagement
  const choose = async (next: CooperationPlan): Promise<void> => {
    if (next === plan) return
    setError('')
    try { onSaved(await saveMaintenance(project.id, { ...project.maintenance, plan: next })) }
    catch (e) { logClient('order-judge:plan', e); setError(errorOf(e).message) }
  }
  return (
    <div className="oj-sec">
      <div className="oj-qrow">
        <span className="oj-qlabel">合作方式</span>
        <div className="seg" role="group" aria-label="合作方式">
          {COOPERATION_PLANS.map(p => <button key={p} type="button" className={plan === p ? 'on' : ''} onClick={() => void choose(p)}>{p}</button>)}
        </div>
      </div>
      {engagement?.reason && <p className="oj-plan-reason" style={{ marginTop: 8 }}>AI：{engagement.mode}，{engagement.reason}</p>}
      {error && <p className="oj-scope-warn" role="alert">{error}</p>}
    </div>
  )
}

// 月维护：项目级，成交过才出现；长期合作没有成交也可用，这时它就是报价。月费定了就不改：一旦记过月份，月费输入框锁住
function MaintenancePanel({ project, all, onSaved, calib: calibs, long = false }: { project: Project; all: Project[]; onSaved: (p: Project) => void; calib: Calibrations; long?: boolean }): JSX.Element {
  const calib = calibFor(calibs, latestType(project.versions))
  const [draft, setDraft] = useState<Maintenance>(project.maintenance)
  const [view, setView] = useState<'client' | 'self'>('self')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (patch: Partial<Maintenance>): void => { setDraft(d => ({ ...d, ...patch })); setNote(null) }
  const pending = normalizeMaintenance(draft)
  const dirty = JSON.stringify(pending) !== JSON.stringify(project.maintenance)
  const pool = all.some(p => p.id === project.id) ? all : [...all, project]
  const engagement = latest(project).brief.engagement
  const scopeHours = latest(project).brief.items.filter(i => i.priority !== '不做').reduce((a, i) => a + i.hours, 0)
  const suggestion = long ? longTermFee(pool, project.id, pending, engagement?.monthHours ?? 0, calib.settings, scopeHours) : suggestFee(pool, project.id, calib.settings)
  const text = view === 'self' ? maintenanceSelfText(project.title, pending, suggestion, long)
    : long ? longTermClientText(project.title, pending, suggestion.fee, engagement?.firstMonth ?? []) : maintenanceClientText(project.title, pending)
  const locked = project.maintenance.months.length > 0 && project.maintenance.fee > 0
  const expenses = draft.expenses.length < MAX_MAINT_EXPENSES ? [...draft.expenses, { name: '', amount: 0 }] : draft.expenses
  const setExpense = (i: number, patch: Partial<Expense>): void => set({ expenses: expenses.map((e, j) => (j === i ? { ...e, ...patch } : e)).filter(e => e.name || e.amount) })
  const setMonth = (i: number, patch: Partial<MonthRecord>): void => set({ months: draft.months.map((m, j) => (j === i ? { ...m, ...patch } : m)) })

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await saveMaintenance(project.id, pending)
      onSaved(saved)
      setDraft(saved.maintenance)
      setNote({ ok: true, text: '已保存' })
    } catch (e) {
      logClient('order-judge:maintenance', e)
      setNote({ ok: false, text: errorOf(e).message })
    } finally { setBusy(false) }
  }
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setNote({ ok: true, text: '已复制' }) } catch (e) { logClient('order-judge:copy', e); setNote({ ok: false, text: '复制失败，请手动选中文字复制' }) }
  }
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.title}-${long ? '长期合作' : '月维护'}${view === 'client' ? '' : '-自用'}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="oj-sec oj-maint">
      <h3><Ic name="calendar" />{long ? '长期合作' : '月维护'}</h3>
      {long && (pending.fee || suggestion.fee != null) && (
        <div className="oj-hero" role="status">
          <span className="oj-hero-name">{pending.fee ? '月费' : '建议月费'}</span>
          <b className="oj-hero-price">¥{(pending.fee || suggestion.fee!).toLocaleString('zh-CN')}<small> / 月</small></b>
          <span className="oj-hero-sub">{suggestion.hours} 小时 × {suggestion.rate}，小时来自{suggestion.source}</span>
        </div>
      )}
      <div className="oj-qform">
        <div className="oj-qrow">
          <span className="oj-qlabel">状态</span>
          <div className="seg" role="group" aria-label="月维护状态">
            {MAINTENANCE_STATES.map(st => <button key={st} type="button" className={draft.state === st ? 'on' : ''} onClick={() => set({ state: st })}>{long && st === '不做' ? '待开始' : st}</button>)}
          </div>
        </div>
        {(long || draft.state !== '不做') && (
          <>
            {long && (
              <label className="oj-qrow">
                <span className="oj-qlabel">每月投入</span>
                <input className="oj-qin" aria-label="每月投入小时" inputMode="decimal" value={draft.monthHours || ''} placeholder={engagement?.monthHours ? `AI 估 ${engagement.monthHours}` : '小时'} disabled={locked}
                  onChange={e => set({ monthHours: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
                <span className="faint small">小时</span>
              </label>
            )}
            <label className="oj-qrow">
              <span className="oj-qlabel">月费</span>
              <input className="oj-qin" aria-label="月费" inputMode="numeric" value={draft.fee || ''} disabled={locked} placeholder={suggestion.fee != null ? `建议 ${suggestion.fee}` : '自己定'}
                onChange={e => set({ fee: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })} />
              <span className="faint small">元{locked ? '，已经记过月份，不再改' : ''}</span>
            </label>
            <label className="oj-qrow">
              <span className="oj-qlabel">开始月份</span>
              <input className="oj-qin" aria-label="开始月份" value={draft.start} placeholder={thisMonth()} maxLength={7} onChange={e => set({ start: e.target.value.replace(/[^\d-]/g, '') })} />
            </label>
            <div className="oj-qrow top">
              <span className="oj-qlabel">每月支出</span>
              <div className="oj-qexp">
                {expenses.map((e, i) => (
                  <div key={i} className="oj-qexp-row">
                    <input className="oj-qin wide" value={e.name} placeholder="服务器、域名、付费接口" maxLength={40} onChange={ev => setExpense(i, { name: ev.target.value })} />
                    <input className="oj-qin" inputMode="numeric" value={e.amount || ''} placeholder="金额" onChange={ev => setExpense(i, { amount: Number(ev.target.value.replace(/[^\d]/g, '')) || 0 })} />
                  </div>
                ))}
              </div>
            </div>
            <div className="oj-qrow top">
              <span className="oj-qlabel">每月记录</span>
              <div className="oj-qexp">
                {draft.months.map((m, i) => (
                  <div key={i} className="oj-qmonth">
                    <div className="oj-qexp-row">
                      <input className="oj-qin" aria-label="月份" value={m.month} placeholder={thisMonth()} maxLength={7} onChange={e => setMonth(i, { month: e.target.value.replace(/[^\d-]/g, '') })} />
                      <input className="oj-qin" aria-label="实际小时" inputMode="decimal" value={m.hours || ''} placeholder="实际小时" onChange={e => setMonth(i, { hours: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ months: draft.months.filter((_, j) => j !== i) })}><Ic name="trash" cls="ic ic-sm" />删除</button>
                    </div>
                    <input className="oj-qin wide" aria-label="交付了什么" value={m.delivered} placeholder="这个月交付的大功能" maxLength={200} onChange={e => setMonth(i, { delivered: e.target.value })} />
                    <div className="seg" role="group" aria-label={`${m.month || '这个月'}觉得`}>
                      {FEELINGS.map(f => <button key={f} type="button" className={m.feeling === f ? 'on' : ''} onClick={() => setMonth(i, { feeling: f })}>{f}</button>)}
                    </div>
                  </div>
                ))}
                {draft.months.length < MAX_MONTHS && (
                  <button type="button" className="btn btn-sm" onClick={() => set({ months: [...draft.months, { month: thisMonth(), delivered: '', hours: 0, feeling: '待定' }] })}><Ic name="plus" cls="ic ic-sm" />记一个月</button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="oj-qbar">
        <div className="seg" role="group" aria-label="月维护说明版本">
          <button type="button" className={view === 'self' ? 'on' : ''} onClick={() => setView('self')}>自用版</button>
          <button type="button" className={view === 'client' ? 'on' : ''} onClick={() => setView('client')}>客户版</button>
        </div>
        <div className="oj-qbtns">
          <button type="button" className="btn btn-sm" onClick={() => void copy()}><Ic name="paste" cls="ic ic-sm" />复制</button>
          <button type="button" className="btn btn-sm" onClick={download}><Ic name="doc" cls="ic ic-sm" />下载</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
          {note && <span className={`oj-qnote ${note.ok ? '' : 'bad'}`} role="status">{note.text}</span>}
        </div>
      </div>
      <pre className="oj-qtext">{text}</pre>
    </div>
  )
}

const pct = (r: number): string => (r ? `${Math.round(r * 100)}%` : '不让')

// 工时：默认不用动。一根整体滑块管全局，单项只露出占钱最多的几条，其余收起；1 天按 8 小时显示
function HoursPanel({ market, draft, raw, settings, set }: { market: string; draft: QuoteState; raw: BriefType; settings: QuoteSettings; set: (p: Partial<QuoteState>) => void }): JSX.Element {
  const rows = hourRows(raw, draft, settings)
  const locked = draft.status !== '草稿'
  const major = rows.filter(r => r.major), rest = rows.filter(r => !r.major)
  const changed = draft.hourScale !== 1 || Object.keys(draft.hourEdits).length > 0
  const drag = (id: string, suggested: number, v: number): void => {
    const { [id]: _, ...others } = draft.hourEdits
    set({ hourEdits: v === suggested ? others : { ...others, [id]: v } })
  }
  const row = (r: HourRow): JSX.Element => (
    <label key={r.id} className="oj-hrow">
      <span title={`${r.title}：${BASIS_TEXT[r.basis]}`}>{r.title}<em>{BASIS_TEXT[r.basis]}</em></span>
      <input type="range" aria-label={`${r.title}的小时`} min={0} max={r.max} step={0.5} value={r.hours} disabled={locked} onChange={e => drag(r.id, r.suggested, Number(e.target.value))} />
      <span className="oj-hval" title={hoursLabel(r.hours)}>
        <input key={`${r.id}:${r.hours}`} type="number" className="oj-hnum" aria-label={`${r.title}的小时数`} min={0} max={ITEM_MAX_HOURS} step={0.5} defaultValue={r.hours} disabled={locked}
          onBlur={e => { const v = Math.min(ITEM_MAX_HOURS, Math.max(0, Math.round(Number(e.target.value) * 2) / 2)); if (e.target.value !== '' && Number.isFinite(v) && v !== r.hours) drag(r.id, r.suggested, v); else e.target.value = String(r.hours) }}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />小时
      </span>
    </label>
  )
  return (
    <div className="oj-hours">
      <p className="oj-hmarket">{market}</p>
      <label className="oj-hrow">
        <span>全部工时</span>
        <input type="range" aria-label="整体小时倍率" min={HOUR_SCALE_MIN} max={HOUR_SCALE_MAX} step={0.1} value={draft.hourScale} disabled={locked} onChange={e => set({ hourScale: Number(e.target.value) })} />
        <span className="oj-hval">{scaleLabel(draft.hourScale)}</span>
      </label>
      {major.map(row)}
      {rest.length > 0 && (
        <details className="oj-hmore">
          <summary>其余 {rest.length} 项，{hoursLabel(rest.reduce((a, r) => a + r.hours, 0))}</summary>
          <div>{rest.map(row)}</div>
        </details>
      )}
      {rows.some(r => r.hours >= ITEM_MAX_HOURS) && <p className="oj-scope-warn">单项最多 {ITEM_MAX_DAYS} 天；某一项要做更久，建议把上面的合作方式改成长期</p>}
      {changed && !locked && <button type="button" className="oj-hreset" onClick={() => set({ hourEdits: {}, hourScale: 1 })}>恢复 AI 的估计</button>}
    </div>
  )
}

// 报价：表单改动即时反映到下面的报价单，点保存才写回；复制 / 下载的就是当前看到的文字
function QuotePanel({ project, version, onSaved, calib: calibs }: { project: Project; version: Version; onSaved: (p: Project) => void; calib: Calibrations }): JSX.Element {
  const calib = calibFor(calibs, version.brief.clientType)
  const [draft, setDraft] = useState<QuoteState>(version.quote)
  const [budgetText, setBudgetText] = useState(version.quote.budget == null ? '' : String(version.quote.budget))
  const [deadlineText, setDeadlineText] = useState(version.quote.deadlineDate ?? '')
  const [view, setView] = useState<'client' | 'self'>('self')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (patch: Partial<QuoteState>): void => { setDraft(d => ({ ...d, ...patch })); setNote(null) }
  const setBonus = (patch: Partial<BonusTerms>): void => { setDraft(d => ({ ...d, bonus: { ...d.bonus, ...patch } })); setNote(null) }
  const pending = freeze(normalizeQuote(draft), calib.settings)
  const versions = project.versions.map(v => ({ n: v.n, at: v.at, brief: v.brief, quote: v.id === version.id ? pending : v.quote }))
  const sheet = buildSheet(project.title, versions, version.n, calib.settings)
  const text = view === 'client' ? clientText(sheet) : selfText(sheet, calib)
  const summary = selfSummary(sheet)
  const dirty = JSON.stringify(pending) !== JSON.stringify(version.quote)
  const kinds = WORK_KINDS.filter(k => sheet.chosen?.lines.some(l => l.work === k))
  const moduleRows = hourRows(version.brief, draft, sheet.settings).filter(r => r.hours > 0 || draft.itemActual[r.id] != null)
  const parsed = parseBudget(version.brief.budget)
  const [moreOn] = useState(draft.bonus.on || draft.discount.ratio > 0 || draft.resultHours > 0 || draft.expenses.length > 0)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await saveQuote(version.id, pending)
      onSaved(saved)
      setDraft(saved.versions.find(x => x.id === version.id)?.quote ?? pending)
      setNote({ ok: true, text: '已保存' })
    } catch (e) {
      logClient('order-judge:quote', e)
      setNote({ ok: false, text: errorOf(e).message })
    } finally { setBusy(false) }
  }
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setNote({ ok: true, text: '已复制' }) } catch (e) { logClient('order-judge:copy', e); setNote({ ok: false, text: '复制失败，请手动选中文字复制' }) }
  }
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.title}-第${version.n}版-${view === 'client' ? '报价单' : '自用'}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const expenses = draft.expenses.length < MAX_EXPENSES ? [...draft.expenses, { name: '', amount: 0 }] : draft.expenses
  const setExpense = (i: number, patch: Partial<Expense>): void => set({ expenses: expenses.map((e, j) => (j === i ? { ...e, ...patch } : e)).filter(e => e.name || e.amount) })

  return (
    <div className="oj-sec oj-quote">
      <h3><Ic name="ticket" />{sheet.base ? `变更单 · 基于第 ${sheet.base.n} 版` : '报价'}</h3>
      {summary && (
        <div className="oj-hero" role="status">
          <span className="oj-hero-name">{summary.name === '变更' ? '这次变更报价' : `报价 · ${summary.name}档`}</span>
          <b className="oj-hero-price">¥{summary.price.toLocaleString('zh-CN')}</b>
          <span className="oj-hero-sub">{[summary.days != null ? `约 ${summary.days} 天做完` : '', `最低可收 ¥${summary.minPrice.toLocaleString('zh-CN')}`, ...summary.others.map(o => `${o.name}档 ¥${o.price.toLocaleString('zh-CN')}`)].filter(Boolean).join(' · ')}</span>
        </div>
      )}
      <HoursPanel market={marketLine(version.brief, calib.market)} draft={pending} raw={version.brief} settings={sheet.settings} set={set} />
      <div className="oj-qform">
        <div className="oj-qrow">
          <span className="oj-qlabel">状态</span>
          <div className="seg" role="group" aria-label="状态">
            {VERSION_STATUSES.map(st => <button key={st} type="button" className={draft.status === st ? 'on' : ''} onClick={() => set({ status: st })}>{st}</button>)}
          </div>
        </div>
        <label className="oj-qrow">
          <span className="oj-qlabel">{draft.status === '已成交' ? '成交价' : '实际报价'}</span>
          <input className="oj-qin" inputMode="numeric" aria-label="实际报价" value={draft.finalPrice ?? ''} placeholder={sheet.chosen ? `默认 ${sheet.chosen.quote}` : ''}
            onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); set({ finalPrice: v ? Number(v) : null }) }} />
          <span className="faint small">元</span>
        </label>
        {!sheet.base && sheet.tiers.length > 1 && (
          <div className="oj-qrow">
            <span className="oj-qlabel">主推</span>
            <div className="seg" role="group" aria-label="主推档">
              {sheet.tiers.map(t => <button key={t.name} type="button" className={sheet.chosen?.name === t.name ? 'on' : ''} onClick={() => set({ tier: t.name })}>{t.name}</button>)}
            </div>
          </div>
        )}
        {!sheet.base && (
          <label className="oj-qrow">
            <span className="oj-qlabel">客户预算</span>
            <input className="oj-qin" inputMode="numeric" value={budgetText} placeholder={parsed != null ? `材料里是 ${parsed}` : '待问'}
              onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); setBudgetText(v); set({ budget: v ? Number(v) : null }) }} />
            <span className="faint small">元</span>
          </label>
        )}
        <label className="oj-qrow">
          <span className="oj-qlabel">截止日</span>
          <input className="oj-qin wide" value={deadlineText} placeholder={version.brief.deadline ? `材料里是「${version.brief.deadline}」` : '如 12 月 20 日、明天'}
            onChange={e => { setDeadlineText(e.target.value); set({ deadlineDate: parseDeadline(e.target.value, ymd(new Date())) }) }} />
          <span className="faint small oj-qhint">{deadlineText.trim() ? (draft.deadlineDate ? `读成 ${draft.deadlineDate}` : '读不出日期') : sheet.deadline ? `按 ${sheet.deadline}` : ''}</span>
        </label>
        {draft.status !== '草稿' && (
          <div className="oj-qstage">
            <p>{draft.status === '已报价' ? '客户怎么回复' : '做完后填'}</p>
        {draft.status === '已报价' && (
          <div className="oj-qrow">
            <span className="oj-qlabel">客户结果</span>
            <div className="seg" role="group" aria-label="客户结果">
              {OUTCOMES.map(o => <button key={o} type="button" className={draft.outcome === o ? 'on' : ''} onClick={() => set({ outcome: o })}>{o === '嫌贵' ? '嫌贵没成交' : o}</button>)}
            </div>
          </div>
        )}
        {draft.status === '已报价' && draft.outcome === '嫌贵' && (
          <label className="oj-qrow">
            <span className="oj-qlabel">客户说的预算</span>
            <input className="oj-qin" inputMode="numeric" value={draft.clientBudget ?? ''} placeholder="没说就空着"
              onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); set({ clientBudget: v ? Number(v) : null }) }} />
            <span className="faint small">元</span>
          </label>
        )}
        {draft.status === '已成交' && kinds.length > 0 && <div className="oj-qpair">{kinds.map(k => (
          <label key={k} className="oj-qrow">
            <span className="oj-qlabel">{k === '接手改' ? '验证和改旧代码用时' : '从零做的部分用时'}</span>
            <input className="oj-qin" inputMode="decimal" value={draft.actual[k] || ''} placeholder="做完再填"
              onChange={e => set({ actual: { ...draft.actual, [k]: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 } })} />
            <span className="faint small">小时</span>
          </label>
        ))}</div>}
        {draft.status === '已成交' && moduleRows.length > 0 && (
          <details className="oj-qmore oj-qmods" open={Object.keys(draft.itemActual).length > 0 || undefined}>
            <summary>按模块填实际小时（可选）</summary>
            <div className="oj-qmods-grid">
            {moduleRows.map(r => (
              <label key={r.id} className="oj-qrow">
                <span className="oj-qlabel">{r.title}</span>
                <input className="oj-qin" inputMode="decimal" value={draft.itemActual[r.id] ?? ''} placeholder={`估 ${hoursLabel(r.hours)}`}
                  onChange={e => {
                    const t = e.target.value.replace(/[^\d.]/g, '')
                    const next = { ...draft.itemActual }
                    if (t === '') delete next[r.id]; else next[r.id] = Number(t) || 0
                    set({ itemActual: next })
                  }} />
                <span className="faint small">小时</span>
              </label>
            ))}
            </div>
          </details>
        )}
        {draft.status === '已成交' && (
          <div className="oj-qrow">
            <span className="oj-qlabel">做完觉得</span>
            <div className="seg" role="group" aria-label="做完觉得">
              {FEELINGS.map(f => <button key={f} type="button" className={draft.feeling === f ? 'on' : ''} onClick={() => set({ feeling: f })}>{f}</button>)}
            </div>
          </div>
        )}
          </div>
        )}
        <details className="oj-qmore" open={moreOn}>
        <summary>更多设置</summary>
        <div className="oj-qform">
        <label className="oj-qrow">
          <span className="oj-qlabel">每天投入</span>
          <input className="oj-qin" inputMode="decimal" value={draft.dailyHours || ''} placeholder="4"
            onChange={e => set({ dailyHours: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
          <span className="faint small">小时</span>
        </label>
        <label className="oj-qrow">
          <span className="oj-qlabel">交付后修改</span>
          <input className="oj-qin" inputMode="decimal" value={draft.resultHours || ''} placeholder="0"
            onChange={e => set({ resultHours: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
          <span className="faint small">小时</span>
        </label>
        <div className="oj-qrow top">
          <span className="oj-qlabel">实际支出</span>
          <div className="oj-qexp">
            {expenses.map((e, i) => (
              <div key={i} className="oj-qexp-row">
                <input className="oj-qin wide" value={e.name} placeholder="服务器、域名、付费接口" maxLength={40} onChange={ev => setExpense(i, { name: ev.target.value })} />
                <input className="oj-qin" inputMode="numeric" value={e.amount || ''} placeholder="金额" onChange={ev => setExpense(i, { amount: Number(ev.target.value.replace(/[^\d]/g, '')) || 0 })} />
              </div>
            ))}
          </div>
        </div>
        {!sheet.bonus && (
          <div className="oj-qrow">
            <span className="oj-qlabel">人情折让</span>
            <div className="seg" role="group" aria-label="人情折让">
              {DISCOUNT_STEPS.map(r => <button key={r} type="button" className={draft.discount.ratio === r ? 'on' : ''} onClick={() => set({ discount: { ...draft.discount, ratio: r } })}>{pct(r)}</button>)}
            </div>
          </div>
        )}
        {!sheet.base && bonusAllowed(version.brief) && (
          <div className="oj-qrow">
            <span className="oj-qlabel">成效奖金</span>
            <div className="seg" role="group" aria-label="成效奖金">
              {[false, true].map(on => <button key={String(on)} type="button" className={draft.bonus.on === on ? 'on' : ''} onClick={() => setBonus({ on })}>{on ? '加' : '不加'}</button>)}
            </div>
          </div>
        )}
        {sheet.bonus && BONUS_INPUTS.map(([k, label, hint]) => (
          <label key={k} className="oj-qrow">
            <span className="oj-qlabel">{label}</span>
            <input className="oj-qin wide" value={draft.bonus[k] as string} placeholder={hint} maxLength={k === 'verify' ? 120 : 60} onChange={e => setBonus({ [k]: e.target.value })} />
          </label>
        ))}
        {sheet.bonus && (
          <div className="oj-qrow">
            <span className="oj-qlabel">达标把握</span>
            <div className="seg" role="group" aria-label="达标把握">
              {CONFIDENCE_STEPS.map(c => <button key={c} type="button" className={draft.bonus.confidence === c ? 'on' : ''} onClick={() => setBonus({ confidence: c })}>{c * 10} 成</button>)}
            </div>
          </div>
        )}
        {sheet.bonus && (
          <label className="oj-qrow">
            <span className="oj-qlabel">客户多赚</span>
            <input className="oj-qin" inputMode="numeric" value={draft.bonus.gain ?? ''} placeholder="达标后客户多赚多少"
              onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); setBonus({ gain: v ? Number(v) : null }) }} />
            <span className="faint small">元，可不填</span>
          </label>
        )}
        {sheet.bonus && draft.status === '已成交' && (
          <div className="oj-qrow">
            <span className="oj-qlabel">奖金结果</span>
            <div className="seg" role="group" aria-label="奖金结果">
              {BONUS_RESULTS.map(r => <button key={r} type="button" className={draft.bonus.result === r ? 'on' : ''} onClick={() => setBonus({ result: r })}>{r}</button>)}
            </div>
          </div>
        )}
        {draft.discount.ratio > 0 && !sheet.bonus && (
          <label className="oj-qrow">
            <span className="oj-qlabel">折让原因</span>
            <input className="oj-qin wide" value={draft.discount.reason} placeholder="同学、老客户第 3 单、换作品展示权" maxLength={60}
              onChange={e => set({ discount: { ...draft.discount, reason: e.target.value } })} />
          </label>
        )}
        </div>
        </details>
      </div>
      <div className="oj-qbar">
        <div className="seg" role="group" aria-label="报价单版本">
          <button type="button" className={view === 'self' ? 'on' : ''} onClick={() => setView('self')}>自用版</button>
          <button type="button" className={view === 'client' ? 'on' : ''} onClick={() => setView('client')}>客户版</button>
        </div>
        <div className="oj-qbtns">
          <button type="button" className="btn btn-sm" onClick={() => void copy()}><Ic name="paste" cls="ic ic-sm" />复制</button>
          <button type="button" className="btn btn-sm" onClick={download}><Ic name="doc" cls="ic ic-sm" />下载</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
          {note && <span className={`oj-qnote ${note.ok ? '' : 'bad'}`} role="status">{note.text}</span>}
        </div>
      </div>
      {view === 'client' || !summary ? <pre className="oj-qtext">{text}</pre> : (
        <div className="oj-self">
          {summary.alerts.map(a => <p key={a} className="oj-self-alert">{a}</p>)}
          <h4>这笔钱花在哪</h4>
          {summary.groups.map(g => (
            <div key={g.label} className="oj-self-row">
              <span>{g.label}</span>
              <b>{g.amount < 0 ? '−' : ''}¥{Math.abs(g.amount).toLocaleString('zh-CN')}</b>
              {g.detail && <small>{g.detail}</small>}
            </div>
          ))}
          <details className="oj-qmore">
            <summary>逐项算式</summary>
            <pre className="oj-qtext">{text}</pre>
          </details>
        </div>
      )}
      <details className="oj-hmore" style={{ marginTop: 12 }}>
        <summary>系统目前学到了什么</summary>
        <div className="faint small">{calib.notes.map(n => <span key={n}>{n}</span>)}</div>
      </details>
    </div>
  )
}

function Item({ item, mark }: { item: BriefItem; mark?: string }): JSX.Element {
  return (
    <li className="oj-item">
      <div className="oj-item-head">
        <b>{item.title}</b>
        <span className="oj-tag">{item.kind}</span>
        {mark && <span className="oj-flip">{mark}</span>}
      </div>
      {item.detail && <p>{item.detail}</p>}
      {item.reason && <p className="why">{item.reason}</p>}
      {item.unclear && <p className="unclear"><Ic name="alert" cls="ic ic-sm" />{item.unclear}</p>}
    </li>
  )
}

function DeleteProjectDialog({ project, onDelete, onClose }: {
  project: Project
  onDelete: (id: string) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const list = previous?.closest('.oj-rows')
    // 原生模态层负责隔离背景和键盘焦点，外观继续使用站内 dlg 样式
    element.showModal()
    cancel.current?.focus()
    return () => {
      element.close()
      if (previous?.isConnected) previous.focus()
      else (list?.isConnected ? list.querySelector<HTMLButtonElement>('.oj-row-main') : null)?.focus()
    }
  }, [])
  useEffect(() => { if (busy) dialog.current?.focus() }, [busy])

  const confirm = async (): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await onDelete(project.id)
      onClose()
    } catch (cause) {
      logClient('order-judge:delete', cause)
      setError(errorOf(cause).message)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return createPortal(
    <dialog ref={dialog} className="dlg oj-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="oj-delete-title" aria-describedby="oj-delete-description" aria-busy={busy} tabIndex={-1}
      onCancel={(event) => { event.preventDefault(); if (!submitting.current) onClose() }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (!first) { event.preventDefault(); event.currentTarget.focus() }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || submitting.current) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
      }}>
      <span className="tape tl sakura" />
      <button type="button" className="dlg-close" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭"><Ic name="x" cls="ic" /></button>
      <h2 id="oj-delete-title" className="dlg-title">删除项目</h2>
      <p className="oj-delete-name">{project.title}</p>
      <p id="oj-delete-description" className="dlg-sub">{project.versions.length} 个版本的需求清单、截图和附件一并删除，删除后不可恢复</p>
      <p className="oj-delete-error" role="alert">{error}</p>
      <div className="dlg-actions">
        <button ref={cancel} type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy}>{busy ? '删除中…' : '确认删除'}</button>
      </div>
    </dialog>, document.body,
  )
}

function GuestCard({ onLogin }: { onLogin: () => void }): JSX.Element {
  return (
    <>
      <div className="oj-head"><h1 className="title-sketch" style={{ fontSize: 34 }}>接单评估</h1></div>
      <section className="panel oj-guest">
        <span className="tape tl teal" />
        <img src="/assets/sagiri-avatar.webp" alt="" width={96} height={96} />
        <p className="font-hand" style={{ fontSize: 20, marginTop: 14 }}>登录后就能整理需求</p>
        <button type="button" className="btn btn-primary mt24" style={{ minWidth: 160 }} onClick={onLogin}>登录 / 注册</button>
      </section>
    </>
  )
}

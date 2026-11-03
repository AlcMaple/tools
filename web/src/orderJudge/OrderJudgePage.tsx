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
import { PRIORITIES, type BriefItem } from '../../shared/order-judge-brief'
import { parseBudget, type Expense } from '../../shared/order-judge-quote'
import { DISCOUNT_STEPS, MAX_EXPENSES, VERSION_STATUSES, buildSheet, clientText, normalizeQuote, selfText, type QuoteState } from '../../shared/order-judge-sheet'
import { imageTileCount, kindOf, prepareMaterials } from '../../shared/order-judge-prepare'
import { expandArchive, isArchive } from './archive'
import { readByokKey } from '../reviews/byok'
import type { JudgeState, Project, Version } from '../../shared/order-judge-api'
import { MAX_TEXT_CHARS, VERSION_LIMIT } from '../../shared/order-judge-api'
import {
  JudgeError, attachUrl, connectProvider, deleteProject, saveQuote, followJudgeChanges, imageUrl, loadState, logClient, organize, providerStatus,
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
    setTab('new')
  }

  const appendTo = (project: Project): void => {
    clearMaterials()
    setOutcome(null)
    setTarget(project)
    setTab('new')
    setMobileDetail(false)
    window.scrollTo({ top: 0 })
  }

  const run = async (): Promise<void> => {
    if (running) return
    const pre = precheck(text, materials.length)
    if (pre === 'empty') { setTip(true); return }
    if (pre === 'chat-record') { setOutcome({ kind: 'chat-record' }); return }
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
      const project = await organize(target?.id ?? null, prepared.text, prepared.images, prepared.attachments, (e) => {
        if (e.stage === 'links') { setLinkCount(e.count); setStage('links') } else setStage('ai')
      }, controller.signal)
      if (controller.signal.aborted) return
      setState((s) => (s ? { ...s, projects: [project, ...s.projects.filter(p => p.id !== project.id)] } : s))
      setTarget(project)
      setSelected(project.id)
      clearMaterials()
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
  const head = <Head tab={tab} onTab={(t) => { setTab(t); setMobileDetail(false) }} count={state ? state.projects.length : null} />
  const deleting = deleteTarget && <DeleteProjectDialog project={deleteTarget} onDelete={removeProject} onClose={() => setDeleteTarget(null)} />

  if (tab === 'projects') {
    const list = state?.projects ?? []
    const current = list.find((p) => p.id === selected) ?? list[0] ?? null
    const sheet = current && <ProjectSheet key={`${current.id}:${latest(current).n}`} project={current} onAppend={() => appendTo(current)} onSaved={replaceProject} />
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
      <div className={`oj-grid${flow ? ' flow' : ''}`}>
        <section
          className="panel oj-mat"
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
            {target && !running && <button type="button" className="btn btn-sm btn-ghost" onClick={startNew}>改为新项目</button>}
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
            <ProjectSheet key={`${outcome.project.id}:${latest(outcome.project).n}`} project={outcome.project} ms={outcome.ms} onSaved={replaceProject} />
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
            <ProjectSheet key={`${target.id}:${latest(target).n}`} project={target} onSaved={replaceProject} />
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

const hoursText = (h: number): string => `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`

// 一个项目：版本切换 + 这一版的需求清单 + 这一版放进来的材料
function ProjectSheet({ project, ms, onAppend, onSaved }: { project: Project; ms?: number; onAppend?: () => void; onSaved: (p: Project) => void }): JSX.Element {
  const [n, setN] = useState(latest(project).n)
  const version = project.versions.find(v => v.n === n) ?? latest(project)
  const b = version.brief
  const marks = new Map<string, string>()
  for (const c of version.changes) if (c.type !== 'removed') marks.set(c.id, c.type === 'added' ? '新增' : '有改动')
  const removed = version.changes.filter((c): c is Extract<typeof c, { type: 'removed' }> => c.type === 'removed')
  const meta = [`第 ${version.n} 版`, when(version.at), b.clientType, ms ? `用时 ${Math.round(ms / 1000)} 秒` : ''].filter(Boolean).join(' · ')
  const facts: [string, string][] = [['客户在意的结果', b.outcome], ['预算', b.budget], ['截止', b.deadline], ['不找你会怎么办', b.alternative]]
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
      {groups.map(g => (
        <div key={g.p} className="oj-sec">
          <h3><Ic name="check" />{g.p === '不做' ? '这次不做' : g.p}<span className="oj-sum">{hoursText(g.items.reduce((s, i) => s + i.hours, 0))}</span></h3>
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
      <QuotePanel key={version.id} project={project} version={version} onSaved={onSaved} />
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

const pct = (r: number): string => (r ? `${Math.round(r * 100)}%` : '不让')

// 报价：表单改动即时反映到下面的报价单，点保存才写回；复制 / 下载的就是当前看到的文字
function QuotePanel({ project, version, onSaved }: { project: Project; version: Version; onSaved: (p: Project) => void }): JSX.Element {
  const [draft, setDraft] = useState<QuoteState>(version.quote)
  const [budgetText, setBudgetText] = useState(version.quote.budget == null ? '' : String(version.quote.budget))
  const [view, setView] = useState<'client' | 'self'>('self')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (patch: Partial<QuoteState>): void => { setDraft(d => ({ ...d, ...patch })); setNote(null) }
  const versions = project.versions.map(v => ({ n: v.n, at: v.at, brief: v.brief, quote: v.id === version.id ? draft : v.quote }))
  const sheet = buildSheet(project.title, versions, version.n)
  const text = view === 'client' ? clientText(sheet) : selfText(sheet)
  const dirty = JSON.stringify(normalizeQuote(draft)) !== JSON.stringify(version.quote)
  const parsed = parseBudget(version.brief.budget)

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      onSaved(await saveQuote(version.id, normalizeQuote(draft)))
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
      <div className="oj-qform">
        <div className="oj-qrow">
          <span className="oj-qlabel">状态</span>
          <div className="seg" role="group" aria-label="状态">
            {VERSION_STATUSES.map(st => <button key={st} type="button" className={draft.status === st ? 'on' : ''} onClick={() => set({ status: st })}>{st}</button>)}
          </div>
        </div>
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
            <span className="oj-qlabel">预算</span>
            <input className="oj-qin" inputMode="numeric" value={budgetText} placeholder={parsed != null ? `材料里是 ${parsed}` : '待问'}
              onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); setBudgetText(v); set({ budget: v ? Number(v) : null }) }} />
            <span className="faint small">元</span>
          </label>
        )}
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
        <div className="oj-qrow">
          <span className="oj-qlabel">人情折让</span>
          <div className="seg" role="group" aria-label="人情折让">
            {DISCOUNT_STEPS.map(r => <button key={r} type="button" className={draft.discount.ratio === r ? 'on' : ''} onClick={() => set({ discount: { ...draft.discount, ratio: r } })}>{pct(r)}</button>)}
          </div>
        </div>
        {draft.discount.ratio > 0 && (
          <label className="oj-qrow">
            <span className="oj-qlabel">折让原因</span>
            <input className="oj-qin wide" value={draft.discount.reason} placeholder="同学、老客户第 3 单、换作品展示权" maxLength={60}
              onChange={e => set({ discount: { ...draft.discount, reason: e.target.value } })} />
          </label>
        )}
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
      <pre className="oj-qtext">{text}</pre>
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
        <span className="oj-item-h">{hoursText(item.hours)}</span>
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

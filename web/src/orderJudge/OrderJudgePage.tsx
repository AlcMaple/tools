// 网页版接单评估。设计稿：docs/design-mockups/web/接单评估.html
// 材料在浏览器里预处理（web/shared/order-judge-prepare.ts），服务端只收文字和 JPEG；
// DeepSeek 连接和助手共用同一条「自配 API」连接，在这里连上，助手那边也就连上了。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth'
import { Ic } from '../SketchIcon'
import { Select } from '../Select'
import { PasswordInput } from '../PasswordInput'
import { useIsWide } from '../useMediaQuery'
import { precheck, type JudgeReport } from '../../shared/order-judge'
import { decodeText, imageTileCount, kindOf, prepareMaterials } from '../../shared/order-judge-prepare'
import type { DocKind, DocMeta, HistoryEntry, JudgeState } from '../../shared/order-judge-api'
import {
  JudgeError, connectProvider, deleteEntry, imageUrl, judge, loadState, logClient, providerStatus, saveDoc,
  type ProviderStatus,
} from './api'

const DEFAULT_MODEL = 'deepseek-v4-flash-vision-exp'
const ACCEPT = 'image/*,video/*,.pdf,.doc,.docx,.rtf,.odt,.pages,.html,.htm,.txt,.md'
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

interface Material {
  id: number
  file: File
  thumb: string | null
  note: string
  bad: boolean
}

type Stage = 'prep' | 'links' | 'ai'
type Outcome =
  | { kind: 'report'; entry: HistoryEntry; ms?: number; links?: number }
  | { kind: 'chat-record' }
  | { kind: 'error'; code: string; message: string; at: number }

const VERDICT: Record<JudgeReport['verdict'], { stamp: string; cls: string; tape: string }> = {
  能: { stamp: '能接', cls: 'st-teal', tape: 'teal' },
  不能: { stamp: '不接', cls: 'st-sakura', tape: 'sakura' },
  信息不足: { stamp: '待补', cls: 'st-gold', tape: 'gold' },
}

const SETTINGS_CODES = new Set(['BYOK_REQUIRED', 'PROVIDER_CONNECTION_REQUIRED', 'PROVIDER_HTTP_401', 'NO_PROFILE'])

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

const sizeText = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

const errorOf = (e: unknown): { code: string; message: string } =>
  e instanceof JudgeError ? { code: e.code, message: e.message } : { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) }

export function OrderJudgePage({ onLogin }: { onLogin: () => void }): JSX.Element | null {
  const { user, ready } = useAuth()
  if (!ready) return null
  if (!user) return <GuestCard onLogin={onLogin} />
  return <JudgeWorkspace />
}

function Head({ tab, onTab, counts, gearDot, onGear }: {
  tab: 'judge' | 'hist'
  onTab: (t: 'judge' | 'hist') => void
  counts: { all: number; yes: number; no: number; info: number } | null
  gearDot: boolean
  onGear: () => void
}): JSX.Element {
  return (
    <div className="oj-head">
      <div>
        <h1 className="title-sketch" style={{ fontSize: 34 }}>接单评估</h1>
        {counts && counts.all > 0 && (
          <p className="muted small mt8 oj-tally oj-desk">
            {counts.all} 单 · 能接 <b>{counts.yes}</b> · 不接 <b>{counts.no}</b> · 待补 <b>{counts.info}</b>
          </p>
        )}
      </div>
      <div className="tools">
        <div className="seg oj-desk" role="group" aria-label="视图">
          <button type="button" className={tab === 'judge' ? 'on' : ''} onClick={() => onTab('judge')}>评估</button>
          <button type="button" className={tab === 'hist' ? 'on' : ''} onClick={() => onTab('hist')}>
            历史{counts ? <span className="n">{counts.all}</span> : null}
          </button>
        </div>
        <div className="oj-mob oj-mode">
          <Select
            options={[{ id: 'judge', text: '评估' }, { id: 'hist', text: counts ? `历史 · ${counts.all}` : '历史' }]}
            value={tab}
            onChange={(id) => onTab(id === 'hist' ? 'hist' : 'judge')}
            placeholder="评估"
          />
        </div>
        <button type="button" className={`icon-btn oj-gear${gearDot ? ' dot' : ''}`} title="评估设置" aria-label="评估设置" onClick={onGear}>
          <Ic name="settings" />
        </button>
      </div>
    </div>
  )
}

function JudgeWorkspace(): JSX.Element {
  const [tab, setTab] = useState<'judge' | 'hist'>('judge')
  const [state, setState] = useState<JudgeState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [provider, setProvider] = useState<ProviderStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  const [mobileDetail, setMobileDetail] = useState(false)
  const wide = useIsWide()
  const nextId = useRef(1)
  const shotNo = useRef(1)
  const fileInput = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const materialsRef = useRef<Material[]>([])
  materialsRef.current = materials

  const refreshProvider = useCallback(() => {
    providerStatus().then(setProvider).catch((e: unknown) => {
      logClient('order-judge:provider', e)
      setProvider(null)
    })
  }, [])

  useEffect(() => {
    loadState().then(setState).catch((e: unknown) => setLoadError(errorOf(e).message))
    refreshProvider()
    return () => {
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

  const connected = provider?.ready === true && provider.source === 'byok'
  const configured = connected && Boolean(state?.docs.profile)

  const addFiles = useCallback((files: File[]) => {
    const fresh: Material[] = files.map((file) => {
      const kind = kindOf(file)
      const probe = kind === 'video' ? document.createElement('video').canPlayType(file.type || 'video/mp4') : 'maybe'
      return {
        id: nextId.current++,
        file,
        thumb: kind === 'image' ? URL.createObjectURL(file) : null,
        note: kind === 'video' && probe ? '12 帧' : '',
        bad: kind === 'other' || (kind === 'video' && !probe),
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
    if (tab !== 'judge' || settingsOpen) return
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
        const target = document.activeElement as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
        e.preventDefault()
        setText((t) => (t ? `${t}\n${pasted}` : pasted))
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [tab, settingsOpen, running, addFiles])

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

  const clearAll = (): void => {
    for (const m of materials) if (m.thumb) URL.revokeObjectURL(m.thumb)
    setMaterials([])
    setText('')
    setOutcome(null)
  }

  const run = async (): Promise<void> => {
    if (running) return
    const pre = precheck(text, materials.length)
    if (pre === 'empty') { setTip(true); return }
    if (pre === 'chat-record') { setOutcome({ kind: 'chat-record' }); return }
    if (!configured) { setSettingsOpen(true); return }
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
    // 平板 / 手机整页切到评估过程，回到页顶看进度
    if (!wide) window.scrollTo({ top: 0 })
    let links = 0
    try {
      const prepared = await prepareMaterials(text, materials.map((m) => m.file), {
        pdfText: async (file) => (await import('./pdf')).pdfText(file),
        onError: logClient,
      })
      if (prepared.unreadable.length) {
        setMaterials((list) => list.map((m) => (prepared.unreadable.includes(m.file.name) ? { ...m, bad: true, note: '读不了' } : m)))
      }
      setPrepStats(prepared.stats.join(' · '))
      const entry = await judge(prepared.text, prepared.images, (e) => {
        if (e.stage === 'links') { links = e.count; setLinkCount(e.count); setStage('links') } else setStage('ai')
      }, controller.signal)
      if (controller.signal.aborted) return
      setState((s) => (s ? { ...s, history: [entry, ...s.history].slice(0, 50) } : s))
      setOutcome({ kind: 'report', entry, ms: Date.now() - t0, links })
    } catch (e) {
      if (controller.signal.aborted) return
      const { code, message } = errorOf(e)
      if (code === 'NETWORK') logClient('order-judge:judge', e)
      setOutcome({ kind: 'error', code, message, at: Date.now() })
      if (code === 'PROVIDER_CONNECTION_REQUIRED' || code === 'BYOK_REQUIRED' || code === 'PROVIDER_HTTP_401') refreshProvider()
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

  const removeEntry = async (id: string): Promise<void> => {
    try {
      await deleteEntry(id)
      setState((s) => (s ? { ...s, history: s.history.filter((h) => h.id !== id) } : s))
      if (selected === id) { setSelected(null); setMobileDetail(false) }
    } catch (e) {
      setLoadError(errorOf(e).message)
    }
  }

  const restore = async (entry: HistoryEntry): Promise<void> => {
    for (const m of materials) if (m.thumb) URL.revokeObjectURL(m.thumb)
    setMaterials([])
    setText(entry.order)
    setOutcome(null)
    setTab('judge')
    setMobileDetail(false)
    window.scrollTo({ top: 0 })
    try {
      const files = await Promise.all(entry.images.map(async (img) => {
        const res = await fetch(imageUrl(entry.id, img.file), { credentials: 'same-origin' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return new File([await res.blob()], `${img.name}.jpg`, { type: 'image/jpeg' })
      }))
      addFiles(files)
    } catch (e) {
      logClient('order-judge:restore', e)
      setOutcome({ kind: 'error', code: 'RESTORE_FAILED', message: '当时的图片没取回来，文字已经放回去了。', at: Date.now() })
    }
  }

  // 平板 / 手机：评估中和出结论后不显示编辑区（CSS 只在 ≤960px 生效，桌面仍是两栏）
  const flow = running || outcome !== null

  const counts = state ? {
    all: state.history.length,
    yes: state.history.filter((h) => h.report.verdict === '能').length,
    no: state.history.filter((h) => h.report.verdict === '不能').length,
    info: state.history.filter((h) => h.report.verdict === '信息不足').length,
  } : null

  const noProfile = Boolean(state && !state.docs.profile)
  const missing = !connected && noProfile ? '还没有连接 DeepSeek Key，也还没上传能力档案'
    : !connected ? 'DeepSeek Key 还没有连接' : noProfile ? '还没有上传能力档案' : ''
  const head = (
    <Head
      tab={tab}
      onTab={(t) => { setTab(t); setMobileDetail(false) }}
      counts={counts}
      gearDot={Boolean(missing)}
      onGear={() => setSettingsOpen(true)}
    />
  )

  const settings = settingsOpen && state && (
    <SettingsDialog
      docs={state.docs}
      provider={provider}
      onDocs={(docs) => setState((s) => (s ? { ...s, docs } : s))}
      onProvider={setProvider}
      onClose={() => { setSettingsOpen(false); refreshProvider() }}
    />
  )

  if (tab === 'hist') {
    const list = state?.history ?? []
    const current = list.find((h) => h.id === selected) ?? list[0] ?? null
    return (
      <>
        {head}
        {loadError && <p className="nag mt16"><Ic name="alert" />{loadError}</p>}
        {list.length === 0 ? (
          <section className="panel oj-sheet blank mt24"><p className="muted">还没有评估过的派单</p></section>
        ) : !wide && mobileDetail && current ? (
          <div className="oj-hist">
            <button type="button" className="oj-back" onClick={() => setMobileDetail(false)}><Ic name="back" />返回历史</button>
            <ReportSheet entry={current} onRestore={() => void restore(current)} />
          </div>
        ) : (
          <div className="oj-hist">
            <section className="panel oj-rows">
              <span className="tape tl lav" />
              {list.map((h) => {
                const v = VERDICT[h.report.verdict]
                return (
                  <div key={h.id} className={`oj-row${current?.id === h.id ? ' on' : ''}`}>
                    <button type="button" className="oj-row-main" onClick={() => { setSelected(h.id); setMobileDetail(true) }}>
                      <span className={`stamp small ${v.cls}`}>{v.stamp}</span>
                      <span className="t">
                        <b>{h.report.title || h.report.headline || '（没有标题）'}</b>
                        <span>{when(h.at)}{h.images.length ? ` · ${h.images.length} 张图` : ''}</span>
                      </span>
                    </button>
                    <button type="button" className="del" title="删除这条" aria-label="删除这条" onClick={() => void removeEntry(h.id)}>
                      <Ic name="trash" cls="ic ic-sm" />
                    </button>
                  </div>
                )
              })}
            </section>
            {current && <div className="oj-desk"><ReportSheet entry={current} onRestore={() => void restore(current)} /></div>}
          </div>
        )}
        {settings}
      </>
    )
  }

  return (
    <>
      {head}
      {state && missing && (
        <div className="nag mt16">
          <Ic name="alert" />
          {missing}，评估前要先填好
          <button type="button" className="btn btn-sm" onClick={() => setSettingsOpen(true)}>去填写</button>
        </div>
      )}
      {loadError && <p className="nag mt16"><Ic name="alert" />{loadError}</p>}
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
          <div className="panel-title"><Ic name="clip" />派单材料</div>
          <div className={`oj-drop${drag ? ' drag' : ''}`}>
            <textarea
              ref={textRef}
              className="oj-text"
              value={text}
              disabled={running}
              placeholder="把派单的文字、网址贴在这里"
              onChange={(e) => setText(e.target.value)}
            />
            <div className="oj-over"><Ic name="clip" />松手放入</div>
          </div>
          {materials.length > 0 && (
            <div className="oj-files">
              {materials.map((m) => {
                const kind = kindOf(m.file)
                return (
                  <div key={m.id} className={`oj-file${m.bad ? ' bad' : ''}`} title={m.file.name}>
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
              <button type="button" className="btn btn-sm btn-ghost" disabled={running} onClick={clearAll}>清空</button>
            )}
            <span className="go">
              <button type="button" className="btn btn-primary oj-go" disabled={running} onClick={() => void run()}>
                {running ? `评估中 ${sec}s` : <><Ic name="judge" />评估</>}
              </button>
              {tip && <span className="bubble oj-tip" role="status">还没有放入内容</span>}
            </span>
          </div>
          <details className="oj-how" open={!text && materials.length === 0 ? true : undefined}>
            <summary><Ic name="chev" cls="ic ic-sm" />不同材料怎么放</summary>
            <dl>
              <dt>文字、截图</dt>
              <dd>
                <span className="oj-desk">{isMac ? '⌘V' : 'Ctrl+V'} 粘贴，可以连续粘贴多张。</span>
                <span className="oj-mob">截图后点「粘贴」，可以连续粘贴多张。</span>
                转发的聊天记录要点开后截图，直接复制只会得到「[聊天记录]」。
              </dd>
              <dt>网址</dt><dd>以文字贴进输入框，会读取网页标题和正文开头，每单最多 10 个。截图里的网址不会被打开。</dd>
              <dt>在线表格、文档</dt><dd>公开的腾讯文档能读到首屏的一部分文字，每张工作表的网址不同，要哪张贴哪张。表格很长时，把关键行截图一起放进来。</dd>
              <dt>要登录的网页</dt><dd>飞书、钉钉、小红书等打不开，请截图或截长图后粘贴。</dd>
              <dt>视频</dt><dd>均匀取 12 帧画面，听不到声音，口头讲的需求请补一段文字。</dd>
              <dt>PDF、Word</dt><dd>只读文字。扫描版 PDF 和文档里的图片读不到，重要的图请单独截图。</dd>
            </dl>
          </details>
        </section>
        <div className="oj-result">
          {flow && !running && (
            <div className="oj-flowbar">
              <button type="button" className="oj-back" onClick={() => setOutcome(null)}><Ic name="back" />返回修改</button>
              <button type="button" className="btn btn-sm" onClick={clearAll}>再评一单</button>
            </div>
          )}
          {running && <Brief text={text} materials={materials} />}
          {running ? (
            <section className="panel oj-sheet">
              <span className="tape tr gold" />
              <p className="oj-meta">开始于 {when(startedAt).replace(/^今天 /, '')}</p>
              <p className="oj-headline" style={{ paddingRight: 0 }}>正在对照能力档案和项目日志…</p>
              <ol className="oj-steps">
                <Step state={stage === 'prep' ? 'run' : 'done'} title="整理材料" sub={prepStats} />
                {(stage === 'links' || linkCount > 0) && <Step state={stage === 'links' ? 'run' : 'done'} title="打开网址" sub={`${linkCount} 个`} />}
                <Step state={stage === 'ai' ? 'run' : 'wait'} title={stage === 'ai' ? 'AI 判断中' : 'AI 判断'} sub={stage === 'ai' ? '一般 20～60 秒' : ''} />
              </ol>
              <div className="oj-cancel">
                <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}><Ic name="x" cls="ic ic-sm" />取消评估</button>
              </div>
            </section>
          ) : outcome?.kind === 'report' ? (
            <ReportSheet entry={outcome.entry} ms={outcome.ms} links={outcome.links} />
          ) : outcome?.kind === 'chat-record' ? (
            <section className="panel oj-sheet">
              <span className="tape tl gold" />
              <span className="stamp oj-verdict st-gold pop">待补</span>
              <p className="oj-meta">刚刚</p>
              <p className="oj-headline">只看到「[聊天记录]」几个字，读不到派单内容</p>
              <div className="oj-sec">
                <h3><Ic name="edit" />怎么补</h3>
                <ol className="oj-list warn">
                  <li><span>转发的聊天记录要先点开，再截图粘贴进来；直接复制只会得到「[聊天记录]」。</span></li>
                  <li><span>{isMac ? '⌘V' : 'Ctrl+V'} 或「粘贴」把截图放进来，可以连续粘贴多张。</span></li>
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
                  <button type="button" className="btn btn-sm" onClick={() => setSettingsOpen(true)}><Ic name="settings" cls="ic ic-sm" />打开评估设置</button>
                </div>
              )}
            </section>
          ) : (
            <section className="panel oj-sheet blank oj-blank">
              <div className="empty" style={{ padding: '10px 0' }}>
                <img src="/assets/sagiri-avatar.webp" alt="" width={84} height={84} className="oj-avatar" />
                <div className="empty-say"><span className="bubble empty-bubble">材料放好后点「评估」，结论会写在这里。</span></div>
              </div>
            </section>
          )}
          {flow && !running && <Brief text={text} materials={materials} fold />}
        </div>
      </div>
      {settings}
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
        <summary><Ic name="clip" />这单的材料<span className="meta">{meta}</span><Ic name="chev" cls="ic ic-sm" /></summary>
        {text && <p className="ex">{text}</p>}
        {strip}
      </details>
    )
  }
  return (
    <section className="panel oj-brief">
      <span className="tape tl teal" />
      <div className="panel-title" style={{ marginBottom: 8 }}><Ic name="clip" />这单的材料<span className="faint small" style={{ marginLeft: 'auto' }}>{meta}</span></div>
      {text && <p className="ex">{text}</p>}
      {strip}
    </section>
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

function ReportSheet({ entry, ms, links, onRestore }: { entry: HistoryEntry; ms?: number; links?: number; onRestore?: () => void }): JSX.Element {
  const r = entry.report
  const v = VERDICT[r.verdict]
  const meta = [when(entry.at), entry.images.length ? `${entry.images.length} 张图` : '', links ? `${links} 个网址` : '', ms ? `用时 ${Math.round(ms / 1000)} 秒` : '']
    .filter(Boolean).join(' · ')
  const gapTitle = r.verdict === '能' ? '可能翻车的地方' : '卡在哪一步'
  return (
    <section className="panel oj-sheet">
      <span className={`tape tl ${v.tape}`} />
      <span key={entry.id} className={`stamp oj-verdict ${v.cls} pop`}>{v.stamp}</span>
      <p className="oj-meta">{meta}</p>
      <p className="oj-headline">{r.headline || r.title}</p>
      {r.summary && <p className="oj-summary">{r.summary}</p>}
      {onRestore && entry.images.length > 0 && (
        <div className="oj-thumbs">
          {entry.images.map((img) => (
            <a key={img.file} href={imageUrl(entry.id, img.file)} target="_blank" rel="noreferrer" title={img.name}>
              <img src={imageUrl(entry.id, img.file)} alt={img.name} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {r.risk && <p className="oj-risk"><Ic name="alert" /><span>{r.risk}</span></p>}
      {r.reasons.length > 0 && (
        <div className="oj-sec">
          <h3><Ic name="check" />为什么</h3>
          <ol className="oj-list">
            {r.reasons.map((x, i) => <li key={i}><p>{x.title && <b>{x.title}</b>}<span>{x.title ? '：' : ''}{x.detail}</span></p></li>)}
          </ol>
        </div>
      )}
      {r.gaps.length > 0 && (
        <div className="oj-sec">
          <h3><Ic name="alert" />{gapTitle}</h3>
          <ol className="oj-list warn">
            {r.gaps.map((x, i) => <li key={i}><p>{x.step && <b>{x.step}</b>}<span>{x.step ? '：' : ''}{x.detail}</span></p></li>)}
          </ol>
        </div>
      )}
      {r.questions.length > 0 && (
        <div className="oj-sec">
          <h3><Ic name="user" />接单前先问清楚</h3>
          <ul className="oj-q">
            {r.questions.map((q, i) => {
              const flip = /[（(]可能改判[）)]\s*$/.test(q)
              return <li key={i}><span>{q.replace(/\s*[（(]可能改判[）)]\s*$/, '')}</span>{flip && <span className="oj-flip">可能改判</span>}</li>
            })}
          </ul>
        </div>
      )}
      {onRestore && (
        <div className="oj-acts">
          <button type="button" className="btn btn-sm" onClick={onRestore}><Ic name="refresh" cls="ic ic-sm" />放回材料区重新评估</button>
        </div>
      )}
    </section>
  )
}

function SettingsDialog({ docs, provider, onDocs, onProvider, onClose }: {
  docs: Record<DocKind, DocMeta | null>
  provider: ProviderStatus | null
  onDocs: (d: Record<DocKind, DocMeta | null>) => void
  onProvider: (p: ProviderStatus) => void
  onClose: () => void
}): JSX.Element {
  const [key, setKey] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [busy, setBusy] = useState<'key' | DocKind | null>(null)
  const [keyError, setKeyError] = useState('')
  const [notice, setNotice] = useState<{ text: string; err: boolean } | null>(null)
  const pick = useRef<Record<DocKind, HTMLInputElement | null>>({ profile: null, log: null })
  const connected = provider?.ready === true && provider.source === 'byok'

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 2400)
    return () => window.clearTimeout(t)
  }, [notice])

  const connect = async (): Promise<void> => {
    const credential = key.trim()
    if (!credential || busy) return
    setBusy('key')
    setKeyError('')
    const profile = provider?.profiles?.find((p) => p.model === DEFAULT_MODEL) ?? provider?.profiles?.[0]
    try {
      onProvider(await connectProvider(profile?.endpoint ?? 'https://api.deepseek.com', profile?.model ?? DEFAULT_MODEL, credential))
      setKey('')
      setEditingKey(false)
      setNotice({ text: '已连接', err: false })
    } catch (e) {
      setKeyError(errorOf(e).message)
    } finally {
      setBusy(null)
    }
  }

  const upload = async (kind: DocKind, file: File): Promise<void> => {
    setBusy(kind)
    try {
      const content = decodeText(await file.arrayBuffer())
      onDocs(await saveDoc(kind, file.name, content))
      setNotice({ text: '已保存', err: false })
    } catch (e) {
      setNotice({ text: errorOf(e).message, err: true })
    } finally {
      setBusy(null)
    }
  }

  const docRow = (kind: DocKind, label: string): JSX.Element => {
    const d = docs[kind]
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <div className={`oj-doc${d ? '' : ' empty-doc'}`}>
          <Ic name="doc" />
          <span className="t">
            {d ? <><b>{d.name}</b><span>{sizeText(d.size)} · {when(d.updatedAt)} 上传</span></> : '还没有上传'}
          </span>
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => pick.current[kind]?.click()}>
            {busy === kind ? '上传中…' : d ? '更换' : '上传 .md'}
          </button>
          <input
            ref={(el) => { pick.current[kind] = el }}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void upload(kind, f)
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="dlg-backdrop open oj-set-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label="评估设置" className="dlg oj-set-dlg">
        <div className="oj-grip" aria-hidden="true" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭"><Ic name="x" cls="ic" /></button>
        <h2 className="dlg-title">评估设置</h2>
        <div className="oj-set">
          <div className={`field${keyError ? ' err' : ''}`}>
            <span className="field-label">DeepSeek Key</span>
            {connected && !editingKey ? (
              <div className="oj-doc">
                <Ic name="check" />
                <span className="t"><b>已连接</b><span>{provider?.model}</span></span>
                <button type="button" className="btn btn-sm" onClick={() => setEditingKey(true)}>换 Key</button>
              </div>
            ) : (
              <div className="oj-key">
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <PasswordInput value={key} onChange={setKey} placeholder="sk-..." autoComplete="off" />
                  <span className={`field-msg${keyError ? ' show' : ''}`} role="status">{keyError}</span>
                </div>
                <button type="button" className="btn btn-sm btn-primary" disabled={!key.trim() || busy !== null} onClick={() => void connect()}>
                  {busy === 'key' ? '连接中…' : '连接'}
                </button>
              </div>
            )}
          </div>
          {docRow('profile', '能力档案')}
          {docRow('log', '项目日志')}
          <div className="oj-set-foot">
            {notice && <span className={`oj-saved${notice.err ? ' err' : ''}`} role="status">{!notice.err && <Ic name="check" cls="ic ic-sm" />}{notice.text}</span>}
            <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>完成</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function GuestCard({ onLogin }: { onLogin: () => void }): JSX.Element {
  return (
    <>
      <div className="oj-head"><h1 className="title-sketch" style={{ fontSize: 34 }}>接单评估</h1></div>
      <section className="panel oj-guest">
        <span className="tape tl teal" />
        <img src="/assets/sagiri-avatar.webp" alt="" width={96} height={96} />
        <p className="font-hand" style={{ fontSize: 20, marginTop: 14 }}>登录后就能评估派单</p>
        <p className="muted small mt8">能力档案、项目日志和评估记录都跟着账号走。</p>
        <button type="button" className="btn btn-primary mt24" style={{ minWidth: 160 }} onClick={onLogin}>登录 / 注册</button>
      </section>
    </>
  )
}

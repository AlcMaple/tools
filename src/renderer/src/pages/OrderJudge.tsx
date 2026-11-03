// 桌面版接单评估：材料 → 需求清单，与网页版同一个账号、同一份项目。方案见 docs/ideas/021-接单评估重新定位.md
import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import { ipcErrMsg } from '../utils/ipcError'
import { reportError } from '../utils/reportError'
import { VIDEO_FRAMES, precheck } from '../../../../web/shared/order-judge'
import { PRIORITIES, WORK_KINDS, type BriefItem } from '../../../../web/shared/order-judge-brief'
import { VERSION_LIMIT, type Project, type Version } from '../../../../web/shared/order-judge-api'
import { parseBudget, type Expense } from '../../../../web/shared/order-judge-quote'
import { BONUS_RESULTS, CONFIDENCE_STEPS, DISCOUNT_STEPS, FEELINGS, bonusAllowed, type BonusTerms, MAX_EXPENSES, OUTCOMES, VERSION_STATUSES, buildSheet, calibrate, clientText, freeze, normalizeQuote, selfText, type Calibration, type QuoteState } from '../../../../web/shared/order-judge-sheet'
import { imageTileCount, kindOf, prepareMaterials } from '../utils/orderJudgePrepare'
import type { OrderJudgeView } from '../types/orderJudge'

const IS_MAC = navigator.userAgent.includes('Mac')
const PASTE_KEY = IS_MAC ? '⌘V' : 'Ctrl+V'
const SHOT_KEY = IS_MAC ? '⌃⌘A' : 'Alt+A'

interface Material {
  id: number
  file: File
  preview?: string
  note?: string
}

type Outcome =
  | { type: 'done'; projectId: string; ms: number }
  | { type: 'precheck' }
  | { type: 'error'; code: string; detail: string }

interface Running {
  startedAt: number
  stage: 'prepare' | 'links' | 'ai'
  stats: string[]
  links: number
}

let nextId = 1

function formatWhen(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `昨天 ${hm}`
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md}`
}

const latest = (p: Project): Version => p.versions[p.versions.length - 1]
const hoursText = (h: number): string => `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// ── 需求清单 ──

function Section({ label, icon, aside, children }: { label: string; icon?: string; aside?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-6 py-5 border-t border-outline-variant/20">
      <p className="mb-3 flex items-center gap-1.5 font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/70">
        {icon && <span className="material-symbols-outlined text-[16px] leading-none">{icon}</span>}
        {label}
        {aside && <span className="ml-auto normal-case tracking-normal font-normal tabular-nums">{aside}</span>}
      </p>
      {children}
    </div>
  )
}

function Item({ item, mark }: { item: BriefItem; mark?: string }): JSX.Element {
  return (
    <li className="grid gap-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[14px] font-bold text-on-surface">{item.title}</span>
        <span className="rounded-lg bg-surface-container-highest px-1.5 py-px font-label text-[11px] text-on-surface-variant">{item.kind}</span>
        {mark && <span className="rounded-lg bg-primary/10 px-1.5 py-px font-label text-[11px] font-bold text-primary">{mark}</span>}
        <span className="ml-auto shrink-0 font-label text-xs text-on-surface-variant tabular-nums">{hoursText(item.hours)}</span>
      </div>
      {item.detail && <p className="text-[14px] leading-relaxed text-on-surface-variant">{item.detail}</p>}
      {item.reason && <p className="text-xs leading-relaxed text-on-surface-variant/70">{item.reason}</p>}
      {item.unclear && (
        <p className="flex items-start gap-1 text-xs leading-relaxed text-amber">
          <span className="material-symbols-outlined text-[14px] leading-none mt-0.5">help</span>{item.unclear}
        </p>
      )}
    </li>
  )
}

function ProjectSheet({ project, base, ms, onAppend, onDelete, onClose, onSaved, calib }: {
  project: Project
  base: string
  onSaved: (p: Project) => void
  calib: Calibration
  ms?: number
  onAppend?: () => void
  onDelete?: () => void
  onClose?: () => void
}): JSX.Element {
  const [n, setN] = useState(latest(project).n)
  useEffect(() => setN(latest(project).n), [project])
  const version = project.versions.find(v => v.n === n) ?? latest(project)
  const b = version.brief
  const marks = new Map<string, string>()
  for (const c of version.changes) if (c.type !== 'removed') marks.set(c.id, c.type === 'added' ? '新增' : '有改动')
  const removed = version.changes.filter((c): c is Extract<typeof c, { type: 'removed' }> => c.type === 'removed')
  const meta = [`第 ${version.n} 版`, formatWhen(version.at), b.clientType, ms ? `用时 ${Math.round(ms / 1000)} 秒` : ''].filter(Boolean).join(' · ')
  const facts: [string, string][] = [['客户在意的结果', b.outcome], ['预算', b.budget], ['截止', b.deadline], ['不找你会怎么办', b.alternative]]
  const groups = PRIORITIES.map(p => ({ p, items: b.items.filter(i => i.priority === p) })).filter(g => g.items.length)
  const tool = 'h-8 px-2.5 rounded-xl hover:bg-surface-container-high hover:text-on-surface flex items-center gap-1'
  return (
    <article className="animate-fade-up overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-low">
      <div className="h-1 bg-primary" />
      <div className="flex items-center gap-3 px-6 pt-4 font-label text-xs text-on-surface-variant/70">
        {project.versions.length > 1 && (
          <div className="flex gap-1" role="tablist" aria-label="版本">
            {project.versions.map(v => (
              <button key={v.n} type="button" role="tab" aria-selected={v.n === version.n} onClick={() => setN(v.n)}
                className={`h-7 min-w-[36px] px-2 rounded-lg font-bold tabular-nums ${v.n === version.n ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface-variant hover:text-on-surface'}`}>v{v.n}</button>
            ))}
          </div>
        )}
        <span className="flex items-center gap-1 ml-auto">
          {onAppend && project.versions.length < VERSION_LIMIT && (
            <button type="button" onClick={onAppend} className={tool}><span className="material-symbols-outlined text-[16px] leading-none">edit_note</span>追加需求</button>
          )}
          {onDelete && (
            <button type="button" onClick={onDelete} className={`${tool} hover:text-error`}><span className="material-symbols-outlined text-[16px] leading-none">delete</span>删除这个项目</button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className={tool}><span className="material-symbols-outlined text-[16px] leading-none">close</span>收起</button>
          )}
        </span>
      </div>
      <div className="px-6 pt-3 pb-5">
        <p className="font-label text-xs text-on-surface-variant/70 tabular-nums">{meta}</p>
        <p className="mt-1 text-[17px] font-bold leading-snug text-on-surface">{b.title || project.title}</p>
        <dl className="mt-4 grid grid-cols-2 gap-3">
          {facts.map(([k, v]) => (
            <div key={k} className="rounded-xl bg-surface-container-high px-4 py-3">
              <dt className="font-label text-[11px] text-on-surface-variant/70">{k}</dt>
              <dd className={`mt-0.5 text-[14px] leading-relaxed ${v ? 'text-on-surface' : 'text-amber'}`}>{v || '待问'}</dd>
            </div>
          ))}
        </dl>
      </div>
      {groups.map(g => (
        <Section key={g.p} label={g.p === '不做' ? '这次不做' : g.p} aside={hoursText(g.items.reduce((s, i) => s + i.hours, 0))}>
          <ul className="grid gap-4">{g.items.map(item => <Item key={item.id} item={item} mark={marks.get(item.id)} />)}</ul>
        </Section>
      ))}
      {removed.length > 0 && (
        <Section label="这一版去掉了" icon="remove_circle">
          <ul className="grid gap-1.5 text-[14px] text-on-surface-variant line-through decoration-on-surface-variant/40">{removed.map(r => <li key={r.id}>{r.title}</li>)}</ul>
        </Section>
      )}
      {b.excluded.length > 0 && (
        <Section label="不包含" icon="block">
          <ul className="grid gap-1.5 text-[14px] text-on-surface-variant">{b.excluded.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </Section>
      )}
      {b.questions.length > 0 && (
        <Section label="要问客户的">
          <ul className="grid gap-2">
            {b.questions.map((q, i) => (
              <li key={i} className="grid grid-cols-[22px_1fr] gap-2 text-[14px] leading-relaxed text-on-surface-variant">
                <span className="mt-1 w-[18px] h-[18px] rounded-[9999px] bg-surface-container-highest grid place-items-center font-label text-[11px] font-bold text-on-surface-variant/70">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <QuotePanel key={version.id} project={project} version={version} onSaved={onSaved} calib={calib} />
      {(version.text || version.images.length > 0 || version.files.length > 0) && (
        <Section label={`第 ${version.n} 版放进来的材料`}>
          {version.text && <p className="mb-3 text-[13px] leading-relaxed text-on-surface-variant line-clamp-4 whitespace-pre-wrap">{version.text}</p>}
          {version.images.length > 0 && base && (
            <div className="flex flex-wrap gap-2">
              {version.images.map(img => (
                <img key={img.file} src={`${base}/${version.id}/${img.file}`} alt={img.name} title={img.name} className="w-[92px] h-[68px] rounded-xl object-cover bg-surface-container-highest" />
              ))}
            </div>
          )}
          {version.files.length > 0 && (
            <ul className="mt-3 grid gap-1 text-[13px] text-on-surface-variant">
              {version.files.map(f => (
                <li key={f.file} className="flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px] leading-none">attach_file</span>{f.name}</li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </article>
  )
}

const BONUS_INPUTS: [keyof BonusTerms, string, string][] = [
  ['metric', '看什么', '下单转化率、大促不掉单、退货率'],
  ['baseline', '现在', '改之前的数，如 1.2%'],
  ['target', '目标', '如 2%'],
  ['verify', '怎么算达标', '用哪里的数据、怎么算'],
  ['period', '考核期', '如上线后 3 个月'],
]

const pct = (r: number): string => (r ? `${Math.round(r * 100)}%` : '不让')

function Seg<T extends string | number>({ label, options, value, text, onPick }: { label: string; options: readonly T[]; value: T; text?: (v: T) => string; onPick: (v: T) => void }): JSX.Element {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl bg-surface-container-high p-0.5">
      {options.map(o => (
        <button key={String(o)} type="button" onClick={() => onPick(o)}
          className={`h-7 px-3 rounded-lg font-label text-xs ${o === value ? 'bg-primary text-on-primary font-bold' : 'text-on-surface-variant hover:text-on-surface'}`}>{text ? text(o) : String(o)}</button>
      ))}
    </div>
  )
}

const qInput = 'h-8 w-24 rounded-lg border border-outline-variant/40 bg-surface-container-high px-2.5 text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant/50 focus:border-primary'

// 与网页版 QuotePanel 同一套计算和文字（web/shared/order-judge-sheet.ts）；表单改动即时反映到报价单，点保存才写回网站
function QuotePanel({ project, version, onSaved, calib }: { project: Project; version: Version; onSaved: (p: Project) => void; calib: Calibration }): JSX.Element {
  const [draft, setDraft] = useState<QuoteState>(version.quote)
  const [budgetText, setBudgetText] = useState(version.quote.budget == null ? '' : String(version.quote.budget))
  const [view, setView] = useState<'自用版' | '客户版'>('自用版')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const set = (patch: Partial<QuoteState>): void => { setDraft(d => ({ ...d, ...patch })); setNote(null) }
  const setBonus = (patch: Partial<BonusTerms>): void => { setDraft(d => ({ ...d, bonus: { ...d.bonus, ...patch } })); setNote(null) }
  const pending = freeze(normalizeQuote(draft), calib.settings)
  const sheet = buildSheet(project.title, project.versions.map(v => ({ n: v.n, at: v.at, brief: v.brief, quote: v.id === version.id ? pending : v.quote })), version.n, calib.settings)
  const text = view === '客户版' ? clientText(sheet) : selfText(sheet, calib)
  const dirty = JSON.stringify(pending) !== JSON.stringify(version.quote)
  const kinds = WORK_KINDS.filter(k => sheet.chosen?.lines.some(l => l.work === k))
  const parsed = parseBudget(version.brief.budget)
  const expenses = draft.expenses.length < MAX_EXPENSES ? [...draft.expenses, { name: '', amount: 0 }] : draft.expenses
  const setExpense = (i: number, patch: Partial<Expense>): void => set({ expenses: expenses.map((e, j) => (j === i ? { ...e, ...patch } : e)).filter(e => e.name || e.amount) })

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await window.orderJudgeApi.saveQuote(version.id, pending)
      onSaved(saved)
      setDraft(saved.versions.find(x => x.id === version.id)?.quote ?? pending)
      setNote({ ok: true, text: '已保存' })
    } catch (e) {
      reportError('order-judge:quote', e)
      setNote({ ok: false, text: ipcErrMsg(e, '没有保存上') })
    } finally { setBusy(false) }
  }
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setNote({ ok: true, text: '已复制' }) } catch (e) { reportError('order-judge:copy', e); setNote({ ok: false, text: '复制失败，请手动选中文字复制' }) }
  }
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.title}-第${version.n}版-${view === '客户版' ? '报价单' : '自用'}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const row = 'flex flex-wrap items-center gap-3'
  const label = 'w-24 shrink-0 font-label text-xs text-on-surface-variant'
  const tool = 'h-8 px-3 rounded-xl bg-surface-container-high text-xs text-on-surface-variant hover:text-on-surface flex items-center gap-1 disabled:opacity-50'

  return (
    <Section label={sheet.base ? `变更单 · 基于第 ${sheet.base.n} 版` : '报价'} icon="request_quote">
      <div className="grid gap-2.5">
        <div className={row}><span className={label}>状态</span><Seg label="状态" options={VERSION_STATUSES} value={draft.status} onPick={st => set({ status: st })} /></div>
        {draft.status === '已报价' && (
          <div className={row}><span className={label}>客户结果</span><Seg label="客户结果" options={OUTCOMES} value={draft.outcome} text={o => (o === '嫌贵' ? '嫌贵没成交' : o)} onPick={o => set({ outcome: o })} /></div>
        )}
        {draft.status === '已报价' && draft.outcome === '嫌贵' && (
          <label className={row}><span className={label}>客户说的预算</span>
            <input className={qInput} inputMode="numeric" value={draft.clientBudget ?? ''} placeholder="没说就空着" onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); set({ clientBudget: v ? Number(v) : null }) }} />
            <span className="text-xs text-on-surface-variant">元</span>
          </label>
        )}
        {draft.status === '已成交' && kinds.map(k => (
          <label key={k} className={row}><span className={label}>实际{k}</span>
            <input className={qInput} inputMode="decimal" value={draft.actual[k] || ''} placeholder="做完再填" onChange={e => set({ actual: { ...draft.actual, [k]: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 } })} />
            <span className="text-xs text-on-surface-variant">小时</span>
          </label>
        ))}
        {draft.status === '已成交' && (
          <div className={row}><span className={label}>做完觉得</span><Seg label="做完觉得" options={FEELINGS} value={draft.feeling} onPick={f => set({ feeling: f })} /></div>
        )}
        {!sheet.base && sheet.tiers.length > 1 && (
          <div className={row}><span className={label}>主推</span><Seg label="主推档" options={sheet.tiers.map(t => t.name)} value={sheet.chosen?.name ?? ''} onPick={t => set({ tier: t as QuoteState['tier'] })} /></div>
        )}
        {!sheet.base && (
          <label className={row}><span className={label}>预算</span>
            <input className={qInput} inputMode="numeric" value={budgetText} placeholder={parsed != null ? `材料里是 ${parsed}` : '待问'}
              onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); setBudgetText(v); set({ budget: v ? Number(v) : null }) }} />
            <span className="text-xs text-on-surface-variant">元</span>
          </label>
        )}
        <label className={row}><span className={label}>交付后修改</span>
          <input className={qInput} inputMode="decimal" value={draft.resultHours || ''} placeholder="0" onChange={e => set({ resultHours: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} />
          <span className="text-xs text-on-surface-variant">小时</span>
        </label>
        <div className="flex flex-wrap items-start gap-3"><span className={`${label} pt-2`}>实际支出</span>
          <div className="grid gap-1.5">
            {expenses.map((e, i) => (
              <div key={i} className="flex gap-1.5">
                <input className={`${qInput} w-52`} value={e.name} placeholder="服务器、域名、付费接口" maxLength={40} onChange={ev => setExpense(i, { name: ev.target.value })} />
                <input className={qInput} inputMode="numeric" value={e.amount || ''} placeholder="金额" onChange={ev => setExpense(i, { amount: Number(ev.target.value.replace(/[^\d]/g, '')) || 0 })} />
              </div>
            ))}
          </div>
        </div>
        {!sheet.bonus && (
          <div className={row}><span className={label}>人情折让</span><Seg label="人情折让" options={DISCOUNT_STEPS} value={draft.discount.ratio} text={pct} onPick={r => set({ discount: { ...draft.discount, ratio: r } })} /></div>
        )}
        {!sheet.base && bonusAllowed(version.brief) && (
          <div className={row}><span className={label}>成效奖金</span><Seg label="成效奖金" options={['不加', '加'] as const} value={draft.bonus.on ? '加' : '不加'} onPick={o => setBonus({ on: o === '加' })} /></div>
        )}
        {sheet.bonus && BONUS_INPUTS.map(([k, name, hint]) => (
          <label key={k} className={row}><span className={label}>{name}</span>
            <input className={`${qInput} w-52`} value={draft.bonus[k] as string} placeholder={hint} maxLength={k === 'verify' ? 120 : 60} onChange={e => setBonus({ [k]: e.target.value })} />
          </label>
        ))}
        {sheet.bonus && (
          <div className={row}><span className={label}>达标把握</span><Seg label="达标把握" options={CONFIDENCE_STEPS} value={draft.bonus.confidence} text={c => `${c * 10} 成`} onPick={c => setBonus({ confidence: c })} /></div>
        )}
        {sheet.bonus && (
          <label className={row}><span className={label}>客户多赚</span>
            <input className={qInput} inputMode="numeric" value={draft.bonus.gain ?? ''} placeholder="达标后客户多赚多少" onChange={e => { const v = e.target.value.replace(/[^\d]/g, ''); setBonus({ gain: v ? Number(v) : null }) }} />
            <span className="text-xs text-on-surface-variant">元，可不填</span>
          </label>
        )}
        {sheet.bonus && draft.status === '已成交' && (
          <div className={row}><span className={label}>奖金结果</span><Seg label="奖金结果" options={BONUS_RESULTS} value={draft.bonus.result} onPick={r => setBonus({ result: r })} /></div>
        )}
        {draft.discount.ratio > 0 && !sheet.bonus && (
          <label className={row}><span className={label}>折让原因</span>
            <input className={`${qInput} w-52`} value={draft.discount.reason} placeholder="同学、老客户第 3 单、换作品展示权" maxLength={60} onChange={e => set({ discount: { ...draft.discount, reason: e.target.value } })} />
          </label>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Seg label="报价单版本" options={['自用版', '客户版'] as const} value={view} onPick={setView} />
        <div className="relative flex items-center gap-2">
          <button type="button" className={tool} onClick={() => void copy()}><span className="material-symbols-outlined text-[16px] leading-none">content_copy</span>复制</button>
          <button type="button" className={tool} onClick={download}><span className="material-symbols-outlined text-[16px] leading-none">download</span>下载</button>
          <button type="button" className="h-8 px-4 rounded-xl bg-primary text-xs font-bold text-on-primary disabled:opacity-50" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
          {note && <span role="status" className={`absolute right-0 top-full mt-1 w-max max-w-[260px] text-xs ${note.ok ? 'text-primary' : 'text-error'}`}>{note.text}</span>}
        </div>
      </div>
      <pre className="mt-6 whitespace-pre-wrap break-words rounded-xl bg-surface-container-high px-4 py-3 font-body text-[13px] leading-relaxed text-on-surface">{text}</pre>
    </Section>
  )
}

function Notice({ title, desc, action }: { title: string; desc?: string; action?: { label: string; onClick: () => void } }): JSX.Element {
  return (
    <article className="animate-fade-up overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-low">
      <div className="h-1 bg-amber" />
      <div className="flex items-start gap-3 px-6 py-5">
        <span className="material-symbols-outlined text-[22px] leading-none text-amber">error</span>
        <div className="min-w-0">
          <p className="text-[17px] font-bold leading-snug text-on-surface">{title}</p>
          {desc && <p className="mt-1 text-[14px] whitespace-pre-wrap break-words text-on-surface-variant">{desc}</p>}
          {action && <button onClick={action.onClick} className="mt-3 h-9 px-4 rounded-xl border border-outline-variant/40 font-label text-sm hover:bg-surface-container-high">{action.label}</button>}
        </div>
      </div>
    </article>
  )
}

// ── 材料 chip ──

function Chip({ m, onRemove, bad }: { m: Material; onRemove: () => void; bad: boolean }): JSX.Element {
  const kind = kindOf(m.file)
  const remove = (
    <button
      onClick={onRemove}
      title="移除"
      aria-label={`移除 ${m.file.name}`}
      className="absolute top-1 right-1 w-5 h-5 grid place-items-center rounded-[9999px] bg-black/60 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
    >
      <span className="material-symbols-outlined text-[14px] leading-none">close</span>
    </button>
  )
  if (m.preview) {
    return (
      <div className={`group relative w-[92px] h-[68px] rounded-xl overflow-hidden bg-surface-container-highest ${bad ? 'ring-1 ring-amber/60' : ''}`}>
        <img src={m.preview} alt={m.file.name} className="absolute inset-0 w-full h-full object-cover" />
        {m.note && <span className="absolute left-1 bottom-1 w-max rounded-lg bg-black/60 px-1.5 py-px font-label text-[10px] text-white">{m.note}</span>}
        {remove}
      </div>
    )
  }
  const icon = bad ? 'warning' : { image: 'image', video: 'movie', pdf: 'picture_as_pdf', doc: 'description', text: 'notes', other: 'draft' }[kind]
  return (
    <div className={`group relative w-[92px] h-[68px] rounded-xl bg-surface-container-highest flex flex-col items-center justify-center gap-1 px-2 text-center ${bad ? 'ring-1 ring-amber/60' : ''}`}>
      <span className={`material-symbols-outlined text-[20px] leading-none ${bad ? 'text-amber' : 'text-on-surface-variant'}`}>{icon}</span>
      <span className="w-full truncate text-[11px] leading-tight text-on-surface-variant" title={m.file.name}>{m.file.name}</span>
      {m.note && <span className="absolute left-1 top-1 w-max rounded-lg bg-surface-container-lowest/80 px-1 font-label text-[10px] text-on-surface-variant">{m.note}</span>}
      {remove}
    </div>
  )
}

// ── 页面 ──

function OrderJudge(): JSX.Element {
  const [text, setText] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [unreadable, setUnreadable] = useState<string[]>([])
  const [running, setRunning] = useState<Running | null>(null)
  const [now, setNow] = useState(Date.now())
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [view, setView] = useState<OrderJudgeView | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [emptyTip, setEmptyTip] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const resultRef = useRef<HTMLElement>(null)
  const shotCount = useRef(0)
  const dragDepth = useRef(0)

  const loadRequest = useRef(0)
  const load = useCallback(async () => {
    const request = ++loadRequest.current
    try {
      const next = await window.orderJudgeApi.load()
      if (request === loadRequest.current) setView(next)
    } catch (e) {
      reportError('order-judge:load', e)
    }
  }, [])

  // 网页那头新建 / 追加 / 删除后，切回窗口时重新拉；换账号由主进程通知
  useEffect(() => {
    void load()
    const stop = window.orderJudgeApi.onChanged(() => { setSelected(null); setTarget(null); setOutcome(null); void load() })
    const onFocus = (): void => { void load() }
    window.addEventListener('focus', onFocus)
    return () => { loadRequest.current++; stop(); window.removeEventListener('focus', onFocus) }
  }, [load])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  const materialsRef = useRef<Material[]>([])
  materialsRef.current = materials
  useEffect(() => () => materialsRef.current.forEach((m) => m.preview && URL.revokeObjectURL(m.preview)), [])

  const addFiles = useCallback((files: File[]) => {
    const added = files.map((raw) => {
      let file = raw
      if (!file.name || file.name === 'image.png') {
        shotCount.current += 1
        file = new File([file], `截图${String(shotCount.current).padStart(2, '0')}.png`, { type: file.type || 'image/png' })
      }
      const kind = kindOf(file)
      const m: Material = { id: nextId++, file }
      if (kind === 'image' && file.type.startsWith('image/') && file.type !== 'image/heic' && file.type !== 'image/tiff') {
        m.preview = URL.createObjectURL(file)
      }
      if (kind === 'video') m.note = `${VIDEO_FRAMES} 帧`
      return m
    })
    setMaterials((prev) => [...prev, ...added])
    setUnreadable([])
    // 角标信息异步补上：长图切几块、PDF 几页
    for (const m of added) {
      const kind = kindOf(m.file)
      const setNote = (note: string): void => setMaterials((prev) => prev.map((x) => (x.id === m.id ? { ...x, note } : x)))
      if (kind === 'image') {
        void imageTileCount(m.file).then((n) => { if (n && n > 1) setNote(`长图 · 切 ${n} 块`) })
      } else if (kind === 'pdf') {
        import('../utils/orderJudgePdf')
          .then(({ pdfPageCount }) => pdfPageCount(m.file))
          .then((n) => setNote(`${n} 页`))
          .catch((e) => reportError('order-judge:pdf-pages', e))
      }
    }
  }, [])

  const removeMaterial = (id: number): void => {
    setMaterials((prev) => {
      const m = prev.find((x) => x.id === id)
      if (m?.preview) URL.revokeObjectURL(m.preview)
      return prev.filter((x) => x.id !== id)
    })
    setUnreadable([])
  }

  // 截图和文件在页面任意位置粘贴都收；焦点不在输入框时文字也追加进输入框
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f)
      if (files.length) {
        e.preventDefault()
        addFiles(files)
        return
      }
      if (document.activeElement !== textRef.current) {
        const t = e.clipboardData?.getData('text') ?? ''
        if (!t) return
        e.preventDefault()
        setText((prev) => prev + (prev ? '\n' : '') + t)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [addFiles])

  const clearAll = (): void => {
    materials.forEach((m) => m.preview && URL.revokeObjectURL(m.preview))
    setMaterials([])
    setText('')
    setUnreadable([])
    setOutcome(null)
    shotCount.current = 0
    textRef.current?.focus()
  }

  const showResult = (): void => {
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const projects = view?.projects ?? []
  const targetProject = projects.find(p => p.id === target) ?? null

  const run = async (): Promise<void> => {
    if (running) return
    if (!text.trim() && !materials.length) {
      setEmptyTip(true)
      setTimeout(() => setEmptyTip(false), 1600)
      return
    }
    setSelected(null)
    setOutcome(null)
    const startedAt = Date.now()
    setNow(startedAt)
    setRunning({ startedAt, stage: 'prepare', stats: [], links: 0 })
    showResult()
    const off = window.orderJudgeApi.onProgress((p) => {
      setRunning((r) => (r ? (p.stage === 'links' ? { ...r, stage: 'links', links: p.count } : { ...r, stage: 'ai' }) : r))
    })
    try {
      const prepared = await prepareMaterials(text, materials.map((m) => m.file))
      setUnreadable(prepared.unreadable)
      if (precheck(prepared.text, prepared.images.length)) {
        setOutcome({ type: 'precheck' })
        return
      }
      setRunning((r) => (r ? { ...r, stats: prepared.stats } : r))
      const files = await Promise.all(prepared.attachments.map(async (f) => ({ name: f.name, data: await fileBase64(f) })))
      const res = await window.orderJudgeApi.organize({ projectId: targetProject?.id ?? null, text: prepared.text, images: prepared.images, files })
      if (res.ok) {
        setView((v) => v && { ...v, projects: [res.project, ...v.projects.filter(p => p.id !== res.project.id)] })
        setOutcome({ type: 'done', projectId: res.project.id, ms: Date.now() - startedAt })
        setTarget(res.project.id)
        materials.forEach((m) => m.preview && URL.revokeObjectURL(m.preview))
        setMaterials([]); setText(''); shotCount.current = 0
      } else {
        setOutcome({ type: 'error', code: res.code, detail: res.error })
      }
    } catch (e) {
      reportError('order-judge:organize', e)
      setOutcome({ type: 'error', code: 'THROWN', detail: ipcErrMsg(e, '未知错误') })
    } finally {
      off()
      setRunning(null)
      showResult()
    }
  }

  const calib = calibrate(view?.projects ?? [])
  const replaceProject = (p: Project): void => setView((v) => v && { ...v, projects: v.projects.map(x => (x.id === p.id ? p : x)) })

  const remove = async (id: string): Promise<void> => {
    setDeleteError('')
    try {
      await window.orderJudgeApi.deleteProject(id)
      setConfirmDelete(null)
      if (selected === id) setSelected(null)
      if (target === id) setTarget(null)
      if (outcome?.type === 'done' && outcome.projectId === id) setOutcome(null)
      await load()
    } catch (e) {
      reportError('order-judge:delete', e)
      setDeleteError(ipcErrMsg(e, '没有删掉'))
    }
  }

  const append = (id: string): void => {
    setTarget(id)
    setSelected(null)
    requestAnimationFrame(() => { textRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); textRef.current?.focus() })
  }

  const base = view?.accountId ? `archivist://judge/${view.accountId}` : ''
  const selectedProject = projects.find(p => p.id === selected) ?? null
  const elapsed = running ? Math.max(0, Math.round((now - running.startedAt) / 1000)) : 0
  const unreadableSet = new Set(unreadable)

  const renderResult = (): React.ReactNode => {
    if (selectedProject) {
      return <ProjectSheet project={selectedProject} base={base} onSaved={replaceProject} calib={calib} onAppend={() => append(selectedProject.id)} onDelete={() => setConfirmDelete(selectedProject.id)} onClose={() => setSelected(null)} />
    }
    if (running) {
      const steps: { title: string; detail: string; state: 'done' | 'run' | 'wait' }[] = [
        { title: '整理材料', detail: running.stage === 'prepare' ? '截图、视频、文档转成 AI 能看的格式' : running.stats.join(' · '), state: running.stage === 'prepare' ? 'run' : 'done' },
      ]
      if (running.links) steps.push({ title: '打开网址', detail: `${running.links} 个`, state: running.stage === 'links' ? 'run' : 'done' })
      steps.push({ title: 'AI 整理需求', detail: targetProject ? `对照第 ${latest(targetProject).n} 版的清单` : '拆成条目，按必须 / 应该 / 可以分好', state: running.stage === 'ai' ? 'run' : 'wait' })
      return (
        <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low px-6 py-5">
          <ol className="grid gap-4">
            {steps.map((s) => (
              <li key={s.title} className="flex items-start gap-3">
                <span className="mt-0.5 w-5 h-5 grid place-items-center">
                  {s.state === 'done' && <span className="material-symbols-outlined text-[20px] leading-none text-yes">check_circle</span>}
                  {s.state === 'run' && <span className="pulse-dot w-2.5 h-2.5 rounded-[9999px] bg-primary" />}
                  {s.state === 'wait' && <span className="w-2.5 h-2.5 rounded-[9999px] bg-outline-variant/60" />}
                </span>
                <div>
                  <p className={`text-sm font-bold ${s.state === 'run' ? 'text-on-surface' : 'text-on-surface-variant'}`}>{s.title}</p>
                  <p className="text-xs text-on-surface-variant/70 mt-0.5">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )
    }
    if (!outcome) return null
    if (outcome.type === 'precheck') {
      return (
        <Notice title="内容里只有「[聊天记录]」，转发的记录复制不出来"
          desc={`在微信里点开这条聊天记录，用 ${SHOT_KEY} 截图后粘贴进来，再整理一次`} />
      )
    }
    if (outcome.type === 'error') {
      const login = outcome.code === 'AUTH_REQUIRED'
      const ai = ['BYOK_REQUIRED', 'PROVIDER_CONNECTION_REQUIRED', 'PROVIDER_HTTP_401'].includes(outcome.code)
      return (
        <Notice title={login ? '还没登录网页版账号' : '这次没有整理出来'}
          desc={`${outcome.detail}${login || ai ? '' : `\n${outcome.code}`}`}
          action={ai ? { label: '去网页版设置 AI', onClick: () => void window.orderJudgeApi.openWeb() } : undefined} />
      )
    }
    const done = projects.find(p => p.id === outcome.projectId)
    return done ? <ProjectSheet project={done} base={base} ms={outcome.ms} onSaved={replaceProject} calib={calib} onAppend={() => append(done.id)} /> : null
  }

  const deleting = projects.find(p => p.id === confirmDelete) ?? null

  return (
    <div className="relative min-h-full bg-background">
      <TopBar />

      <div className="pt-16">
        {/* Sticky 页头 —— 同妙语库 / 锦囊妙计：top-16 卡在 fixed TopBar 下面，页面操作放右侧 */}
        <div className="sticky top-16 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-4 md:px-8 py-4 md:py-5">
          <div className="flex items-end justify-between gap-4 md:gap-6">
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-on-surface">接单评估</h1>
              <p className="hidden md:block text-sm text-on-surface-variant/80 mt-1 font-label tabular-nums">
                {view && !view.loggedIn ? '登录网页版账号后使用' : projects.length ? `${projects.length} 个项目` : '还没有整理过的项目'}
              </p>
            </div>
            <button
              onClick={() => void window.orderJudgeApi.openWeb()}
              className="shrink-0 flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl bg-surface-container-high border border-outline-variant/20 text-on-surface font-label text-xs uppercase tracking-widest hover:bg-surface-bright hover:border-primary/40 transition-all active:scale-95 whitespace-nowrap"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>open_in_new</span>
              <span className="hidden sm:inline">在网页打开</span>
            </button>
          </div>
        </div>

      <div className="pt-8 px-4 md:px-8 pb-16">
        <div className="mx-auto max-w-[1180px] grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">

            <div className="mb-2 flex h-8 items-center gap-2 px-1 text-[13px] text-on-surface-variant">
              <span className="material-symbols-outlined text-[18px] leading-none">{targetProject ? 'edit_note' : 'add_circle'}</span>
              <span className="min-w-0 truncate">{targetProject ? `给「${targetProject.title}」追加需求` : '新项目'}</span>
              {targetProject && (
                <button type="button" disabled={!!running} onClick={() => setTarget(null)} className="shrink-0 h-8 px-2.5 rounded-xl font-label text-primary hover:bg-primary/10 disabled:opacity-50">改为新项目</button>
              )}
            </div>

            <section
              className="relative rounded-xl border border-outline-variant/40 bg-surface-container-low transition-colors focus-within:border-primary/60"
              onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragOver(true) }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragOver(false) }}
              onDrop={(e) => {
                e.preventDefault()
                dragDepth.current = 0
                setDragOver(false)
                addFiles([...e.dataTransfer.files])
              }}
            >
              <textarea
                ref={textRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder={targetProject ? '粘贴客户新补充的要求，可以粘贴多次' : '粘贴需求文字或截图，可以粘贴多次'}
                className="block w-full min-h-[148px] resize-y bg-transparent px-5 pt-4 pb-2 text-[15px] leading-relaxed text-on-surface placeholder:text-on-surface-variant/40 outline-none border-0 focus:ring-0"
              />
              {materials.length > 0 && (
                <div className="flex flex-wrap gap-2 px-5 pb-3">
                  {materials.map((m) => (
                    <Chip key={m.id} m={m} bad={unreadableSet.has(m.file.name)} onRemove={() => removeMaterial(m.id)} />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3 border-t border-outline-variant/20 px-5 h-14">
                {unreadable.length > 0 ? (
                  <p className="flex-1 min-w-0 truncate text-[13px] text-amber" title={unreadable.join('、')}>
                    <span className="material-symbols-outlined text-[16px] leading-none align-[-3px]">warning</span>{' '}
                    {unreadable.join('、')} 读不了，换成常见格式或截几张图再放进来
                  </p>
                ) : (
                  <p className="flex-1 min-w-0 truncate text-[13px] text-on-surface-variant/70">
                    <kbd className="font-label text-[11px] px-1.5 py-0.5 rounded-lg bg-surface-container-highest text-on-surface-variant">{PASTE_KEY}</kbd>
                    {' '}粘贴文字或截图 · 视频、PDF、Word、长图拖进来，或{' '}
                    <button onClick={() => fileRef.current?.click()} className="text-primary hover:underline underline-offset-2">选择文件</button>
                  </p>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = '' }}
                />
                <button onClick={clearAll} disabled={!!running} className="shrink-0 h-9 px-3 rounded-xl font-label text-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors disabled:opacity-50">清空</button>
                <button
                  onClick={() => void run()}
                  disabled={!!running}
                  className="shrink-0 w-[148px] h-10 rounded-xl bg-primary text-on-primary font-bold text-sm flex items-center justify-center gap-1.5 hover:brightness-110 disabled:opacity-60 disabled:hover:brightness-100 transition"
                >
                  <span className="material-symbols-outlined text-[18px] leading-none">{running ? 'hourglass_top' : 'checklist'}</span>
                  <span className="tabular-nums">{running ? `整理中 ${elapsed} 秒` : targetProject ? `整理第 ${latest(targetProject).n + 1} 版` : '整理需求'}</span>
                </button>
              </div>

              {dragOver && (
                <div className="pointer-events-none absolute inset-0 rounded-xl border-2 border-dashed border-primary bg-primary/10 grid place-items-center">
                  <div className="flex items-center gap-2 text-primary font-bold">
                    <span className="material-symbols-outlined leading-none">file_download</span>松手放入
                  </div>
                </div>
              )}
              {emptyTip && (
                <div className="absolute right-5 -bottom-9 w-max rounded-xl bg-surface-container-highest px-3 py-1.5 text-xs text-on-surface shadow-lg z-10">还没有放入内容</div>
              )}
            </section>

            <details className="group mt-3">
              <summary className="inline-flex items-center gap-1 cursor-pointer py-1 text-[13px] text-on-surface-variant/70 hover:text-on-surface transition-colors list-none [&::-webkit-details-marker]:hidden">
                <span className="material-symbols-outlined text-[18px] leading-none transition-transform group-open:rotate-90">chevron_right</span>
                不同材料怎么放
              </summary>
              <dl className="mt-2 grid grid-cols-[7.5em_1fr] gap-x-5 gap-y-3 rounded-xl bg-surface-container px-5 py-4 text-[13px] leading-relaxed">
                <dt className="font-bold text-on-surface">文字、截图</dt>
                <dd className="text-on-surface-variant">{PASTE_KEY} 粘贴，可以连续粘贴多张。转发的聊天记录要点开后截图，直接复制只会得到「[聊天记录]」</dd>
                <dt className="font-bold text-on-surface">网址</dt>
                <dd className="text-on-surface-variant">以文字形式贴进输入框，会打开网页读取标题和正文开头，每次最多 10 个。截图里的网址不会被打开</dd>
                <dt className="font-bold text-on-surface">在线表格、文档</dt>
                <dd className="text-on-surface-variant">公开的腾讯文档能读到首屏的一部分文字，每张工作表的网址不同，需要哪张贴哪张。表格很长或要看细节时，把关键行截图一起放进来</dd>
                <dt className="font-bold text-on-surface">要登录的网页</dt>
                <dd className="text-on-surface-variant">飞书、钉钉、小红书等打不开，请在浏览器里截图或截长图后粘贴</dd>
                <dt className="font-bold text-on-surface">视频</dt>
                <dd className="text-on-surface-variant">均匀取 {VIDEO_FRAMES} 帧画面，听不到声音，口头讲的需求请补一段文字</dd>
                <dt className="font-bold text-on-surface">PDF、Word</dt>
                <dd className="text-on-surface-variant">只读文字。扫描版 PDF 和文档里的图片读不到，重要的图请单独截图</dd>
              </dl>
            </details>

                        <section ref={resultRef} className="mt-8 scroll-mt-[220px]">{renderResult()}</section>
          </div>

          <aside className="min-w-0">
            <div className="xl:sticky xl:top-[220px]">
              <div className="flex items-baseline justify-between mb-2 px-1">
                <h3 className="font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/70">项目</h3>
                {projects.length > 0 && (
                  <span className="font-label text-[11px] text-on-surface-variant/50 tabular-nums">{projects.length} 个</span>
                )}
              </div>
              {projects.length === 0 ? (
                <p className="px-1 py-6 text-sm text-on-surface-variant/60">还没有整理过的项目</p>
              ) : (
                <div className="xl:max-h-[calc(100vh-280px)] overflow-y-auto custom-scrollbar -mx-1 px-1">
                  {projects.map((p) => {
                    const on = selected === p.id
                    const v = latest(p)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setSelected(p.id); showResult() }}
                        className={`w-full grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 items-center text-left rounded-xl px-3 py-2.5 transition-colors ${on ? 'bg-surface-container-high' : 'hover:bg-surface-container'}`}
                      >
                        <span className="row-span-2 self-start mt-0.5 min-w-[36px] text-center rounded-lg bg-surface-container-highest px-1.5 py-0.5 font-label text-[11px] font-bold text-on-surface-variant tabular-nums">v{v.n}</span>
                        <span className={`truncate text-sm text-on-surface ${on ? 'font-bold' : ''}`}>{p.title}</span>
                        <span className="truncate font-label text-[11px] text-on-surface-variant/60 tabular-nums">
                          {formatWhen(p.updatedAt)} · {v.brief.clientType} · {v.brief.items.length} 条
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      </div>

      {deleting && (
        <div className="fixed inset-0 z-[80] bg-black/40 grid place-items-center p-4" onClick={() => setConfirmDelete(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="oj-del-title" onClick={(e) => e.stopPropagation()} className="w-[400px] max-w-full rounded-xl border border-outline-variant/30 bg-surface-container-low p-6">
            <h3 id="oj-del-title" className="text-lg font-bold text-on-surface">删除「{deleting.title}」</h3>
            <p className="mt-2 text-sm text-on-surface-variant">{deleting.versions.length} 个版本和放进来的材料会一起删掉，网页版也看不到了</p>
            <div className="relative mt-6 flex justify-end gap-2">
              {deleteError && <span className="absolute left-0 top-1/2 -translate-y-1/2 max-w-[55%] truncate text-xs text-error" title={deleteError}>{deleteError}</span>}
              <button type="button" autoFocus onClick={() => setConfirmDelete(null)} className="h-9 px-4 rounded-xl font-label text-sm text-on-surface-variant hover:bg-surface-container-high">取消</button>
              <button type="button" onClick={() => void remove(deleting.id)} className="h-9 px-4 rounded-xl bg-error text-on-error font-label text-sm font-bold hover:brightness-110">确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default OrderJudge

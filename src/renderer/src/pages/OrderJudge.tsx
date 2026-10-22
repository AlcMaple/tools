// 设计稿：docs/design-mockups/接单评估.html
import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import { ipcErrMsg } from '../utils/ipcError'
import { reportError } from '../utils/reportError'
import { DOC_TEMPLATES, downloadDocTemplate } from '../../../../web/shared/order-judge-templates'
import { VIDEO_FRAMES, precheck, type JudgeReport, type Precheck } from '../../../../web/shared/order-judge'
import type { EstimateResult } from '../../../../web/shared/order-judge-estimate'
import { DAY_RATE } from '../../../../web/shared/order-judge-quote'
import { imageTileCount, kindOf, prepareMaterials } from '../utils/orderJudgePrepare'
import type {
  OrderJudgeErrorCode, OrderJudgeHistoryEntry, OrderJudgePath, OrderJudgeSettings,
} from '../types/orderJudge'

const IS_MAC = navigator.userAgent.includes('Mac')
const PASTE_KEY = IS_MAC ? '⌘V' : 'Ctrl+V'
const SHOT_KEY = IS_MAC ? '⌃⌘A' : 'Alt+A'

interface Material {
  id: number
  file: File
  preview?: string
  note?: string
}

type Est =
  | { kind: 'run'; tasks: number; groups: number }
  | { kind: 'done'; result: EstimateResult }
  | { kind: 'error'; code: string; message: string }

type Outcome =
  | { type: 'report'; entry: OrderJudgeHistoryEntry; warnings: string[] }
  | { type: 'precheck'; kind: Precheck }
  | { type: 'error'; code: OrderJudgeErrorCode | 'THROWN'; detail?: string }

interface Running {
  startedAt: number
  stage: 'prepare' | 'links' | 'ai'
  stats: string[]
  links: number
}

const VERDICT_STYLE: Record<string, { badge: string; bar: string; icon: string }> = {
  能: { badge: 'bg-yes-container text-yes', bar: 'bg-yes', icon: 'check_circle' },
  不能: { badge: 'bg-error-container text-on-error-container dark:text-error', bar: 'bg-error', icon: 'block' },
  信息不足: { badge: 'bg-amber-container text-amber', bar: 'bg-amber', icon: 'help' },
  出错: { badge: 'bg-amber-container text-amber', bar: 'bg-amber', icon: 'error' },
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

// ── 结论卡片 ──

function Section({ label, icon, children }: { label: string; icon?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-6 py-5 border-t border-outline-variant/20">
      <p className="mb-3 flex items-center gap-1.5 font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/70">
        {icon && <span className="material-symbols-outlined text-[16px] leading-none">{icon}</span>}
        {label}
      </p>
      {children}
    </div>
  )
}

function Items({ items, numClass }: { items: { t: string; d: string }[]; numClass: string }): JSX.Element {
  return (
    <ol className="grid gap-3">
      {items.map((x, i) => (
        <li key={i} className="grid grid-cols-[22px_1fr] gap-2">
          <span className={`font-label text-[13px] font-bold tabular-nums pt-0.5 ${numClass}`}>{i + 1}</span>
          <p className="text-[14px] leading-relaxed">
            {x.t && <span className="font-bold text-on-surface">{x.t}</span>}
            <span className="text-on-surface-variant">{x.t ? '：' : ''}{x.d}</span>
          </p>
        </li>
      ))}
    </ol>
  )
}

function Card({ verdict, children }: { verdict: string; children: React.ReactNode }): JSX.Element {
  return (
    <article className="animate-fade-up overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-low">
      <div className={`h-1 ${VERDICT_STYLE[verdict].bar}`} />
      {children}
    </article>
  )
}

function VerdictBar({ verdict, headline, sub }: { verdict: string; headline: string; sub?: React.ReactNode }): JSX.Element {
  const st = VERDICT_STYLE[verdict]
  return (
    <div className="flex items-start gap-4 px-6 pt-6 pb-5">
      <span className={`shrink-0 inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-lg font-black ${st.badge}`}>
        <span className="material-symbols-outlined text-[20px] leading-none">{st.icon}</span>
        {verdict}
      </span>
      <div className="pt-1 min-w-0">
        <p className="text-[17px] font-bold leading-snug text-on-surface">{headline}</p>
        {sub}
      </div>
    </div>
  )
}

function ReportBody({ r }: { r: JudgeReport }): JSX.Element {
  return (
    <>
      {r.summary && (
        <Section label="需求"><p className="text-[14px] leading-relaxed text-on-surface-variant whitespace-pre-line">{r.summary}</p></Section>
      )}
      {r.risk && (
        <Section label="风险" icon="warning">
          <p className="rounded-xl bg-amber-container px-4 py-3 text-[14px] leading-relaxed text-amber">{r.risk}</p>
        </Section>
      )}
      {r.reasons.length > 0 && (
        <Section label="原因">
          <Items items={r.reasons.map((x) => ({ t: x.title, d: x.detail }))} numClass="text-on-surface-variant/60" />
        </Section>
      )}
      {r.gaps.length > 0 && (
        <Section label={r.verdict === '能' ? '可能翻车的地方' : '卡点'}>
          <Items items={r.gaps.map((x) => ({ t: x.step, d: x.detail }))} numClass="text-error" />
        </Section>
      )}
      {r.questions.length > 0 && (
        <Section label="接单前先问清楚">
          <ul className="grid gap-2">
            {r.questions.map((q, i) => {
              const m = /^(.*?)[（(]可能改判[）)]\s*$/.exec(q)
              return (
                <li key={i} className="grid grid-cols-[22px_1fr] gap-2 text-[14px] leading-relaxed text-on-surface-variant">
                  <span className="mt-1 w-[18px] h-[18px] rounded-[9999px] bg-surface-container-highest grid place-items-center font-label text-[11px] font-bold text-on-surface-variant/70">?</span>
                  <span>
                    {m ? m[1] : q}
                    {m && (
                      <span className="ml-1.5 whitespace-nowrap rounded-lg bg-amber-container px-1.5 py-px font-label text-[11px] font-bold text-amber">可能改判</span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </>
  )
}

function ErrorCard({ code, detail, onSettings }: {
  code: OrderJudgeErrorCode | 'THROWN'
  detail?: string
  onSettings: () => void
}): JSX.Element {
  const settingsBtn = { label: '去评估设置', onClick: onSettings }
  const map: Record<OrderJudgeErrorCode | 'THROWN', { title: string; desc: string; action?: { label: string; onClick?: () => void; href?: string } }> = {
    SHARED_ERROR: { title: '共享评估未完成', desc: detail || '请查看同步状态或网页评估设置。', action: settingsBtn },
    NEED_WEB: { title: '还不能评估', desc: '登录网页版账号并开启「与网页版共用评估和历史」后，就能用网页账号的 AI 评估。', action: settingsBtn },
    BAD_INPUT: { title: '材料格式不对', desc: '图片数据没有通过检查，清空后重新放一次。' },
    THROWN: { title: '评估中断', desc: detail ?? '' },
  }
  const e = map[code]
  return (
    <Card verdict="出错">
      <VerdictBar
        verdict="出错"
        headline={e.title}
        sub={
          <>
            {e.desc && <p className="mt-1 text-[14px] whitespace-pre-wrap break-words text-on-surface-variant">{e.desc}</p>}
            {e.action && (e.action.href ? (
              <a href={e.action.href} target="_blank" rel="noreferrer" className="inline-flex mt-3 h-9 items-center px-4 rounded-xl border border-outline-variant/40 font-label text-sm hover:bg-surface-container-high">{e.action.label}</a>
            ) : (
              <button onClick={e.action.onClick} className="mt-3 h-9 px-4 rounded-xl border border-outline-variant/40 font-label text-sm hover:bg-surface-container-high">{e.action.label}</button>
            ))}
          </>
        }
      />
    </Card>
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

// ── 评估设置抽屉 ──

function SettingsSheet({ open, settings, onClose, onChange }: {
  open: boolean
  settings: OrderJudgeSettings | null
  onClose: () => void
  onChange: (s: OrderJudgeSettings) => void
}): JSX.Element {
  const [err, setErr] = useState('')
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    if (!open) setErr('')
  }, [open])

  const pick = async (which: 'profile' | 'log'): Promise<void> => {
    try {
      onChange(await window.orderJudgeApi.pickFile(which))
    } catch (e) {
      reportError('order-judge:pick-file', e)
      setErr(ipcErrMsg(e, '选择文件失败'))
    }
  }
  // 开启时会把本机路径并进账号、本机历史上传一次，可能要几秒，期间锁住开关。
  const toggleShared = async (shared: boolean): Promise<void> => {
    setSwitching(true); setErr('')
    try { onChange(await window.orderJudgeApi.setShared(shared)) }
    catch (e) {
      reportError('order-judge:set-shared', e)
      setErr(ipcErrMsg(e, '没有开启共用'))
      onChange(await window.orderJudgeApi.getSettings())
    } finally { setSwitching(false) }
  }

  const edit = async (task: Promise<OrderJudgeSettings>, tag: string): Promise<void> => {
    try { onChange(await task) } catch (e) { reportError(tag, e); setErr(ipcErrMsg(e, '保存路径失败')) }
  }

  // 按顺序取第一个本机存在的文件；用的那条图标亮起，本机不存在的那条变淡（通常是另一台电脑的路径）。
  const pathList = (label: string, icon: string, paths: OrderJudgePath[], which: 'profile' | 'log'): JSX.Element => {
    const iconButton = 'w-7 h-7 grid place-items-center rounded-lg text-on-surface-variant hover:bg-surface-container-highest disabled:opacity-30 disabled:hover:bg-transparent'
    return (
      <div>
        <div className="flex items-center justify-between">
          <span className="font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/70">{label}</span>
          <button type="button" onClick={() => downloadDocTemplate(which)} className="font-label text-xs text-primary hover:underline">下载模版</button>
        </div>
        <p className="mt-1 text-xs text-on-surface-variant">{DOC_TEMPLATES[which].purpose}</p>
        <div className="mt-2 space-y-1.5">
          {paths.map((p, i) => (
            <div key={p.path} className="flex items-center gap-1 rounded-xl bg-surface-container-high border border-outline-variant/30 h-11 pl-3 pr-1">
              <span className={`material-symbols-outlined text-[18px] leading-none ${p.active ? 'text-primary' : 'text-on-surface-variant/40'}`}>{icon}</span>
              <span className={`flex-1 min-w-0 truncate text-sm ml-1 ${p.exists ? '' : 'text-on-surface-variant/50'}`} title={`${p.device} · ${p.path}${p.updatedAt ? `\n更新于 ${formatWhen(p.updatedAt)}` : ''}`}>{p.path}</span>
              <span className="shrink-0 font-label text-[11px] text-on-surface-variant/50 px-1">{p.device}</span>
              <button type="button" aria-label="上移" disabled={i === 0} onClick={() => void edit(window.orderJudgeApi.movePath(which, i, -1), 'order-judge:move-path')} className={iconButton}><span className="material-symbols-outlined text-[18px] leading-none">arrow_upward</span></button>
              <button type="button" aria-label="下移" disabled={i === paths.length - 1} onClick={() => void edit(window.orderJudgeApi.movePath(which, i, 1), 'order-judge:move-path')} className={iconButton}><span className="material-symbols-outlined text-[18px] leading-none">arrow_downward</span></button>
              <button type="button" aria-label="移除" onClick={() => void edit(window.orderJudgeApi.removePath(which, i), 'order-judge:remove-path')} className={iconButton}><span className="material-symbols-outlined text-[18px] leading-none">close</span></button>
            </div>
          ))}
          <button type="button" onClick={() => void pick(which)} className="h-9 px-3 rounded-xl font-label text-sm text-primary hover:bg-primary/10">{paths.length ? '添加路径' : '选择文件'}</button>
        </div>
      </div>
    )
  }

  const notice = settings?.shared && !settings.hasWebAccount ? '请先在应用设置中登录网页版账号'
    : settings?.shared && settings.sync.state === 'error' ? settings.sync.message : ''

  return (
    <>
      <div className={`fixed inset-0 bg-black/40 z-[60] transition-opacity ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={onClose} />
      <aside className={`fixed top-0 right-0 bottom-0 w-[400px] max-w-full transition-transform duration-300 bg-surface-container-low border-l border-outline-variant/20 z-[70] flex flex-col ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between h-16 px-6 border-b border-outline-variant/20">
          <h3 className="text-lg font-bold tracking-tight">评估设置</h3>
          <button onClick={onClose} className="w-9 h-9 grid place-items-center rounded-xl text-on-surface-variant hover:bg-surface-container-high" aria-label="关闭">
            <span className="material-symbols-outlined leading-none">close</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-6 space-y-7">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={switching} checked={settings?.shared ?? false} onChange={e => void toggleShared(e.target.checked)} />与网页版共用评估和历史</label>
            {notice && <p role="status" className="text-sm text-on-surface-variant">{notice}</p>}
          </div>
          {pathList('能力档案', 'description', settings?.paths.profile ?? [], 'profile')}
          {pathList('项目日志', 'history_edu', settings?.paths.log ?? [], 'log')}
        </div>
        {err && (
          <div className="relative h-12 px-6 border-t border-outline-variant/20">
            <span className="absolute left-6 right-6 top-1/2 -translate-y-1/2 flex items-center gap-1 text-xs truncate text-error" title={err}>
              <span className="material-symbols-outlined text-[16px] leading-none">error</span>{err}
            </span>
          </div>
        )}
      </aside>
    </>
  )
}

// ── 页面 ──

const yuan = (n: number): string => `¥${n.toLocaleString('en-US')}`
const monthDay = (date: string): string => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`

// 与网页版估价卡片同一份数据（设计稿 docs/design-mockups/web/接单评估.html），样式跟桌面版 MD3
function EstimateCard({ est }: { est: Est }): JSX.Element {
  const head = (meta?: string): JSX.Element => (
    <div className="flex items-baseline gap-3 px-6 pt-5">
      <p className="flex items-center gap-1.5 font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/70">
        <span className="material-symbols-outlined text-[16px] leading-none">request_quote</span>估价
      </p>
      {meta && <p className="ml-auto font-label text-xs text-on-surface-variant/70 tabular-nums">{meta}</p>}
    </div>
  )
  const shell = (children: React.ReactNode): JSX.Element => (
    <article className="animate-fade-up mt-4 overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-low pb-5">{children}</article>
  )
  if (est.kind === 'run') {
    const steps = [
      { title: '拆任务', detail: est.tasks ? `${est.tasks} 个任务` : '', state: est.tasks ? 'done' : 'run' },
      { title: '估工时', detail: est.tasks ? `已估完 ${est.groups} / 8 组` : '', state: est.tasks ? 'run' : 'wait' },
    ]
    return shell(
      <>
        {head()}
        <ol className="grid gap-3 px-6 pt-4">
          {steps.map((s) => (
            <li key={s.title} className="flex items-start gap-3">
              <span className="mt-0.5 w-5 h-5 grid place-items-center">
                {s.state === 'done' && <span className="material-symbols-outlined text-[20px] leading-none text-yes">check_circle</span>}
                {s.state === 'run' && <span className="pulse-dot w-2.5 h-2.5 rounded-[9999px] bg-primary" />}
                {s.state === 'wait' && <span className="w-2.5 h-2.5 rounded-[9999px] bg-outline-variant/60" />}
              </span>
              <div>
                <p className={`text-sm font-bold ${s.state === 'run' ? 'text-on-surface' : 'text-on-surface-variant'}`}>{s.title}</p>
                {s.detail && <p className="text-xs text-on-surface-variant/70 mt-0.5">{s.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      </>,
    )
  }
  if (est.kind === 'error') {
    return shell(
      <>
        {head()}
        <p className="mx-6 mt-4 rounded-xl bg-error-container px-4 py-3 text-[14px] leading-relaxed text-on-error-container">{est.message}</p>
        <p className="mx-6 mt-2 font-label text-xs text-on-surface-variant/70">{est.code}</p>
      </>,
    )
  }
  const { hours, quote } = est.result
  const max = Math.max(1, ...hours.groups.map((g) => g.hours))
  const tiers = quote?.tiers ?? []
  return shell(
    <>
      {head(`${formatWhen(est.result.at)} · 用时 ${Math.round(est.result.ms / 1000)} 秒 · ${hours.taskCount} 个任务`)}
      <p className="px-6 pt-2 text-[28px] font-black leading-tight text-on-surface tabular-nums">
        {hours.totalHours.toLocaleString('en-US')}<span className="ml-1.5 text-sm font-bold text-on-surface-variant">小时</span>
      </p>
      {quote ? (
        <div className="px-6 pt-4">
          <div className="grid grid-cols-2 gap-3">
            {tiers.map((t) => (
              <div key={t.factor} className="rounded-xl bg-surface-container-high px-4 py-3">
                <p className="text-lg font-black text-on-surface tabular-nums">{yuan(t.price)}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-on-surface-variant tabular-nums">{t.workdays} 个工作日 · {monthDay(t.end)}交付 · 共 {t.calendarDays} 天</p>
              </div>
            ))}
          </div>
          {(quote.assumedYears.length > 0 || quote.springFestivalRisk) && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {quote.assumedYears.length > 0 && <span className="rounded-lg bg-amber-container px-2 py-0.5 font-label text-[11px] font-bold text-amber">{quote.assumedYears.join('、')} 年节假日未公布，按双休估算</span>}
              {quote.springFestivalRisk && <span className="rounded-lg bg-amber-container px-2 py-0.5 font-label text-[11px] font-bold text-amber">交期跨春节，实际可能顺延</span>}
            </div>
          )}
          <p className="mt-3 flex gap-1.5 text-xs leading-relaxed text-on-surface-variant">
            <span className="material-symbols-outlined text-[16px] leading-none text-amber">info</span>
            <span>以上不含加急。加急每提前 1 天加（请的人数 + 1）× {DAY_RATE} 元，最多提前 {tiers.map((t) => t.calendarDays).join(' / ')} 天；例：请 1 人提前 2 天加 {2 * 2 * DAY_RATE} 元。</span>
          </p>
        </div>
      ) : (
        <p className="mx-6 mt-4 rounded-xl bg-amber-container px-4 py-3 text-[14px] leading-relaxed text-amber">{est.result.quoteError}</p>
      )}
      <div className="mx-6 mt-4 grid gap-0.5 border-t border-outline-variant/20 pt-3">
        {hours.groups.map((g, i) => (
          <details key={g.key} open={i === 0} className="group">
            <summary className="grid cursor-pointer list-none grid-cols-[7em_1fr_auto_18px] items-center gap-3 py-1.5 text-[13px] text-on-surface [&::-webkit-details-marker]:hidden">
              <span>{g.name}</span>
              <span className="h-1.5 overflow-hidden rounded-[9999px] bg-surface-container-highest"><i className="block h-full rounded-[9999px] bg-primary" style={{ width: `${Math.round(g.hours / max * 100)}%` }} /></span>
              <span className="whitespace-nowrap text-right tabular-nums text-on-surface-variant">{g.hours} 小时</span>
              <span className="material-symbols-outlined text-[18px] leading-none text-on-surface-variant/70 transition-transform group-open:rotate-180">expand_more</span>
            </summary>
            <ul className="mb-2 ml-[calc(7em+12px)] grid gap-0.5">
              {g.tasks.map((t, k) => (
                <li key={k} className="flex justify-between gap-3 text-xs leading-relaxed text-on-surface-variant">
                  <span>{t.title}</span><span className="shrink-0 tabular-nums text-on-surface-variant/70">{t.hours}</span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </>,
  )
}

function OrderJudge(): JSX.Element {
  const [text, setText] = useState('')
  const [materials, setMaterials] = useState<Material[]>([])
  const [unreadable, setUnreadable] = useState<string[]>([])
  const [running, setRunning] = useState<Running | null>(null)
  const [now, setNow] = useState(Date.now())
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [est, setEst] = useState<Est | null>(null)
  const [history, setHistory] = useState<{ base: string; entries: OrderJudgeHistoryEntry[] }>({ base: '', entries: [] })
  const [selected, setSelected] = useState<string | null>(null)
  const [settings, setSettings] = useState<OrderJudgeSettings | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [emptyTip, setEmptyTip] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const resultRef = useRef<HTMLElement>(null)
  const shotCount = useRef(0)
  const dragDepth = useRef(0)

  const historyRequest = useRef(0)
  const historyOwner = useRef('')
  const loadHistory = useCallback(async () => {
    const request = ++historyRequest.current
    try {
      const next = await window.orderJudgeApi.history()
      if (request === historyRequest.current) setHistory(next)
    } catch (e) {
      reportError('order-judge:history', e)
    }
  }, [])

  useEffect(() => {
    let live = true
    const refresh = (): void => {
      window.orderJudgeApi.getSettings().then(next => {
        if (!live) return
        const owner = JSON.stringify([next.shared, next.webUsername])
        if (owner !== historyOwner.current) { historyOwner.current = owner; historyRequest.current++; setHistory({ base: '', entries: [] }); setSelected(null) }
        setSettings(next); void loadHistory()
      }).catch((e) => reportError('order-judge:settings', e))
    }
    refresh()
    const stop = window.orderJudgeApi.onChanged(refresh)
    return () => { live = false; historyRequest.current++; stop() }
  }, [loadHistory])

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
      if (sheetOpen) return
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
  }, [addFiles, sheetOpen])

  const clearAll = (): void => {
    materials.forEach((m) => m.preview && URL.revokeObjectURL(m.preview))
    setMaterials([])
    setText('')
    setUnreadable([])
    setOutcome(null)
    setSelected(null)
    shotCount.current = 0
    textRef.current?.focus()
  }

  const showResult = (): void => {
    requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const evaluate = async (): Promise<void> => {
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
    setEst(null)
    const off = window.orderJudgeApi.onProgress((p) => {
      if (p.stage === 'verdict') {
        // 结论先到先显示，估价接着在下面跑
        setOutcome({ type: 'report', entry: p.entry, warnings: [] })
        setRunning(null)
        setEst((x) => x ?? { kind: 'run', tasks: 0, groups: 0 })
        return
      }
      if (p.stage === 'estimate') {
        const e = p.event
        if (e.type === 'scope') setEst({ kind: 'run', tasks: e.tasks, groups: 0 })
        else if (e.type === 'group') setEst((x) => (x?.kind === 'run' ? { ...x, groups: x.groups + 1 } : x))
        else if (e.type === 'done') setEst({ kind: 'done', result: e.result })
        else if (e.type === 'error') setEst({ kind: 'error', code: e.code, message: e.error })
        else setEst((x) => x ?? { kind: 'run', tasks: 0, groups: 0 })
        return
      }
      setRunning((r) => (r ? (p.stage === 'links' ? { ...r, stage: 'links', links: p.count } : { ...r, stage: 'ai' }) : r))
    })
    try {
      const prepared = await prepareMaterials(text, materials.map((m) => m.file))
      setUnreadable(prepared.unreadable)
      const pre = precheck(prepared.text, prepared.images.length)
      if (pre) {
        setOutcome({ type: 'precheck', kind: pre })
        return
      }
      setRunning((r) => (r ? { ...r, stats: prepared.stats } : r))
      const res = await window.orderJudgeApi.judge({ text: prepared.text, images: prepared.images })
      if (res.ok) {
        setOutcome({ type: 'report', entry: res.entry, warnings: res.warnings })
        void loadHistory()
      } else {
        setOutcome({ type: 'error', code: res.code, detail: res.detail })
        if (res.code === 'NEED_WEB') {
          window.orderJudgeApi.getSettings().then(setSettings).catch(() => undefined)
        }
      }
    } catch (e) {
      reportError('order-judge:evaluate', e)
      setOutcome({ type: 'error', code: 'THROWN', detail: ipcErrMsg(e, '未知错误') })
    } finally {
      off()
      setRunning(null)
      showResult()
    }
  }

  const reloadFromHistory = async (entry: OrderJudgeHistoryEntry): Promise<void> => {
    try {
      const files = await Promise.all(entry.images.map(async (img) => {
        const blob = await (await fetch(`${history.base}/${entry.id}/${img.file}`)).blob()
        return new File([blob], `${img.name}.jpg`, { type: 'image/jpeg' })
      }))
      clearAll()
      setText(entry.order)
      addFiles(files)
    } catch (e) {
      reportError('order-judge:reload', e)
    }
  }

  const deleteEntry = async (id: string): Promise<void> => {
    try {
      await window.orderJudgeApi.deleteHistory(id)
      if (selected === id) setSelected(null)
      await loadHistory()
    } catch (e) {
      reportError('order-judge:delete', e)
    }
  }

  const selectedEntry = history.entries.find((x) => x.id === selected) ?? null
  const elapsed = running ? Math.max(0, Math.round((now - running.startedAt) / 1000)) : 0
  const needsSetup = settings !== null && (!settings.shared || !settings.hasWebAccount)
  const unreadableSet = new Set(unreadable)
  const verdictCount = (v: string): number => history.entries.filter((x) => x.report.verdict === v).length

  const renderResult = (): React.ReactNode => {
    if (selectedEntry) {
      const r = selectedEntry.report
      return (
        <>
        <Card verdict={r.verdict}>
          <div className="flex items-center justify-between gap-3 px-6 pt-4 -mb-2 font-label text-xs text-on-surface-variant/70">
            <span className="flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px] leading-none">history</span>{formatWhen(selectedEntry.at)}</span>
            <span className="flex items-center gap-1">
              <button onClick={() => void reloadFromHistory(selectedEntry)} className="h-8 px-2.5 rounded-xl hover:bg-surface-container-high hover:text-on-surface flex items-center gap-1">
                <span className="material-symbols-outlined text-[16px] leading-none">refresh</span>放回输入框
              </button>
              <button onClick={() => setSelected(null)} className="h-8 px-2.5 rounded-xl hover:bg-surface-container-high hover:text-on-surface flex items-center gap-1">
                <span className="material-symbols-outlined text-[16px] leading-none">close</span>收起
              </button>
            </span>
          </div>
          <VerdictBar verdict={r.verdict} headline={r.headline} />
          <ReportBody r={r} />
          <Section label="当时放进来的材料">
            {selectedEntry.order && (
              <p className="mb-3 text-[13px] leading-relaxed text-on-surface-variant line-clamp-3 whitespace-pre-wrap">{selectedEntry.order}</p>
            )}
            {selectedEntry.images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedEntry.images.map((img) => (
                  <img key={img.file} src={`${history.base}/${selectedEntry.id}/${img.file}`} alt={img.name} title={img.name} className="w-[92px] h-[68px] rounded-xl object-cover bg-surface-container-highest" />
                ))}
              </div>
            )}
          </Section>
        </Card>
        {selectedEntry.estimate && <EstimateCard est={{ kind: 'done', result: selectedEntry.estimate }} />}
        </>
      )
    }
    if (running) {
      const steps: { title: string; detail: string; state: 'done' | 'run' | 'wait' }[] = [
        { title: '整理材料', detail: running.stage === 'prepare' ? '截图、视频、文档转成 AI 能看的格式' : running.stats.join(' · '), state: running.stage === 'prepare' ? 'run' : 'done' },
      ]
      if (running.links) steps.push({ title: '打开网址', detail: `${running.links} 个`, state: running.stage === 'links' ? 'run' : 'done' })
      steps.push({ title: 'AI 判断中', detail: '对照能力档案和项目日志', state: running.stage === 'ai' ? 'run' : 'wait' })
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
    if (outcome.type === 'error') {
      return <ErrorCard code={outcome.code} detail={outcome.detail} onSettings={() => setSheetOpen(true)} />
    }
    if (outcome.type === 'precheck') {
      return (
        <Card verdict="信息不足">
          <VerdictBar
            verdict="信息不足"
            headline={outcome.kind === 'empty' ? '没有拿到派单内容' : '内容里只有「[聊天记录]」，转发的记录复制不出来'}
          />
          {outcome.kind === 'chat-record' && (
            <Section label="怎么补">
              <p className="text-[14px] leading-relaxed text-on-surface-variant">
                在微信里点开这条聊天记录，用 <kbd className="font-label text-[11px] px-1.5 py-0.5 rounded-lg bg-surface-container-highest">{SHOT_KEY}</kbd> 截图后粘贴进来，再评估一次。
              </p>
            </Section>
          )}
        </Card>
      )
    }
    const r = outcome.entry.report
    return (
      <>
      <Card verdict={r.verdict}>
        <VerdictBar
          verdict={r.verdict}
          headline={r.headline}
          sub={outcome.warnings.map((w) => (
            <p key={w} className="mt-1.5 flex items-center gap-1 text-xs text-amber">
              <span className="material-symbols-outlined text-[14px] leading-none">warning</span>{w}
            </p>
          ))}
        />
        <ReportBody r={r} />
      </Card>
      {est && <EstimateCard est={est} />}
      </>
    )
  }

  const tag: Record<string, string> = {
    能: 'bg-yes-container text-yes',
    不能: 'bg-error-container text-on-error-container dark:text-error',
    信息不足: 'bg-amber-container text-amber',
  }

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
                {history.entries.length
                  ? `${history.entries.length} 单 · 能 ${verdictCount('能')} · 不能 ${verdictCount('不能')} · 信息不足 ${verdictCount('信息不足')}`
                  : '还没有评估记录'}
              </p>
            </div>
            <button
              onClick={() => setSheetOpen(true)}
              className="relative shrink-0 flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl bg-surface-container-high border border-outline-variant/20 text-on-surface font-label text-xs uppercase tracking-widest hover:bg-surface-bright hover:border-primary/40 transition-all active:scale-95 whitespace-nowrap"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>tune</span>
              <span className="hidden sm:inline">评估设置</span>
              {needsSetup && <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-[9999px] bg-amber ring-2 ring-surface-container-lowest" />}
            </button>
          </div>
        </div>

      <div className="pt-8 px-4 md:px-8 pb-16">
        <div className="mx-auto max-w-[1180px] grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">

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
                placeholder="粘贴派单文字或截图，可以粘贴多次"
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
                  onClick={() => void evaluate()}
                  disabled={!!running}
                  className="shrink-0 w-[132px] h-10 rounded-xl bg-primary text-on-primary font-bold text-sm flex items-center justify-center gap-1.5 hover:brightness-110 disabled:opacity-60 disabled:hover:brightness-100 transition"
                >
                  <span className="material-symbols-outlined text-[18px] leading-none">{running ? 'hourglass_top' : 'gavel'}</span>
                  <span className="tabular-nums">{running ? `分析中 ${elapsed} 秒` : '评估'}</span>
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
                <dd className="text-on-surface-variant">以文字形式贴进输入框，会打开网页读取标题和正文开头，每单最多 10 个。截图里的网址不会被打开</dd>
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
                <h3 className="font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant/70">历史记录</h3>
                {history.entries.length > 0 && (
                  <span className="font-label text-[11px] text-on-surface-variant/50 tabular-nums">{history.entries.length} 条</span>
                )}
              </div>
              {history.entries.length === 0 ? (
                <p className="px-1 py-6 text-sm text-on-surface-variant/60">还没有评估过的派单</p>
              ) : (
                <div className="xl:max-h-[calc(100vh-280px)] overflow-y-auto custom-scrollbar -mx-1 px-1">
                  {history.entries.map((x) => {
                    const on = selected === x.id
                    return (
                      <div
                        key={x.id}
                        onClick={() => { setSelected(x.id); showResult() }}
                        className={`group relative grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 items-center cursor-pointer rounded-xl px-3 py-2.5 transition-colors ${on ? 'bg-surface-container-high' : 'hover:bg-surface-container'}`}
                      >
                        <span className={`row-span-2 self-start mt-0.5 min-w-[52px] text-center rounded-lg px-1.5 py-0.5 font-label text-[11px] font-bold ${tag[x.report.verdict]}`}>{x.report.verdict}</span>
                        <span className={`truncate pr-7 text-sm text-on-surface ${on ? 'font-bold' : ''}`}>{x.report.title || x.report.summary || x.order || '（截图）'}</span>
                        <span className="font-label text-[11px] text-on-surface-variant/60 tabular-nums">
                          {formatWhen(x.at)}{x.images.length ? ` · ${x.images.length} 张图` : ''}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); void deleteEntry(x.id) }}
                          title="删除这条"
                          aria-label="删除这条"
                          className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 grid place-items-center rounded-xl text-on-surface-variant/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-error hover:bg-surface-container-highest transition"
                        >
                          <span className="material-symbols-outlined text-[16px] leading-none">delete</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      </div>

      <SettingsSheet open={sheetOpen} settings={settings} onClose={() => setSheetOpen(false)} onChange={setSettings} />
    </div>
  )
}

export default OrderJudge

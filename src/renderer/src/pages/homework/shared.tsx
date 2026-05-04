// Shared types, helpers, and primitive UI used by HomeworkView / ClassicView.

export interface Attack {
  id: number
  team: string[]
  note: string
  updatedAt: string
}

export interface DefenseGroup {
  id: number
  defense: string[]
  updatedAt: string
  attacks: Attack[]
}

/**
 * Backfill missing `updatedAt` on attacks using today's date.
 * Idempotent. Mirrors normalizeClassic for the homework dataset.
 */
export function normalizeHomework(groups: DefenseGroup[]): DefenseGroup[] {
  const now = todayStr()
  return groups.map(g => ({
    ...g,
    attacks: g.attacks.map(a => ({
      ...a,
      updatedAt: a.updatedAt || now,
    })),
  }))
}

export interface ClassicTeam {
  id: number
  team: string[]
  note: string
  updatedAt: string
}

export interface ClassicGroup {
  id: number
  title: string
  updatedAt: string
  teams: ClassicTeam[]
}

/**
 * Backfill missing `updatedAt` on teams using today's date.
 * Idempotent: only touches teams that lack a date (e.g. legacy data).
 * After running, the user should manually push to sync the dated data to WebDAV.
 */
export function normalizeClassic(groups: ClassicGroup[]): ClassicGroup[] {
  const now = todayStr()
  return groups.map(g => ({
    ...g,
    teams: g.teams.map(t => ({
      ...t,
      updatedAt: t.updatedAt || now,
    })),
  }))
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function ipcErrMsg(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  return e.message.replace(/^Error invoking remote method '[^']+': /, '') || fallback
}

export function commonPrefixLen(teams: string[][]): number {
  if (teams.length <= 1) return 0
  let n = 0
  const first = teams[0]
  while (n < first.length) {
    if (!teams.every(t => t[n] === first[n])) break
    n++
  }
  return n
}

export function stripCjkLatinSpaces(s: string): string {
  return s
    .replace(/(?<=[一-鿿])\s+(?=[a-zA-Z0-9])/g, '')
    .replace(/(?<=[a-zA-Z0-9])\s+(?=[一-鿿])/g, '')
}

export function cleanCharName(s: string): string {
  return stripCjkLatinSpaces(s.replace(/`/g, '').trim())
}

/** Match against the defense field only. Attacks and notes are ignored. */
export function matchesDefense(item: DefenseGroup, q: string): boolean {
  if (!q) return true
  const terms = stripCjkLatinSpaces(q.toLowerCase()).split(/[、\s]+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = item.defense.join(' ').toLowerCase()
  return terms.every(t => hay.includes(t))
}

/** Match against the title field only. Teams and notes are ignored. */
export function matchesClassic(item: ClassicGroup, q: string): boolean {
  if (!q) return true
  const terms = stripCjkLatinSpaces(q.toLowerCase()).split(/[、\s]+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = item.title.toLowerCase()
  return terms.every(t => hay.includes(t))
}

export function todayStr(): string {
  // Local date — toISOString() returns UTC and would roll back across midnight
  // for users east of UTC (e.g. UTC+8 sees yesterday's date until 08:00 local).
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function Highlight({ text, query }: { text: string; query: string }): JSX.Element {
  if (!query) return <>{text}</>
  const re = new RegExp(`(${escapeRe(query)})`, 'gi')
  const parts: Array<{ t: string; m: boolean }> = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ t: text.slice(last, match.index), m: false })
    parts.push({ t: match[0], m: true })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ t: text.slice(last), m: false })
  return (
    <>
      {parts.map((p, i) =>
        p.m ? <mark key={i} className="hl">{p.t}</mark> : <span key={i}>{p.t}</span>
      )}
    </>
  )
}

export function ModalShell({ onBackdrop, children }: { onBackdrop: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onBackdrop} />
      <div className="relative bg-surface-container-high backdrop-blur rounded-xl border border-outline-variant/25 shadow-2xl w-[520px] max-w-[92vw]">
        {children}
      </div>
    </div>
  )
}

export function FormField({
  label, dot, hint, children,
}: { label: string; dot?: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <label className="flex items-center gap-2 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2">
        {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot} inline-block flex-shrink-0`} />}
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">{hint}</p>}
    </div>
  )
}

export function ModalInput(props: React.InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      {...props}
      className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
    />
  )
}


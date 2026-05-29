// Shared types, helpers, and primitive UI used by HomeworkView / ClassicView.

import { useLayoutEffect, useRef, useState } from 'react'

export interface Attack {
  id: number
  team: string[]
  notes: string[]
  updatedAt: string
}

export interface DefenseGroup {
  id: number
  defense: string[]
  updatedAt: string
  attacks: Attack[]
  /**
   * Group-level notes — used by JJC 换防 (attackOptional mode) when the user
   * records a defense lineup without any attacks. They render under the group
   * header so the user can see them on first scan. Default `[]`.
   */
  notes?: string[]
}

/** Coerce legacy `note: string` or fresh `notes: string[]` into a normalized array. */
export function coerceNotes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === 'string')
      .map(s => s.trim())
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    const t = raw.trim()
    return t ? [t] : []
  }
  return []
}

/**
 * Backfill missing `updatedAt` and migrate `note` (string) → `notes` (array).
 * Idempotent.
 */
export function normalizeHomework(groups: DefenseGroup[]): DefenseGroup[] {
  const now = todayStr()
  return groups.map(g => ({
    ...g,
    notes: coerceNotes((g as { notes?: unknown }).notes),
    attacks: g.attacks.map(a => ({
      id: a.id,
      team: a.team,
      notes: coerceNotes((a as { notes?: unknown; note?: unknown }).notes ?? (a as { note?: unknown }).note),
      updatedAt: a.updatedAt || now,
    })),
  }))
}

export interface ClassicTeam {
  id: number
  team: string[]
  notes: string[]
  updatedAt: string
}

export interface ClassicGroup {
  id: number
  title: string
  updatedAt: string
  teams: ClassicTeam[]
}

/**
 * Backfill missing `updatedAt` and migrate `note` (string) → `notes` (array).
 * Idempotent: only touches teams that lack a date or still carry the legacy field.
 * After running, the user should manually push to sync the dated data to WebDAV.
 */
export function normalizeClassic(groups: ClassicGroup[]): ClassicGroup[] {
  const now = todayStr()
  return groups.map(g => ({
    ...g,
    teams: g.teams.map(t => ({
      id: t.id,
      team: t.team,
      notes: coerceNotes((t as { notes?: unknown; note?: unknown }).notes ?? (t as { note?: unknown }).note),
      updatedAt: t.updatedAt || now,
    })),
  }))
}

// ── PJJC (3v3 换防) ──────────────────────────────────────────────────────────
// PJJC = "皮甲竞技场 / 巅峰竞技场" — defenders set 3 lineups simultaneously, and
// attackers must clear all 3 (one team per defense). A PjjcGroup is therefore a
// 3-defense bundle, and each PjjcAttack is a 3-team bundle that beats it (with
// shared notes describing the run).
export interface PjjcAttack {
  id: number
  teams: string[][]   // length 3, paired 1:1 with PjjcGroup.defenses
  notes: string[]
  updatedAt: string
}

export interface PjjcGroup {
  id: number
  defenses: string[][]  // length 3
  updatedAt: string
  attacks: PjjcAttack[]
  /** Group-level notes — defense-side annotations. Default `[]`. */
  notes?: string[]
}

function padToThree(rows: string[][]): string[][] {
  const out = rows.slice(0, 3)
  while (out.length < 3) out.push([])
  return out
}

export function normalizePjjc(groups: unknown): PjjcGroup[] {
  if (!Array.isArray(groups)) return []
  const now = todayStr()
  return groups
    .filter((g): g is object => !!g && typeof g === 'object')
    .map((raw, gi) => {
      const g = raw as { id?: unknown; defenses?: unknown; updatedAt?: unknown; attacks?: unknown }
      const defenses = padToThree(
        (Array.isArray(g.defenses) ? g.defenses : [])
          .map((d: unknown) =>
            Array.isArray(d)
              ? d.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean)
              : [])
      )
      const attacks: PjjcAttack[] = Array.isArray(g.attacks)
        ? g.attacks.map((ar: unknown, ai) => {
            const a = ar as { id?: unknown; teams?: unknown; notes?: unknown; note?: unknown; updatedAt?: unknown }
            const teams = padToThree(
              (Array.isArray(a.teams) ? a.teams : [])
                .map((t: unknown) =>
                  Array.isArray(t)
                    ? t.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean)
                    : [])
            )
            return {
              id: typeof a.id === 'number' ? a.id : Date.now() + gi * 100 + ai,
              teams,
              notes: coerceNotes(a.notes ?? a.note),
              updatedAt: typeof a.updatedAt === 'string' && a.updatedAt ? a.updatedAt : now,
            }
          })
        : []
      return {
        id: typeof g.id === 'number' ? g.id : Date.now() + gi,
        defenses,
        updatedAt: typeof g.updatedAt === 'string' && g.updatedAt ? g.updatedAt : now,
        attacks,
        notes: coerceNotes((g as { notes?: unknown }).notes),
      }
    })
}

export function matchesPjjc(group: PjjcGroup, q: string): boolean {
  if (!q) return true
  const terms = stripCjkLatinSpaces(q.toLowerCase()).split(/[、\s]+/).filter(Boolean)
  if (terms.length === 0) return true
  // 3 个防守阵容拍平成一串角色位，每个搜索词占一个不同的位（同上二分匹配规则）
  return matchesAllRoles(group.defenses.flat(), terms)
}

// ── Log entry (做过的事记录) ───────────────────────────────────────────────────
// 极简结构：只有正文，无时间无嵌套。展示时用「、」拼接成流式文本。
export interface LogEntry {
  id: number
  text: string
}

export function normalizeLog(entries: unknown): LogEntry[] {
  if (!Array.isArray(entries)) return []
  const seen = new Set<number>()
  return entries
    .map((raw, i) => {
      if (!raw || typeof raw !== 'object') return null
      const e = raw as { id?: unknown; text?: unknown }
      const text = typeof e.text === 'string' ? e.text.trim() : ''
      if (!text) return null
      let id = typeof e.id === 'number' ? e.id : Date.now() + i
      while (seen.has(id)) id++
      seen.add(id)
      return { id, text }
    })
    .filter((e): e is LogEntry => e !== null)
}

export function matchesLog(entry: LogEntry, q: string): boolean {
  if (!q) return true
  const terms = stripCjkLatinSpaces(q.toLowerCase()).split(/[、\s]+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = entry.text.toLowerCase()
  return terms.every(t => hay.includes(t))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Re-export from the shared util so HomeworkLookup's existing import keeps working.
export { ipcErrMsg } from '../../utils/ipcError'

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

function stripCjkLatinSpaces(s: string): string {
  return s
    .replace(/(?<=[一-鿿])\s+(?=[a-zA-Z0-9])/g, '')
    .replace(/(?<=[a-zA-Z0-9])\s+(?=[一-鿿])/g, '')
}

export function cleanCharName(s: string): string {
  return stripCjkLatinSpaces(s.replace(/`/g, '').trim())
}

/**
 * 判断一组角色位（roles）能否满足全部搜索词（terms）——**每个词占一个不同的
 * 角色位**（二分匹配）。
 *
 * 规则：
 * - 角色位整名精确匹配，**不做子串包含** —— 搜「驴」命中不了「魔驴」（两个不同角色）。
 * - 「/」是「二选一」记号：角色位「涅比亚/ams」表示这个位填涅比亚**或** ams。
 *   所以单搜「涅比亚」或单搜「ams」都能命中它（拆开任一别名匹配即可）。
 * - 但搜「涅比亚、ams」要求**两个不同的位**分别是涅比亚和 ams；「涅比亚/ams」只是
 *   一个二选一的位，不能同时算作两者 → 用二分匹配保证每个词占独立的角色位。
 *
 * 规模极小（角色 / 词都 ≤5），直接回溯。
 */
function matchesAllRoles(roles: string[], terms: string[]): boolean {
  // 每个角色位 → 它能被哪些词命中（整名 + "/" 拆出的各别名，全小写）
  const roleAlts = roles.map(r => {
    // stripCjkLatinSpaces 同时作用于角色位：存量数据里「水 m」这种中英文之间带
    // 空格的名字（拼音输入法的产物），要去掉空格后再比，否则匹配不到（查询词那
    // 边已经 strip 过了，两边都 strip 才能对上）。
    const lower = stripCjkLatinSpaces(r.toLowerCase()).trim()
    const alts = new Set<string>()
    if (lower) alts.add(lower)
    for (const part of lower.split('/')) {
      const p = part.trim()
      if (p) alts.add(p)
    }
    return alts
  })
  const used = new Array(roleAlts.length).fill(false)
  // 回溯：给第 i 个词找一个还没被占、且能命中它的角色位
  const assign = (i: number): boolean => {
    if (i >= terms.length) return true
    for (let r = 0; r < roleAlts.length; r++) {
      if (used[r] || !roleAlts[r].has(terms[i])) continue
      used[r] = true
      if (assign(i + 1)) return true
      used[r] = false
    }
    return false
  }
  return assign(0)
}

/** Match against the defense field only. Attacks and notes are ignored. */
export function matchesDefense(item: DefenseGroup, q: string): boolean {
  if (!q) return true
  const terms = stripCjkLatinSpaces(q.toLowerCase()).split(/[、\s]+/).filter(Boolean)
  if (terms.length === 0) return true
  return matchesAllRoles(item.defense, terms)
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

// ── Note chip — refined editorial tag ─────────────────────────────────────────
// Design: hairline border + gradient tonal fill + left accent bar.
// Replaces the legacy "blue pill + dot" with something more intentional.
// To "edit", the user removes via ✕ and re-adds — same model as GitHub labels /
// Issue assignees. Avoids the in-place edit state machine (and the surprise
// double-click hit area users sometimes triggered while just selecting text).
export function NoteChip({
  text, query, withRemove, onRemove,
}: {
  text: string
  query?: string
  withRemove?: boolean
  onRemove?: () => void
}): JSX.Element {
  return (
    <span className="inline-flex items-stretch overflow-hidden rounded-md border border-secondary/[0.18] bg-gradient-to-r from-secondary/[0.10] to-secondary/[0.03] hover:from-secondary/[0.14] hover:to-secondary/[0.05] transition-colors">
      <span
        aria-hidden
        className="w-[2.5px] shrink-0 bg-gradient-to-b from-secondary/80 via-secondary/55 to-secondary/30"
      />
      <span className="px-2.5 py-[3px] text-[11.5px] font-medium text-secondary/95 tracking-[0.005em] leading-[1.45] whitespace-nowrap select-none">
        {query ? <Highlight text={text} query={query} /> : text}
      </span>
      {withRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove?.() }}
          tabIndex={-1}
          title="移除该备注"
          className="px-1.5 flex items-center text-secondary/45 hover:text-error hover:bg-error/12 transition-colors"
        >
          <span className="material-symbols-outlined text-[12px] leading-none">close</span>
        </button>
      )}
    </span>
  )
}

/** Inline list of NoteChips for a row. Renders nothing if `notes` is empty. */
export function NoteChipList({ notes, query }: { notes: string[]; query?: string }): JSX.Element | null {
  if (notes.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {notes.map((n, i) => <NoteChip key={i} text={n} query={query} />)}
    </div>
  )
}

/** Build the "copy" payload for an attack/team line — names joined with 、, notes appended in parentheses. */
export function copyTeamText(team: string[], notes: string[]): string {
  return team.join('、') + (notes.length ? ` (${notes.join(' / ')})` : '')
}

// ── Reverse of copyTeamText: parse pasted "<team> (note1 / note2)" payloads ──

/**
 * Inverse of `copyTeamText`. Recognizes our own emitted format plus a few
 * tolerated variants:
 *   - ASCII or full-width parens: `(...)` / `（...）`
 *   - Slash separator with optional surrounding whitespace
 *
 * Returns null when the input doesn't end with a parens block — that case is
 * indistinguishable from a normal team-only paste and the default paste should
 * proceed.
 */
export function parseTeamPaste(text: string): { team: string; notes: string[] } | null {
  // Trailing parens block, greedy team part, non-paren-containing notes body.
  const m = text.match(/^(.+?)\s*[（(]\s*([^()（）]+?)\s*[）)]\s*$/)
  if (!m) return null
  const teamPart = m[1].trim()
  const notesPart = m[2].trim()
  if (!teamPart || !notesPart) return null
  const notes = notesPart
    .split(/\s*\/\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (notes.length === 0) return null
  return { team: teamPart, notes }
}

/**
 * Build an `onPaste` handler for a team `ModalInput` that auto-extracts a
 * trailing "(notes ...)" block into the chip-style notes field. Returns a
 * no-op handler that defers to the browser when the paste isn't a full-field
 * replace OR doesn't match our copy format, so partial inserts (e.g. user
 * editing a single character in the middle) aren't hijacked.
 *
 * Merges new notes into existing ones (dedup) rather than replacing — if the
 * user added a note before pasting, we don't want to lose it.
 */
export function createTeamPasteHandler(opts: {
  setTeam: (v: string) => void
  setNotes: (n: string[]) => void
  currentNotes: string[]
}): (e: React.ClipboardEvent<HTMLInputElement>) => void {
  return (e) => {
    const input = e.currentTarget
    const valueLen = input.value.length
    const selStart = input.selectionStart ?? 0
    const selEnd = input.selectionEnd ?? 0
    // Only intercept when paste replaces the WHOLE field (empty input, or full
    // selection). Middle-of-text paste falls through to the browser default.
    const isFullReplace = valueLen === 0 || (selStart === 0 && selEnd === valueLen)
    if (!isFullReplace) return

    const pasted = e.clipboardData.getData('text')
    const parsed = parseTeamPaste(pasted)
    if (!parsed) return

    e.preventDefault()
    opts.setTeam(parsed.team)
    const merged = [...opts.currentNotes]
    for (const n of parsed.notes) {
      if (!merged.includes(n)) merged.push(n)
    }
    opts.setNotes(merged)
  }
}

/** Shallow-equal for two string arrays (order-sensitive). */
export function notesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ── NoteTagInput — chip-style tag input for the modals ────────────────────────
// Behavior (mirrors GitHub label / assignee pickers):
//   - Type + Enter on main input → adds the trimmed draft as a new chip
//   - Click ✕ on any chip        → removes that chip
//   - To "edit" a chip, remove it and type the new value
//   - onBlur on main input commits pending draft (no data loss on Save)
// Backspace on empty main input is intentionally a no-op so users don't
// accidentally wipe out chips while editing other fields.
export function NoteTagInput({
  notes, onNotesChange, draft, onDraftChange, placeholder,
}: {
  notes: string[]
  onNotesChange: (next: string[]) => void
  draft: string
  onDraftChange: (s: string) => void
  placeholder?: string
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [inputWidth, setInputWidth] = useState<number>(140)

  // Auto-size the input to fit the current draft (or placeholder when empty).
  // The hidden measuring span shares typography with the input, so its rendered
  // width is the natural width the input needs to display the same text.
  // Result: the input only consumes the space it actually needs on row 1, and
  // the flex-wrap container keeps it on row 1 as long as it fits — only
  // wrapping to row 2 when the typed text genuinely overflows.
  useLayoutEffect(() => {
    if (!measureRef.current) return
    const measured = measureRef.current.offsetWidth
    // Empty + no chips: roomy slot so the placeholder reads naturally.
    // Empty + chips present: just enough for the cursor + a couple chars.
    const minW = notes.length === 0 ? 140 : 14
    setInputWidth(Math.max(minW, measured + 12))
  }, [draft, notes.length, placeholder])

  const commit = (): void => {
    const t = draft.trim()
    if (!t) return
    if (!notes.includes(t)) onNotesChange([...notes, t])
    onDraftChange('')
  }

  const removeAt = (i: number): void => {
    onNotesChange(notes.filter((_, idx) => idx !== i))
  }

  // Text the measuring span renders. Mirrors what the user sees:
  // - draft when typing
  // - placeholder when empty and chips are absent
  // - empty (so the input collapses to minW) when chips are present and no draft
  const measureText = draft || (notes.length === 0 ? placeholder ?? '' : '')

  return (
    <div
      onClick={(e) => {
        // Only focus main input when clicking the container's whitespace,
        // not when clicking a chip / button / inner input.
        if (e.target === e.currentTarget) inputRef.current?.focus()
      }}
      className="relative w-full bg-surface-container border border-outline-variant/20 rounded-lg px-2.5 py-2 flex flex-wrap items-center gap-1.5 focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary/30 transition-all min-h-[42px] cursor-text"
    >
      {notes.map((n, i) => (
        <NoteChip
          key={`${i}-${n}`}
          text={n}
          withRemove
          onRemove={() => removeAt(i)}
        />
      ))}
      {/* Hidden span — measures the natural width of `measureText` in the same
          typography as the input below. `whitespace-pre` preserves spaces. */}
      <span
        ref={measureRef}
        aria-hidden="true"
        className="invisible absolute whitespace-pre text-sm pointer-events-none"
        style={{ left: -9999, top: -9999 }}
      >
        {measureText || ' '}
      </span>
      <input
        ref={inputRef}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        value={draft}
        onChange={e => onDraftChange(e.target.value)}
        onKeyDown={e => {
          // Ignore Enter while an IME composition is active: pinyin users press
          // Enter to commit the composing buffer (e.g. "up" → 主), and that
          // keystroke must not be swallowed as a chip submission.
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            commit()
          }
          // No Backspace shortcut — chips are removed only via the ✕ button
          // to avoid accidental deletion when the user is editing other fields.
        }}
        onBlur={commit}
        placeholder={notes.length === 0 ? placeholder : ''}
        style={{ width: inputWidth }}
        // flex-shrink-0 + explicit width = the input occupies exactly
        // `inputWidth` and the flex-wrap parent will wrap it to row 2 only
        // when row 1 cannot fit it.
        className="flex-shrink-0 bg-transparent outline-none text-sm text-on-surface placeholder:text-on-surface-variant/35 py-0.5"
      />
    </div>
  )
}

/** Merge any pending draft text into the notes list (used by modal Save buttons). */
function flushNotes(notes: string[], draft: string): string[] {
  const t = draft.trim()
  if (!t) return notes
  if (notes.includes(t)) return notes
  return [...notes, t]
}

/** Initial state factory for a NoteTagInput hosted inside a modal. */
export function useNoteTagState(initial: string[]): {
  notes: string[]
  setNotes: (n: string[]) => void
  draft: string
  setDraft: (s: string) => void
  finalNotes: () => string[]
} {
  const [notes, setNotes] = useState<string[]>(initial)
  const [draft, setDraft] = useState('')
  return {
    notes,
    setNotes,
    draft,
    setDraft,
    finalNotes: () => flushNotes(notes, draft),
  }
}

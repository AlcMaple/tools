import { useEffect, useImperativeHandle, useState, forwardRef } from 'react'
import {
  ClassicGroup, ClassicTeam,
  Highlight, ModalShell, FormField, ModalInput,
  NoteChip, NoteTagInput, useNoteTagState,
  commonPrefixLen, matchesClassic, todayStr,
} from './shared'

export interface ClassicViewHandle {
  openAdd: () => void
}

// Helper: render a row's notes inline as chips (display-only).
function NoteChipList({ notes, query }: { notes: string[]; query?: string }): JSX.Element | null {
  if (notes.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {notes.map((n, i) => <NoteChip key={i} text={n} query={query} />)}
    </div>
  )
}

// Helper: build the "copy" payload for a team line. Notes are joined with ` / `.
function copyText(team: string[], notes: string[]): string {
  return team.join('、') + (notes.length ? ` (${notes.join(' / ')})` : '')
}

// Helper: shallow-equal for two string arrays (order-sensitive).
function notesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ── Add modal (new classic group) ──────────────────────────
function AddClassicModal({
  titleInput, teamInput,
  setTitleInput, setTeamInput,
  onClose, onSave,
}: {
  titleInput: string; teamInput: string
  setTitleInput: (v: string) => void
  setTeamInput: (v: string) => void
  onClose: () => void; onSave: (notes: string[]) => void
}): JSX.Element {
  const noteState = useNoteTagState([])
  const canSave = titleInput.trim().length > 0 && teamInput.trim().length > 0
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-tertiary/15 border border-tertiary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-tertiary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">新增经典阵容</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">记录一个常用阵容主题与首条阵容</p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-3">
        <div className="rounded-xl border border-tertiary/20 bg-tertiary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-tertiary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-tertiary/80">主题标题</span>
          </div>
          <ModalInput
            placeholder="例：无奶平推（经典三坦+魔女+涅比亚）"
            value={titleInput}
            onChange={e => setTitleInput(e.target.value)}
            autoFocus
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">支持括号说明，如「无奶平推（经典三坦+魔女+涅比亚）」</p>
        </div>

        <div className="flex items-center justify-center">
          <div className="flex items-center gap-1 text-on-surface-variant/30 text-[11px] font-label uppercase tracking-widest">
            <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
            阵容
          </div>
        </div>

        <div className="rounded-xl border border-secondary/20 bg-secondary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-secondary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>group</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-secondary/80">阵容</span>
          </div>
          <ModalInput
            placeholder="例：els、七七香、涅比亚、猪妹、春剑"
            value={teamInput}
            onChange={e => setTeamInput(e.target.value)}
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">用顿号 、 分隔，最多 5 名角色</p>
        </div>

        <div>
          <label className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mb-1.5">
            <span className="material-symbols-outlined text-[13px]">edit_note</span>
            备注（可选，可多条）
          </label>
          <NoteTagInput
            notes={noteState.notes}
            onNotesChange={noteState.setNotes}
            draft={noteState.draft}
            onDraftChange={noteState.setDraft}
            placeholder="如：叠叠乐 — 回车添加新备注"
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">回车提交一条；双击 chip 编辑；点 ✕ 移除</p>
        </div>
      </div>

      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(noteState.finalNotes())}
          disabled={!canSave}
          className="flex-1 py-3 rounded-xl border border-tertiary/40 bg-tertiary/10 text-sm font-bold text-tertiary hover:bg-tertiary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">save</span>
          保存
        </button>
      </div>
    </ModalShell>
  )
}

// ── Edit title modal ───────────────────────────────────────
function EditTitleModal({
  group, onClose, onSave,
}: {
  group: ClassicGroup
  onClose: () => void
  onSave: (newTitle: string) => void
}): JSX.Element {
  const [value, setValue] = useState(group.title)
  const canSave = value.trim().length > 0 && value.trim() !== group.title
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-tertiary/15 border border-tertiary/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-tertiary text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">编辑主题标题</h3>
            <p className="text-xs text-on-surface-variant/70">修改标题不会影响该主题下的阵容列表。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-5 space-y-4 border border-outline-variant/15">
          <div className="pb-4 border-b border-outline-variant/15">
            <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">阵容条数</p>
            <p className="text-xs font-mono">{group.teams.length} 条</p>
          </div>
          <FormField label="标题" dot="bg-tertiary">
            <ModalInput value={value} onChange={e => setValue(e.target.value)} autoFocus />
          </FormField>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(value.trim())}
          disabled={!canSave}
          className="flex-1 py-3 rounded-xl border border-tertiary/40 bg-tertiary/10 text-sm font-bold text-tertiary hover:bg-tertiary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">save</span>
          保存修改
        </button>
      </div>
    </ModalShell>
  )
}

// ── Edit team modal ────────────────────────────────────────
function EditTeamModal({
  team, onClose, onSave,
}: {
  team: ClassicTeam
  onClose: () => void
  onSave: (team: string[], notes: string[]) => void
}): JSX.Element {
  const [teamValue, setTeamValue] = useState(team.team.join('、'))
  const noteState = useNoteTagState(team.notes)
  const teamChanged = teamValue.trim() !== team.team.join('、')
  const finalNotes = noteState.finalNotes()
  const notesChanged = !notesEqual(finalNotes, team.notes)
  const canSave = teamValue.trim().length > 0 && (teamChanged || notesChanged)
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-secondary/15 border border-secondary/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-secondary text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>group</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">编辑阵容</h3>
            <p className="text-xs text-on-surface-variant/70">修改这条阵容的角色列表或备注信息。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-5 space-y-4 border border-outline-variant/15">
          <div className="pb-4 border-b border-outline-variant/15">
            <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5">当前阵容</p>
            <p className="text-sm text-on-surface-variant/70 font-mono">{team.team.join('、')}</p>
            {team.notes.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {team.notes.map((n, i) => <NoteChip key={i} text={n} />)}
              </div>
            )}
          </div>
          <FormField label="阵容角色" dot="bg-secondary" hint="用顿号 、 分隔，最多 5 名角色">
            <ModalInput value={teamValue} onChange={e => setTeamValue(e.target.value)} autoFocus />
          </FormField>
          <FormField label="备注（可选，可多条）" dot="bg-outline" hint="回车提交一条；双击 chip 编辑；点 ✕ 移除">
            <NoteTagInput
              notes={noteState.notes}
              onNotesChange={noteState.setNotes}
              draft={noteState.draft}
              onDraftChange={noteState.setDraft}
              placeholder="如：叠叠乐 — 回车添加新备注"
            />
          </FormField>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(teamValue.split('、').map(s => s.trim()).filter(Boolean), noteState.finalNotes())}
          disabled={!canSave}
          className="flex-1 py-3 rounded-xl border border-secondary/40 bg-secondary/10 text-sm font-bold text-secondary hover:bg-secondary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">save</span>
          保存修改
        </button>
      </div>
    </ModalShell>
  )
}

// ── Add team to existing group modal ───────────────────────
function AddTeamModal({
  group, onClose, onSave,
}: {
  group: ClassicGroup
  onClose: () => void
  onSave: (team: string[], notes: string[]) => void
}): JSX.Element {
  const [teamValue, setTeamValue] = useState('')
  const noteState = useNoteTagState([])
  const canSave = teamValue.trim().length > 0
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-secondary/15 border border-secondary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-secondary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>group</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-black tracking-tight">新增阵容</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label truncate">主题：{group.title}</p>
        </div>
      </div>
      <div className="px-7 py-5 space-y-3">
        <div className="rounded-xl border border-secondary/20 bg-secondary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-secondary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>group</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-secondary/80">阵容</span>
          </div>
          <ModalInput
            placeholder="例：els、七七香、涅比亚、猪妹、春剑"
            value={teamValue}
            onChange={e => setTeamValue(e.target.value)}
            autoFocus
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">用顿号 、 分隔，最多 5 名角色</p>
        </div>
        <div>
          <label className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mb-1.5">
            <span className="material-symbols-outlined text-[13px]">edit_note</span>
            备注（可选，可多条）
          </label>
          <NoteTagInput
            notes={noteState.notes}
            onNotesChange={noteState.setNotes}
            draft={noteState.draft}
            onDraftChange={noteState.setDraft}
            placeholder="如：叠叠乐 — 回车添加新备注"
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">回车提交一条；双击 chip 编辑；点 ✕ 移除</p>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(teamValue.split('、').map(s => s.trim()).filter(Boolean), noteState.finalNotes())}
          disabled={!canSave}
          className="flex-1 py-3 rounded-xl border border-secondary/40 bg-secondary/10 text-sm font-bold text-secondary hover:bg-secondary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">save</span>
          保存
        </button>
      </div>
    </ModalShell>
  )
}

// ── Delete group modal ─────────────────────────────────────
function DeleteClassicModal({
  group, onClose, onConfirm,
}: {
  group: ClassicGroup
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-5">
          <div className="w-12 h-12 rounded-xl bg-error/15 border border-error/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-error text-[24px]">delete</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">删除整个主题?</h3>
            <p className="text-xs text-on-surface-variant/70">该经典阵容主题及其所有阵容将被永久删除，此操作不可撤销。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-4 space-y-3 border border-outline-variant/15">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg border border-white/5 bg-gradient-to-b from-surface-container-high/50 to-surface-container-lowest flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-tertiary text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{group.title}</p>
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 mt-0.5">主题</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-outline-variant/15">
            <div>
              <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">阵容条数</p>
              <p className="text-xs font-mono">{group.teams.length} 条（将全部删除）</p>
            </div>
            <div>
              <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">最后更新</p>
              <p className="text-xs font-mono">{group.updatedAt}</p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-start gap-2 text-[11px] text-error font-label uppercase tracking-widest">
          <span className="material-symbols-outlined text-[14px] mt-px">warning</span>
          <span>删除后无法恢复，请谨慎操作。</span>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button onClick={onConfirm} className="flex-1 py-3 rounded-xl border border-error/40 bg-error/10 text-sm font-bold text-error hover:bg-error/20 transition-colors flex items-center justify-center gap-2">
          <span className="material-symbols-outlined text-base leading-none">delete</span>
          删除整组
        </button>
      </div>
    </ModalShell>
  )
}

// ── Delete team modal ──────────────────────────────────────
function DeleteTeamModal({
  team, onClose, onConfirm,
}: {
  team: ClassicTeam
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-5">
          <div className="w-12 h-12 rounded-xl bg-error/15 border border-error/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-error text-[24px]">delete</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">删除这条阵容？</h3>
            <p className="text-xs text-on-surface-variant/70">仅删除此条阵容，主题及其余阵容不受影响。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-4 space-y-3 border border-outline-variant/15">
          <div className="flex flex-wrap items-center gap-x-0.5 text-sm font-bold">
            {team.team.map((c, i) => (
              <span key={i} className="text-on-surface">
                {c}{i < team.team.length - 1 && <span className="text-outline-variant mx-0.5">、</span>}
              </span>
            ))}
            <span className="ml-2 font-label text-[10px] uppercase tracking-widest text-outline/70">{team.team.length}/5</span>
          </div>
          {team.notes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {team.notes.map((n, i) => <NoteChip key={i} text={n} />)}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-start gap-2 text-[11px] text-error font-label uppercase tracking-widest">
          <span className="material-symbols-outlined text-[14px] mt-px">warning</span>
          <span>删除后无法恢复，请谨慎操作。</span>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button onClick={onConfirm} className="flex-1 py-3 rounded-xl border border-error/40 bg-error/10 text-sm font-bold text-error hover:bg-error/20 transition-colors flex items-center justify-center gap-2">
          <span className="material-symbols-outlined text-base leading-none">delete</span>
          删除该条
        </button>
      </div>
    </ModalShell>
  )
}

// ── Main view ──────────────────────────────────────────────
const ClassicView = forwardRef<ClassicViewHandle, {
  data: ClassicGroup[]
  setData: React.Dispatch<React.SetStateAction<ClassicGroup[]>>
  query: string
  onClearQuery: () => void
}>(function ClassicView({ data, setData, query, onClearQuery }, ref) {
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set())

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [teamInput, setTeamInput] = useState('')

  const [editTitleGroup, setEditTitleGroup] = useState<ClassicGroup | null>(null)
  const [editTeamTarget, setEditTeamTarget] = useState<{ groupId: number; team: ClassicTeam } | null>(null)
  const [deleteGroup, setDeleteGroup] = useState<ClassicGroup | null>(null)
  const [deleteTeamTarget, setDeleteTeamTarget] = useState<{ groupId: number; team: ClassicTeam } | null>(null)
  const [addTeamTarget, setAddTeamTarget] = useState<ClassicGroup | null>(null)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyWithFeedback = (key: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  useImperativeHandle(ref, () => ({
    openAdd: () => {
      setTitleInput('')
      setTeamInput('')
      setIsAddOpen(true)
    },
  }), [])

  useEffect(() => {
    if (data.length > 1) {
      setCollapsedIds(new Set(data.slice(1).map(d => d.id)))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = data
    .filter(d => matchesClassic(d, query))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

  const totalTeams = filtered.reduce((s, d) => s + d.teams.length, 0)

  const toggleCollapse = (id: number) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleAdd = (notes: string[]) => {
    const title = titleInput.trim()
    const team = teamInput.split('、').map(s => s.trim()).filter(Boolean)
    if (!title || !team.length) return
    const now = todayStr()
    setData(prev => {
      const existing = prev.find(d => d.title === title)
      if (existing) {
        // Adding a team to an existing group: only the new team gets a fresh date.
        return prev.map(d =>
          d.id === existing.id
            ? { ...d, teams: [...d.teams, { id: Date.now(), team, notes, updatedAt: now }] }
            : d
        )
      }
      // New group: group + first team share the same date.
      return [...prev, { id: Date.now(), title, updatedAt: now, teams: [{ id: Date.now() + 1, team, notes, updatedAt: now }] }]
    })
    setIsAddOpen(false)
  }

  const handleEditTitle = (newTitle: string) => {
    if (!editTitleGroup) return
    setData(prev => prev.map(d =>
      d.id === editTitleGroup.id ? { ...d, title: newTitle, updatedAt: todayStr() } : d
    ))
    setEditTitleGroup(null)
  }

  const handleEditTeam = (team: string[], notes: string[]) => {
    if (!editTeamTarget) return
    const now = todayStr()
    setData(prev => prev.map(d =>
      d.id === editTeamTarget.groupId
        ? { ...d, teams: d.teams.map(t => t.id === editTeamTarget.team.id ? { ...t, team, notes, updatedAt: now } : t) }
        : d
    ))
    setEditTeamTarget(null)
  }

  const handleDelete = () => {
    if (!deleteGroup) return
    setData(prev => prev.filter(d => d.id !== deleteGroup.id))
    setDeleteGroup(null)
  }

  const handleDeleteTeam = () => {
    if (!deleteTeamTarget) return
    setData(prev => prev.map(d =>
      d.id === deleteTeamTarget.groupId
        ? { ...d, teams: d.teams.filter(t => t.id !== deleteTeamTarget.team.id) }
        : d
    ))
    setDeleteTeamTarget(null)
  }

  const handleAddTeam = (team: string[], notes: string[]) => {
    if (!addTeamTarget) return
    const now = todayStr()
    setData(prev => prev.map(d =>
      d.id === addTeamTarget.id
        ? { ...d, teams: [...d.teams, { id: Date.now(), team, notes, updatedAt: now }] }
        : d
    ))
    setAddTeamTarget(null)
  }

  return (
    <div className="px-8 py-6">
      {/* Stats strip */}
      <div className="flex items-center gap-6 mb-5 px-1">
        <div className="flex items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-outline">Themes</span>
          <span className="text-base font-bold text-on-surface">{filtered.length}</span>
        </div>
        <span className="text-outline-variant">·</span>
        <div className="flex items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-outline">Teams</span>
          <span className="text-base font-bold text-on-surface">{totalTeams}</span>
        </div>
        <span className="text-outline-variant">·</span>
        <div className="flex items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-outline">Showing</span>
          <span className="text-base font-bold text-tertiary">
            {totalTeams}<span className="text-on-surface-variant font-normal text-xs"> rows</span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setCollapsedIds(new Set())}
            className="px-3 py-1 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/15 font-label text-[11px] uppercase tracking-widest hover:text-tertiary hover:border-tertiary/30 transition-colors flex items-center gap-1"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_more</span>全部展开
          </button>
          <button
            onClick={() => setCollapsedIds(new Set(filtered.map(d => d.id)))}
            className="px-3 py-1 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/15 font-label text-[11px] uppercase tracking-widest hover:text-tertiary hover:border-tertiary/30 transition-colors flex items-center gap-1"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_less</span>全部折叠
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-surface-container-high flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-tertiary text-3xl">{data.length === 0 ? 'auto_awesome' : 'search_off'}</span>
          </div>
          <h3 className="text-lg font-bold text-on-surface">{data.length === 0 ? '还没有经典阵容' : '没有匹配的阵容'}</h3>
          <p className="text-sm text-on-surface-variant/70 mt-1 font-label">
            {data.length === 0 ? '点击右上角「新增」添加第一个常用阵容主题。' : (
              <>试试别的关键词，或者{' '}
              <button className="text-tertiary underline underline-offset-2" onClick={onClearQuery}>清空搜索</button></>
            )}
          </p>
        </div>
      ) : (
        <div className="bg-surface-container-lowest rounded-xl border border-white/5 overflow-hidden pb-2">
          {filtered.map((item, groupIndex) => {
            const sortedTeams = [...item.teams].sort((a, b) => {
              const la = a.team.join('')
              const lb = b.team.join('')
              return la < lb ? -1 : la > lb ? 1 : 0
            })
            const prefixLen = commonPrefixLen(sortedTeams.map(t => t.team))
            const isCollapsed = collapsedIds.has(item.id)

            return (
              <div key={item.id} className={groupIndex > 0 ? 'border-t border-white/[0.04]' : ''}>
                <div
                  className="flex items-center gap-3 px-5 py-3 bg-gradient-to-r from-tertiary/[0.06] to-transparent cursor-pointer hover:from-tertiary/[0.12] transition-colors select-none"
                  onClick={e => {
                    if ((e.target as HTMLElement).closest('.header-actions')) return
                    toggleCollapse(item.id)
                  }}
                >
                  <span
                    className="material-symbols-outlined text-outline shrink-0 transition-transform duration-200"
                    style={{ fontSize: 18, transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
                  >chevron_right</span>
                  <span className="material-symbols-outlined text-tertiary shrink-0" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                  <div className="text-[15px] font-bold tracking-tight text-tertiary min-w-0 truncate">
                    <Highlight text={item.title} query={query} />
                  </div>
                  <div className="flex-1" />
                  <div className="header-actions flex items-center gap-1 shrink-0">
                    <span className="font-label text-[10px] uppercase tracking-widest text-outline mr-2">{item.updatedAt}</span>
                    <button className="p-1.5 rounded-md hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-secondary" title="新增阵容" onClick={() => setAddTeamTarget(item)}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                    </button>
                    <button
                      className={`p-1.5 rounded-md transition-colors ${copiedKey === `cls-${item.id}` ? 'text-secondary' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                      title="复制标题"
                      onClick={() => copyWithFeedback(`cls-${item.id}`, item.title)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{copiedKey === `cls-${item.id}` ? 'check' : 'content_copy'}</span>
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-surface-container-high transition-colors text-on-surface-variant" title="编辑标题" onClick={() => setEditTitleGroup(item)}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit</span>
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-error/10 transition-colors text-on-surface-variant hover:text-error" title="删除整组" onClick={() => setDeleteGroup(item)}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                    </button>
                  </div>
                </div>

                <div className={`collapse-body${isCollapsed ? ' collapsed' : ''}`}>
                  <div className="inner">
                    <div className="py-1">
                      {sortedTeams.map((t, idx) => (
                        <div key={t.id} className="atk-row">
                          <div className="idx">{String(idx + 1).padStart(2, '0')}</div>
                          <div className="min-w-0">
                            <div className="atk-text">
                              {t.team.map((c, i) => (
                                <span key={i}>
                                  <span className={i < prefixLen ? 'core' : 'rest'}>
                                    <Highlight text={c} query={query} />
                                  </span>
                                  {i < t.team.length - 1 && <span className="sep">、</span>}
                                </span>
                              ))}
                            </div>
                            <NoteChipList notes={t.notes} query={query} />
                          </div>
                          <div className="font-label text-[10px] uppercase tracking-widest text-outline/70 whitespace-nowrap">
                            {t.updatedAt}<span className="text-outline-variant/40 mx-1.5">·</span>{t.team.length}/5
                          </div>
                          <div className="row-actions">
                            <button
                              className={`p-1.5 rounded transition-colors ${copiedKey === `tm-${t.id}` ? 'text-secondary' : 'text-on-surface-variant/50 hover:text-tertiary hover:bg-surface-container-high'}`}
                              title="复制阵容"
                              onClick={() => copyWithFeedback(`tm-${t.id}`, copyText(t.team, t.notes))}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{copiedKey === `tm-${t.id}` ? 'check' : 'content_copy'}</span>
                            </button>
                            <button className="p-1.5 rounded text-on-surface-variant/50 hover:text-secondary hover:bg-surface-container-high transition-colors" title="编辑" onClick={() => setEditTeamTarget({ groupId: item.id, team: t })}>
                              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>edit</span>
                            </button>
                            <button className="p-1.5 rounded text-on-surface-variant/50 hover:text-error hover:bg-error/10 transition-colors" title="删除该条" onClick={() => setDeleteTeamTarget({ groupId: item.id, team: t })}>
                              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Modals */}
      {isAddOpen && (
        <AddClassicModal
          titleInput={titleInput} teamInput={teamInput}
          setTitleInput={setTitleInput} setTeamInput={setTeamInput}
          onClose={() => setIsAddOpen(false)} onSave={handleAdd}
        />
      )}
      {editTitleGroup && (
        <EditTitleModal group={editTitleGroup} onClose={() => setEditTitleGroup(null)} onSave={handleEditTitle} />
      )}
      {editTeamTarget && (
        <EditTeamModal team={editTeamTarget.team} onClose={() => setEditTeamTarget(null)} onSave={handleEditTeam} />
      )}
      {deleteGroup && (
        <DeleteClassicModal group={deleteGroup} onClose={() => setDeleteGroup(null)} onConfirm={handleDelete} />
      )}
      {deleteTeamTarget && (
        <DeleteTeamModal team={deleteTeamTarget.team} onClose={() => setDeleteTeamTarget(null)} onConfirm={handleDeleteTeam} />
      )}
      {addTeamTarget && (
        <AddTeamModal group={addTeamTarget} onClose={() => setAddTeamTarget(null)} onSave={handleAddTeam} />
      )}
    </div>
  )
})

export default ClassicView

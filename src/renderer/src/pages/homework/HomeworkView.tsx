import { useEffect, useImperativeHandle, useState, forwardRef } from 'react'
import {
  Attack, DefenseGroup,
  Highlight, ModalShell, FormField, ModalInput,
  NoteChip, NoteChipList, NoteTagInput, useNoteTagState, copyTeamText, notesEqual,
  commonPrefixLen, matchesDefense, todayStr, sortDefenseLex,
} from './shared'
import { ImportModal } from './ImportModal'

export interface HomeworkViewHandle {
  openAdd: () => void
}

// ── Add modal ──────────────────────────────────────────────
function AddModal({
  defenseInput, attackInput,
  setDefenseInput, setAttackInput,
  onClose, onSave,
}: {
  defenseInput: string; attackInput: string
  setDefenseInput: (v: string) => void
  setAttackInput: (v: string) => void
  onClose: () => void; onSave: (notes: string[]) => void
}): JSX.Element {
  const noteState = useNoteTagState([])
  const canSave = defenseInput.trim().length > 0 && attackInput.trim().length > 0
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-primary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>add_circle</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">新增作业</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">记录一条「防守 → 进攻」对应关系</p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-3">
        <div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-primary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>shield</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-primary/80">防守方</span>
          </div>
          <ModalInput
            placeholder="例：涅比亚、ams、春剑、水m、布丁"
            value={defenseInput}
            onChange={e => setDefenseInput(e.target.value)}
            autoFocus
          />
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">用顿号 、 分隔，最多 5 名角色</p>
        </div>

        <div className="flex items-center justify-center">
          <div className="flex items-center gap-1 text-on-surface-variant/30 text-[11px] font-label uppercase tracking-widest">
            <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
            进攻
          </div>
        </div>

        <div className="rounded-xl border border-secondary/20 bg-secondary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-secondary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-secondary/80">进攻方</span>
          </div>
          <ModalInput
            placeholder="例：els、魔女、春剑、水m、布丁"
            value={attackInput}
            onChange={e => setAttackInput(e.target.value)}
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
            placeholder="如：配速、装备、控制要点 — 回车添加新备注"
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
          className="flex-1 py-3 rounded-xl border border-primary/40 bg-primary/10 text-sm font-bold text-primary hover:bg-primary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">save</span>
          保存
        </button>
      </div>
    </ModalShell>
  )
}

// ── Edit defense modal ─────────────────────────────────────
function EditDefenseModal({
  group, onClose, onSave,
}: {
  group: DefenseGroup
  onClose: () => void
  onSave: (newDefense: string[]) => void
}): JSX.Element {
  const [value, setValue] = useState(group.defense.join('、'))
  const canSave = value.trim().length > 0 && value.trim() !== group.defense.join('、')
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-primary text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>shield</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">编辑防守方</h3>
            <p className="text-xs text-on-surface-variant/70">修改防守阵容的角色列表，该组下所有进攻方作业不受影响。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-5 space-y-4 border border-outline-variant/15">
          <div className="grid grid-cols-2 gap-3 pb-4 border-b border-outline-variant/15">
            <div>
              <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">当前人数</p>
              <p className="text-xs font-mono">{group.defense.length} / 5</p>
            </div>
            <div>
              <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">进攻方条数</p>
              <p className="text-xs font-mono">{group.attacks.length} 条</p>
            </div>
          </div>
          <FormField label="防守方角色" dot="bg-primary" hint="用顿号 、 分隔，最多 5 名角色">
            <ModalInput value={value} onChange={e => setValue(e.target.value)} autoFocus />
          </FormField>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(value.split('、').map(s => s.trim()).filter(Boolean))}
          disabled={!canSave}
          className="flex-1 py-3 rounded-xl border border-primary/40 bg-primary/10 text-sm font-bold text-primary hover:bg-primary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">save</span>
          保存修改
        </button>
      </div>
    </ModalShell>
  )
}

// ── Edit attack modal ──────────────────────────────────────
function EditAttackModal({
  atk, onClose, onSave,
}: {
  atk: Attack
  onClose: () => void
  onSave: (team: string[], notes: string[]) => void
}): JSX.Element {
  const [teamValue, setTeamValue] = useState(atk.team.join('、'))
  const noteState = useNoteTagState(atk.notes)
  const teamChanged = teamValue.trim() !== atk.team.join('、')
  const finalNotes = noteState.finalNotes()
  const notesChanged = !notesEqual(finalNotes, atk.notes)
  const canSave = teamValue.trim().length > 0 && (teamChanged || notesChanged)
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-secondary/15 border border-secondary/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-secondary text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">编辑进攻方</h3>
            <p className="text-xs text-on-surface-variant/70">修改这条进攻阵容的角色列表或备注信息。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-5 space-y-4 border border-outline-variant/15">
          <div className="pb-4 border-b border-outline-variant/15">
            <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5">当前阵容</p>
            <p className="text-sm text-on-surface-variant/70 font-mono">{atk.team.join('、')}</p>
            {atk.notes.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {atk.notes.map((n, i) => <NoteChip key={i} text={n} />)}
              </div>
            )}
          </div>
          <FormField label="进攻方角色" dot="bg-secondary" hint="用顿号 、 分隔，最多 5 名角色">
            <ModalInput value={teamValue} onChange={e => setTeamValue(e.target.value)} autoFocus />
          </FormField>
          <FormField label="备注（可选，可多条）" dot="bg-outline" hint="回车提交一条；双击 chip 编辑；点 ✕ 移除">
            <NoteTagInput
              notes={noteState.notes}
              onNotesChange={noteState.setNotes}
              draft={noteState.draft}
              onDraftChange={noteState.setDraft}
              placeholder="如：配速、装备、控制要点 — 回车添加新备注"
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

// ── Delete confirm modals ──────────────────────────────────
function DeleteModal({
  group, onClose, onConfirm,
}: {
  group: DefenseGroup
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
            <h3 className="text-lg font-black tracking-tight mb-1">删除防守组?</h3>
            <p className="text-xs text-on-surface-variant/70">该防守方及其所有进攻方作业将被永久删除，此操作不可撤销。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-4 space-y-3 border border-outline-variant/15">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg border border-white/5 bg-gradient-to-b from-surface-container-high/50 to-surface-container-lowest flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-primary text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>shield</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{group.defense.join('、')}</p>
              <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 mt-0.5">防守方</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-outline-variant/15">
            <div>
              <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">角色数</p>
              <p className="text-xs font-mono">{group.defense.length} 名</p>
            </div>
            <div>
              <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">进攻方条数</p>
              <p className="text-xs font-mono">{group.attacks.length} 条（将全部删除）</p>
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

function DeleteAttackModal({
  atk, onClose, onConfirm,
}: {
  atk: Attack
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
            <h3 className="text-lg font-black tracking-tight mb-1">删除这条进攻阵容？</h3>
            <p className="text-xs text-on-surface-variant/70">仅删除此条进攻记录，防守方及其余进攻作业不受影响。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-4 space-y-3 border border-outline-variant/15">
          <div className="flex flex-wrap items-center gap-x-0.5 text-sm font-bold">
            {atk.team.map((c, i) => (
              <span key={i} className="text-on-surface">
                {c}{i < atk.team.length - 1 && <span className="text-outline-variant mx-0.5">、</span>}
              </span>
            ))}
            <span className="ml-2 font-label text-[10px] uppercase tracking-widest text-outline/70">{atk.team.length}/5</span>
          </div>
          {atk.notes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {atk.notes.map((n, i) => <NoteChip key={i} text={n} />)}
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

// ── Add attack to existing group modal ─────────────────────
function AddAttackModal({
  group, onClose, onSave,
}: {
  group: DefenseGroup
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
          <span className="material-symbols-outlined text-secondary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-black tracking-tight">新增进攻阵容</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label truncate">
            防守方：{group.defense.join('、')}
          </p>
        </div>
      </div>
      <div className="px-7 py-5 space-y-3">
        <div className="rounded-xl border border-secondary/20 bg-secondary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-secondary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-secondary/80">进攻方</span>
          </div>
          <ModalInput
            placeholder="例：els、魔女、春剑、水m、布丁"
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
            placeholder="如：配速、装备、控制要点 — 回车添加新备注"
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

// ── Main view ──────────────────────────────────────────────
const HomeworkView = forwardRef<HomeworkViewHandle, {
  data: DefenseGroup[]
  setData: React.Dispatch<React.SetStateAction<DefenseGroup[]>>
  query: string
  onClearQuery: () => void
  /**
   * When true, defense lineups are sorted lexicographically (字典序) on save.
   * Used by JJC where the defense title is canonicalised so lineups with the
   * same characters in different input order collapse into one group.
   */
  sortDefenseLex?: boolean
  /**
   * When true, the import button is hidden. JJC reuses HomeworkView but has
   * no JSON import path of its own.
   */
  hideImport?: boolean
}>(function HomeworkView({ data, setData, query, onClearQuery, sortDefenseLex: shouldSort = false, hideImport = false }, ref) {
  const maybeSort = (d: string[]): string[] => shouldSort ? sortDefenseLex(d) : d
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set())

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [defenseInput, setDefenseInput] = useState('')
  const [attackInput, setAttackInput] = useState('')

  const [editDefenseGroup, setEditDefenseGroup] = useState<DefenseGroup | null>(null)
  const [editAttackTarget, setEditAttackTarget] = useState<{ groupId: number; atk: Attack } | null>(null)
  const [deleteGroup, setDeleteGroup] = useState<DefenseGroup | null>(null)
  const [deleteAttackTarget, setDeleteAttackTarget] = useState<{ groupId: number; atk: Attack } | null>(null)
  const [addAttackTarget, setAddAttackTarget] = useState<DefenseGroup | null>(null)
  const [isImportOpen, setIsImportOpen] = useState(false)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyWithFeedback = (key: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  useImperativeHandle(ref, () => ({
    openAdd: () => {
      setDefenseInput('')
      setAttackInput('')
      setIsAddOpen(true)
    },
  }), [])

  useEffect(() => {
    if (data.length > 1) {
      setCollapsedIds(new Set(data.slice(1).map(d => d.id)))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = data
    .filter(d => matchesDefense(d, query))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

  const totalAttacks = filtered.reduce((s, d) => s + d.attacks.length, 0)

  const toggleCollapse = (id: number) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleAdd = (notes: string[]) => {
    const defenseRaw = defenseInput.split('、').map(s => s.trim()).filter(Boolean)
    const team = attackInput.split('、').map(s => s.trim()).filter(Boolean)
    if (!defenseRaw.length || !team.length) return
    const defense = maybeSort(defenseRaw)
    const defKey = defense.join('、')
    const now = todayStr()
    setData(prev => {
      const existing = prev.find(d => maybeSort(d.defense).join('、') === defKey)
      if (existing) {
        // Adding an attack to an existing defense: only the new attack gets a fresh date.
        return prev.map(d =>
          d.id === existing.id
            ? { ...d, attacks: [...d.attacks, { id: Date.now(), team, notes, updatedAt: now }] }
            : d
        )
      }
      // New defense: defense + first attack share today's date.
      return [...prev, { id: Date.now(), defense, updatedAt: now, attacks: [{ id: Date.now() + 1, team, notes, updatedAt: now }] }]
    })
    setIsAddOpen(false)
  }

  const handleEditDefense = (newDefense: string[]) => {
    if (!editDefenseGroup) return
    const next = maybeSort(newDefense)
    setData(prev => prev.map(d =>
      d.id === editDefenseGroup.id ? { ...d, defense: next, updatedAt: todayStr() } : d
    ))
    setEditDefenseGroup(null)
  }

  const handleEditAttack = (team: string[], notes: string[]) => {
    if (!editAttackTarget) return
    const now = todayStr()
    setData(prev => prev.map(d =>
      d.id === editAttackTarget.groupId
        ? { ...d, attacks: d.attacks.map(a => a.id === editAttackTarget.atk.id ? { ...a, team, notes, updatedAt: now } : a) }
        : d
    ))
    setEditAttackTarget(null)
  }

  const handleDelete = () => {
    if (!deleteGroup) return
    setData(prev => prev.filter(d => d.id !== deleteGroup.id))
    setDeleteGroup(null)
  }

  const handleDeleteAttack = () => {
    if (!deleteAttackTarget) return
    setData(prev => prev.map(d =>
      d.id === deleteAttackTarget.groupId
        ? { ...d, attacks: d.attacks.filter(a => a.id !== deleteAttackTarget.atk.id) }
        : d
    ))
    setDeleteAttackTarget(null)
  }

  const handleImport = (merged: DefenseGroup[]) => {
    setData(merged)
    setIsImportOpen(false)
  }

  const handleAddAttack = (team: string[], notes: string[]) => {
    if (!addAttackTarget) return
    const now = todayStr()
    setData(prev => prev.map(d =>
      d.id === addAttackTarget.id
        ? { ...d, attacks: [...d.attacks, { id: Date.now(), team, notes, updatedAt: now }] }
        : d
    ))
    setAddAttackTarget(null)
  }

  return (
    <div className="px-8 py-6">
      {/* Stats strip */}
      <div className="flex items-center gap-6 mb-5 px-1">
        <div className="flex items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-outline">Defense</span>
          <span className="text-base font-bold text-on-surface">{filtered.length}</span>
        </div>
        <span className="text-outline-variant">·</span>
        <div className="flex items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-outline">Attacks</span>
          <span className="text-base font-bold text-on-surface">{totalAttacks}</span>
        </div>
        <span className="text-outline-variant">·</span>
        <div className="flex items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-outline">Showing</span>
          <span className="text-base font-bold text-primary">
            {totalAttacks}<span className="text-on-surface-variant font-normal text-xs"> rows</span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!hideImport && (
            <button
              onClick={() => setIsImportOpen(true)}
              className="px-3 py-1 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/15 font-label text-[11px] uppercase tracking-widest hover:text-tertiary hover:border-tertiary/30 transition-colors flex items-center gap-1"
              title="从 JSON 文件批量导入作业"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>upload_file</span>导入
            </button>
          )}
          <button
            onClick={() => setCollapsedIds(new Set())}
            className="px-3 py-1 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/15 font-label text-[11px] uppercase tracking-widest hover:text-primary hover:border-primary/30 transition-colors flex items-center gap-1"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_more</span>全部展开
          </button>
          <button
            onClick={() => setCollapsedIds(new Set(filtered.map(d => d.id)))}
            className="px-3 py-1 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/15 font-label text-[11px] uppercase tracking-widest hover:text-primary hover:border-primary/30 transition-colors flex items-center gap-1"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>unfold_less</span>全部折叠
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20">
          <div className="w-16 h-16 rounded-2xl bg-surface-container-high flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-primary text-3xl">search_off</span>
          </div>
          <h3 className="text-lg font-bold text-on-surface">没有匹配的阵容</h3>
          <p className="text-sm text-on-surface-variant/70 mt-1 font-label">
            试试别的角色名，或者{' '}
            <button className="text-primary underline underline-offset-2" onClick={onClearQuery}>清空搜索</button>
          </p>
        </div>
      ) : (
        <div className="bg-surface-container-lowest rounded-xl border border-white/5 overflow-hidden pb-2">
          {filtered.map((item, groupIndex) => {
            const sortedAttacks = [...item.attacks].sort((a, b) => {
              const la = a.team.join('')
              const lb = b.team.join('')
              return la < lb ? -1 : la > lb ? 1 : 0
            })
            const prefixLen = commonPrefixLen(sortedAttacks.map(a => a.team))
            const isCollapsed = collapsedIds.has(item.id)

            return (
              <div key={item.id} className={groupIndex > 0 ? 'border-t border-white/[0.04]' : ''}>
                <div
                  className="flex items-center gap-3 px-5 py-3 bg-gradient-to-r from-primary/[0.06] to-transparent cursor-pointer hover:from-primary/[0.12] transition-colors select-none"
                  onClick={e => {
                    if ((e.target as HTMLElement).closest('.header-actions')) return
                    toggleCollapse(item.id)
                  }}
                >
                  <span
                    className="material-symbols-outlined text-outline shrink-0 transition-transform duration-200"
                    style={{ fontSize: 18, transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
                  >chevron_right</span>
                  <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>shield</span>
                  <div className="flex flex-wrap items-center gap-x-0.5 text-[15px] font-bold tracking-tight shrink-0">
                    {item.defense.map((c, i) => (
                      <span key={i} className="text-primary">
                        <Highlight text={c} query={query} />
                        {i < item.defense.length - 1 && <span className="text-primary/40">、</span>}
                      </span>
                    ))}
                  </div>
                  <div className="flex-1" />
                  <div className="header-actions flex items-center gap-1 shrink-0">
                    <span className="font-label text-[10px] uppercase tracking-widest text-outline mr-2">{item.updatedAt}</span>
                    <button className="p-1.5 rounded-md hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-secondary" title="新增进攻阵容" onClick={() => setAddAttackTarget(item)}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                    </button>
                    <button
                      className={`p-1.5 rounded-md transition-colors ${copiedKey === `def-${item.id}` ? 'text-secondary' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                      title="复制防守方阵容"
                      onClick={() => copyWithFeedback(`def-${item.id}`, item.defense.join('、'))}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{copiedKey === `def-${item.id}` ? 'check' : 'content_copy'}</span>
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-surface-container-high transition-colors text-on-surface-variant" title="编辑防守方" onClick={() => setEditDefenseGroup(item)}>
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
                      {sortedAttacks.map((atk, idx) => (
                        <div key={atk.id} className="atk-row">
                          <div className="idx">{String(idx + 1).padStart(2, '0')}</div>
                          <div className="min-w-0">
                            <div className="atk-text">
                              {atk.team.map((c, i) => (
                                <span key={i}>
                                  <span className={i < prefixLen ? 'core' : 'rest'}>
                                    <Highlight text={c} query={query} />
                                  </span>
                                  {i < atk.team.length - 1 && <span className="sep">、</span>}
                                </span>
                              ))}
                            </div>
                            <NoteChipList notes={atk.notes} query={query} />
                          </div>
                          <div className="font-label text-[10px] uppercase tracking-widest text-outline/70 whitespace-nowrap">
                            {atk.updatedAt}<span className="text-outline-variant/40 mx-1.5">·</span>{atk.team.length}/5
                          </div>
                          <div className="row-actions">
                            <button
                              className={`p-1.5 rounded transition-colors ${copiedKey === `atk-${atk.id}` ? 'text-secondary' : 'text-on-surface-variant/50 hover:text-primary hover:bg-surface-container-high'}`}
                              title="复制进攻阵容"
                              onClick={() => copyWithFeedback(`atk-${atk.id}`, copyTeamText(atk.team, atk.notes))}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{copiedKey === `atk-${atk.id}` ? 'check' : 'content_copy'}</span>
                            </button>
                            <button className="p-1.5 rounded text-on-surface-variant/50 hover:text-secondary hover:bg-surface-container-high transition-colors" title="编辑" onClick={() => setEditAttackTarget({ groupId: item.id, atk })}>
                              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>edit</span>
                            </button>
                            <button className="p-1.5 rounded text-on-surface-variant/50 hover:text-error hover:bg-error/10 transition-colors" title="删除该条" onClick={() => setDeleteAttackTarget({ groupId: item.id, atk })}>
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
        <AddModal
          defenseInput={defenseInput} attackInput={attackInput}
          setDefenseInput={setDefenseInput} setAttackInput={setAttackInput}
          onClose={() => setIsAddOpen(false)} onSave={handleAdd}
        />
      )}
      {editDefenseGroup && (
        <EditDefenseModal group={editDefenseGroup} onClose={() => setEditDefenseGroup(null)} onSave={handleEditDefense} />
      )}
      {editAttackTarget && (
        <EditAttackModal atk={editAttackTarget.atk} onClose={() => setEditAttackTarget(null)} onSave={handleEditAttack} />
      )}
      {deleteGroup && (
        <DeleteModal group={deleteGroup} onClose={() => setDeleteGroup(null)} onConfirm={handleDelete} />
      )}
      {deleteAttackTarget && (
        <DeleteAttackModal atk={deleteAttackTarget.atk} onClose={() => setDeleteAttackTarget(null)} onConfirm={handleDeleteAttack} />
      )}
      {addAttackTarget && (
        <AddAttackModal group={addAttackTarget} onClose={() => setAddAttackTarget(null)} onSave={handleAddAttack} />
      )}
      {isImportOpen && (
        <ImportModal current={data} onClose={() => setIsImportOpen(false)} onConfirm={handleImport} />
      )}
    </div>
  )
})

export default HomeworkView

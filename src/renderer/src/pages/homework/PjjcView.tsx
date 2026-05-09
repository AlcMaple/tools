import { useEffect, useImperativeHandle, useState, forwardRef } from 'react'
import {
  PjjcAttack, PjjcGroup,
  Highlight, ModalShell, ModalInput,
  NoteChip, NoteChipList, NoteTagInput, useNoteTagState, copyTeamText, notesEqual,
  matchesPjjc, todayStr,
} from './shared'

export interface PjjcViewHandle {
  openAdd: () => void
}

const SLOT_LABELS = ['防 1', '防 2', '防 3'] as const
const ATK_LABELS = ['进 1', '进 2', '进 3'] as const

function parseLine(s: string): string[] {
  return s.split('、').map(p => p.trim()).filter(Boolean)
}

function joinTeam(arr: string[]): string {
  return arr.join('、')
}

function defKey(defenses: string[][]): string {
  return defenses.map(d => d.join('、')).join('|')
}

// ── Add modal ──────────────────────────────────────────────────────────────
function AddPjjcModal({
  onClose, onSave,
}: {
  onClose: () => void
  onSave: (defenses: string[][], teams: string[][], notes: string[]) => void
}): JSX.Element {
  const [defenseInputs, setDefenseInputs] = useState<[string, string, string]>(['', '', ''])
  const [teamInputs, setTeamInputs] = useState<[string, string, string]>(['', '', ''])
  const noteState = useNoteTagState([])
  const defenses = defenseInputs.map(parseLine) as string[][]
  const teams = teamInputs.map(parseLine) as string[][]
  // 至少要三个防守方非空（PJJC 设计上必须三个一起）；进攻可暂空（之后再补）。
  const canSave = defenses.every(d => d.length > 0)

  const updateDefense = (idx: 0 | 1 | 2, v: string) => {
    setDefenseInputs(prev => {
      const next: [string, string, string] = [...prev] as [string, string, string]
      next[idx] = v
      return next
    })
  }
  const updateTeam = (idx: 0 | 1 | 2, v: string) => {
    setTeamInputs(prev => {
      const next: [string, string, string] = [...prev] as [string, string, string]
      next[idx] = v
      return next
    })
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-primary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>swap_horiz</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">新增换防记录</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">同时记录三个防守方阵容和对应的进攻方</p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-3">
        <div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-primary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>shield</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-primary/80">防守方 · 三方一组</span>
          </div>
          <div className="space-y-2">
            {SLOT_LABELS.map((label, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="font-label text-[10px] uppercase tracking-widest text-primary/70 w-10 flex-shrink-0">{label}</span>
                <ModalInput
                  placeholder={`例：涅比亚、ams、春剑、水m、布丁`}
                  value={defenseInputs[i]}
                  onChange={e => updateDefense(i as 0 | 1 | 2, e.target.value)}
                  autoFocus={i === 0}
                />
              </div>
            ))}
          </div>
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">每行用顿号 、 分隔，最多 5 名角色</p>
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
            <span className="font-label text-[10px] uppercase tracking-widest text-secondary/80">进攻方 · 三方对应</span>
          </div>
          <div className="space-y-2">
            {ATK_LABELS.map((label, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="font-label text-[10px] uppercase tracking-widest text-secondary/70 w-10 flex-shrink-0">{label}</span>
                <ModalInput
                  placeholder={`对应防 ${i + 1} 的进攻阵容（可留空）`}
                  value={teamInputs[i]}
                  onChange={e => updateTeam(i as 0 | 1 | 2, e.target.value)}
                />
              </div>
            ))}
          </div>
          <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">每行对应同序号的防守方，留空表示暂无作业</p>
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
        </div>
      </div>

      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(defenses, teams, noteState.finalNotes())}
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

// ── Edit defense modal — edits all 3 defenses of a group ──────────────────
function EditDefensesModal({
  group, onClose, onSave,
}: {
  group: PjjcGroup
  onClose: () => void
  onSave: (defenses: string[][]) => void
}): JSX.Element {
  const [inputs, setInputs] = useState<[string, string, string]>([
    joinTeam(group.defenses[0] ?? []),
    joinTeam(group.defenses[1] ?? []),
    joinTeam(group.defenses[2] ?? []),
  ])
  const next = inputs.map(parseLine) as string[][]
  const changed = JSON.stringify(next) !== JSON.stringify(group.defenses)
  const allFilled = next.every(d => d.length > 0)
  const canSave = changed && allFilled

  const update = (idx: 0 | 1 | 2, v: string) => {
    setInputs(prev => {
      const out: [string, string, string] = [...prev] as [string, string, string]
      out[idx] = v
      return out
    })
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-primary text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>shield</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">编辑三防阵容</h3>
            <p className="text-xs text-on-surface-variant/70">同步更新本组的三个防守阵容；进攻方不受影响。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-5 space-y-3 border border-outline-variant/15">
          {SLOT_LABELS.map((label, i) => (
            <div key={i}>
              <label className="flex items-center gap-2 font-label text-[10px] uppercase tracking-widest text-primary/80 mb-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block flex-shrink-0" />
                {label}
              </label>
              <ModalInput
                value={inputs[i]}
                onChange={e => update(i as 0 | 1 | 2, e.target.value)}
                autoFocus={i === 0}
              />
            </div>
          ))}
          <p className="font-label text-[10px] text-on-surface-variant/40">每行用顿号 、 分隔，最多 5 名角色</p>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(next)}
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

// ── Edit attack modal — edits all 3 attacks of a row ──────────────────────
function EditAttackModal({
  atk, onClose, onSave,
}: {
  atk: PjjcAttack
  onClose: () => void
  onSave: (teams: string[][], notes: string[]) => void
}): JSX.Element {
  const [inputs, setInputs] = useState<[string, string, string]>([
    joinTeam(atk.teams[0] ?? []),
    joinTeam(atk.teams[1] ?? []),
    joinTeam(atk.teams[2] ?? []),
  ])
  const noteState = useNoteTagState(atk.notes)
  const next = inputs.map(parseLine) as string[][]
  const teamsChanged = JSON.stringify(next) !== JSON.stringify(atk.teams)
  const finalNotes = noteState.finalNotes()
  const notesChanged = !notesEqual(finalNotes, atk.notes)
  const canSave = (teamsChanged || notesChanged)

  const update = (idx: 0 | 1 | 2, v: string) => {
    setInputs(prev => {
      const out: [string, string, string] = [...prev] as [string, string, string]
      out[idx] = v
      return out
    })
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-7 pb-5">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-secondary/15 border border-secondary/30 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-secondary text-[24px]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-black tracking-tight mb-1">编辑三方进攻</h3>
            <p className="text-xs text-on-surface-variant/70">分别修改对应每一防守方的进攻阵容或备注。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-5 space-y-3 border border-outline-variant/15">
          {ATK_LABELS.map((label, i) => (
            <div key={i}>
              <label className="flex items-center gap-2 font-label text-[10px] uppercase tracking-widest text-secondary/80 mb-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-secondary inline-block flex-shrink-0" />
                {label}
              </label>
              <ModalInput
                value={inputs[i]}
                onChange={e => update(i as 0 | 1 | 2, e.target.value)}
                autoFocus={i === 0}
              />
            </div>
          ))}
          <div>
            <label className="flex items-center gap-2 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-outline inline-block flex-shrink-0" />
              备注（可选，可多条）
            </label>
            <NoteTagInput
              notes={noteState.notes}
              onNotesChange={noteState.setNotes}
              draft={noteState.draft}
              onDraftChange={noteState.setDraft}
              placeholder="回车添加新备注"
            />
          </div>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(next, noteState.finalNotes())}
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

// ── Add attack to existing group modal ────────────────────────────────────
function AddAttackModal({
  group, onClose, onSave,
}: {
  group: PjjcGroup
  onClose: () => void
  onSave: (teams: string[][], notes: string[]) => void
}): JSX.Element {
  const [inputs, setInputs] = useState<[string, string, string]>(['', '', ''])
  const noteState = useNoteTagState([])
  const next = inputs.map(parseLine) as string[][]
  const canSave = next.some(t => t.length > 0)

  const update = (idx: 0 | 1 | 2, v: string) => {
    setInputs(prev => {
      const out: [string, string, string] = [...prev] as [string, string, string]
      out[idx] = v
      return out
    })
  }

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-secondary/15 border border-secondary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-secondary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-black tracking-tight">新增三方进攻</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label truncate">
            防 1：{joinTeam(group.defenses[0])} · 防 2：{joinTeam(group.defenses[1])} · 防 3：{joinTeam(group.defenses[2])}
          </p>
        </div>
      </div>
      <div className="px-7 py-5 space-y-3">
        <div className="rounded-xl border border-secondary/20 bg-secondary/[0.04] px-4 pt-3 pb-4">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="material-symbols-outlined text-secondary text-[15px]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-secondary/80">进攻方 · 三方对应</span>
          </div>
          <div className="space-y-2">
            {ATK_LABELS.map((label, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="font-label text-[10px] uppercase tracking-widest text-secondary/70 w-10 flex-shrink-0">{label}</span>
                <ModalInput
                  placeholder={`对应防 ${i + 1} 的进攻阵容（可留空）`}
                  value={inputs[i]}
                  onChange={e => update(i as 0 | 1 | 2, e.target.value)}
                  autoFocus={i === 0}
                />
              </div>
            ))}
          </div>
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
            placeholder="回车添加新备注"
          />
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => onSave(next, noteState.finalNotes())}
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

// ── Delete confirm modals ─────────────────────────────────────────────────
function DeleteGroupModal({
  group, onClose, onConfirm,
}: {
  group: PjjcGroup
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
            <h3 className="text-lg font-black tracking-tight mb-1">删除整组换防?</h3>
            <p className="text-xs text-on-surface-variant/70">该三防阵容及其所有进攻方记录将被永久删除，此操作不可撤销。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-4 space-y-2 border border-outline-variant/15">
          {SLOT_LABELS.map((label, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="font-label text-[10px] uppercase tracking-widest text-primary/70 w-9 flex-shrink-0">{label}</span>
              <span className="text-sm font-bold truncate text-on-surface">{joinTeam(group.defenses[i])}</span>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-outline-variant/15">
            <div>
              <p className="font-label text-[9px] uppercase tracking-widest text-on-surface-variant/50 mb-0.5">进攻条数</p>
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
  atk: PjjcAttack
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
            <h3 className="text-lg font-black tracking-tight mb-1">删除这条三方进攻？</h3>
            <p className="text-xs text-on-surface-variant/70">仅删除此条进攻记录，三防阵容及其余进攻不受影响。</p>
          </div>
        </div>

        <div className="bg-surface-container rounded-lg p-4 space-y-2 border border-outline-variant/15">
          {ATK_LABELS.map((label, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="font-label text-[10px] uppercase tracking-widest text-secondary/70 w-9 flex-shrink-0">{label}</span>
              <span className="text-sm text-on-surface truncate">{joinTeam(atk.teams[i]) || <span className="text-outline-variant">—</span>}</span>
            </div>
          ))}
          {atk.notes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-outline-variant/15">
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

// ── Main view ─────────────────────────────────────────────────────────────
const PjjcView = forwardRef<PjjcViewHandle, {
  data: PjjcGroup[]
  setData: React.Dispatch<React.SetStateAction<PjjcGroup[]>>
  query: string
  onClearQuery: () => void
}>(function PjjcView({ data, setData, query, onClearQuery }, ref) {
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set())

  const [isAddOpen, setIsAddOpen] = useState(false)
  const [editDefensesGroup, setEditDefensesGroup] = useState<PjjcGroup | null>(null)
  const [editAttackTarget, setEditAttackTarget] = useState<{ groupId: number; atk: PjjcAttack } | null>(null)
  const [deleteGroup, setDeleteGroup] = useState<PjjcGroup | null>(null)
  const [deleteAttackTarget, setDeleteAttackTarget] = useState<{ groupId: number; atk: PjjcAttack } | null>(null)
  const [addAttackTarget, setAddAttackTarget] = useState<PjjcGroup | null>(null)

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyWithFeedback = (key: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1500)
  }

  useImperativeHandle(ref, () => ({
    openAdd: () => setIsAddOpen(true),
  }), [])

  useEffect(() => {
    if (data.length > 1) {
      setCollapsedIds(new Set(data.slice(1).map(d => d.id)))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = data
    .filter(d => matchesPjjc(d, query))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

  const totalAttacks = filtered.reduce((s, d) => s + d.attacks.length, 0)

  const toggleCollapse = (id: number) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleAdd = (defenses: string[][], teams: string[][], notes: string[]) => {
    if (!defenses.every(d => d.length > 0)) return
    const now = todayStr()
    const key = defKey(defenses)
    setData(prev => {
      const existing = prev.find(d => defKey(d.defenses) === key)
      const hasAnyTeam = teams.some(t => t.length > 0)
      if (existing) {
        // Group already exists — append the new attack row if it has any content.
        if (!hasAnyTeam) return prev
        return prev.map(d =>
          d.id === existing.id
            ? { ...d, attacks: [...d.attacks, { id: Date.now(), teams, notes, updatedAt: now }] }
            : d
        )
      }
      const initialAttacks: PjjcAttack[] = hasAnyTeam
        ? [{ id: Date.now() + 1, teams, notes, updatedAt: now }]
        : []
      return [...prev, { id: Date.now(), defenses, updatedAt: now, attacks: initialAttacks }]
    })
    setIsAddOpen(false)
  }

  const handleEditDefenses = (defenses: string[][]) => {
    if (!editDefensesGroup) return
    setData(prev => prev.map(d =>
      d.id === editDefensesGroup.id ? { ...d, defenses, updatedAt: todayStr() } : d
    ))
    setEditDefensesGroup(null)
  }

  const handleEditAttack = (teams: string[][], notes: string[]) => {
    if (!editAttackTarget) return
    const now = todayStr()
    setData(prev => prev.map(d =>
      d.id === editAttackTarget.groupId
        ? { ...d, attacks: d.attacks.map(a => a.id === editAttackTarget.atk.id ? { ...a, teams, notes, updatedAt: now } : a) }
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

  const handleAddAttack = (teams: string[][], notes: string[]) => {
    if (!addAttackTarget) return
    const now = todayStr()
    setData(prev => prev.map(d =>
      d.id === addAttackTarget.id
        ? { ...d, attacks: [...d.attacks, { id: Date.now(), teams, notes, updatedAt: now }] }
        : d
    ))
    setAddAttackTarget(null)
  }

  return (
    <div className="px-8 py-6">
      {/* Stats strip */}
      <div className="flex items-center gap-6 mb-5 px-1">
        <div className="flex items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-widest text-outline">Groups</span>
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
            <span className="material-symbols-outlined text-primary text-3xl">{data.length === 0 ? 'swap_horiz' : 'search_off'}</span>
          </div>
          <h3 className="text-lg font-bold text-on-surface">{data.length === 0 ? '还没有换防记录' : '没有匹配的阵容'}</h3>
          <p className="text-sm text-on-surface-variant/70 mt-1 font-label">
            {data.length === 0 ? '点击右上角「新增」录入第一组三防阵容。' : (
              <>试试别的关键词，或者{' '}
              <button className="text-primary underline underline-offset-2" onClick={onClearQuery}>清空搜索</button></>
            )}
          </p>
        </div>
      ) : (
        <div className="bg-surface-container-lowest rounded-xl border border-white/5 overflow-hidden pb-2">
          {filtered.map((item, groupIndex) => {
            const isCollapsed = collapsedIds.has(item.id)
            const sortedAttacks = [...item.attacks].sort((a, b) => {
              const la = a.teams.flat().join('')
              const lb = b.teams.flat().join('')
              return la < lb ? -1 : la > lb ? 1 : 0
            })

            return (
              <div key={item.id} className={groupIndex > 0 ? 'border-t border-white/[0.04]' : ''}>
                {/* Group header — 3 defenses stacked */}
                <div
                  className="flex items-start gap-3 px-5 py-3 bg-gradient-to-r from-primary/[0.06] to-transparent cursor-pointer hover:from-primary/[0.12] transition-colors select-none"
                  onClick={e => {
                    if ((e.target as HTMLElement).closest('.header-actions')) return
                    toggleCollapse(item.id)
                  }}
                >
                  <span
                    className="material-symbols-outlined text-outline shrink-0 transition-transform duration-200 mt-0.5"
                    style={{ fontSize: 18, transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
                  >chevron_right</span>
                  <span className="material-symbols-outlined text-primary shrink-0 mt-0.5" style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}>shield</span>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    {SLOT_LABELS.map((label, i) => (
                      <div key={i} className="flex items-baseline gap-2 text-[14px] font-bold tracking-tight">
                        <span className="font-label text-[9.5px] uppercase tracking-widest text-primary/55 w-9 flex-shrink-0">{label}</span>
                        <div className="flex flex-wrap items-center gap-x-0.5">
                          {item.defenses[i].map((c, j) => (
                            <span key={j} className="text-primary">
                              <Highlight text={c} query={query} />
                              {j < item.defenses[i].length - 1 && <span className="text-primary/40">、</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="header-actions flex items-center gap-1 shrink-0 mt-0.5">
                    <span className="font-label text-[10px] uppercase tracking-widest text-outline mr-2">{item.updatedAt}</span>
                    <button className="p-1.5 rounded-md hover:bg-surface-container-high transition-colors text-on-surface-variant hover:text-secondary" title="新增三方进攻" onClick={() => setAddAttackTarget(item)}>
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                    </button>
                    <button
                      className={`p-1.5 rounded-md transition-colors ${copiedKey === `pdef-${item.id}` ? 'text-secondary' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                      title="复制三防阵容"
                      onClick={() => copyWithFeedback(
                        `pdef-${item.id}`,
                        item.defenses.map((d, i) => `${SLOT_LABELS[i]}：${joinTeam(d)}`).join('\n')
                      )}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{copiedKey === `pdef-${item.id}` ? 'check' : 'content_copy'}</span>
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-surface-container-high transition-colors text-on-surface-variant" title="编辑三防阵容" onClick={() => setEditDefensesGroup(item)}>
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
                        <div key={atk.id} className="atk-row" style={{ alignItems: 'flex-start' }}>
                          <div className="idx" style={{ paddingTop: 4 }}>{String(idx + 1).padStart(2, '0')}</div>
                          <div className="min-w-0 space-y-0.5 py-0.5">
                            {ATK_LABELS.map((label, i) => (
                              <div key={i} className="flex items-baseline gap-2 atk-text">
                                <span className="font-label text-[9.5px] uppercase tracking-widest text-secondary/55 w-9 flex-shrink-0">{label}</span>
                                <span className="flex-1 min-w-0 truncate">
                                  {atk.teams[i].length === 0 ? (
                                    <span className="text-outline-variant/50">—</span>
                                  ) : atk.teams[i].map((c, j) => (
                                    <span key={j}>
                                      <span className="rest"><Highlight text={c} query={query} /></span>
                                      {j < atk.teams[i].length - 1 && <span className="sep">、</span>}
                                    </span>
                                  ))}
                                </span>
                              </div>
                            ))}
                            <NoteChipList notes={atk.notes} query={query} />
                          </div>
                          <div className="font-label text-[10px] uppercase tracking-widest text-outline/70 whitespace-nowrap" style={{ paddingTop: 4 }}>
                            {atk.updatedAt}
                          </div>
                          <div className="row-actions" style={{ paddingTop: 2 }}>
                            <button
                              className={`p-1.5 rounded transition-colors ${copiedKey === `patk-${atk.id}` ? 'text-secondary' : 'text-on-surface-variant/50 hover:text-primary hover:bg-surface-container-high'}`}
                              title="复制三方进攻"
                              onClick={() => copyWithFeedback(
                                `patk-${atk.id}`,
                                atk.teams.map((t, i) => `${ATK_LABELS[i]}：${copyTeamText(t, [])}`).join('\n')
                                  + (atk.notes.length ? `\n备注：${atk.notes.join(' / ')}` : '')
                              )}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{copiedKey === `patk-${atk.id}` ? 'check' : 'content_copy'}</span>
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
                      {item.attacks.length === 0 && (
                        <div className="px-4 py-3 text-[12px] font-label text-on-surface-variant/45">
                          暂无进攻记录 — 点头部 <span className="material-symbols-outlined align-middle" style={{ fontSize: 12 }}>add</span> 添加
                        </div>
                      )}
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
        <AddPjjcModal onClose={() => setIsAddOpen(false)} onSave={handleAdd} />
      )}
      {editDefensesGroup && (
        <EditDefensesModal group={editDefensesGroup} onClose={() => setEditDefensesGroup(null)} onSave={handleEditDefenses} />
      )}
      {editAttackTarget && (
        <EditAttackModal atk={editAttackTarget.atk} onClose={() => setEditAttackTarget(null)} onSave={handleEditAttack} />
      )}
      {deleteGroup && (
        <DeleteGroupModal group={deleteGroup} onClose={() => setDeleteGroup(null)} onConfirm={handleDelete} />
      )}
      {deleteAttackTarget && (
        <DeleteAttackModal atk={deleteAttackTarget.atk} onClose={() => setDeleteAttackTarget(null)} onConfirm={handleDeleteAttack} />
      )}
      {addAttackTarget && (
        <AddAttackModal group={addAttackTarget} onClose={() => setAddAttackTarget(null)} onSave={handleAddAttack} />
      )}
    </div>
  )
})

export default PjjcView

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import {
  Attack, DefenseGroup,
  Highlight, ModalShell, FormField, ModalInput,
  NoteChip, NoteTagInput, useNoteTagState, coerceNotes,
  cleanCharName, commonPrefixLen, matchesDefense, todayStr,
} from './shared'

export interface HomeworkViewHandle {
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

// Helper: build the "copy" payload for an attack line. Notes joined with ` / `.
function copyText(team: string[], notes: string[]): string {
  return team.join('、') + (notes.length ? ` (${notes.join(' / ')})` : '')
}

// Helper: shallow-equal for two string arrays (order-sensitive).
function notesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ── Import helpers (homework-only) ─────────────────────────
interface ImportItem {
  defense: string[]
  attacks: Array<{ team: string[]; notes: string[] }>
}

interface ImportParseResult {
  items?: ImportItem[]
  error?: string
}

function parseImportJson(text: string): ImportParseResult {
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch (e) { return { error: 'JSON 解析失败：' + (e as Error).message } }
  if (!Array.isArray(raw)) return { error: '根节点必须是数组' }

  const items: ImportItem[] = []
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as { defense?: unknown; attacks?: unknown } | null
    if (!it || typeof it !== 'object') return { error: `第 ${i + 1} 项不是对象` }
    if (!Array.isArray(it.defense)) return { error: `第 ${i + 1} 项缺少 defense 数组` }
    if (!Array.isArray(it.attacks)) return { error: `第 ${i + 1} 项缺少 attacks 数组` }

    const defense = it.defense.map(c => cleanCharName(String(c))).filter(Boolean)
    if (defense.length === 0) return { error: `第 ${i + 1} 项 defense 为空` }

    const attacks: Array<{ team: string[]; notes: string[] }> = []
    for (let j = 0; j < it.attacks.length; j++) {
      const a = it.attacks[j] as { team?: unknown; note?: unknown; notes?: unknown } | null
      if (!a || typeof a !== 'object' || !Array.isArray(a.team)) {
        return { error: `第 ${i + 1} 项第 ${j + 1} 条攻击缺少 team 数组` }
      }
      const team = a.team.map(c => cleanCharName(String(c))).filter(Boolean)
      if (team.length === 0) return { error: `第 ${i + 1} 项第 ${j + 1} 条攻击 team 为空` }
      // Accept legacy `note: string` or fresh `notes: string[]` from external JSON.
      const notes = coerceNotes(a.notes ?? a.note)
      attacks.push({ team, notes })
    }
    items.push({ defense, attacks })
  }
  return { items }
}

interface ImportPreview {
  newDefenseCount: number
  newAttackCount: number
  skippedCount: number
  result: DefenseGroup[]
}

function computeImportMerge(items: ImportItem[], current: DefenseGroup[]): ImportPreview {
  const result: DefenseGroup[] = current.map(d => ({ ...d, attacks: [...d.attacks] }))
  let newDefenseCount = 0
  let newAttackCount = 0
  let skippedCount = 0
  const now = todayStr()
  let idCounter = Date.now()
  const nextId = () => idCounter++

  for (const item of items) {
    const defKey = item.defense.join('、')
    const existing = result.find(d => d.defense.join('、') === defKey)
    if (existing) {
      // Defense's own updatedAt is left untouched — only attacks get a fresh date.
      const existingTeams = new Set(existing.attacks.map(a => a.team.join('、')))
      for (const atk of item.attacks) {
        const teamKey = atk.team.join('、')
        if (existingTeams.has(teamKey)) { skippedCount++; continue }
        existing.attacks.push({ id: nextId(), team: atk.team, notes: atk.notes, updatedAt: now })
        existingTeams.add(teamKey)
        newAttackCount++
      }
    } else {
      const seenTeams = new Set<string>()
      const newAttacks: Attack[] = []
      for (const atk of item.attacks) {
        const teamKey = atk.team.join('、')
        if (seenTeams.has(teamKey)) { skippedCount++; continue }
        seenTeams.add(teamKey)
        newAttacks.push({ id: nextId(), team: atk.team, notes: atk.notes, updatedAt: now })
        newAttackCount++
      }
      if (newAttacks.length > 0) {
        // Brand-new defense: defense + first batch of attacks share today's date.
        result.push({ id: nextId(), defense: item.defense, updatedAt: now, attacks: newAttacks })
        newDefenseCount++
      }
    }
  }

  return { newDefenseCount, newAttackCount, skippedCount, result }
}

const AI_IMPORT_PROMPT = `请把以下 markdown 中 \`# jjc\` 段落下面的内容转换成 JSON 数组。

规则：
1. 只看 \`# jjc\` 这个一级标题下的内容，其他段落（# 进攻、# 换防、# 机器人pjjc 等）全部忽略
2. ## 二级标题是 defense（防守方），紧随其后的 - 列表项是该防守方对应的 attack（进攻方）
3. 角色名以 、分隔；保留 /（如「路人妹/炸弹人」当一个名字）
4. 备注按优先级提取（去掉外围括号）：【...】> （...）/(...) > 角色串末尾以 ，引出的纯文本
5. 多条独立备注请拆成数组多项；没有备注时 notes 为 []

输出格式（严格符合，不要任何额外解释文字）：
[
  {
    "defense": ["els", "魔女", "ams", "魔驴", "拉姆"],
    "attacks": [
      { "team": ["白望", "真阳", "风剑", "龙锤", "春511"], "notes": ["up主"] }
    ]
  }
]

以下是要转换的 markdown：

[在这里粘贴你的 markdown 内容]`

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

// ── Import modal ───────────────────────────────────────────
function ImportModal({
  current, onClose, onConfirm,
}: {
  current: DefenseGroup[]
  onClose: () => void
  onConfirm: (merged: DefenseGroup[]) => void
}): JSX.Element {
  const [fileName, setFileName] = useState('')
  const [parseResult, setParseResult] = useState<ImportParseResult | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    setFileName(file.name)
    const text = await file.text()
    const result = parseImportJson(text)
    setParseResult(result)
    setPreview(result.items ? computeImportMerge(result.items, current) : null)
  }

  const canImport = !!preview && (preview.newDefenseCount > 0 || preview.newAttackCount > 0)

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-tertiary/15 border border-tertiary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-tertiary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>upload_file</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">导入作业 JSON</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">从外部 JSON 文件批量增量导入，重复条目自动跳过</p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-3">
        <button
          onClick={() => inputRef.current?.click()}
          className="w-full rounded-xl border border-dashed border-outline-variant/30 hover:border-tertiary/40 bg-surface-container/40 hover:bg-tertiary/[0.04] px-4 py-5 transition-colors flex flex-col items-center gap-1.5"
        >
          <span className="material-symbols-outlined text-on-surface-variant/60 text-2xl">folder_open</span>
          <span className="text-sm font-bold">{fileName || '点击选择 JSON 文件'}</span>
          {!fileName && <span className="text-[11px] text-on-surface-variant/50 font-label">仅支持 .json 格式</span>}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />

        {parseResult?.error && (
          <div className="rounded-xl border border-error/30 bg-error/[0.06] px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-error text-[18px] mt-px">error</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-error">解析失败</p>
              <p className="text-[11px] text-error/80 mt-0.5 font-label break-words">{parseResult.error}</p>
            </div>
          </div>
        )}

        {preview && (
          <div className="rounded-xl border border-outline-variant/15 bg-surface-container px-4 py-3">
            <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50 mb-2">导入预览</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-base font-mono font-bold text-primary">+{preview.newDefenseCount}</p>
                <p className="font-label text-[10px] text-on-surface-variant/60 mt-0.5">新增防守组</p>
              </div>
              <div>
                <p className="text-base font-mono font-bold text-secondary">+{preview.newAttackCount}</p>
                <p className="font-label text-[10px] text-on-surface-variant/60 mt-0.5">新增进攻条</p>
              </div>
              <div>
                <p className="text-base font-mono font-bold text-on-surface-variant/60">{preview.skippedCount}</p>
                <p className="font-label text-[10px] text-on-surface-variant/60 mt-0.5">重复跳过</p>
              </div>
            </div>
          </div>
        )}

        <details
          className="rounded-xl border border-outline-variant/15 bg-surface-container/60"
          open={showPrompt}
          onToggle={e => setShowPrompt((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer list-none px-4 py-2.5 flex items-center gap-2 select-none">
            <span
              className="material-symbols-outlined text-on-surface-variant/60 transition-transform shrink-0"
              style={{ fontSize: 16, transform: showPrompt ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >chevron_right</span>
            <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 flex-1">复制给 AI 的转换提示词</span>
            <button
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                navigator.clipboard.writeText(AI_IMPORT_PROMPT)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className={`p-1 rounded transition-colors ${copied ? 'text-secondary' : 'text-on-surface-variant/60 hover:text-primary hover:bg-surface-container-high'}`}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{copied ? 'check' : 'content_copy'}</span>
            </button>
          </summary>
          <pre className="px-4 pb-3 pt-1 text-[11px] text-on-surface-variant/80 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-60 overflow-auto">{AI_IMPORT_PROMPT}</pre>
        </details>
      </div>

      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors">
          取消
        </button>
        <button
          onClick={() => preview && onConfirm(preview.result)}
          disabled={!canImport}
          className="flex-1 py-3 rounded-xl border border-tertiary/40 bg-tertiary/10 text-sm font-bold text-tertiary hover:bg-tertiary/20 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-base leading-none">download_done</span>
          导入到本地
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
}>(function HomeworkView({ data, setData, query, onClearQuery }, ref) {
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
    const defense = defenseInput.split('、').map(s => s.trim()).filter(Boolean)
    const team = attackInput.split('、').map(s => s.trim()).filter(Boolean)
    if (!defense.length || !team.length) return
    const defKey = defense.join('、')
    const now = todayStr()
    setData(prev => {
      const existing = prev.find(d => d.defense.join('、') === defKey)
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
    setData(prev => prev.map(d =>
      d.id === editDefenseGroup.id ? { ...d, defense: newDefense, updatedAt: todayStr() } : d
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
          <button
            onClick={() => setIsImportOpen(true)}
            className="px-3 py-1 rounded-md bg-surface-container-high text-on-surface-variant border border-outline-variant/15 font-label text-[11px] uppercase tracking-widest hover:text-tertiary hover:border-tertiary/30 transition-colors flex items-center gap-1"
            title="从 JSON 文件批量导入作业"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>upload_file</span>导入
          </button>
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
                              onClick={() => copyWithFeedback(`atk-${atk.id}`, copyText(atk.team, atk.notes))}
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

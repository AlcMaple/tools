import { useState, useEffect, useRef } from 'react'
import TopBar from '../components/TopBar'

interface Attack {
  id: number
  team: string[]
  note: string
}

interface DefenseGroup {
  id: number
  defense: string[]
  updatedAt: string
  attacks: Attack[]
}

const STORAGE_KEY = 'maple-homework-data'

const INITIAL_DATA: DefenseGroup[] = [
  {
    id: 1, defense: ['涅比亚', 'ams', '春剑', '水m', '布丁'], updatedAt: '2026-04-29',
    attacks: [
      { id: 101, team: ['els', '魔女', '春剑', '水m', '布丁'], note: '' },
      { id: 102, team: ['els', '魔女', '水优妮', '春剑', '布丁'], note: '' },
      { id: 103, team: ['els', '魔女', '水电', '水雷姆', '跳跳虎'], note: '' },
      { id: 104, team: ['涅比亚', 'ams', '春剑', '水m', '布丁'], note: '镜像阵容，稳定' },
      { id: 105, team: ['涅比亚', 'ams', '驴', '水m', '布丁'], note: '' },
      { id: 106, team: ['涅比亚', 'ams', '路人妹', '春剑', '布丁'], note: '' },
      { id: 107, team: ['涅比亚', 'ams', '驴', '春剑', '布丁'], note: '' },
      { id: 108, team: ['涅比亚', 'ams', '鬼松', '黄骑', '布丁'], note: '' },
      { id: 109, team: ['涅比亚', 'ams', '超猫', '黄骑', '偶像'], note: '' },
      { id: 110, team: ['涅比亚', 'ams', '史莱姆', '黑姐姐', '水m'], note: '' },
      { id: 111, team: ['涅比亚', '妹弓', '史莱姆', '水m', '布丁'], note: '' },
      { id: 112, team: ['涅比亚', '妹弓', '圣吃', '史莱姆', '水m'], note: '' },
      { id: 113, team: ['涅比亚', '镜子', '水星', '黄骑', '真阳'], note: '' },
      { id: 114, team: ['涅比亚', 'els', '魔女/smt', '黄骑', '布丁'], note: '' },
      { id: 115, team: ['涅比亚', 'els', 'smt', '黄骑', '春剑'], note: '' },
      { id: 116, team: ['涅比亚', 'els', '魔女', '水星', '布丁'], note: '' },
      { id: 117, team: ['涅比亚', '水星', '黄骑', '姐姐', '水m'], note: '' },
      { id: 118, team: ['涅比亚', '魔女', '水星', '春剑', '布丁'], note: '' },
      { id: 119, team: ['涅比亚', '魔女', '水老师', '春剑', '布丁'], note: '' },
      { id: 120, team: ['涅比亚', '魔女', 'ams', '春剑', '布丁'], note: '' },
      { id: 121, team: ['涅比亚', '魔女', '裁缝', '春剑', '布丁'], note: '' },
    ],
  },
  {
    id: 2, defense: ['涅比亚', 'ams', '驴', '水m', '布丁'], updatedAt: '2026-04-26',
    attacks: [
      { id: 201, team: ['xcw', 'els', '驴', '水电', '猫剑'], note: '' },
      { id: 202, team: ['白猫', '水电', '中二', '风剑', '裁缝'], note: '' },
      { id: 203, team: ['xcw', 'els', '水电', '裁缝', '龙拳'], note: '' },
      { id: 204, team: ['xcw', '水电', '江月', '路人兔', '中二'], note: '控制魔攻（xcw 比中二要低）' },
      { id: 205, team: ['xcw', '优妮', '水电', '水星', '龙拳'], note: '' },
      { id: 206, team: ['魔女', '水电', '水拉姆', '中二', '龙锤'], note: '' },
    ],
  },
  {
    id: 3, defense: ['魔女', '圣莱', '水电', '水星', '水雷姆'], updatedAt: '2026-04-22',
    attacks: [
      { id: 301, team: ['圣莱', '水电', '雷姆', '裁缝', '龙拳'], note: 'up 主推荐' },
    ],
  },
  {
    id: 4, defense: ['黄泉', '克拉拉', '三月七', '藿藿'], updatedAt: '2026-04-19',
    attacks: [
      { id: 401, team: ['饮月', '停云', '罗刹', '藿藿'], note: '饮月单核，需要专武' },
      { id: 402, team: ['刃', '布洛妮娅', '花火', '罗刹'], note: '刃打巨像更稳' },
    ],
  },
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function Highlight({ text, query }: { text: string; query: string }): JSX.Element {
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

function commonPrefixLen(teams: string[][]): number {
  if (teams.length <= 1) return 0
  let n = 0
  const first = teams[0]
  while (n < first.length) {
    if (!teams.every(t => t[n] === first[n])) break
    n++
  }
  return n
}

function matches(item: DefenseGroup, q: string): boolean {
  if (!q) return true
  const hay = [...item.defense, ...item.attacks.flatMap(a => [...a.team, a.note])].join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}

// ── Shared modal shell (FileExplorer style) ────────────────
function ModalShell({ onBackdrop, children }: { onBackdrop: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onBackdrop} />
      <div className="relative bg-surface-container-high backdrop-blur rounded-xl border border-outline-variant/25 shadow-2xl w-[520px] max-w-[92vw]">
        {children}
      </div>
    </div>
  )
}

// ── Shared form input ──────────────────────────────────────
function FormField({
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

function ModalInput(props: React.InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      {...props}
      className="w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
    />
  )
}

// ── Add modal ──────────────────────────────────────────────
function AddModal({
  defenseInput, attackInput, noteInput,
  setDefenseInput, setAttackInput, setNoteInput,
  onClose, onSave,
}: {
  defenseInput: string; attackInput: string; noteInput: string
  setDefenseInput: (v: string) => void
  setAttackInput: (v: string) => void
  setNoteInput: (v: string) => void
  onClose: () => void; onSave: () => void
}): JSX.Element {
  const canSave = defenseInput.trim().length > 0 && attackInput.trim().length > 0
  return (
    <ModalShell onBackdrop={onClose}>
      {/* Header */}
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-primary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>add_circle</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">新增作业</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">记录一条「防守 → 进攻」对应关系</p>
        </div>
      </div>

      {/* Body */}
      <div className="px-7 py-5 space-y-3">
        {/* Defense card */}
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

        {/* Arrow connector */}
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-1 text-on-surface-variant/30 text-[11px] font-label uppercase tracking-widest">
            <span className="material-symbols-outlined text-[16px]">arrow_downward</span>
            进攻
          </div>
        </div>

        {/* Attack card */}
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

        {/* Note field */}
        <div>
          <label className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mb-1.5">
            <span className="material-symbols-outlined text-[13px]">edit_note</span>
            备注（可选）
          </label>
          <ModalInput
            placeholder="配速、装备、控制要点…"
            value={noteInput}
            onChange={e => setNoteInput(e.target.value)}
          />
        </div>
      </div>

      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          取消
        </button>
        <button
          onClick={onSave}
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
            <ModalInput
              value={value}
              onChange={e => setValue(e.target.value)}
              autoFocus
            />
          </FormField>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
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
  onSave: (team: string[], note: string) => void
}): JSX.Element {
  const [teamValue, setTeamValue] = useState(atk.team.join('、'))
  const [noteValue, setNoteValue] = useState(atk.note)
  const canSave = teamValue.trim().length > 0 &&
    (teamValue.trim() !== atk.team.join('、') || noteValue.trim() !== atk.note)
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
            {atk.note && <p className="text-xs text-secondary/70 mt-1">{atk.note}</p>}
          </div>
          <FormField label="进攻方角色" dot="bg-secondary" hint="用顿号 、 分隔，最多 5 名角色">
            <ModalInput
              value={teamValue}
              onChange={e => setTeamValue(e.target.value)}
              autoFocus
            />
          </FormField>
          <FormField label="备注（可选）" dot="bg-outline">
            <ModalInput
              placeholder="配速、装备、控制要点…"
              value={noteValue}
              onChange={e => setNoteValue(e.target.value)}
            />
          </FormField>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          取消
        </button>
        <button
          onClick={() => onSave(teamValue.split('、').map(s => s.trim()).filter(Boolean), noteValue.trim())}
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

// ── Delete confirm modal ───────────────────────────────────
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
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 py-3 rounded-xl border border-error/40 bg-error/10 text-sm font-bold text-error hover:bg-error/20 transition-colors flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-base leading-none">delete</span>
          删除整组
        </button>
      </div>
    </ModalShell>
  )
}

// ── Delete attack confirm modal ────────────────────────────
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
          {atk.note && (
            <p className="text-xs text-on-surface-variant/70 font-label">{atk.note}</p>
          )}
        </div>

        <div className="mt-3 flex items-start gap-2 text-[11px] text-error font-label uppercase tracking-widest">
          <span className="material-symbols-outlined text-[14px] mt-px">warning</span>
          <span>删除后无法恢复，请谨慎操作。</span>
        </div>
      </div>
      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          className="flex-1 py-3 rounded-xl border border-error/40 bg-error/10 text-sm font-bold text-error hover:bg-error/20 transition-colors flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-base leading-none">delete</span>
          删除该条
        </button>
      </div>
    </ModalShell>
  )
}

// ── Main page ──────────────────────────────────────────────
export default function HomeworkLookup(): JSX.Element {
  const [data, setData] = useState<DefenseGroup[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : INITIAL_DATA
    } catch { return INITIAL_DATA }
  })
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [isDebouncing, setIsDebouncing] = useState(false)
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set())

  // modal states
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [defenseInput, setDefenseInput] = useState('')
  const [attackInput, setAttackInput] = useState('')
  const [noteInput, setNoteInput] = useState('')

  const [editDefenseGroup, setEditDefenseGroup] = useState<DefenseGroup | null>(null)
  const [editAttackTarget, setEditAttackTarget] = useState<{ groupId: number; atk: Attack } | null>(null)
  const [deleteGroup, setDeleteGroup] = useState<DefenseGroup | null>(null)
  const [deleteAttackTarget, setDeleteAttackTarget] = useState<{ groupId: number; atk: Attack } | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }, [data])

  useEffect(() => {
    if (data.length > 1) {
      setCollapsedIds(new Set(data.slice(1).map(d => d.id)))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleQueryChange = (v: string) => {
    setQuery(v)
    setIsDebouncing(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(v.trim())
      setIsDebouncing(false)
    }, 220)
  }

  const clearQuery = () => {
    setQuery('')
    setDebouncedQuery('')
    setIsDebouncing(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }

  const filtered = data
    .filter(d => matches(d, debouncedQuery))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))

  const totalAttacks = filtered.reduce((s, d) => s + d.attacks.length, 0)

  const toggleCollapse = (id: number) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleAdd = () => {
    const defense = defenseInput.split('、').map(s => s.trim()).filter(Boolean)
    const team = attackInput.split('、').map(s => s.trim()).filter(Boolean)
    if (!defense.length || !team.length) return
    const defKey = defense.join('、')
    const now = new Date().toISOString().slice(0, 10)
    setData(prev => {
      const existing = prev.find(d => d.defense.join('、') === defKey)
      if (existing) {
        return prev.map(d =>
          d.id === existing.id
            ? { ...d, updatedAt: now, attacks: [...d.attacks, { id: Date.now(), team, note: noteInput.trim() }] }
            : d
        )
      }
      return [...prev, { id: Date.now(), defense, updatedAt: now, attacks: [{ id: Date.now() + 1, team, note: noteInput.trim() }] }]
    })
    setIsAddOpen(false)
  }

  const handleEditDefense = (newDefense: string[]) => {
    if (!editDefenseGroup) return
    setData(prev => prev.map(d =>
      d.id === editDefenseGroup.id
        ? { ...d, defense: newDefense, updatedAt: new Date().toISOString().slice(0, 10) }
        : d
    ))
    setEditDefenseGroup(null)
  }

  const handleEditAttack = (team: string[], note: string) => {
    if (!editAttackTarget) return
    setData(prev => prev.map(d =>
      d.id === editAttackTarget.groupId
        ? {
            ...d,
            updatedAt: new Date().toISOString().slice(0, 10),
            attacks: d.attacks.map(a => a.id === editAttackTarget.atk.id ? { ...a, team, note } : a),
          }
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

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="搜索阵容、角色名…" />
      <div className="pt-16">
      {/* Page header */}
      <div className="sticky top-0 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-8 py-5 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>swords</span>
            <span>Tools</span>
            <span className="text-outline-variant">/</span>
            <span className="text-on-surface font-bold">Homework Lookup</span>
          </div>
          <h1 className="text-3xl font-black tracking-tighter text-on-surface">阵容作业查询</h1>
          <p className="text-sm text-on-surface-variant/80 mt-1 font-label">
            输入防守方角色，实时检索匹配的进攻方阵容 · 同一防守方的多个攻略归纳到一起
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
            <input
              className="w-[380px] bg-surface-container-high border border-outline-variant/20 rounded-xl py-2.5 pl-10 pr-20 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40 focus:bg-surface-bright transition-all placeholder:text-on-surface-variant/40"
              placeholder="模糊搜索：角色名、备注、关键词…"
              value={query}
              onChange={e => handleQueryChange(e.target.value)}
            />
            {isDebouncing && (
              <div className="absolute right-10 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-primary pulse-dot" />
            )}
            {query && !isDebouncing && (
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 hover:text-primary p-1"
                onClick={clearQuery}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
              </button>
            )}
          </div>
          <button
            onClick={() => { setDefenseInput(''); setAttackInput(''); setNoteInput(''); setIsAddOpen(true) }}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary font-label text-xs uppercase tracking-widest hover:bg-primary-fixed transition-all active:scale-95 shadow-lg shadow-primary/10 whitespace-nowrap"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}>add</span>
            添加阵容
          </button>
        </div>
      </div>

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

        {/* Empty state */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-20">
            <div className="w-16 h-16 rounded-2xl bg-surface-container-high flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-primary text-3xl">search_off</span>
            </div>
            <h3 className="text-lg font-bold text-on-surface">没有匹配的阵容</h3>
            <p className="text-sm text-on-surface-variant/70 mt-1 font-label">
              试试别的角色名，或者{' '}
              <button className="text-primary underline underline-offset-2" onClick={clearQuery}>清空搜索</button>
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
                  {/* Defense header */}
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
                    >
                      chevron_right
                    </span>
                    <span
                      className="material-symbols-outlined text-primary shrink-0"
                      style={{ fontSize: 16, fontVariationSettings: "'FILL' 1" }}
                    >
                      shield
                    </span>
                    <div className="flex flex-wrap items-center gap-x-0.5 text-[15px] font-bold tracking-tight shrink-0">
                      {item.defense.map((c, i) => (
                        <span key={i} className="text-primary">
                          <Highlight text={c} query={debouncedQuery} />
                          {i < item.defense.length - 1 && <span className="text-primary/40">、</span>}
                        </span>
                      ))}
                    </div>
                    <div className="flex-1" />
                    <div className="header-actions flex items-center gap-1 shrink-0">
                      <span className="font-label text-[10px] uppercase tracking-widest text-outline mr-2">{item.updatedAt}</span>
                      <button
                        className="p-1.5 rounded-md hover:bg-surface-container-high transition-colors text-on-surface-variant"
                        title="编辑防守方"
                        onClick={() => setEditDefenseGroup(item)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit</span>
                      </button>
                      <button
                        className="p-1.5 rounded-md hover:bg-error/10 transition-colors text-on-surface-variant hover:text-error"
                        title="删除整组"
                        onClick={() => setDeleteGroup(item)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                      </button>
                    </div>
                  </div>

                  {/* Collapsible attack rows */}
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
                                      <Highlight text={c} query={debouncedQuery} />
                                    </span>
                                    {i < atk.team.length - 1 && <span className="sep">、</span>}
                                  </span>
                                ))}
                              </div>
                              {atk.note && (
                                <div className="atk-note">
                                  <Highlight text={atk.note} query={debouncedQuery} />
                                </div>
                              )}
                            </div>
                            <div className="font-label text-[10px] uppercase tracking-widest text-outline/70">{atk.team.length}/5</div>
                            <div className="row-actions">
                              <button className="p-1.5 rounded text-on-surface-variant/50 hover:text-primary hover:bg-surface-container-high transition-colors" title="复制">
                                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>content_copy</span>
                              </button>
                              <button
                                className="p-1.5 rounded text-on-surface-variant/50 hover:text-secondary hover:bg-surface-container-high transition-colors"
                                title="编辑"
                                onClick={() => setEditAttackTarget({ groupId: item.id, atk })}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: 15 }}>edit</span>
                              </button>
                              <button
                                className="p-1.5 rounded text-on-surface-variant/50 hover:text-error hover:bg-error/10 transition-colors"
                                title="删除该条"
                                onClick={() => setDeleteAttackTarget({ groupId: item.id, atk })}
                              >
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
      </div>

      {/* Modals */}
      {isAddOpen && (
        <AddModal
          defenseInput={defenseInput} attackInput={attackInput} noteInput={noteInput}
          setDefenseInput={setDefenseInput} setAttackInput={setAttackInput} setNoteInput={setNoteInput}
          onClose={() => setIsAddOpen(false)} onSave={handleAdd}
        />
      )}
      {editDefenseGroup && (
        <EditDefenseModal
          group={editDefenseGroup}
          onClose={() => setEditDefenseGroup(null)}
          onSave={handleEditDefense}
        />
      )}
      {editAttackTarget && (
        <EditAttackModal
          atk={editAttackTarget.atk}
          onClose={() => setEditAttackTarget(null)}
          onSave={handleEditAttack}
        />
      )}
      {deleteGroup && (
        <DeleteModal
          group={deleteGroup}
          onClose={() => setDeleteGroup(null)}
          onConfirm={handleDelete}
        />
      )}
      {deleteAttackTarget && (
        <DeleteAttackModal
          atk={deleteAttackTarget.atk}
          onClose={() => setDeleteAttackTarget(null)}
          onConfirm={handleDeleteAttack}
        />
      )}
      </div>
    </div>
  )
}

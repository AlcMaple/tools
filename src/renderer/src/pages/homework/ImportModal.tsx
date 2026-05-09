import { useRef, useState } from 'react'
import {
  Attack, DefenseGroup,
  ModalShell,
  cleanCharName, coerceNotes, todayStr,
} from './shared'

// ── Import payload schema (homework-only) ─────────────────────────────────────

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
  const nextId = (): number => idCounter++

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

// ── Import modal ──────────────────────────────────────────────────────────────

export function ImportModal({
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

  const handleFile = async (file: File): Promise<void> => {
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

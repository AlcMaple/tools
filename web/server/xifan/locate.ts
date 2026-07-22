// bgmId → 稀饭 animeId 的「定位」。
//
// 没有确定性映射：稀饭不暴露 BGM id，唯一联系是标题。所以首次绑定必然是「拿追番标题去周表比中文名」的
// 模糊匹配 —— 但**绝不自动认**（跟 app「源只按显式 bindings 关联、绝不模糊匹配」同一条原则）：
// locate 只返回**排好序的候选**，由用户在前端点一下确认（= 建绑定），确认才落库（bindings.ts）。
// 已绑定的直接返回 bound，不再比。
import { fetchWeekday } from './weekday'
import { getBinding } from './bindings'

// 归一化：NFKC（全角→半角、兼容字符归并）+ 小写 + 只留「汉字 / 平假名 / 片假名 / 字母数字」，
// 把空格、・、～、！、，、。等标点全去掉。稀饭是简体中文名，追番的 titleCn / aliases 也多是简体，
// 归一化后能对上；日文原名（title）作最后兜底。不做繁简转换（成本高、收益低，交给候选让用户挑）。
function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}0-9a-z]/gu, '')
}

// 二元组 Dice 相似度（0..1）—— 给「非包含关系」的候选一个排序依据，不追求精确，够排序即可。
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(a)
  const gb = grams(b)
  let inter = 0
  for (const [g, n] of ga) {
    const nb = gb.get(g)
    if (nb) inter += Math.min(n, nb)
  }
  return (2 * inter) / (a.length - 1 + (b.length - 1))
}

// 一个周表条目 vs 追番的一组标题，取最高分：相等 1 > 互相包含（按长度比）> 二元组相似度。
function scoreItem(vodName: string, titles: string[]): number {
  const nv = norm(vodName)
  if (!nv) return 0
  let best = 0
  for (const t of titles) {
    const nt = norm(t)
    if (!nt) continue
    let s: number
    if (nv === nt) s = 1
    else if (nv.includes(nt) || nt.includes(nv)) {
      const short = Math.min(nv.length, nt.length)
      const long = Math.max(nv.length, nt.length)
      // 太短的包含（如 2 字标题命中一长串）压低分，避免「魔王」命中「魔王学院…」这种误伤
      s = short >= 2 ? 0.8 + 0.2 * (short / long) : 0.3
    } else s = 0.7 * dice(nv, nt)
    if (s > best) best = s
  }
  return best
}

export interface Candidate {
  xifanId: number
  xifanName: string
  day: number
  remarks: string
  score: number
}

export interface LocateResult {
  bound?: Candidate // 已绑定（命中 bindings 表）—— 前端直接开播
  candidates: Candidate[] // 未绑定时的候选，按分降序，让用户挑一个确认
}

export async function locate(bgmId: number, titles: string[]): Promise<LocateResult> {
  const clean = titles.map((t) => t.trim()).filter(Boolean)
  const items = await fetchWeekday()

  // 已绑定：直接返回。顺带从周表补一份最新 day/remarks（周表里没有就给占位），前端可显示但不依赖。
  const bound = getBinding(bgmId)
  if (bound) {
    const hit = items.find((i) => i.xifanId === bound.xifanId)
    return {
      bound: {
        xifanId: bound.xifanId,
        xifanName: bound.xifanName || hit?.name || '',
        day: hit?.day ?? 0,
        remarks: hit?.remarks ?? '',
        score: 1,
      },
      candidates: [],
    }
  }

  // 未绑定：打分排序。同一 xifanId 可能跨天重复（极少），按 id 去重留最高分。
  const scored = new Map<number, Candidate>()
  for (const it of items) {
    const s = scoreItem(it.name, clean)
    if (s < 0.2) continue // 分太低的不当候选，免得列一堆牛头不对马嘴的（真匹配远在此之上：包含≥0.8、像样的模糊≥0.4）
    const prev = scored.get(it.xifanId)
    if (!prev || s > prev.score) {
      scored.set(it.xifanId, {
        xifanId: it.xifanId,
        xifanName: it.name,
        day: it.day,
        remarks: it.remarks,
        score: Math.round(s * 100) / 100,
      })
    }
  }
  const candidates = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 6)
  return { candidates }
}

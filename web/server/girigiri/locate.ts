// bgmId → Girigiri GV… 的标题定位。
// Girigiri 同样不暴露 BGM id，候选只排序不自动绑定；用户点选后才写 bindings 表。
import { getBinding } from './bindings'
import { fetchWeekday } from './weekday'

function norm(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}0-9a-z]/gu, '')
}

function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = (value: string): Map<string, number> => {
    const out = new Map<string, number>()
    for (let i = 0; i < value.length - 1; i++) {
      const gram = value.slice(i, i + 2)
      out.set(gram, (out.get(gram) ?? 0) + 1)
    }
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  let intersection = 0
  for (const [gram, count] of ga) {
    const other = gb.get(gram)
    if (other) intersection += Math.min(count, other)
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1))
}

function scoreItem(name: string, titles: string[]): number {
  const normalizedName = norm(name)
  if (!normalizedName) return 0
  let best = 0
  for (const title of titles) {
    const normalizedTitle = norm(title)
    if (!normalizedTitle) continue
    let score = 0
    if (normalizedName === normalizedTitle) score = 1
    else if (normalizedName.includes(normalizedTitle) || normalizedTitle.includes(normalizedName)) {
      const short = Math.min(normalizedName.length, normalizedTitle.length)
      const long = Math.max(normalizedName.length, normalizedTitle.length)
      score = short >= 2 ? 0.8 + 0.2 * (short / long) : 0.3
    } else score = 0.7 * dice(normalizedName, normalizedTitle)
    if (score > best) best = score
  }
  return best
}

export interface GirigiriCandidate {
  girigiriId: string
  girigiriName: string
  day: number
  remarks: string
  score: number
}

export interface GirigiriLocateResult {
  bound?: GirigiriCandidate
  candidates: GirigiriCandidate[]
}

export async function locate(bgmId: number, titles: string[]): Promise<GirigiriLocateResult> {
  const clean = titles.map((title) => title.trim()).filter(Boolean)
  const items = await fetchWeekday()
  const bound = getBinding(bgmId)
  if (bound) {
    const hit = items.find((item) => item.girigiriId === bound.girigiriId)
    return {
      bound: {
        girigiriId: bound.girigiriId,
        girigiriName: bound.girigiriName || hit?.name || '',
        day: hit?.day ?? 0,
        remarks: hit?.remarks ?? '',
        score: 1,
      },
      candidates: [],
    }
  }

  const scored = new Map<string, GirigiriCandidate>()
  for (const item of items) {
    const score = scoreItem(item.name, clean)
    if (score < 0.2) continue
    const previous = scored.get(item.girigiriId)
    if (!previous || score > previous.score) {
      scored.set(item.girigiriId, {
        girigiriId: item.girigiriId,
        girigiriName: item.name,
        day: item.day,
        remarks: item.remarks,
        score: Math.round(score * 100) / 100,
      })
    }
  }
  return { candidates: [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 6) }
}

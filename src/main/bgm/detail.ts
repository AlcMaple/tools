import * as https from 'https'
import { getMoegirlSynopsis } from '../moegirl/synopsis'

const BASE_API = 'https://api.bgm.tv/v0'
const HEADERS = {
  'User-Agent': 'tools/1.0 (github.com/user/tools)',
  'Accept': 'application/json',
}

// Staff 职位过滤（从 /persons 端点）
const STAFF_ROLES_FROM_PERSONS = ['导演', '监督', '音乐', '系列构成', '脚本', '人物原案', '总作画监督']
// 从 infobox 直接提取的字段（优先级更高）
const INFOBOX_STAFF_KEYS = ['导演', '监督', '音乐', '系列构成', '人物设定', '原作']

export interface StaffEntry {
  role: string
  name: string
  name_cn: string
}

export interface BgmDetail {
  id: number
  title: string
  title_cn: string
  summary: string
  cover: string
  link: string
  score: number
  rank: number
  votes: number
  date: string
  platform: string
  episodes: number
  tags: string[]
  studio: string
  staff: StaffEntry[]
  infobox: Record<string, string>
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
        catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')) })
  })
}

// ── Parsers ────────────────────────────────────────────────────────────────────
/**
 * 从 BGM summary 提取中文部分；没中文就把日文原文整段返回。
 *
 * BGM 的简介有三种常见形态：
 *   1. **中日并排（带 marker）**：「中文简介\n[简介原文]\n日文原文」
 *      ——marker 前的就是中文，取它即可
 *   2. **纯中文**：直接是中文段落
 *   3. **纯日文/原文**：BGM 没人翻译时直接挂日文（噬血狂袭 IV 这种）
 *
 * 之前的实现按 `\n` 切段然后**逐段**用假名密度过滤：在第 3 种情况会把
 * "假名少的段"（"物語の舞台は魔族特区"恩莱島"" —— 假名只 2 个 < 5 的阈值）
 * 误判成中文留下，"假名多的段"过滤掉，把一篇完整日文撕得只剩三段碎句。
 *
 * 修法：检测到 marker → 取前半中文段；否则不切段，**整段**算假名密度判断
 * hasChinese，text 永远原样返回。这样上层 fallback 到 moegirl 失败后，
 * 用户至少能看到完整原文。
 */
function extractChineseSummary(summary: string): { text: string; hasChinese: boolean } {
  if (!summary) return { text: '', hasChinese: false }

  // 形态 1：显式中日 marker
  const splitters = [
    /\[简介原文\]/, /\[簡介原文\]/, /【简介原文】/, /【簡介原文】/,
    /\n简介原文：/, /\n簡介原文：/, /\[introduction\]/i
  ]
  for (const splitter of splitters) {
    if (splitter.test(summary)) {
      const chinesePart = summary.split(splitter)[0].trim()
      if (chinesePart) return { text: chinesePart, hasChinese: true }
    }
  }

  // 形态 2 / 3：没 marker。整段算假名密度，绝不逐段撕。
  // 阈值 5% 加上 10 个绝对数量是 OR 关系——日文短文也常有显著假名出现率
  // （助词の・を・に / 连接词），>5% 基本能稳判；中文外来语夹零星假名通常
  // 远低于 5%。
  const kanaMatches = summary.match(/[぀-ゟ゠-ヿ]/g) || []
  const kanaRatio = kanaMatches.length / summary.length
  const isMostlyJapanese = kanaMatches.length > 10 || kanaRatio > 0.05
  return { text: summary, hasChinese: !isMostlyJapanese }
}

function parseInfobox(infobox: unknown[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const item of infobox) {
    const entry = item as Record<string, unknown>
    const key = String(entry.key ?? '')
    let value = entry.value
    if (Array.isArray(value)) {
      value = value.map((v) => String((v as Record<string, unknown>).v ?? '')).filter(Boolean).join('、')
    }
    result[key] = String(value ?? '').trim()
  }
  return result
}

function pickStaffFromPersons(persons: unknown[]): StaffEntry[] {
  const picked: StaffEntry[] = []
  const seenRoles = new Set<string>()
  for (const p of persons) {
    const person = p as Record<string, unknown>
    const relation = String(person.relation ?? '')
    if (!STAFF_ROLES_FROM_PERSONS.some((role) => relation.includes(role))) continue
    if (seenRoles.has(relation)) continue
    seenRoles.add(relation)
    picked.push({
      role: relation,
      name: String(person.name ?? ''),
      name_cn: String(person.name_cn || person.name || ''),
    })
    if (picked.length >= 6) break
  }
  return picked
}

function pickStaffFromInfobox(infobox: Record<string, string>): StaffEntry[] {
  const result: StaffEntry[] = []
  for (const key of INFOBOX_STAFF_KEYS) {
    const value = (infobox[key] ?? '').trim()
    if (!value) continue
    const first = value.split(/[,，、]/)[0].trim()
    if (first) result.push({ role: key, name: first, name_cn: first })
  }
  return result
}

function mergeStaff(fromInfobox: StaffEntry[], fromPersons: StaffEntry[]): StaffEntry[] {
  const merged = [...fromInfobox]
  const seenRoles = new Set(merged.map((s) => s.role))
  for (const s of fromPersons) {
    if (!Array.from(seenRoles).some((existing) => existing.includes(s.role) || s.role.includes(existing))) {
      merged.push(s)
      seenRoles.add(s.role)
    }
    if (merged.length >= 6) break
  }
  return merged
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function getBgmDetail(subjectId: number): Promise<BgmDetail> {
  const subject = await fetchJson(`${BASE_API}/subjects/${subjectId}`) as Record<string, unknown>

  const infobox = parseInfobox((subject.infobox as unknown[]) ?? [])
  const rating = (subject.rating as Record<string, unknown>) ?? {}
  const images = (subject.images as Record<string, string>) ?? {}

  const cover = images.large || images.common || images.medium || ''
  // 只取前 4 个最热门 tag —— BGM API 返回的 tags 已经按热度排好序，4 个
  // 就够 AnimeInfo Genre 区 + MyAnime UserTagsEditor 的 BGM 标签参考用了。
  // 这俩地方一致显示完整 data.tags / track.bgmTags 即可，下游不再做二次
  // slice，避免"详情页 3 个、modal 8 个" 那种数量错位的混淆（见 commit 沿革）。
  const tags = ((subject.tags as { name: string }[]) ?? []).slice(0, 4).map((t) => t.name)

  let studio = infobox['动画制作'] || infobox['制作公司'] || ''
  const airDate = String(subject.date ?? '') || infobox['放送开始'] || ''

  const staffInfobox = pickStaffFromInfobox(infobox)

  let staffPersons: StaffEntry[] = []
  try {
    const persons = await fetchJson(`${BASE_API}/subjects/${subjectId}/persons`) as unknown[]
    if (!studio) {
      for (const p of persons) {
        const person = p as Record<string, unknown>
        if (person.type === 3 && String(person.relation ?? '').includes('动画制作')) {
          studio = String(person.name_cn || person.name || '')
          break
        }
      }
    }
    staffPersons = pickStaffFromPersons(persons)
  } catch { /* persons 失败时仅用 infobox */ }

  const staff = mergeStaff(staffInfobox, staffPersons)

  const rawSummary = String(subject.summary ?? '')
  const bgmSummary = extractChineseSummary(rawSummary)
  let finalSummary = bgmSummary.text
  if (!bgmSummary.hasChinese && rawSummary) {
    const searchTitle = String(subject.name_cn || subject.name || '').trim()
    if (searchTitle) {
      const aliases = (infobox['别名'] ?? '')
        .split(/[、,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      try {
        const moe = await getMoegirlSynopsis(searchTitle, aliases)
        if (moe) {
          const moeCheck = extractChineseSummary(moe)
          if (moeCheck.hasChinese) finalSummary = moeCheck.text
        }
      } catch { /* moegirl 失败时回退到 BGM 原文 */ }
    }
  }

  return {
    id: Number(subject.id),
    title: String(subject.name ?? ''),
    title_cn: String(subject.name_cn ?? ''),
    summary: finalSummary,
    cover,
    link: `https://bgm.tv/subject/${subjectId}`,
    score: Number(rating.score ?? 0),
    rank: Number(rating.rank ?? 0),
    votes: Number(rating.total ?? 0),
    date: airDate,
    platform: String(subject.platform ?? ''),
    episodes: Number(subject.eps ?? 0),
    tags,
    studio,
    staff,
    infobox,
  }
}

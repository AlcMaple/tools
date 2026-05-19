import { getMoegirlSynopsis } from '../moegirl/synopsis'
import { fetchBgmApiJson } from './api-client'

const BASE_API = 'https://api.bgm.tv/v0'

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
  /** BGM 主类目数字：1=书籍 / 2=动画 / 3=音乐 / 4=游戏 / 6=三次元 */
  type: number
  title: string
  title_cn: string
  summary: string
  cover: string
  link: string
  score: number
  rank: number
  votes: number
  date: string
  /** 子类型：动画的 TV/剧场版/OVA / 书籍的 漫画/小说/画集/其他 等 */
  platform: string
  episodes: number
  tags: string[]
  studio: string
  staff: StaffEntry[]
  infobox: Record<string, string>
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
/**
 * 找文本里"日文区"第一次出现的位置（30 字滑动窗口里假名 ≥ JP_DENSITY_THRESHOLD
 * 个）。找不到返回 -1。
 *
 * 用滑动窗口而非按字符/按行/按句切，是为了规避两类误判：
 *
 *   - **按行切的灾难**（commit 058bde0 修过）：日文短句被误判成"中文留下"、
 *     长句被丢，整段简介剩三段碎句。本函数永远只产出一个"切点"（前面全
 *     算中文、后面全算日文），不存在"留下哪些段"的决策。
 *
 *   - **单字假名误伤**：中文里偶尔嵌「コミック」「アニメ」这种日文外来语
 *     人名/术语；窗口要求 ≥6 个假名才算"进入日文区"，单点假名 burst 不
 *     会触发。
 */
function findJapaneseRegionStart(text: string): number {
  const WINDOW_SIZE = 30
  const JP_DENSITY_THRESHOLD = 6 // 6/30 = 20% kana → 几乎肯定是日文段
  if (text.length < WINDOW_SIZE) return -1
  const kanaRegex = /[぀-ゟ゠-ヿ]/g
  for (let i = 0; i <= text.length - WINDOW_SIZE; i++) {
    const window = text.slice(i, i + WINDOW_SIZE)
    const kanaCount = (window.match(kanaRegex) || []).length
    if (kanaCount >= JP_DENSITY_THRESHOLD) return i
  }
  return -1
}

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

  // 形态 2：「中文段 + 日文段」无 marker 直接拼（BGM 4419 这种）。
  //
  // 两步定位真实边界：
  //
  //   ① `findJapaneseRegionStart` 返回**窗口起点** jpStart —— 这个窗口里
  //      假名 ≥ 6 个，意味着附近有"持续日文区"。但 jpStart 本身往往**还在
  //      中文段内**（窗口跨过边界往后看了 30 字才凑够 6 个假名）。
  //
  //   ② 在窗口 [jpStart, jpStart+30] 里扫第一个假名字符的位置 —— 那才是
  //      日文区真正开始的地方，也就是"中文段结束的位置"。
  //
  // 之前直接用 jpStart 当切点，导致中文段尾巴几个字被误截（BGM 4419 的"决战
  // 镜之国"被切成"勇闯镜之"丢了 20+ 字）。
  //
  // jpStart = 0（窗口从一开始就是日文密集区）→ 没有中文段可切，直接走形态
  // 3，**不**做任何切分（保护噬血狂袭 IV 那种纯日文场景）。
  const jpStart = findJapaneseRegionStart(summary)
  if (jpStart > 0) {
    const windowSlice = summary.slice(jpStart, Math.min(jpStart + 30, summary.length))
    const firstKanaInWindow = windowSlice.search(/[぀-ゟ゠-ヿ]/)
    // 窗口里一定有 ≥6 假名所以这里 >= 0 永真，但保险起见还是判一下
    if (firstKanaInWindow >= 0) {
      const realBoundary = jpStart + firstKanaInWindow
      const chinesePart = summary.slice(0, realBoundary).trim()
      // 防御性：切出来的"中文段"至少要有 5 个汉字才算数。否则可能是日文
      // 段开头几个零散标点 / 拉丁字符被误切到前面。
      const hanCount = (chinesePart.match(/[一-鿿]/g) || []).length
      if (chinesePart && hanCount >= 5) {
        return { text: chinesePart, hasChinese: true }
      }
    }
  }

  // 形态 3：纯中文 / 纯日文。整段算假名密度，**绝不逐段撕**。
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
  const subject = await fetchBgmApiJson<Record<string, unknown>>(`${BASE_API}/subjects/${subjectId}`)

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
    const persons = await fetchBgmApiJson<unknown[]>(`${BASE_API}/subjects/${subjectId}/persons`)
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
    // BGM 主类目数字。老 detail 缓存可能没这字段 —— renderer 端 normalize 时
    // type=0 + platform 模式匹配兜底（见 animeTrackStore deriveSubjectType）。
    type: Number(subject.type ?? 0),
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

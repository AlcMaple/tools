import { getMoegirlSynopsis } from '../moegirl/synopsis'
import { fetchBgmApiJson } from './api-client'
import { fetchSubjectViaHtml } from './html-fallback'

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

// ── 简介解析 ──────────────────────────────────────────────────────────────────
// 从 BGM 简介里取中文部分;没有中文就把日文原文**整段**返回。
//
// 简介有三种形态:中日并排(带 marker)、纯中文、纯日文(没人翻译时)。
// **绝不逐段判断假名密度再挑段留下** —— 那样纯日文简介会被撕成几句碎片(假名少的段被当成
// 中文留下、假名多的段被丢掉)。这里的做法是只找**一个切点**:前面全算中文、后面全算日文。
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

  // 形态 0:显式的「中文简介」marker,中文在 marker **之后**(与形态 1 相反)。
  // 这类条目日文原文在前,而且日文段前面还常有一段发售履历(汉字夹数字、不是简介),会被下面
  // 形态 2 的日文区检测误当成中文整段截出来。所以这个 marker 必须**最优先**判。
  const cnMarkers = [
    /[[【［]\s*中文简介\s*[\]】］]/, /[[【［]\s*中文簡介\s*[\]】］]/,
    /\n\s*中文简介\s*[:：]?\s*\n/, /\n\s*中文簡介\s*[:：]?\s*\n/
  ]
  for (const marker of cnMarkers) {
    const m = summary.match(marker)
    if (m && m.index !== undefined) {
      const after = summary.slice(m.index + m[0].length).trim()
      // marker 之后要真有中文才算数，否则可能是误匹配（marker 在结尾等）。
      const hanCount = (after.match(/[一-鿿]/g) || []).length
      if (after && hanCount >= 5) return { text: after, hasChinese: true }
    }
  }

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

  // 形态 2:中文段 + 日文段直接拼、没有 marker。分两步定边界:
  //   ① findJapaneseRegionStart 返回的是**窗口起点**(该窗口里假名 ≥6),但这个点往往还在中文段内
  //      —— 窗口是往后看了 30 字才凑够假名的。
  //   ② 再到窗口内扫第一个假名字符,那才是日文区真正的起点、也就是中文段的结束位置。
  // 直接拿窗口起点当切点会把中文段尾巴切掉二十来个字。
  // 窗口起点为 0(一上来就是日文密集区)说明没有中文段可切,直接走形态 3,**不做任何切分**。
  const jpStart = findJapaneseRegionStart(summary)
  if (jpStart > 0) {
    const windowSlice = summary.slice(jpStart, Math.min(jpStart + 30, summary.length))
    const firstKanaInWindow = windowSlice.search(/[぀-ゟ゠-ヿ]/)
    // 窗口里一定有 ≥6 假名所以这里 >= 0 永真，但保险起见还是判一下
    if (firstKanaInWindow >= 0) {
      const realBoundary = jpStart + firstKanaInWindow
      const chinesePart = summary.slice(0, realBoundary).trim()
      // 防御:切出来的中文段至少要有 5 个汉字才算数,否则可能只是日文段开头几个零散标点被误切过来。
      const hanCount = (chinesePart.match(/[一-鿿]/g) || []).length
      if (chinesePart && hanCount >= 5) {
        return { text: chinesePart, hasChinese: true }
      }
    }
  }

  // 形态 3:纯中文 / 纯日文。整段算假名密度,**绝不逐段撕**。
  // 比例和绝对数量是 OR 关系 —— 日文短文的助词假名出现率本来就高,中文里夹的零星外来语则远低于阈值。
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
  // api.bgm.tv 失败就降级抓 bgm.tv HTML(同形对象,其余解析不变)。
  //
  // **任何 api 失败都要降级,不能只认 RateLimitError**:BGM 限流绝大多数时候表现为超时 / 丢包
  // 而不是 429(被惩罚时直接不回包)。只认 429 的话,真限流会走 else 分支直接报「请求超时」
  // 既不降级也没倒计时。HTML 也失败才抛原始 api 错误(更能反映根因)。
  let subject: Record<string, unknown>
  try {
    subject = await fetchBgmApiJson<Record<string, unknown>>(`${BASE_API}/subjects/${subjectId}`)
  } catch (apiErr) {
    try {
      subject = (await fetchSubjectViaHtml(subjectId)) as unknown as Record<string, unknown>
    } catch (htmlErr) {
      // HTML 是最后一条路,所以抛它的错误而不是原始 api 错误 —— 让 UI 的「禁用 Try again」反映
      // **最终路线**的状态:HTML 只是临时超时就给普通错误(重试会再走一遍 api→HTML,可能就通了);
      // HTML 也确认限流才带倒计时禁用。即「连 HTML 都不行才禁用」。
      throw htmlErr
    }
  }

  const infobox = parseInfobox((subject.infobox as unknown[]) ?? [])
  const rating = (subject.rating as Record<string, unknown>) ?? {}
  const images = (subject.images as Record<string, string>) ?? {}

  const cover = images.large || images.common || images.medium || ''
  // 只取前 4 个最热门的 tag(API 返回时已按热度排好)。下游**不再二次 slice**,免得出现
  // 「详情页 3 个、弹窗 8 个」那种数量错位。
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
    // 老 detail 缓存可能没有 type 字段,渲染层 normalize 时用 platform 模式匹配兜底
    // (见 animeTrackStore 的 deriveSubjectType)。
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

/**
 * api.bgm.tv 限流冷却期的降级数据源。
 *
 * 抓 `bgm.tv/subject/{id}` 的服务端渲染 HTML(用户手动浏览没事的松端点),解析成**与 API 同形**
 * 的对象 —— 这样调用方几乎不用改解析逻辑,拿到的字段名完全一样。
 *
 * **只对限流降级**:调用方在拿到 RateLimitError 时才切到这里;网络 / 5xx 仍按错误处理(HTML 也救不了)。
 *
 * 取舍:HTML 的字段不如 JSON 干净齐全(排名、投票数、平台、类型多半拿不到,给默认值)——
 * 这是降级不是平替,冷却期能搜到、能看核心信息就够。解析依赖页面结构,所以每个字段都是
 * best-effort + 兜底,缺字段不抛错。防御栈复用搜索那一套(会话 + 限速 + 限流页检测),不另起一套。
 */
import * as cheerio from 'cheerio/slim'
import { fetchHtmlWithDefenses } from './search'

/** 与 api.bgm.tv 同形的字段子集(详情和别名回退用得到的那些)。 */
export interface ApiShapedSubject {
  id: number
  type: number
  name: string
  name_cn: string
  summary: string
  infobox: Array<{ key: string; value: string }>
  images: Record<string, string>
  rating: { score: number; rank: number; total: number }
  eps: number
  tags: Array<{ name: string }>
  platform: string
  date: string
}

const toInt = (s: string): number => {
  const n = parseInt(s.replace(/[^0-9]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}
const toFloat = (s: string): number => {
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

/**
 * 抓 bgm.tv 详情页 HTML，解析成 API 同形对象。
 * @throws 沿用 fetchHtmlWithDefenses 的错误（RateLimitError / 网络 / 5xx）——
 *         若连 bgm.tv 都限流了，调用方按错误处理（已无更松的端点可退）。
 */
export async function fetchSubjectViaHtml(subjectId: number): Promise<ApiShapedSubject> {
  const html = await fetchHtmlWithDefenses(`https://bgm.tv/subject/${subjectId}`)
  const $ = cheerio.load(html)

  // infobox：`<ul id="infobox"><li><span class="tip">键: </span>值</li>...`
  // 多值字段（别名等）可能嵌 `<ul><li>` 子列表，合并成「、」连接的单串
  // （下游 normalizeForMatch 会去掉「、」，别名子串匹配照样成立）。
  const infobox: Array<{ key: string; value: string }> = []
  const ib: Record<string, string> = {}
  $('#infobox > li').each((_, li) => {
    const $li = $(li)
    const tip = $li.find('span.tip').first().text().replace(/[:：]\s*$/, '').trim()
    if (!tip) return
    const nested = $li.find('ul li')
    let value: string
    if (nested.length) {
      value = nested.map((__, n) => $(n).text().trim()).get().filter(Boolean).join('、')
    } else {
      const full = $li.text().trim()
      value = (full.startsWith(tip) ? full.slice(tip.length) : full).replace(/^[:：]\s*/, '').trim()
    }
    infobox.push({ key: tip, value })
    ib[tip] = value
  })

  const name = $('h1.nameSingle a').first().text().trim() || $('h1.nameSingle').first().text().trim()
  const name_cn = ib['中文名'] ?? ''
  const summary = $('#subject_summary').text().trim()

  let cover = $('.infobox img.cover').first().attr('src')
    || $('#bangumiInfo img').first().attr('src')
    || ''
  if (cover.startsWith('//')) cover = 'https:' + cover

  const score = toFloat($('[property="v:average"]').first().text() || $('.global_score .number').first().text())
  const votes = toInt($('[property="v:votes"]').first().text())

  const tags: Array<{ name: string }> = []
  $('.subject_tag_section a.l').each((_, a) => {
    const t = $(a).find('span').first().text().trim()
    if (t) tags.push({ name: t })
  })

  return {
    id: subjectId,
    type: 0, // HTML 难可靠判主类目；renderer 端 type=0 + platform 兜底（见 deriveSubjectType）
    name: name || name_cn,
    name_cn,
    summary,
    infobox,
    images: { large: cover, common: cover, medium: cover },
    rating: { score, rank: 0, total: votes }, // rank HTML 不易拿，降级给 0
    eps: toInt(ib['话数'] || ib['集数'] || ''),
    tags,
    platform: '', // detail 用 infobox 兜底 subtype；空可接受
    date: ib['放送开始'] || ib['上映年度'] || ib['发售日'] || '',
  }
}

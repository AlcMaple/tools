/**
 * api.bgm.tv 限流冷却期的降级数据源（008 第二步）。
 *
 * 思路：抓 `bgm.tv/subject/{id}` 的**服务端渲染 HTML**（用户手动浏览没事的"松
 * 端点"），cheerio 解析成**与 api.bgm.tv `/v0/subjects/{id}` 同形**的对象。这样
 * detail.ts / search.ts 的别名回退几乎不用改解析逻辑 —— 它们拿到的字段名一样
 * （`infobox` / `name` / `images` / `rating` / `eps` / ...）。
 *
 * 谁来切：调用方在 API 抛 `RateLimitError`（熔断冷却中或刚 429）时 catch → 改调
 * 这里。**只对限流降级**，其它错误（网络/5xx）仍按错误处理（HTML 也救不了）。
 *
 * 取舍：
 *   - HTML 字段不如 JSON 干净/全（rank / votes / platform / type 多半拿不到，给默认值）。
 *     这是**降级**，不是平替 —— 冷却期能搜到、能看核心信息即可。
 *   - 解析对 BGM 页面结构有依赖（改版会失效）。所以每个字段 best-effort + 兜底，
 *     缺字段不抛错（infobox 是关键，别的能拿就拿）。
 *   - 复用 search.ts 的 bgm.tv 防御栈（BrowserSession + 2200ms limiter + 限流页检测），
 *     不另起一套，避免对 bgm.tv 也突发。
 */
import * as cheerio from 'cheerio/slim'
import { fetchHtmlWithDefenses } from './search'

/** 与 api.bgm.tv `/v0/subjects/{id}` 同形的子集（detail / 别名回退用到的字段）。 */
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

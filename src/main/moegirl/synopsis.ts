import * as https from 'https'
import * as cheerio from 'cheerio/slim'

const BASE_URL = 'https://mzh.moegirl.org.cn/'
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

const TEMPLATE_ID = 'MOE_SKIN_TEMPLATE_BODYCONTENT'
const PAGE_DATA_ID = 'MOE_SKIN_PAGE_DATA'

const CANDIDATE_SECTIONS = [
  '剧情简介',
  '故事简介',
  '剧情概要',
  '故事概要',
  '故事梗概',
  '内容简介',
  '作品简介',
  '剧情介绍',
  '简介',
]

const DROP_SELECTORS = [
  'table',
  'style',
  'script',
  '.reference',
  '.mw-editsection',
  '.navbox',
  '.infobox',
  '.toc',
  '.thumb',
  '.gallery',
  '.hatnote',
]

type CheerioAPI = ReturnType<typeof cheerio.load>
type CheerioSel = ReturnType<CheerioAPI>
type Element = { type: string; name?: string }

interface PageInfo {
  $: CheerioAPI
  root: CheerioSel
  displayTitle: string | null
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function httpsGet(url: string, timeout = 15000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      // 跟随 3xx 重定向（location 可能是相对路径）
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        httpsGet(next, timeout).then(resolve, reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({ status, body: Buffer.concat(chunks).toString('utf-8') }),
      )
    })
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
  })
}

// ── HTML 解析 ────────────────────────────────────────────────────────────────

function extractTemplateHtml(html: string): string | null {
  const re = new RegExp(
    `<template[^>]*id=["']${TEMPLATE_ID}["'][^>]*>([\\s\\S]*?)</template>`,
  )
  const m = html.match(re)
  return m ? m[1] : null
}

function tidy(text: string): string {
  return text
    .replace(/\[\s*\d+\s*\]/g, '')
    .replace(/\[\s*编辑\s*\]/g, '')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function loadMoegirlPage(html: string): PageInfo {
  const $full = cheerio.load(html)

  // displayTitle：优先 MOE_SKIN_PAGE_DATA 里的 JSON
  let displayTitle: string | null = null
  const pageDataEl = $full(`#${PAGE_DATA_ID}`)
  if (pageDataEl.length) {
    try {
      const raw = pageDataEl.text() || pageDataEl.html() || '{}'
      const data = JSON.parse(raw)
      displayTitle =
        data.displaytitle || data.wgPageName || data.wgTitle || data.title || null
    } catch { /* ignore */ }
  }
  if (!displayTitle) {
    const t = $full('title').text()
    if (t) displayTitle = t.replace(/\s*-\s*萌娘百科.*$/, '').trim() || null
  }
  if (displayTitle) displayTitle = displayTitle.replace(/<[^>]+>/g, '').trim()

  // 真正的正文在 <template> 里（Moe Skin）
  const templateHtml = extractTemplateHtml(html)
  const $body = templateHtml ? cheerio.load(templateHtml) : $full
  const rootMatch = $body('.mw-parser-output').first()
  const root = rootMatch.length ? rootMatch : $body.root()

  return { $: $body, root, displayTitle }
}

// ── 标题 / 系列页 ─────────────────────────────────────────────────────────────

function headingLevel(name: string | undefined): number | null {
  if (!name) return null
  const m = name.match(/^h([1-6])$/i)
  return m ? parseInt(m[1], 10) : null
}

function isHeadingAtOrAbove($: CheerioAPI, node: unknown, level: number): boolean {
  const el = node as Element
  if (!el || el.type !== 'tag') return false
  const lvl = headingLevel(el.name)
  if (lvl !== null) return lvl <= level
  if (el.name === 'div') {
    const cls = ($(el as never).attr('class') ?? '').split(/\s+/)
    if (cls.includes('mw-heading')) {
      const inner = $(el as never).find('h1,h2,h3,h4,h5,h6').first()
      const innerEl = inner.get(0) as Element | undefined
      if (innerEl) {
        const innerLvl = headingLevel(innerEl.name)
        if (innerLvl !== null) return innerLvl <= level
      }
    }
  }
  return false
}

function findSynopsisHeading($: CheerioAPI, root: CheerioSel): CheerioSel | null {
  const headings = root.find('h1,h2,h3,h4,h5,h6')

  for (const keyword of CANDIDATE_SECTIONS) {
    for (const h of headings.toArray()) {
      const $h = $(h as never)
      if ($h.attr('id') === keyword || $h.text().trim() === keyword) return $h
    }
  }
  for (const h of headings.toArray()) {
    const text = $(h as never).text().trim()
    if (/简介|概要|梗概/.test(text)) return $(h as never)
  }
  return null
}

function isSeriesPage($: CheerioAPI, root: CheerioSel, displayTitle: string | null): boolean {
  if (displayTitle && /系列\s*$/.test(displayTitle)) return true
  if (root.find('#系列介绍, #系列作品').length) return true

  const headings = root.find('h2,h3').toArray()
  const hasEra = headings.some((h) => {
    const $h = $(h as never)
    const id = $h.attr('id') || $h.text().trim()
    return /^第[一二三四五六七八九十百千]+代$/.test(id)
  })
  if (hasEra && !findSynopsisHeading($, root)) return true

  return false
}

function findLinkByAlias(
  $: CheerioAPI,
  root: CheerioSel,
  aliases: string[],
): string | null {
  const anchors = root.find('a[title]').toArray()
  for (const alias of aliases) {
    if (!alias) continue
    for (const a of anchors) {
      const $a = $(a as never)
      if ($a.text().trim() === alias) {
        const title = $a.attr('title')
        if (title) return title
      }
    }
  }
  return null
}

// ── 段落抽取 ────────────────────────────────────────────────────────────────

function extractFromSection($: CheerioAPI, root: CheerioSel): string | null {
  const heading = findSynopsisHeading($, root)
  if (!heading) return null

  const headingEl = heading.get(0) as Element | undefined
  if (!headingEl) return null
  const level = headingLevel(headingEl.name)
  if (level === null) return null

  const parentDiv = heading.parent('div.mw-heading')
  const start = parentDiv.length ? parentDiv : heading

  const parts: string[] = []
  start.nextAll().each((_, sib) => {
    if (isHeadingAtOrAbove($, sib, level)) return false
    const el = sib as Element
    if (el.type !== 'tag' || !el.name) return
    if (['p', 'ul', 'ol', 'blockquote'].includes(el.name)) {
      const txt = $(sib).text().trim()
      if (txt) parts.push(txt)
      return
    }
    if (el.name === 'div') {
      const cls = ($(sib).attr('class') ?? '').split(/\s+/)
      if (cls.some((c) => ['poem', 'quote', 'mw-collapsible'].includes(c))) {
        const txt = $(sib).text().trim()
        if (txt) parts.push(txt)
      }
    }
    return
  })

  return tidy(parts.join('\n\n')) || null
}

function extractLead($: CheerioAPI, root: CheerioSel): string | null {
  for (const sel of DROP_SELECTORS) {
    root.find(sel).remove()
  }
  const paragraphs: string[] = []
  root.find('p').each((_, el) => {
    if (paragraphs.length >= 3) return false
    const txt = $(el).text().trim().replace(/\s+/g, ' ')
    if (txt.length < 10) return
    paragraphs.push(txt)
    return
  })
  return tidy(paragraphs.join('\n\n')) || null
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function tryPage(title: string): Promise<PageInfo | null> {
  let res: { status: number; body: string }
  try {
    res = await httpsGet(BASE_URL + encodeURIComponent(title))
  } catch {
    return null
  }
  if (res.status === 404 || res.status >= 400 || !res.body) return null
  return loadMoegirlPage(res.body)
}

/**
 * Resolve a query to Moegirl's canonical page title via MediaWiki's opensearch
 * API. Use as a fallback when direct page lookup 404s — common causes:
 *
 *   - BGM gives `电影 LOVELIVE！...` (all-caps + full-width "！")
 *     Moegirl page lives at `电影 LoveLive!...` (mixed case + half-width "!")
 *   - BGM has `JoJo的奇妙冒险 黄金之风` but Moegirl uses `JoJo的奇妙冒险 黄金之风`
 *     with different spacing
 *
 * MediaWiki is case-sensitive past the first character AND does not normalize
 * full-width Unicode punctuation. The search API is index-backed and fuzzy on
 * both axes, so it finds the canonical title we can then re-fetch.
 *
 * Returns null on network error / empty results / parse failure — caller falls
 * through to the next candidate.
 */
async function resolveCanonicalTitle(query: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: 'opensearch',
    search: query,
    limit: '1',
    namespace: '0',
    format: 'json',
  })
  try {
    const res = await httpsGet(`${BASE_URL}api.php?${params.toString()}`, 10000)
    if (res.status !== 200 || !res.body) return null
    const data = JSON.parse(res.body)
    // opensearch contract: [searchTerm, [titles], [descriptions], [urls]]
    if (Array.isArray(data) && Array.isArray(data[1]) && data[1].length > 0) {
      const t = String(data[1][0]).trim()
      return t || null
    }
  } catch {
    /* swallow — opensearch is a best-effort fallback */
  }
  return null
}

/**
 * 从萌娘百科取剧情简介。
 *
 * 处理"bgm 标题落到系列页"的情况（例：《光之美少女》bgm id=4243，
 * 走中文名会进入《光之美少女系列》的系列介绍页而不是第一季页）：
 * 1. 候选标题依次是：中文主标题 + 传入的别名
 * 2. 如果某候选页被识别为系列页（尾缀"系列"、有系列介绍锚点、
 *    或只有代际分节而无简介分节），就在该页扫 `<a title="...">` 的链接文字，
 *    命中任一别名时把其 title 属性当作真正的条目名再跳一次
 * 3. 跳过去后再做一次正常的简介抽取
 */
export async function getMoegirlSynopsis(
  title: string,
  aliases: string[] = [],
): Promise<string | null> {
  const candidates: string[] = []
  const push = (s: string | null | undefined): void => {
    const v = (s ?? '').trim()
    if (v && !candidates.includes(v)) candidates.push(v)
  }
  push(title)
  for (const a of aliases) push(a)
  if (candidates.length === 0) return null

  const allNames = candidates.slice()

  for (const candidate of candidates) {
    // 1. Direct page lookup. Works for most well-canonicalized titles
    //    (e.g. 光之美少女, JoJo的奇妙冒险).
    let page = await tryPage(candidate)
    // 2. Opensearch fallback when direct lookup 404s. Catches casing /
    //    full-width-punctuation mismatches between BGM and Moegirl titles.
    if (!page) {
      const canonical = await resolveCanonicalTitle(candidate)
      if (canonical && canonical !== candidate) {
        page = await tryPage(canonical)
      }
    }
    if (!page) continue
    const { $, root, displayTitle } = page
    if (!root || root.length === 0) continue

    if (isSeriesPage($, root, displayTitle)) {
      const resolved = findLinkByAlias($, root, allNames)
      if (!resolved) continue

      const deeper = await tryPage(resolved)
      if (!deeper || !deeper.root || deeper.root.length === 0) continue
      if (isSeriesPage(deeper.$, deeper.root, deeper.displayTitle)) continue

      const syn = extractFromSection(deeper.$, deeper.root) ?? extractLead(deeper.$, deeper.root)
      if (syn) return syn
      continue
    }

    const syn = extractFromSection($, root) ?? extractLead($, root)
    if (syn) return syn
  }

  return null
}

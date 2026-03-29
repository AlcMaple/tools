import * as cheerio from 'cheerio/slim'
import { HttpSession } from '../shared/http-session'

const BASE_URL = 'https://dm.xifanacg.com'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_URL}/`,
}

export const xifanSession = new HttpSession('xifan', HEADERS)

export interface XifanSearchResult {
  title: string
  cover: string
  episode: string
  year: string
  area: string
  watch_url: string
  detail_url: string
}

export interface XifanSource {
  idx: number
  name: string
  template: string | null
  ep1: string
}

export interface XifanWatchInfo {
  title: string
  id: string
  total: number
  sources: XifanSource[]
}

function needsCaptcha(html: string): boolean {
  return html.includes('name="verify"') || html.includes('ds-verify-img')
}

function buildTemplate(ep1Url: string): string | null {
  const result = ep1Url.replace(/(.*?)(\d+)([^./\d]*\.[^./]+$)/, '$1{:02d}$3')
  return result.includes('{:02d}') ? result : null
}

// ── captcha ────────────────────────────────────────────────────────────────────

export async function getCaptcha(): Promise<{ image_b64: string }> {
  const res = await xifanSession.get(`${BASE_URL}/verify/index.html`)
  xifanSession.save()
  return { image_b64: res.bodyBuffer.toString('base64') }
}

// ── verify ─────────────────────────────────────────────────────────────────────

export async function verifyCaptcha(code: string): Promise<{ success: boolean }> {
  const url = `${BASE_URL}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`
  const res = await xifanSession.get(url, {
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
  })
  xifanSession.save()
  const t = res.body
  const success = t.includes('"code":1') || t.includes('成功') || t.toLowerCase().includes('"msg":"ok"')
  return { success }
}

// ── search ─────────────────────────────────────────────────────────────────────

export async function search(keyword: string): Promise<XifanSearchResult[] | { needs_captcha: true }> {
  const url = `${BASE_URL}/search.html?wd=${encodeURIComponent(keyword)}`
  const res = await xifanSession.get(url)
  xifanSession.save()

  if (needsCaptcha(res.body)) return { needs_captcha: true }

  const $ = cheerio.load(res.body)
  const results: XifanSearchResult[] = []

  $('div.row.mask2 div.vod-detail.search-list').each((_, el) => {
    const titleTag = $(el).find('h3.slide-info-title')
    const linkTag = titleTag.parent('a')
    const title = titleTag.text().trim()
    const href = linkTag.attr('href') ?? ''
    const detailUrl = href ? `${BASE_URL}${href}` : ''

    const playHref = $(el).find('div.vod-detail-bnt a.button').attr('href') ?? ''
    const watchUrl = playHref ? `${BASE_URL}${playHref}` : ''

    const cover = $(el).find('div.detail-pic img').attr('data-src') ?? ''
    const remarks: string[] = []
    $(el).find('span.slide-info-remarks').each((_, r) => { remarks.push($(r).text().trim()) })

    if (title) {
      results.push({
        title,
        cover,
        episode: remarks[0] ?? '',
        year: remarks[1] ?? '',
        area: remarks[2] ?? '',
        watch_url: watchUrl,
        detail_url: detailUrl,
      })
    }
  })

  return results
}

// ── watch ──────────────────────────────────────────────────────────────────────

interface PlayerData {
  url: string
  from: string
  id: string
  vod_data?: { vod_name?: string }
}

function parsePlayerData(html: string): PlayerData | null {
  // Try compact JSON first
  const m1 = html.match(/var player_aaaa\s*=\s*(\{.*?\})<\/script>/)
  if (m1) {
    try { return JSON.parse(m1[1]) as PlayerData } catch { /* fall through */ }
  }
  // Fall back to block parsing
  const m2 = html.match(/var player_aaaa\s*=\s*\{(.*?)\};/s)
  if (!m2) return null
  const block = m2[1]

  function getStr(key: string): string {
    const pat = new RegExp(`\\b${key}\\s*:\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's')
    const r = block.match(pat)
    if (!r) return ''
    try { return JSON.parse(`"${r[1]}"`) } catch { return r[1].replace(/\\\//g, '/') }
  }

  const vodM = block.match(/vod_data\s*:\s*\{(.*?)\}/s)
  let vodName = ''
  if (vodM) {
    const nm = vodM[1].match(/\bvod_name\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"/s)
    if (nm) { try { vodName = JSON.parse(`"${nm[1]}"`) } catch { vodName = nm[1] } }
  }

  return { url: getStr('url'), from: getStr('from'), id: getStr('id'), vod_data: { vod_name: vodName } }
}

async function fetchSourceEp1(animeId: string, sourceIdx: number): Promise<{ template: string | null; ep1: string }> {
  const url = `${BASE_URL}/watch/${animeId}/${sourceIdx}/1.html`
  try {
    const res = await xifanSession.get(url)
    const data = parsePlayerData(res.body)
    if (!data) return { template: null, ep1: '' }
    const ep1Url = decodeURIComponent(data.url)
    return { template: buildTemplate(ep1Url), ep1: ep1Url }
  } catch {
    return { template: null, ep1: '' }
  }
}

export async function watch(watchUrl: string): Promise<XifanWatchInfo> {
  const res = await xifanSession.get(watchUrl)
  xifanSession.save()
  const html = res.body

  const data = parsePlayerData(html)
  if (!data) throw new Error('Failed to parse player data')

  const animeId = data.id
  const title = data.vod_data?.vod_name ?? ''
  const ep1Url = decodeURIComponent(data.url)
  const currentFrom = data.from

  const $ = cheerio.load(html)
  let total = 1
  const activeTag = $(`a[data-form="${currentFrom}"]`)
  if (activeTag.length) {
    const badge = activeTag.find('span.badge')
    const n = parseInt(badge.text())
    if (!isNaN(n)) total = n
  }

  const sourceTags = $('div.anthology-tab.nav-swiper a.vod-playerUrl')
  const sources: XifanSource[] = []

  for (let i = 0; i < sourceTags.length; i++) {
    const tag = sourceTags.eq(i)
    const badgeText = tag.find('span.badge').text()
    const iconText = tag.find('i').text()
    const name = tag.text().replace(badgeText, '').replace(iconText, '').replace(/\u00A0/g, ' ').trim()
    const idx = i + 1

    if (idx === 1) {
      sources.push({ idx: 1, name, template: buildTemplate(ep1Url), ep1: ep1Url })
    } else {
      const { template, ep1 } = await fetchSourceEp1(animeId, idx)
      sources.push({ idx, name, template, ep1: ep1 })
    }
  }

  return { title, id: animeId, total, sources }
}

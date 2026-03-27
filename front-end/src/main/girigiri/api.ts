import * as cheerio from 'cheerio/slim'
import { HttpSession } from '../shared/http-session'

const BASE_DOMAIN = 'https://bgm.girigirilove.com'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${BASE_DOMAIN}/`,
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'max-age=0',
}

export const giriSession = new HttpSession('girigiri', HEADERS)

export interface GiriSearchResult {
  title: string
  cover: string
  year: string
  region: string
  play_url: string
}

export interface GiriEpisode {
  idx: number
  name: string
  url: string
}

export interface GiriWatchInfo {
  title: string
  episodes: GiriEpisode[]
}

function needsCaptcha(html: string): boolean {
  const indicators = ['name="verify"', 'ds-verify-img', 'verify/index.html', 'class="verify-', '滑动验证', '请完成验证']
  return indicators.some((s) => html.includes(s))
}

function resolveUrl(href: string): string {
  try { return new URL(href, BASE_DOMAIN).href } catch { return href }
}

// ── captcha ────────────────────────────────────────────────────────────────────

export async function getCaptcha(): Promise<{ image_b64: string }> {
  const url = `${BASE_DOMAIN}/verify/index.html?t=${Date.now()}`
  const res = await giriSession.get(url)
  giriSession.save()
  return { image_b64: res.bodyBuffer.toString('base64') }
}

// ── verify ─────────────────────────────────────────────────────────────────────

export async function verifyCaptcha(code: string): Promise<{ success: boolean }> {
  const url = `${BASE_DOMAIN}/index.php/ajax/verify_check?type=search&verify=${encodeURIComponent(code)}`
  const res = await giriSession.get(url, {
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  })
  giriSession.save()
  const t = res.body
  const success = ['"code":1', '成功', '"msg":"ok"', '验证通过', '验证成功'].some((s) => t.includes(s))
  return { success }
}

// ── search ─────────────────────────────────────────────────────────────────────

export async function search(keyword: string): Promise<GiriSearchResult[] | { needs_captcha: true }> {
  const url = `${BASE_DOMAIN}/search/-------------/?wd=${encodeURIComponent(keyword)}`
  const res = await giriSession.get(url)
  giriSession.save()

  if (needsCaptcha(res.body)) return { needs_captcha: true }

  const $ = cheerio.load(res.body)
  const results: GiriSearchResult[] = []
  const seen = new Set<string>()

  let items = $('div[class*="vod-item"][class*="col"], div[class^="g-movie-item"], li[class*="vod-list-item"]')
  if (!items.length) {
    items = $('div[class*="mask2"] > div[class*="vod-detail"]').first()
  }

  items.each((_, el) => {
    const link = $(el).find('a[href]').first()
    if (!link.length) return
    const href = link.attr('href') ?? ''
    const playUrl = resolveUrl(href)
    if (seen.has(playUrl)) return
    seen.add(playUrl)

    const titleTag = link.find('h3').first() || link.find('span').first() || link
    const title = titleTag.text().trim() || link.text().trim()
    if (!title) return

    const img = $(el).find('img').first()
    const cover = img.attr('data-src') ?? img.attr('src') ?? ''

    const infoText = $(el).find('div[class*="info"], span[class*="desc"], div[class*="meta"], p[class*="detail"]').text()
    const yearM = infoText.match(/(\d{4})/)
    const regionM = infoText.match(/(日本|中国|美国|韩国|国产|日漫|大陆)/)

    results.push({
      title,
      cover,
      year: yearM ? yearM[1] : '',
      region: regionM ? regionM[1] : '',
      play_url: playUrl,
    })
  })

  // Fallback: scan for /watch/ or /GV links
  if (!results.length) {
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? ''
      if (href.includes('/watch/') || href.includes('/GV')) {
        const url2 = resolveUrl(href)
        const title = $(el).text().trim()
        if (!seen.has(url2) && title) {
          seen.add(url2)
          results.push({ title, cover: '', year: '', region: '', play_url: url2 })
        }
      }
    })
  }

  return results
}

// ── watch ──────────────────────────────────────────────────────────────────────

export async function watch(playUrl: string): Promise<GiriWatchInfo> {
  const res = await giriSession.get(playUrl)
  giriSession.save()
  const $ = cheerio.load(res.body)

  let title = ''
  const h3 = $('h3.slide-info-title').first()
  if (h3.length) {
    title = h3.text().trim()
  } else {
    title = $('title').text().split('_')[0].trim()
  }

  const episodes: GiriEpisode[] = []

  $('.anthology-list-play li a').each((_, el) => {
    const idx = episodes.length + 1
    const name = $(el).text().trim() || `第${idx}集`
    const href = $(el).attr('href') ?? ''
    if (href) episodes.push({ idx, name, url: resolveUrl(href) })
  })

  if (!episodes.length) {
    const matches = res.body.matchAll(/href=["'](\/?playGV\d+-\d+-\d+\/?)['"]/g)
    let idx = 1
    for (const m of matches) {
      episodes.push({ idx, name: `第${idx}集`, url: resolveUrl(m[1]) })
      idx++
    }
  }

  return { title, episodes }
}

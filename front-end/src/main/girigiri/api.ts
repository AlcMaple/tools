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

export interface GiriSource {
  name: string
  episodes: GiriEpisode[]
}

export interface GiriWatchInfo {
  title: string
  sources: GiriSource[]
  episodes: GiriEpisode[]  // = sources[0].episodes
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
  console.log(`[girigiri:search] primary selector matched ${items.length} items`)
  if (!items.length) {
    items = $('div[class*="mask2"] > div[class*="vod-detail"]')
    console.log(`[girigiri:search] mask2 fallback matched ${items.length} items`)
  }

  const elements = items.toArray();
  for (const el of elements) {
    const link = $(el).find('a[href]').first()
    if (!link.length) continue
    const href = link.attr('href') ?? ''
    const playUrl = resolveUrl(href)
    if (seen.has(playUrl)) continue
    seen.add(playUrl)

    const titleTag = link.find('h3').first() || link.find('span').first() || link
    const title = titleTag.text().trim() || link.text().trim()
    if (!title) continue

    let img = $(el).find('img').first();
    if (!img.length) {
      img = $(el).parent().find('img').first();
    }

    if (!img.length) {
      img = link.closest('.flex, .vod-item, .g-movie-item, li').find('img').first();
    }

    const rawCover = img.attr('data-src') ?? img.attr('data-original') ?? img.attr('src') ?? '';
    let coverUrl = rawCover ? resolveUrl(rawCover) : '';

    // 如果获取到了封面链接，直接下载并转为 Base64
    let finalCover = '';
    if (coverUrl) {
      try {
        console.log(`[girigiri:search]   downloading cover for "${title}"...`);
        
        // 使用 Node 原生 fetch
        const imgRes = await fetch(coverUrl, {
          headers: {
            'Referer': BASE_DOMAIN,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        // 二进制 buffer 处理
        const arrayBuffer = await imgRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        if (buffer.length > 0) {
          finalCover = `data:image/jpeg;base64,${buffer.toString('base64')}`;
          console.log(`[girigiri:search]   cover downloaded successfully! Base64 size: ${Math.round(finalCover.length / 1024)}KB`);
        } else {
          finalCover = coverUrl;
        }
      } catch (err) {
        console.warn(`[girigiri:search]   failed to download cover for "${title}":`, err);
        finalCover = coverUrl; 
      }
    } else {
       console.warn(`[girigiri:search]   no cover URL found in DOM for "${title}"`);
    }

    const infoText = $(el).find('div[class*="info"], span[class*="desc"], div[class*="meta"], p[class*="detail"]').text()
    const yearM = infoText.match(/(\d{4})/)
    const regionM = infoText.match(/(日本|中国|美国|韩国|国产|日漫|大陆)/)

    console.log(`[girigiri:search]   card title="${title}" url=${playUrl}`)
    results.push({
      title,
      cover: finalCover, // 使用转换后的 Base64 或者是原链接
      year: yearM ? yearM[1] : '',
      region: regionM ? regionM[1] : '',
      play_url: playUrl,
    })
  }

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

  const sources: GiriSource[] = []

  // Parse structured source tabs (.anthology-tab) + matching episode boxes (.anthology-list-box)
  const $tabs = $('a.vod-playerUrl')
  const $boxes = $('.anthology-list-box')
  console.log(`[girigiri:watch] tabs=${$tabs.length} boxes=${$boxes.length} url=${playUrl}`)
  const DATA_FORM_MAP: Record<string, string> = { cht: '繁中', chs: '简中' }
  if ($tabs.length > 0 && $boxes.length > 0) {
    $tabs.each((i, tab) => {
      const dataForm = $(tab).attr('data-form') ?? ''
      const sourceName = DATA_FORM_MAP[dataForm] || $(tab).clone().find('.badge').remove().end().text().trim() || `片源${i + 1}`
      const eps: GiriEpisode[] = []
      $boxes.eq(i).find('ul.anthology-list-play li a').each((_, el) => {
        const href = $(el).attr('href') ?? ''
        if (!href) return
        const idx = eps.length + 1
        const epName = $(el).find('span').first().text().trim() || $(el).text().trim() || `第${idx}集`
        eps.push({ idx, name: epName, url: resolveUrl(href) })
      })
      console.log(`[girigiri:watch]   source[${i}] data-form="${dataForm}" name="${sourceName}" eps=${eps.length}`)
      sources.push({ name: sourceName, episodes: eps })
    })
  }

  // Fallback: single source from common selectors
  if (sources.every((s) => s.episodes.length === 0)) {
    sources.length = 0
    const fallbackEps: GiriEpisode[] = []
    const EP_CONTAINERS = ['.anthology-list-play', 'div[class*="anthology"]', 'div[class*="episode-list"]']
    for (const sel of EP_CONTAINERS) {
      const $container = $(sel).first()
      if (!$container.length) continue
      let $bestUl = $container.find('ul').first()
      let bestCount = $bestUl.find('li a[href]').length
      $container.find('ul').each((_, ul) => {
        const count = $(ul).find('li a[href]').length
        if (count > bestCount) { bestCount = count; $bestUl = $(ul) }
      })
      $bestUl.find('li a').each((_, el) => {
        const href = $(el).attr('href') ?? ''
        if (!href) return
        const idx = fallbackEps.length + 1
        fallbackEps.push({ idx, name: $(el).text().trim() || `第${idx}集`, url: resolveUrl(href) })
      })
      if (fallbackEps.length) break
    }
    if (!fallbackEps.length) {
      const matches = res.body.matchAll(/href=["']([^"']*(?:play|GV)[^"']*\d+[^"']*)['"]/g)
      const seen = new Set<string>()
      let idx = 1
      for (const m of matches) {
        const url2 = resolveUrl(m[1])
        if (!seen.has(url2)) { seen.add(url2); fallbackEps.push({ idx, name: `第${idx}集`, url: url2 }); idx++ }
      }
    }
    if (fallbackEps.length) sources.push({ name: '默认片源', episodes: fallbackEps })
  }

  if (!sources.length) {
    console.warn('[girigiri:watch] 0 episodes parsed. URL:', playUrl)
    console.warn('[girigiri:watch] body snippet:', res.body.slice(0, 2000))
  }

  return { title, sources, episodes: sources[0]?.episodes ?? [] }
}

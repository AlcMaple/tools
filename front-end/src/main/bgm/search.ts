import * as https from 'https'
import * as cheerio from 'cheerio/slim'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const BASE_URL = 'https://bgm.tv/subject_search/{keyword}?cat=2&page={page}'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}
const PAGE_DELAY_MS = 1000

export interface BgmSearchResult {
  title: string
  date: string
  rate: string
  link: string
}

function getCacheDir(): string {
  return join(app.getPath('userData'), 'bgm_cache')
}

function safeName(keyword: string): string {
  return keyword.replace(/[\\/:*?"<>|]/g, '_')
}

function getCachePath(keyword: string, page: number): string {
  return join(getCacheDir(), `${safeName(keyword)}_${page}.html`)
}

async function initCache(): Promise<void> {
  await fs.mkdir(getCacheDir(), { recursive: true })
}

async function readCache(keyword: string, page: number): Promise<string | null> {
  const p = getCachePath(keyword, page)
  if (existsSync(p)) {
    return fs.readFile(p, 'utf-8')
  }
  return null
}

async function saveCache(html: string, keyword: string, page: number): Promise<void> {
  await fs.writeFile(getCachePath(keyword, page), html, 'utf-8')
}

function parseTotalPages(html: string): number {
  const $ = cheerio.load(html)
  const pageNums: number[] = []
  $('#multipage a.p').each((_, el) => {
    const href = $(el).attr('href') ?? ''
    const m = href.match(/page=(\d+)/)
    if (m) pageNums.push(parseInt(m[1]))
  })
  return pageNums.length > 0 ? Math.max(...pageNums) : 1
}

function parseDate(text: string): { dateObj: Date; dateStr: string } {
  let m: RegExpMatchArray | null

  m = text.match(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?/)
  if (m) {
    const y = parseInt(m[1])
    const mo = parseInt(m[2])
    const d = m[3] ? parseInt(m[3]) : 1
    return { dateObj: new Date(y, mo - 1, d), dateStr: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  }

  m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) {
    const [y, mo, d] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])]
    return { dateObj: new Date(y, mo - 1, d), dateStr: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
  }

  m = text.match(/(\d{4})/)
  if (m) {
    return { dateObj: new Date(parseInt(m[1]), 0, 1), dateStr: `${m[1]}-01-01` }
  }

  return { dateObj: new Date(0), dateStr: '未知日期' }
}

function parsePage(
  html: string,
  keyword: string
): Array<BgmSearchResult & { dateObj: Date }> {
  const $ = cheerio.load(html)
  const results: Array<BgmSearchResult & { dateObj: Date }> = []

  $('#browserItemList li.item').each((_, el) => {
    const a = $(el).find('h3 > a.l')
    if (!a.length) return

    const title = a.text().trim()
    if (!title.includes(keyword)) return

    const infoText = $(el).find('p.info.tip').text().trim()
    const { dateObj, dateStr } = parseDate(infoText)
    const rate = $(el).find('p.rateInfo small.fade').text().trim() || 'N/A'
    const href = a.attr('href') ?? ''

    results.push({
      title,
      date: dateStr,
      dateObj,
      rate,
      link: href.startsWith('http') ? href : `https://bgm.tv${href}`
    })
  })

  return results
}

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

async function fetchPage(
  keyword: string,
  page: number,
  update: boolean
): Promise<string | null> {
  if (!update) {
    const cached = await readCache(keyword, page)
    if (cached) return cached
  }

  const url = BASE_URL.replace('{keyword}', encodeURIComponent(keyword)).replace(
    '{page}',
    String(page)
  )

  try {
    const html = await httpsGet(url)
    await saveCache(html, keyword, page)
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS))
    return html
  } catch {
    return null
  }
}

export async function searchBgm(
  keyword: string,
  update = false
): Promise<BgmSearchResult[]> {
  await initCache()

  const html1 = await fetchPage(keyword, 1, update)
  if (!html1) return []

  const totalPages = parseTotalPages(html1)
  const page1Items = parsePage(html1, keyword)
  if (page1Items.length === 0) return []

  const allItems = [...page1Items]

  for (let page = 2; page <= totalPages; page++) {
    const html = await fetchPage(keyword, page, update)
    if (!html) continue

    const items = parsePage(html, keyword)
    if (items.length === 0) break

    allItems.push(...items)
  }

  // 去重 + 按日期排序
  const seen = new Set<string>()
  const deduped = allItems.filter((x) => {
    if (seen.has(x.title)) return false
    seen.add(x.title)
    return true
  })

  deduped.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime())

  return deduped.map(({ title, date, rate, link }) => ({ title, date, rate, link }))
}

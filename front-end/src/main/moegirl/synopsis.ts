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
type Element = { type: string; name?: string }

function httpsGet(url: string, timeout = 15000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        }),
      )
    })
    req.setTimeout(timeout, () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
  })
}

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
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

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

function findSynopsisHeading(
  $: CheerioAPI,
  root: ReturnType<CheerioAPI>,
): ReturnType<CheerioAPI> | null {
  const headings = root.find('h1,h2,h3,h4,h5,h6')

  for (const keyword of CANDIDATE_SECTIONS) {
    for (const h of headings.toArray()) {
      const $h = $(h as never)
      if ($h.attr('id') === keyword || $h.text().trim() === keyword) {
        return $h
      }
    }
  }

  for (const h of headings.toArray()) {
    const text = $(h as never).text().trim()
    if (/简介|概要|梗概/.test(text)) return $(h as never)
  }

  return null
}

function extractFromSection(
  $: CheerioAPI,
  root: ReturnType<CheerioAPI>,
): string | null {
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

function extractLead($: CheerioAPI, root: ReturnType<CheerioAPI>): string | null {
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

export async function getMoegirlSynopsis(title: string): Promise<string | null> {
  const t = title.trim()
  if (!t) return null

  let status = 0
  let body = ''
  try {
    const res = await httpsGet(BASE_URL + encodeURIComponent(t))
    status = res.status
    body = res.body
  } catch {
    return null
  }
  if (status === 404 || status >= 400 || !body) return null

  const templateHtml = extractTemplateHtml(body)
  const htmlForParse = templateHtml ?? body
  const $ = cheerio.load(htmlForParse)
  const rootMatch = $('.mw-parser-output').first()
  const scope = rootMatch.length ? rootMatch : $.root()

  return extractFromSection($, scope) ?? extractLead($, scope)
}

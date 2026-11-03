// 接单评估的材料与网址处理：限额、前置判断、网页摘要。纯函数，网页服务端、浏览器和桌面端共用。

export const MAX_IMAGES = 40 // 单次最多发多少张图，控制费用
export const MAX_LINKS = 10 // 每单最多打开几个网址
export const SAME_SITE_GAP_MS: [number, number] = [3000, 5000] // 同一网站两次打开之间随机等待
export const VIDEO_FRAMES = 12
export const MAX_DOC_CHARS = 20000

// 发请求之前就能下结论的两种情况：什么都没放；只有微信多选复制出来的「[聊天记录]」占位符。
export type Precheck = 'empty' | 'chat-record'

export function precheck(text: string, imageCount: number): Precheck | null {
  if (imageCount > 0) return null
  if (!text.trim()) return 'empty'
  if (text.includes('[聊天记录]') || text.includes('[聊天記錄]')) return 'chat-record'
  return null
}

// ── 派单里的网址 ──

const URL_RE = /https?:\/\/[\w\-./?=&%#:+~@!,;]+/g

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])].slice(0, MAX_LINKS)
}

// 同一网站按顺序打开（中间随机等几秒，像人手动点开），不同网站同时打开
export function groupByHost(urls: string[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const u of urls) {
    let host = u
    try { host = new URL(u).hostname } catch { /* 解析不了就自成一组 */ }
    groups.set(host, [...(groups.get(host) ?? []), u])
  }
  return [...groups.values()]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function htmlToText(raw: string): string {
  const body = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  return unescapeHtml(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

// 腾讯文档表格：单元格文字以 URL 编码的去重碎片（flyweight texts）藏在页面脚本里，取出来当参考
function docFragments(raw: string): string {
  const m = /%22flyweight%22:%7B%22texts%22:%5B(.*?)%5D/.exec(raw) ?? /"flyweight":\{"texts":\[(.*?)\]/.exec(raw)
  if (!m) return ''
  let texts: unknown
  try {
    texts = JSON.parse('[' + decodeURIComponent(m[1]) + ']')
  } catch {
    return ''
  }
  if (!Array.isArray(texts)) return ''
  const joined = texts.filter((t): t is string => typeof t === 'string' && !!t.trim()).join(' / ')
  return '\n在线表格的文字碎片（只含首屏部分数据，单元格被拆碎、顺序可能打乱，只用来了解表格主题；'
    + '具体内容以截图为准，如果没有截图且需求依赖表格细节，在 questions 里请客户提供表格截图）：\n' + joined.slice(0, 3000)
}

export function pageDigest(url: string, raw: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  return `[${url}]\n标题：${title ? unescapeHtml(title[1].trim()) : ''}\n${htmlToText(raw).slice(0, 1500)}` + docFragments(raw)
}

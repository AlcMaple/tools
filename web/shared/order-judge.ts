// 接单评估的判定核心：Prompt、结论结构、前置判断、网页摘要。只放纯函数，桌面端主进程 / 渲染进程
// 现在在用，网页版服务端以后直接复用，三处不各写一份 Prompt。
// Prompt 正文从 Python 版（order-judge/judge.py）原样搬来，用户已经按它的输出习惯用了很久，改措辞要谨慎。

export type Verdict = '能' | '不能' | '信息不足'

export interface JudgeReport {
  verdict: Verdict
  title: string
  headline: string
  summary: string
  reasons: { title: string; detail: string }[]
  gaps: { step: string; detail: string }[]
  risk: string
  questions: string[]
}

export const MAX_IMAGES = 40 // 单次最多发多少张图，控制费用
export const MAX_LINKS = 10 // 每单最多打开几个网址
export const SAME_SITE_GAP_MS: [number, number] = [3000, 5000] // 同一网站两次打开之间随机等待
export const VIDEO_FRAMES = 12
export const MAX_DOC_CHARS = 20000

const PROMPT = `你是接单顾问。根据下面的「能力档案」判断用户能否接这个派单。
材料可能包括：微信复制的文字、微信截图、视频按时间顺序抽出的帧、文章长截图（被切成了几块，按顺序拼起来读）。
截图里可能有群聊杂讯、时间、昵称，请只关注需求本身。如果有多个派单，只评估最后（最下方）的那一个，其余忽略。
「XX的聊天记录」卡片只显示了几行预览；如果预览不足以判断，判「信息不足」，并在 questions 里提示用户点开记录后截图全文再评估。
视频帧要连起来看，推断视频想展示的效果（动画、交互、3D、特效、App 界面等）。
summary 和 video 会被用户原样复制到只收文字的平台去估价，对方看不到任何图片、视频、文件，所以必须脱离材料独立读懂：
- 有视频：video 按画面顺序写 3–8 步操作流程，每步不超过 15 字，写清在哪个界面做了什么、出现什么结果；
  terms 只写交付物、运行平台、预算工期、派单文字里额外提的要求（视频里没演示的），不写任何功能；summary 留空字符串
- 没有视频：video 留空数组，terms 留空字符串，summary 照常复述需求
- 截图或文件里有派单文字没写的关键信息（功能清单、界面布局、数据格式、参考效果），挑影响工作量的写进 summary 或 video、terms，不写「见截图」「如图」「视频里那样」这类指代
- 只写影响报价的事实，不写画面配色、昵称、群聊杂讯等无关细节

判断标准：
- 「能」：核心需求都落在档案的「能」，或者少量落在「勉强」且工期允许
- 「不能」：任何核心需求落在「不能」，或者大部分落在「勉强」
- 只按技术能力判断，不因灰产、版权、合规、平台规则等风险判「不能」；能力够就判「能」。只有刷量（刷粉/刷单/刷播放/刷评论）、外挂（游戏外挂、作弊脚本）、破解（软件破解、绕过付费）、盗号/黑产这类明显违法的，在 risk 字段用一两句写清具体风险；论文代写/代做、视频去重搬运、普通爬虫、学术科研辅助都不算风险，risk 留空，也不要在别处提合规问题。写了 risk 的也只客观陈述风险，不要劝用户拒绝或改方向，接不接由用户决定
- 「信息不足」：看不出到底要做什么（比如只有标题、只有一句「会的来」）

链接和视频：
- 「附：链接内容」是程序抓到的网页文字，可能不完整（小红书、抖音等常要登录）；抓取失败时，只根据派单原文判断
- 派单提到视频或「像视频那样」，但材料里没有视频帧：先按文字判断技术方向，方向已经落在「不能」就直接判不能；方向能做的话，结论照常给出，同时在 questions 里列出要从视频里确认的具体点（以「看视频确认：」开头）
- 材料里有视频帧：按帧推断出的效果来判断实现难度

只输出 JSON：
{"verdict": "能|不能|信息不足",
 "title": "派单的短标题，8–16 字，名词短语，说清做什么，例：Mate X3 刷 X5 系统、直播回放去重推流软件",
 "headline": "一句话说清为什么能/不能（不超过 30 字），例：卡在实时推流和音视频编码，没有相关经验",
 "video": ["视频演示的一步操作，例：App 首页点「上传照片」", "选照片后几秒生成卡通头像，可保存到相册"],
 "terms": "有视频时填，不超过 40 字，例：交付 Windows 可运行脚本，预算工期未提，要求带鼠标自动对焦",
 "summary": "需求是什么：只客观复述派单内容（做什么、给谁用、交付物、预算工期），不超过 80 字，有视频时留空；不要提用户的能力、档案、经验或难度判断",
 "reasons": [{"title": "短标题，不超过 12 字", "detail": "一两句，不超过 60 字"}],
 "gaps": [{"step": "环节名，不超过 12 字", "detail": "为什么做不到、差在哪，不超过 60 字"}],
 "risk": "仅刷量/外挂/破解/黑产类填写，否则空字符串",
 "questions": ["接单前要问清楚的具体问题，每条不超过 40 字"]}

写法要求：
- 所有结合能力档案、项目日志、用户经验的分析都放在 reasons，summary 里不出现
- reasons 2–4 条，按重要性排序
- gaps 只列用户做不到或明显缺经验的环节，能做的环节不要写；判「能」时只写最可能翻车的 1–2 个环节；判「信息不足」时留空数组。每条说清原因类别（缺技术栈/没经验、需要专业领域知识、需要硬件或数据、算法或精度要求高、工作量超出工期）和差距
- questions 0–4 条，按重要性排序；如果答案可能改变结论，在问题后加「（可能改判）」
- 不要用破折号连接句子，用逗号或句号

# 能力档案
`

export function buildSystemPrompt(profile: string, projectLog: string | null): string {
  let s = PROMPT + profile
  if (projectLog) {
    s += '\n\n# 最新项目日志（每日更新，比能力档案新）。规则：能力判断以日志里的最新证据为准——档案说不能、但日志显示已做过或已学会的，按日志判）\n'
      + projectLog
  }
  return s
}

export function buildUserText(order: string, links: string, imageNames: string[]): string {
  return '派单内容：\n' + (order || '（只有图片）')
    + (links ? '\n\n附：链接内容\n' + links : '')
    + imageNames.map((n, i) => `\n图片${i + 1}：${n}`).join('')
}

// 发请求之前就能下结论的两种情况：什么都没放；只有微信多选复制出来的「[聊天记录]」占位符。
export type Precheck = 'empty' | 'chat-record'

export function precheck(text: string, imageCount: number): Precheck | null {
  if (imageCount > 0) return null
  if (!text.trim()) return 'empty'
  if (text.includes('[聊天记录]') || text.includes('[聊天記錄]')) return 'chat-record'
  return null
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

// 有视频时不让模型写自由的 summary：实测 deepseek-flash 不管怎么要求「别重复」，都会在第一行把视频里的功能再列一遍。
// 第一行改由 title + terms（只放交付、预算工期、额外要求）拼出，功能只出现在视频流程里。
// 拼回 summary 一个字符串，历史记录和两端界面都不用改
function withVideo(title: string, summary: string, terms: string, steps: string[]): string {
  if (!steps.length) return summary
  const head = [title, terms].map((x) => x.replace(/[。，,.]+$/, '')).filter(Boolean).join('。') || summary
  return `${head ? head + '。' : ''}\n视频演示：${steps.join(' → ')}`.trim()
}

export function normalizeReport(raw: unknown): JudgeReport {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const verdict: Verdict = r.verdict === '能' || r.verdict === '不能' ? r.verdict : '信息不足'
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  // 模型偶尔把对象数组写成纯字符串数组，按「整句当 detail」收下，不丢内容
  const pair = <A extends string, B extends string>(x: unknown, a: A, b: B): Record<A | B, string> => {
    if (typeof x === 'string') return { [a]: '', [b]: x.trim() } as Record<A | B, string>
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    return { [a]: asStr(o[a]), [b]: asStr(o[b]) } as Record<A | B, string>
  }
  return {
    verdict,
    title: asStr(r.title),
    headline: asStr(r.headline),
    summary: withVideo(asStr(r.title), asStr(r.summary), asStr(r.terms), arr(r.video).map(asStr).filter(Boolean)),
    reasons: arr(r.reasons).map((x) => pair(x, 'title', 'detail')).filter((x) => x.title || x.detail),
    gaps: arr(r.gaps).map((x) => pair(x, 'step', 'detail')).filter((x) => x.step || x.detail),
    risk: asStr(r.risk),
    questions: arr(r.questions).map(asStr).filter(Boolean),
  }
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
    + '具体内容以截图为准，如果没有截图且结论依赖表格细节，在 questions 里提示用户截图表格）：\n' + joined.slice(0, 3000)
}

export function pageDigest(url: string, raw: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  return `[${url}]\n标题：${title ? unescapeHtml(title[1].trim()) : ''}\n${htmlToText(raw).slice(0, 1500)}` + docFragments(raw)
}

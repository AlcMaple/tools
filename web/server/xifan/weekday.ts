// 稀饭「追番周表」抓取 —— 免验证码拿到「本季在播番剧 → 稀饭 animeId」的唯一途径。
//
// 为什么是它：稀饭的搜索页 /search.html 有验证码，我们过不了（也不该去破）；而周表页背后的数据接口
// POST /index.php/ds_api/weekday **不设验证码**，塞一个中文星期（一/二/…/日）就回那一天的番单，每条带
//   vod_id（= animeId）、vod_name（中文名）、url（/watch/{id}/1/1.html）、vod_remarks（"03|周一21:30" = 更新到第几集）。
// 「继续看」的绑定（bgmId → animeId）就靠把追番标题拿到这里比中文名匹配（见 locate.ts）。
//
// 抓法克制（CLAUDE.md 网络红线）：7 天**顺序**抓、天与天之间抖动歇一下（不并发＝不像爬虫），抓到的整体
// 缓存 6h。单天失败就跳过，不重试、不让整体失败 —— 能匹配多少算多少。
import '../http' // 副作用导入：让 undici fetch 认 HTTPS_PROXY（本地 Clash 非 TUN 时用）
import { BASE_URL, DESKTOP_UA } from './resolve'

export interface WeekItem {
  xifanId: number
  name: string
  day: number // 1-7
  remarks: string // 如 "03|周一21:30"，用来判断更新到第几集
}

// index 0..6 → day 1..7；接口收的是中文星期，跟周表页 tab 的 data-val 一致。
const CN_DAYS = ['一', '二', '三', '四', '五', '六', '日']

interface RawItem {
  vod_id?: number
  vod_name?: string
  url?: string
  vod_remarks?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function fetchDay(day: number): Promise<WeekItem[]> {
  const res = await fetch(`${BASE_URL}/index.php/ds_api/weekday`, {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', // 该接口只认 AJAX 请求（网页就这么发的），少了它拿不到数据
      Referer: `${BASE_URL}/index.php/label/weekday.html`,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    body: new URLSearchParams({ weekday: CN_DAYS[day - 1] }).toString(),
    signal: AbortSignal.timeout(12000),
  })
  const data = (await res.json().catch(() => null)) as { code?: number; list?: RawItem[] } | null
  if (!data || Number(data.code) !== 1 || !Array.isArray(data.list)) return []
  const out: WeekItem[] = []
  for (const it of data.list) {
    // vod_id 优先；缺了就从 url /watch/{id}/… 抠出来兜底
    const id = Number(it.vod_id) || Number(it.url?.match(/\/watch\/(\d+)\//)?.[1])
    if (!id) continue
    out.push({ xifanId: id, name: String(it.vod_name ?? '').trim(), day, remarks: String(it.vod_remarks ?? '') })
  }
  return out
}

// 进程内缓存 6h —— 周表一季度才换、更新集数按天走，6h 够新鲜；也把 7 次请求摊薄到 6h 一轮。
let cache: { items: WeekItem[]; at: number } | null = null
const TTL = 6 * 60 * 60 * 1000

export async function fetchWeekday(): Promise<WeekItem[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.items
  const all: WeekItem[] = []
  for (let day = 1; day <= 7; day++) {
    try {
      all.push(...(await fetchDay(day)))
    } catch {
      /* 单天失败跳过 —— 不重试、不整体失败 */
    }
    if (day < 7) await sleep(150 + Math.floor(Math.random() * 150)) // 抖动歇一下，别像爬虫连发
  }
  // 全 7 天都空（接口改版 / 被拦）→ 不写缓存，留给下次重试，别把一个空结果焊死 6h
  if (all.length) cache = { items: all, at: Date.now() }
  return all
}

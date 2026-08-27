// Girigiri 番剧周期表 —— 官方首页/周期表页通过 POST /index.php/ds_api/weekday 取数据，免验证码。
// 这里和稀饭的周表定位保持同一条产品语义：只用来给 bgmId 找候选，绝不因为模糊命中自动建绑定。
import { proxyReady } from '../http'
import { BASE_URL, GIRIGIRI_UA } from './resolve'

export interface WeekItem {
  girigiriId: string
  name: string
  day: number
  remarks: string
}

const CN_DAYS = ['一', '二', '三', '四', '五', '六', '日']
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface RawItem {
  url?: string
  vod_id?: number
  vod_name?: string
  vod_remarks?: string
}

async function fetchDay(day: number): Promise<WeekItem[]> {
  const response = await fetch(`${BASE_URL}/index.php/ds_api/weekday`, {
    method: 'POST',
    headers: {
      'User-Agent': GIRIGIRI_UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BASE_URL}/index.php/label/weekday.html`,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    body: new URLSearchParams({ weekday: CN_DAYS[day - 1] }).toString(),
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error(`Girigiri 周表请求失败：服务器返回 HTTP ${response.status}`)
  const data = (await response.json().catch(() => null)) as { code?: unknown; list?: RawItem[] } | null
  if (!data || Number(data.code) !== 1 || !Array.isArray(data.list)) return []

  const out: WeekItem[] = []
  for (const item of data.list) {
    const fromUrl = item.url?.match(/\/play(GV\d+)-/i)?.[1]
    const numericId = Number(item.vod_id)
    const id = (fromUrl || (numericId > 0 ? `GV${numericId}` : '')).toUpperCase()
    if (!/^GV\d+$/.test(id)) continue
    out.push({
      girigiriId: id,
      name: String(item.vod_name ?? '').trim(),
      day,
      remarks: String(item.vod_remarks ?? ''),
    })
  }
  return out
}

let cache: { items: WeekItem[]; at: number } | null = null
const TTL = 6 * 60 * 60 * 1000

export async function fetchWeekday(): Promise<WeekItem[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.items
  await proxyReady
  const all: WeekItem[] = []
  for (let day = 1; day <= 7; day++) {
    try {
      all.push(...(await fetchDay(day)))
    } catch {
      // 单天失败不影响其余天；全部为空时不写缓存，给下一次调用留下恢复机会。
    }
    if (day < 7) await sleep(150 + Math.floor(Math.random() * 150))
  }
  if (all.length) cache = { items: all, at: Date.now() }
  return all
}

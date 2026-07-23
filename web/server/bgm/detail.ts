// BGM 条目详情 —— 只为「加追番时回填标签 / 别名 / 放送日期」而存在。
//
// 为什么非要多这一次请求：周历接口（/calendar）**不返标签，也不返别名**，只有条目详情有。
// 没有它，「按类型过滤」永远是空的、「搜索别名」也搜不到（搜「猫と竜」找不到《猫与龙》）。
// app 那边同理，做法见 animeTrackStore.ensureBgmTagsFilled——这里是它的服务端版。
//
// 注意 **不取总集数**：周历的 eps 恒为 0（实测本季 112 部全是 0），而 app 的既定语义是
// `totalEpisodes == null` 就是「连载中」、由用户手填（app 的 setTotalEpisodes 是 BGM eps=0
// 时的逃生通道）。这里跟着 app 走，不自作主张去补一个数。
import { fetchJson } from '../http'

const BGM_HEADERS = {
  'User-Agent': 'MapleTools-Web/0.1 (https://github.com/AlcMaple/tools)',
  Accept: 'application/json',
}

export interface SubjectDetail {
  tags: string[]
  aliases: string[]
  date: string
  cover: string // BGM 图床封面 URL（lain.bgm.tv/...）；离线档没有封面，靠这里补
}

/** infobox 里的「别名」条目 —— 值可能是字符串，也可能是 [{k,v}] 列表 */
function aliasesFromInfobox(infobox: unknown): string[] {
  if (!Array.isArray(infobox)) return []
  const out: string[] = []
  for (const rawItem of infobox) {
    const item = rawItem as { key?: unknown; value?: unknown }
    if (item.key !== '别名') continue
    if (typeof item.value === 'string') out.push(item.value)
    else if (Array.isArray(item.value)) {
      for (const rawV of item.value) {
        const v = (rawV as { v?: unknown }).v
        if (typeof v === 'string' && v.trim()) out.push(v.trim())
      }
    }
  }
  return out
}

// timeoutMs 可调：加追番时**同步**取详情用短超时（默认给 4s），别让 BGM 抖动把
// 「追番」按钮的响应卡住；后台延迟兜底（fillDetailLater）仍用宽松的 10s。
export async function fetchSubjectDetail(bgmId: number, timeoutMs = 10000): Promise<SubjectDetail> {
  const raw = (await fetchJson(`https://api.bgm.tv/v0/subjects/${bgmId}`, {
    headers: BGM_HEADERS,
    timeoutMs,
  })) as Record<string, unknown>

  // tags 是 [{name, count}]，按 count 已倒序；跟 app 一样只留前 4 个
  //（BGM_TAG_LIMIT——再多卡片一行放不下，而且长尾标签没有过滤价值）
  const tags = Array.isArray(raw.tags)
    ? (raw.tags as { name?: unknown }[])
        .map((t) => (typeof t.name === 'string' ? t.name : ''))
        .filter(Boolean)
        .slice(0, 4)
    : []

  // 封面：images.large / .common 任一（都是 lain.bgm.tv 图床，前端 coverUrl() 会改写成 /api/cover 代理）
  const images = (raw.images ?? {}) as Record<string, unknown>
  const cover = ['large', 'common', 'medium'].map((k) => images[k]).find((v): v is string => typeof v === 'string' && !!v) ?? ''

  return {
    tags,
    aliases: aliasesFromInfobox(raw.infobox),
    date: typeof raw.date === 'string' ? raw.date : '',
    cover,
  }
}

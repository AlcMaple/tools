// 网页播放器的跨站源切换上下文。
//
// 稀饭 animeId 与 Girigiri GV id 不能互相推断；播放页只携带稳定的 bgmId，
// 这里分别查两张绑定表，再生成保持同一集数的站内播放页地址（合集条目按各自偏移换算）。视频与线路解析仍由
// 各自原有播放器负责，本模块不接触媒体字节。
import { getBinding as getGirigiriBinding } from './girigiri/bindings'
import { getBinding as getXifanBinding } from './xifan/bindings'

export type WebPlayerSource = 'xifan' | 'girigiri'

export interface WebPlayerSourceOption {
  key: WebPlayerSource
  label: string
  active: boolean
  href: string | null
}

export function parsePlayerBgmId(value: string | undefined): number | null {
  if (value == null || value === '') return null
  if (!/^[1-9]\d*$/.test(value)) return null
  const bgmId = Number(value)
  return Number.isSafeInteger(bgmId) ? bgmId : null
}

function playPageHref(source: WebPlayerSource, sourceId: number | string, ep: number, bgmId: number | null): string {
  const query = new URLSearchParams({ src: source, id: String(sourceId), ep: String(ep) })
  if (bgmId != null) query.set('bgmId', String(bgmId))
  return `/api/player/page?${query.toString()}`
}

// 当前源条目若是合集，追番集数 = 源站集数 - 偏移；只认 URL 里正在播的那个条目，绑定换了就不套旧偏移
export function playerEpOffset(active: WebPlayerSource, activeSourceId: number | string, bgmId: number | null): number {
  if (bgmId == null) return 0
  if (active === 'xifan') {
    const b = getXifanBinding(bgmId)
    return b && b.xifanId === Number(activeSourceId) ? b.epOffset : 0
  }
  const b = getGirigiriBinding(bgmId)
  return b && b.girigiriId === String(activeSourceId).toUpperCase() ? b.epOffset : 0
}

export function playerSourceOptions(
  active: WebPlayerSource,
  activeSourceId: number | string,
  ep: number,
  bgmId: number | null,
): WebPlayerSourceOption[] {
  const xifanBinding = bgmId == null ? null : getXifanBinding(bgmId)
  const girigiriBinding = bgmId == null ? null : getGirigiriBinding(bgmId)
  // 新绑定的候选行会在原生链接打开新标签的同时异步落库。当前源因此以 URL 里的
  // 已校验 id 为准，避免新标签抢先读取绑定表时把正在播放的源误标成“未关联”。
  const xifanId = active === 'xifan' ? Number(activeSourceId) : xifanBinding?.xifanId
  const girigiriId = active === 'girigiri' ? String(activeSourceId).toUpperCase() : girigiriBinding?.girigiriId
  // 两站可能一边是单部、一边是合集，换源时先还原成这部番自己的集数再套对方的偏移
  const ownEp = ep - playerEpOffset(active, activeSourceId, bgmId)
  const epFor = (source: WebPlayerSource, offset: number | undefined): number =>
    source === active ? ep : Math.max(1, ownEp + (offset ?? 0))

  const options: WebPlayerSourceOption[] = [
    {
      key: 'xifan',
      label: '稀饭',
      active: active === 'xifan',
      href: Number.isInteger(xifanId) && Number(xifanId) > 0
        ? playPageHref('xifan', Number(xifanId), epFor('xifan', xifanBinding?.epOffset), bgmId)
        : null,
    },
    {
      key: 'girigiri',
      label: 'Girigiri',
      active: active === 'girigiri',
      href: typeof girigiriId === 'string' && /^GV\d+$/.test(girigiriId)
        ? playPageHref('girigiri', girigiriId, epFor('girigiri', girigiriBinding?.epOffset), bgmId)
        : null,
    },
  ]
  // 旧书签没有 bgmId，无法判断另一站是否已关联；只显示当前源，不能把“上下文未知”
  // 错写成“未关联”。从追番页新开的链接都会携带 bgmId 并显示完整两源。
  return bgmId == null ? options.filter((option) => option.active) : options
}

/** 放进 nonce 内联脚本前再转义 `<`，即使未来 label 变成外部数据也不能闭合 script。 */
export function serializePlayerSources(options: WebPlayerSourceOption[]): string {
  return JSON.stringify(options).replaceAll('<', '\\u003c')
}

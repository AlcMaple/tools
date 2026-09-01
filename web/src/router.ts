// 极简 hash 路由 —— 网页版只有少量固定页面，为此引 react-router 不划算（YAGNI），
// 但也不能只用 state：那样地址栏不变，设置页刷新就回周历、也收藏不了。hash 路由 20 行拿到真实 URL。
import { useEffect, useState } from 'react'

export type Route = 'calendar' | 'settings' | 'tracks' | 'rewards' | 'community'

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (h === 'settings' || h.startsWith('settings/')) return 'settings'
  if (h === 'rewards') return 'rewards'
  if (h === 'community' || h.startsWith('community/')) return 'community'
  // hash 是站内页面的明确选择，必须先于 `/u/:username` 的 pathname 判断。
  // 否则 `/u/foo#/tracks` 会被误判成公开用户页。
  if (h === 'tracks') return 'tracks'
  if (window.location.pathname === '/u' || window.location.pathname.startsWith('/u/')) return 'community'
  return 'calendar'
}

export function navigate(r: Route): void {
  // 从 `/u/:username` 切回站内功能时，同时回到根路径；只改 hash 会把公开用户路径
  // 留在地址栏，随后 `#/` 又会被识别成该用户页。
  const hash = r === 'calendar' ? '#/' : `#/${r}`
  const onPublicProfilePath = window.location.pathname === '/u' || window.location.pathname.startsWith('/u/')
  if (onPublicProfilePath) {
    window.history.pushState(null, '', `/${hash}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    return
  }
  if (window.location.hash === hash) {
    window.dispatchEvent(new PopStateEvent('popstate'))
    return
  }
  window.location.hash = hash
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const onHash = (): void => setRoute(parse())
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [])
  return route
}

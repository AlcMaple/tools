// 极简 hash 路由 —— 网页版目前只有两个页面（周历 / 设置），为此引 react-router 不划算（YAGNI），
// 但也不能只用 state：那样地址栏不变，设置页刷新就回周历、也收藏不了。hash 路由 20 行拿到真实 URL。
import { useEffect, useState } from 'react'

export type Route = 'calendar' | 'settings' | 'tracks'

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '')
  return h === 'settings' || h === 'tracks' ? h : 'calendar'
}

export function navigate(r: Route): void {
  // 周历是首页 → 清掉 hash，别让地址栏挂个 #/calendar
  window.location.hash = r === 'calendar' ? '' : `/${r}`
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse)
  useEffect(() => {
    const onHash = (): void => setRoute(parse())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

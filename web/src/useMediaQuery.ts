import { useEffect, useState } from 'react'

// 与 app 的 useIsCompact 同口径：<1200px 走「选天 + 多列网格」的精简布局，
// ≥1200px 走桌面 7 列整周一览。
export function useIsCompact(): boolean {
  const query = '(max-width: 1199px)'
  const [match, setMatch] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = (): void => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return match
}

// 手帐骨架的分界线（书脊 ↔ 顶栏+底部标签 同一条）：≥961px 桌面态。
// 周历横向布局在宽屏显示整周、窄屏保留日期章选天；另一种纵向布局由页面开关控制。
export function useIsWide(): boolean {
  const query = '(min-width: 961px)'
  const [match, setMatch] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = (): void => setMatch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return match
}

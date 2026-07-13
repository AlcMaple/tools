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

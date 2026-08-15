// 动漫查询页顶部的 BGM 在线登录状态小组件。
// 默认搜索使用本地数据；只有用户主动在线搜索时登录态才相关。挂载时仅读取本地状态，
// 真正的登录和重新校验都由用户点击触发。

import { useEffect, useState } from 'react'
import type { BgmAuthStatus } from '../types/bgm'
import { getCachedAuth, setCachedAuth } from '../utils/bgmAuth'

export function BgmLoginChip(): JSX.Element | null {
  const [auth, setAuth] = useState<BgmAuthStatus | null>(getCachedAuth())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const s = await window.bgmApi.authStatus().catch(() => null)
      if (!alive || !s) return
      setCachedAuth(s)
      setAuth(s)
    })()
    return () => { alive = false }
  }, [])

  const refreshCache = (next: BgmAuthStatus): void => {
    setCachedAuth(next)
    setAuth(next)
  }

  const login = async (): Promise<void> => {
    setBusy(true)
    try { refreshCache(await window.bgmApi.login()) }
    finally { setBusy(false) }
  }
  const recheck = async (): Promise<void> => {
    setBusy(true)
    try { refreshCache(await window.bgmApi.verifyLogin()) }
    finally { setBusy(false) }
  }

  // 状态未知(首帧)先不占位
  if (!auth && !busy) return null

  if (busy) {
    return (
      <span className="inline-flex items-center gap-1 font-label text-[11px] text-on-surface-variant/50">
        <span className="material-symbols-outlined leading-none animate-spin" style={{ fontSize: 14 }}>sync</span>
        BGM 处理中…
      </span>
    )
  }

  if (auth?.loggedIn) {
    // 已登录:低调显示,点一下可手动复验
    return (
      <button
        onClick={() => { void recheck() }}
        className="inline-flex items-center gap-1 font-label text-[11px] text-on-surface-variant/45 hover:text-primary transition-colors"
        title="BGM 在线搜索已登录。点击重新校验是否过期。"
        type="button"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>check_circle</span>
        BGM 在线已登录
      </button>
    )
  }

  // 未登录 / 已过期:醒目提示 + 就地登录
  return (
    <button
      onClick={() => { void login() }}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary font-label text-[11px] transition-colors"
      title="BGM 在线搜索尚未登录。点击登录可减少等待。"
      type="button"
    >
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 15 }}>login</span>
      BGM 在线未登录 · 点击登录
    </button>
  )
}

// 动漫查询页顶部的 BGM 登录状态小组件。
//
// 为什么放这儿:BGM 匿名搜索会被故意拖慢(~16s),登录态则 ~0.6s 秒回。登录态会
// 过期,但状态以前只藏在设置里,用户没有理由天天开设置 → 过期了也不知道。这里
// 在「进入动漫查询 tab 时」就地显示状态,过期/未登录直接给登录按钮,免去翻设置。
//
// 进 tab 自动校验一次(带 cookie 拉首页看 /logout,见主进程 verifyBgmLogin)。
// 校验结果用模块级缓存兜 5 分钟,避免频繁切 tab 反复打扰 BGM。

import { useEffect, useState } from 'react'
import type { BgmAuthStatus } from '../types/bgm'
import { needsAutoVerify, getCachedAuth, setCachedAuth } from '../utils/bgmAuth'

export function BgmLoginChip(): JSX.Element | null {
  const [auth, setAuth] = useState<BgmAuthStatus | null>(getCachedAuth())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      // 8 点边界缓存内已查过 → 直接用,不再打扰 BGM(见 utils/bgmAuth)
      if (!needsAutoVerify()) {
        setAuth(getCachedAuth())
        return
      }
      const s = await window.bgmApi.authStatus().catch(() => null)
      if (!alive || !s) return
      setAuth(s)
      // 显示已登录的话再主动校验一次,确认没过期(过期主进程会清 cookie 并回落)
      const fresh = s.loggedIn
        ? await window.bgmApi.verifyLogin().catch(() => s)
        : s
      if (!alive) return
      setCachedAuth(fresh)
      setAuth(fresh)
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
        title="BGM 已登录(搜索走登录态、秒回)。点击重新校验是否过期。"
        type="button"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 14 }}>check_circle</span>
        BGM 已登录
      </button>
    )
  }

  // 未登录 / 已过期:醒目提示 + 就地登录
  return (
    <button
      onClick={() => { void login() }}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary font-label text-[11px] transition-colors"
      title="未登录时 BGM 会把搜索拖慢到十几秒。点此登录,搜索即可秒回。"
      type="button"
    >
      <span className="material-symbols-outlined leading-none" style={{ fontSize: 15 }}>login</span>
      BGM 未登录 · 点此登录提速
    </button>
  )
}

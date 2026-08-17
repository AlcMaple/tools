// 密保提示条 —— 注册表单只有「用户名 + 密码 + 确认」，密保是之后在设置里设的。没有密保、也没有已验证邮箱的
// 用户彻底找不回密码，号和追番数据就永久丢了。已定的处理方式是「不强制、
// 登录后给一条不烦人的提示引导」。
//
// 只在「用户名密码账号 + 没有其它恢复凭据 + 本次会话没关掉」时出现。邮箱验证码账号不依赖密码，
// 也不能进入账号安全模块。关掉只存 sessionStorage：下次开浏览器还会提醒，但同一次浏览里不会反复烦人。
// 皮肤 = 原型稿 .nag（便签感警示条）。
import { useState } from 'react'
import { useAuth } from './auth'
import { Ic } from './SketchIcon'

const DISMISS_KEY = 'mt-nag-security-dismissed'

export function NagBar({ onGoSettings }: { onGoSettings: () => void }): JSX.Element | null {
  const { user } = useAuth()
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1')

  if (!user || !user.hasPassword || user.hasSecurity || user.hasEmail || dismissed) return null

  return (
    <div className="nag">
      <Ic name="alert" cls="ic" />
      <span>账号还没有设置密保问题，找回密码会少一条路</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onGoSettings}>
        去设置
      </button>
      <button
        type="button"
        className="nag-x"
        title="本次浏览不再提醒"
        aria-label="关闭提醒"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, '1')
          setDismissed(true)
        }}
      >
        <Ic name="x" cls="ic ic-sm" />
      </button>
    </div>
  )
}

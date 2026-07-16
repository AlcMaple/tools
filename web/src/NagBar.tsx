// 密保提示条 —— 注册表单只有「用户名 + 密码 + 确认」，密保是之后在设置里设的，所以**没设密保的
// 用户彻底找不回密码**（没邮箱、没别的凭证），号和追番数据就永久丢了。已定的处理方式是「不强制、
// 登录后给一条不烦人的提示引导」（见 ideas/012）。
//
// 只在「已登录 + 没设密保 + 本次会话没关掉」时出现。关掉只存 sessionStorage：下次开浏览器还会提醒，
// 毕竟真丢号是不可逆的；但同一次浏览里不会反复烦人。
import { useState } from 'react'
import { useAuth } from './auth'
import { Icon } from './Icon'

const DISMISS_KEY = 'mt-nag-security-dismissed'

export function NagBar({ onGoSettings }: { onGoSettings: () => void }): JSX.Element | null {
  const { user } = useAuth()
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1')

  if (!user || user.hasSecurity || dismissed) return null

  return (
    <div className="flex items-center gap-2.5 border-b border-primary/20 bg-primary/10 px-4 py-2 text-xs text-primary md:px-6">
      <Icon name="shield" size={15} className="shrink-0" />
      <span className="flex-1">
        你还没设置密保问题 —— <b>一旦忘记密码将无法找回账号</b>。
      </span>
      <button
        type="button"
        onClick={onGoSettings}
        className="shrink-0 rounded border border-primary/40 bg-primary/10 px-2.5 py-0.5 font-label text-[11px] font-bold text-primary"
      >
        去设置
      </button>
      <button
        type="button"
        title="本次浏览不再提醒"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, '1')
          setDismissed(true)
        }}
        className="shrink-0 px-1 text-primary/60 hover:text-primary"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

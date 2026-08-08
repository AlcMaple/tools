// B 站短信登录弹窗 —— 与扫码登录是两个独立入口，不在扫码弹窗里嵌 tab / 链接。
// 协议状态照搬 Biu：手机号 → 极验 + 发短信 → captcha flow → 6 位码登录。
import { useEffect, useRef, useState } from 'react'
import { ModalButton, ModalShell } from '../pages/homework/shared'
import { ipcErrMsg } from '../utils/ipcError'

const PHONE_CN = /^1\d{10}$/
const SMS_CODE = /^\d{6}$/

type Busy = 'idle' | 'sending' | 'logging-in'

const inputClass = 'w-full bg-surface-container border border-outline-variant/20 rounded-lg px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/35 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all'

function digits(raw: string, max: number): string {
  return raw.replace(/\D/g, '').slice(0, max)
}

export default function BiliSmsLoginModal({
  onClose,
  onLoggedIn,
}: {
  onClose: () => void
  onLoggedIn: () => void
}): JSX.Element {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [flowId, setFlowId] = useState('')
  const [sentPhone, setSentPhone] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [busy, setBusy] = useState<Busy>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  const updatePhone = (raw: string): void => {
    const next = digits(raw, 11)
    setPhone(next)
    setError('')
    if (sentPhone && next !== sentPhone) {
      setFlowId('')
      setSentPhone('')
      setCode('')
      setCountdown(0)
      setNotice('手机号已变更,请重新获取验证码')
    }
  }

  const sendCode = async (): Promise<void> => {
    if (!PHONE_CN.test(phone)) {
      setError('请输入正确的中国大陆手机号')
      return
    }

    setBusy('sending')
    setError('')
    setNotice('')
    try {
      const result = await window.biliApi.sendSms(phone)
      if (result.cancelled) {
        setNotice('已取消安全验证')
        return
      }
      setFlowId(result.flowId)
      setSentPhone(phone)
      setCode('')
      setCountdown(60)
      setNotice(`验证码已发送至 +86 ${phone.slice(0, 3)}****${phone.slice(-4)}`)
      window.setTimeout(() => codeRef.current?.focus())
    } catch (err) {
      setError(ipcErrMsg(err, '验证码发送失败'))
    } finally {
      setBusy('idle')
    }
  }

  const login = async (): Promise<void> => {
    if (!flowId) {
      setError('请先获取验证码')
      return
    }
    if (!SMS_CODE.test(code)) {
      setError('请输入 6 位短信验证码')
      return
    }

    setBusy('logging-in')
    setError('')
    try {
      const result = await window.biliApi.loginSms(flowId, code)
      if (result.loggedIn) {
        onLoggedIn()
        onClose()
      }
    } catch (err) {
      setError(ipcErrMsg(err, '短信登录失败'))
    } finally {
      setBusy('idle')
    }
  }

  const isBusy = busy !== 'idle'

  return (
    <ModalShell onBackdrop={isBusy ? () => undefined : onClose}>
      <form
        className="p-6"
        onSubmit={(event) => {
          event.preventDefault()
          if (!isBusy) void login()
        }}
      >
        <div className="flex items-center gap-2 text-on-surface">
          <span className="material-symbols-outlined leading-none text-primary" style={{ fontSize: 20 }}>sms</span>
          <h3 className="font-headline text-base font-bold">短信登录 B 站</h3>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-2 block font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50">
              手机号
            </span>
            <div className="flex rounded-lg bg-surface-container focus-within:ring-2 focus-within:ring-primary/40">
              <span className="flex shrink-0 items-center border border-r-0 border-outline-variant/20 px-3 font-label text-xs text-on-surface-variant/70">
                +86
              </span>
              <input
                autoFocus
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={phone}
                onChange={(event) => updatePhone(event.target.value)}
                placeholder="请输入手机号"
                className={`${inputClass} rounded-l-none focus:ring-0`}
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-2 block font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50">
              短信验证码
            </span>
            <div className="flex items-stretch gap-2">
              <input
                ref={codeRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => { setCode(digits(event.target.value, 6)); setError('') }}
                placeholder="6 位验证码"
                className={inputClass}
              />
              <button
                type="button"
                disabled={isBusy || countdown > 0}
                onClick={() => { void sendCode() }}
                className="min-w-[112px] shrink-0 rounded-lg border border-primary/35 bg-primary/10 px-3 font-label text-xs font-bold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy === 'sending' ? '安全验证中…' : countdown > 0 ? `${countdown}s` : '获取验证码'}
              </button>
            </div>
          </label>

          {/* 常驻反馈位：错误 / 已发送状态切换时不推挤输入框和页脚。 */}
          <div className="min-h-5" aria-live="polite">
            {error ? (
              <p className="font-label text-[11px] text-error">{error}</p>
            ) : notice ? (
              <p className="font-label text-[11px] text-primary/80">{notice}</p>
            ) : (
              <p className="font-label text-[11px] text-on-surface-variant/45">获取验证码前需要完成一次滑块验证</p>
            )}
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <ModalButton type="button" variant="cancel" disabled={isBusy} onClick={onClose}>关闭</ModalButton>
          <ModalButton type="submit" variant="primary" disabled={isBusy || !flowId || code.length !== 6}>
            {busy === 'logging-in' ? '登录中…' : '登录'}
          </ModalButton>
        </div>
      </form>
    </ModalShell>
  )
}

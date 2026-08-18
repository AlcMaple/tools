// 登录 / 注册 / 邮箱验证码登录 / 找回密码 弹窗 —— 皮肤 = 原型稿 .auth-dlg：
// 左侧纱雾立绘栏（halftone 网点渐隐）+ 右侧稿纸表单；「密码登录 / 验证码登录」页签，
// 注册 / 找回由底部链接进入；Google 品牌按钮在表单下方（或分隔线隔开）。
// 逻辑与旧版一致：邮箱验证码确认地址后新旧账号都直接登录；找回 = 账号 + 密保问题 + 答案 + 新密码×2；
// Enter 提交、ESC / 背景 / × 关闭；第三方入口按服务端配置显示（未配凭据整体不出现）。
import { useEffect, useRef, useState } from 'react'
import { auth, fetchOauthProviders, fetchQuestions } from './auth'
import type { SecurityQuestion } from './auth'
import { Ic } from './SketchIcon'
import { PasswordInput } from './PasswordInput'
import { Select } from './Select'

export type AuthMode = 'login' | 'register' | 'email' | 'forgot'

const TITLE: Record<AuthMode, string> = { login: '登录', register: '注册', email: '邮箱验证码登录', forgot: '找回密码' }

const QUICK_EMAIL_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'qq.com',
  '163.com',
  '126.com',
  'foxmail.com',
  'icloud.com',
] as const

type InboxLink = { text: string; href: string }

function inboxLinkFor(address: string): InboxLink | null {
  const domain = address.trim().split('@').pop()?.toLowerCase()
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { text: '打开 Gmail 查收验证码', href: 'https://mail.google.com/' }
  }
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com') {
    return { text: '打开 Outlook 查收验证码', href: 'https://outlook.live.com/mail/0/' }
  }
  // foxmail 的收件箱就是 QQ 邮箱网页版；icloud 走自家邮件入口。
  if (domain === 'qq.com' || domain === 'foxmail.com') {
    return { text: '打开 QQ 邮箱查收验证码', href: 'https://mail.qq.com/' }
  }
  if (domain === '163.com') return { text: '打开 163 邮箱查收验证码', href: 'https://mail.163.com/' }
  if (domain === '126.com') return { text: '打开 126 邮箱查收验证码', href: 'https://mail.126.com/' }
  if (domain === 'yeah.net') return { text: '打开 Yeah 邮箱查收验证码', href: 'https://mail.yeah.net/' }
  if (domain === 'icloud.com') return { text: '打开 iCloud 邮箱查收验证码', href: 'https://www.icloud.com/mail' }
  return null
}

export function AuthModal({
  open,
  mode,
  onMode,
  onClose,
  presetError = null,
}: {
  open: boolean
  mode: AuthMode
  onMode: (m: AuthMode) => void
  onClose: () => void
  /** 打开弹窗时就带上的错误（如第三方登录回调失败回跳后由 App 传入）。 */
  presetError?: string | null
}): JSX.Element | null {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [emailStep, setEmailStep] = useState<'address' | 'code'>('address')
  const [emailChallengeId, setEmailChallengeId] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailCooldown, setEmailCooldown] = useState(0)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [questions, setQuestions] = useState<SecurityQuestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [googleEnabled, setGoogleEnabled] = useState(false)
  const userRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  const isReg = mode === 'register'
  const isForgot = mode === 'forgot'
  const isEmail = mode === 'email'

  useEffect(() => {
    if (!open) return
    setUsername('')
    setEmail('')
    setEmailStep('address')
    setEmailChallengeId('')
    setEmailCode('')
    setEmailCooldown(0)
    setPassword('')
    setConfirm('')
    setQuestionId('')
    setAnswer('')
    setError(presetError)
    setOkMsg(null)
    setSubmitting(false)
    userRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    setError(null)
    setOkMsg(null)
    if (mode === 'email') {
      setEmailStep('address')
      setEmailChallengeId('')
      setEmailCode('')
      setEmailCooldown(0)
    }
  }, [mode])

  useEffect(() => {
    if (!emailCooldown) return
    const timer = window.setInterval(() => setEmailCooldown((n) => Math.max(0, n - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [emailCooldown])

  useEffect(() => {
    if (isForgot && questions.length === 0) {
      void fetchQuestions().then(setQuestions).catch(() => undefined)
    }
  }, [isForgot, questions.length])

  // 第三方入口按服务端配置显示：未配凭据就不出现，本地和线上行为一致。
  useEffect(() => {
    if (!open || isForgot) return
    let alive = true
    void fetchOauthProviders()
      .then((r) => {
        if (alive) setGoogleEnabled(r.google)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, isForgot])

  if (!open) return null

  const useEmailDomain = (domain: string): void => {
    const raw = email.trim()
    const at = raw.indexOf('@')
    const local = (at < 0 ? raw : raw.slice(0, at)).trim()
    const next = `${local}@${domain}`
    setEmail(next)
    window.requestAnimationFrame(() => {
      const input = emailRef.current
      if (!input) return
      input.focus()
      const cursor = local ? next.length : 0
      input.setSelectionRange(cursor, cursor)
    })
  }

  const inboxLink = emailStep === 'code' ? inboxLinkFor(email) : null

  // 整页跳转授权 —— 回来后会话 cookie 已就位，auth.init() 恢复登录态；前端不经手任何令牌。
  const startGoogleLogin = (): void => {
    const url = new URL(window.location.href)
    url.searchParams.delete('oauth')
    window.location.href = `/api/auth/oauth/google/start?returnTo=${encodeURIComponent(
      url.pathname + url.search + url.hash,
    )}`
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    if (isEmail && emailStep === 'address') {
      setSubmitting(true)
      try {
        const result = await auth.requestEmailCode(email.trim())
        setEmailChallengeId(result.challengeId)
        setEmailStep('code')
        setEmailCooldown(60)
        setOkMsg('验证码已发送，请检查邮箱')
      } catch (err) {
        setError(err instanceof Error ? err.message : '验证码发送失败，请稍后再试')
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (isEmail && emailStep === 'code') {
      setSubmitting(true)
      try {
        await auth.verifyEmailCode(emailChallengeId, emailCode.trim())
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : '验证码校验失败，请重试')
      } finally {
        setSubmitting(false)
      }
      return
    }
    if ((isReg || isForgot) && password !== confirm) {
      setError(isForgot ? '两次输入的新密码不一致' : '两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    try {
      if (isReg) {
        await auth.register(username.trim(), password, confirm)
        onClose()
      } else if (isForgot) {
        await auth.forgot({
          username: username.trim(),
          questionId,
          answer,
          newPassword: password,
          confirm,
        })
        // 重置成功不自动登录 —— 让用户拿新密码走正常登录，也顺带确认自己记住了
        setOkMsg('密码已重置，请用新密码登录')
        setTimeout(() => onMode('login'), 1200)
      } else {
        await auth.login(username.trim(), password)
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '出错了，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const resendCode = async (): Promise<void> => {
    setError(null)
    setSubmitting(true)
    try {
      const result = await auth.requestEmailCode(email.trim())
      setEmailChallengeId(result.challengeId)
      setEmailCooldown(60)
      setOkMsg('新的验证码已发送')
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败，请稍后再试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="登录 MapleTools" className="dlg auth-dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <aside className="auth-side">
          <span className="halftone-wash" />
          <img src="/assets/sagiri-full.webp" alt="和泉纱雾 · 官方立绘" />
          <p className="auth-side-cap">「才、才不是在等你登录……」</p>
        </aside>

        <div className="auth-main">
          {!isReg && !isForgot ? (
            <div className="auth-tabs">
              <button
                type="button"
                className={`auth-tab${mode === 'login' ? ' on' : ''}`}
                onClick={() => onMode('login')}
              >
                密码登录
              </button>
              <button
                type="button"
                className={`auth-tab${mode === 'email' ? ' on' : ''}`}
                onClick={() => onMode('email')}
              >
                验证码登录
              </button>
            </div>
          ) : (
            <div className="auth-head font-hand">{TITLE[mode]}</div>
          )}

          <form onSubmit={submit} className="auth-pane show">
            {isEmail ? (
              <>
                <label className="field">
                  <span className="field-label">邮箱</span>
                  <span className="field-row">
                    <input
                      ref={emailRef}
                      type="text"
                      inputMode="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                      autoFocus={emailStep === 'address'}
                      disabled={emailStep !== 'address'}
                    />
                  </span>
                </label>
                {emailStep === 'address' && (
                  <div className="mail-chips" role="group" aria-label="快捷补全邮箱后缀">
                    {QUICK_EMAIL_DOMAINS.map((domain) => (
                      <button
                        key={domain}
                        type="button"
                        className="tagx"
                        onClick={() => useEmailDomain(domain)}
                      >
                        @{domain}
                      </button>
                    ))}
                  </div>
                )}
                {emailStep !== 'address' && (
                  <button
                    type="button"
                    className="link mail-swap"
                    onClick={() => {
                      setEmailStep('address')
                      setEmailChallengeId('')
                      setEmailCode('')
                      setError(null)
                      setOkMsg(null)
                    }}
                  >
                    更换邮箱
                  </button>
                )}

                {emailStep === 'code' && (
                  <label className="field">
                    <span className="field-label">邮箱验证码</span>
                    <span className="field-row">
                      <input
                        type="text"
                        className="has-tail"
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="邮件里的 6 位数字"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        autoFocus
                      />
                      <button
                        type="button"
                        className={`tail-btn send${emailCooldown > 0 ? ' counting' : ''}`}
                        disabled={submitting || emailCooldown > 0}
                        onClick={() => void resendCode()}
                      >
                        {emailCooldown > 0 ? `${emailCooldown}s 后重发` : '重新发送'}
                      </button>
                    </span>
                  </label>
                )}
                <p className="faint small mt8">验证码 10 分钟内有效 · 新邮箱验证后自动注册</p>
                {inboxLink && (
                  <a
                    className="link mt8"
                    style={{ display: 'inline-block' }}
                    href={inboxLink.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    {inboxLink.text}
                  </a>
                )}
              </>
            ) : (
              <>
                <label className="field">
                  <span className="field-label">{isForgot ? '要找回的账号' : '用户名'}</span>
                  <span className="field-row">
                    {/* 新流程只提示用户名；登录态仍容纳历史「邮箱 + 密码」账号的长标识。 */}
                    <input
                      ref={userRef}
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder={isForgot ? '你的用户名' : '用户名'}
                      maxLength={mode === 'login' ? 254 : 12}
                      autoComplete="username"
                    />
                  </span>
                </label>

                {isForgot && (
                  <>
                    <div className="field">
                      <span className="field-label">密保问题</span>
                      <Select
                        options={questions}
                        value={questionId}
                        onChange={setQuestionId}
                        placeholder="请选择你设置的问题…"
                      />
                    </div>
                    <label className="field">
                      <span className="field-label">答案</span>
                      <span className="field-row">
                        <input
                          type="text"
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                          placeholder="当年写下的答案"
                        />
                      </span>
                    </label>
                  </>
                )}

                <label className="field">
                  <span className="field-label">{isForgot ? '新密码' : '密码'}</span>
                  <PasswordInput
                    value={password}
                    onChange={setPassword}
                    placeholder={isForgot ? '设置新密码' : '输入密码'}
                    autoComplete={isReg || isForgot ? 'new-password' : 'current-password'}
                  />
                  {(isReg || isForgot) && <span className="field-hint">至少 6 位</span>}
                </label>

                {(isReg || isForgot) && (
                  <label className="field">
                    <span className="field-label">{isForgot ? '确认新密码' : '确认密码'}</span>
                    <PasswordInput
                      value={confirm}
                      onChange={setConfirm}
                      placeholder="再输一次密码"
                      autoComplete="new-password"
                    />
                  </label>
                )}
              </>
            )}

            {(error || okMsg) && (
              <p className={`form-note${error ? ' err' : ''}`} aria-live="polite">
                {error || okMsg}
              </p>
            )}

            <button type="submit" disabled={submitting} className="btn btn-primary btn-block mt8">
              {submitting
                ? '请稍候…'
                : isEmail
                  ? emailStep === 'address' ? '发送验证码' : '验证并登录'
                  : isForgot
                    ? '重置密码'
                    : isReg
                      ? '注册'
                      : '登录'}
            </button>

            <div className="auth-foot">
              {mode === 'login' && (
                <>
                  <button type="button" className="link" onClick={() => onMode('register')}>
                    注册新账号
                  </button>
                  <button type="button" className="link" onClick={() => onMode('forgot')}>
                    忘记密码
                  </button>
                </>
              )}
              {isReg && (
                <button type="button" className="link" onClick={() => onMode('login')}>
                  已有账号？去登录
                </button>
              )}
              {isForgot && (
                <button type="button" className="link" onClick={() => onMode('login')}>
                  想起来了？去登录
                </button>
              )}
            </div>
          </form>

          {googleEnabled && !isForgot && (
            <>
              <div className="or-line mt8" aria-hidden="true">
                或
              </div>
              <button type="button" className="btn btn-google btn-block mt16" onClick={startGoogleLogin}>
                <Ic name="google" cls="ic" />
                使用 Google 继续
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

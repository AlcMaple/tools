// 登录 / 注册 / 邮箱验证码登录 / 找回密码 弹窗 —— 压在暗化的周历上，MD3 卡片。
// 登录：用户名 + 密码（带「忘记密码？」入口）；注册：多一个确认密码；
// 邮箱：验证码确认地址后，无论新旧账号都直接登录，不额外收集用户名或密码。
// 找回密码：账号 + 密保问题（预设下拉）+ 答案 + 新密码 + 确认。
// Enter 提交、ESC / 背景 / × 关闭。
import { useEffect, useRef, useState } from 'react'
import { auth, fetchQuestions } from './auth'
import type { SecurityQuestion } from './auth'
import { Icon } from './Icon'
import { Select } from './Select'

export type AuthMode = 'login' | 'register' | 'email' | 'forgot'

const TITLE: Record<AuthMode, string> = { login: '登录', register: '注册', email: '邮箱验证码登录', forgot: '找回密码' }

const QUICK_EMAIL_DOMAINS = ['gmail.com', 'outlook.com', 'qq.com', '163.com'] as const

type InboxLink = { text: string; href: string }

function inboxLinkFor(address: string): InboxLink | null {
  const domain = address.trim().split('@').pop()?.toLowerCase()
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { text: '打开 Gmail 查收验证码', href: 'https://mail.google.com/' }
  }
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com') {
    return { text: '打开 Outlook 查收验证码', href: 'https://outlook.live.com/mail/0/' }
  }
  if (domain === 'qq.com') return { text: '打开 QQ 邮箱查收验证码', href: 'https://mail.qq.com/' }
  if (domain === '163.com') return { text: '打开 163 邮箱查收验证码', href: 'https://mail.163.com/' }
  if (domain === '126.com') return { text: '打开 126 邮箱查收验证码', href: 'https://mail.126.com/' }
  if (domain === 'yeah.net') return { text: '打开 Yeah 邮箱查收验证码', href: 'https://mail.yeah.net/' }
  return null
}

export function AuthModal({
  open,
  mode,
  onMode,
  onClose,
}: {
  open: boolean
  mode: AuthMode
  onMode: (m: AuthMode) => void
  onClose: () => void
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
    setError(null)
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-5 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative m-auto w-full max-w-[366px] rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="absolute right-3.5 top-3.5 flex h-6 w-6 items-center justify-center rounded text-on-surface-variant/50 transition-colors hover:bg-surface-container-high hover:text-on-surface"
        >
          <Icon name="close" size={16} />
        </button>

        <div className="font-label text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
          MapleTools
        </div>
        <h2 className="mb-4 mt-1.5 text-lg font-extrabold text-on-surface">{TITLE[mode]}</h2>

        {!isForgot && !isEmail && (
          <div className="mb-4 grid grid-cols-2 gap-1.5 rounded-md bg-surface-container p-1">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onMode(m)}
                className={`rounded border py-1.5 text-sm font-semibold transition-colors ${
                  mode === m
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-transparent text-on-surface-variant/70 hover:text-on-surface'
                }`}
              >
                {m === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit}>
          {isEmail ? (
            <>
              <Field label="邮箱地址">
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
                  className={inputCls}
                />
                {emailStep === 'address' && (
                  <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="快捷补全邮箱后缀">
                    {QUICK_EMAIL_DOMAINS.map((domain) => (
                      <button
                        key={domain}
                        type="button"
                        onClick={() => useEmailDomain(domain)}
                        className="rounded border border-outline-variant/25 bg-surface-container px-2 py-1 font-label text-[10px] text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary"
                      >
                        @{domain}
                      </button>
                    ))}
                  </div>
                )}
                {emailStep !== 'address' && (
                  <button
                    type="button"
                    onClick={() => {
                      setEmailStep('address')
                      setEmailChallengeId('')
                      setEmailCode('')
                      setError(null)
                      setOkMsg(null)
                    }}
                    className="mt-1.5 font-label text-[10px] font-semibold text-primary hover:underline"
                  >
                    更换邮箱
                  </button>
                )}
              </Field>

              {emailStep === 'code' && (
                <Field label="邮箱验证码">
                  <input
                    type="text"
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="输入 6 位验证码"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    className={inputCls}
                  />
                  <div className="mt-1.5 flex items-center justify-between gap-3">
                    <Hint>验证码 10 分钟内有效</Hint>
                    <button
                      type="button"
                      disabled={submitting || emailCooldown > 0}
                      onClick={async () => {
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
                      }}
                      className="shrink-0 font-label text-[10px] font-semibold text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {emailCooldown > 0 ? `${emailCooldown}s 后重发` : '重新发送'}
                    </button>
                  </div>
                  {inboxLink && (
                    <a
                      href={inboxLink.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                      className="mt-2 inline-flex font-label text-[10px] font-semibold text-primary hover:underline"
                    >
                      {inboxLink.text}
                    </a>
                  )}
                </Field>
              )}

            </>
          ) : (
            <>
              <Field label={isForgot ? '登录账号' : '用户名'}>
                {/* 新流程只提示用户名；登录态仍容纳历史「邮箱 + 密码」账号的长标识。 */}
                <input
                  ref={userRef}
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={isForgot ? '你的用户名' : '用户名'}
                  maxLength={mode === 'login' ? 254 : 12}
                  autoComplete="username"
                  className={inputCls}
                />
              </Field>

              {isForgot && (
                <>
                  <Field label="找回密码问题">
                    <Select
                      options={questions}
                      value={questionId}
                      onChange={setQuestionId}
                      placeholder="请选择你设置的问题…"
                    />
                  </Field>
                  <Field label="找回密码答案">
                    <input
                      type="text"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      placeholder="输入你的答案"
                      className={inputCls}
                    />
                  </Field>
                </>
              )}

              <Field label={isForgot ? '新密码' : '密码'}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isForgot ? '设置新密码' : '输入密码'}
                  autoComplete={isReg || isForgot ? 'new-password' : 'current-password'}
                  className={inputCls}
                />
                {(isReg || isForgot) && <Hint>至少 6 位</Hint>}
              </Field>

              {(isReg || isForgot) && (
                <Field label={isForgot ? '确认新密码' : '确认密码'}>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="再输一次密码"
                    autoComplete="new-password"
                    className={inputCls}
                  />
                </Field>
              )}
            </>
          )}

          {mode === 'login' && (
            // 报错跟「忘记密码」挤在同一行（左提示 / 右入口）而不是自己占一行：
            // 这一行在登录态恒存在，报错只是填进它的空位，提交按钮不会被顶下去。
            // 登录态只可能出 error，okMsg 是找回密码专属，两者不会在这撞车。
            <div className="-mt-2 mb-3 flex items-center justify-between gap-3">
              <p className="font-label text-[11px] text-error">{error}</p>
              <button
                type="button"
                onClick={() => onMode('forgot')}
                className="shrink-0 font-label text-[11.5px] font-semibold text-primary hover:underline"
              >
                忘记密码？
              </button>
            </div>
          )}

          {isEmail ? (
            <div className="custom-scrollbar mb-3 h-9 overflow-y-auto" aria-live="polite">
              {(error || okMsg) && (
                <p className={`font-label text-[11px] ${error ? 'text-error' : 'text-primary'}`}>
                  {error || okMsg}
                </p>
              )}
            </div>
          ) : mode !== 'login' && error ? (
            <p className="mb-3 font-label text-[11px] text-error">{error}</p>
          ) : null}
          {!isEmail && okMsg && <p className="mb-3 font-label text-[11px] text-primary">{okMsg}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-0.5 w-full rounded-lg bg-primary py-2.5 text-sm font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting
              ? '请稍候…'
              : isEmail
                ? emailStep === 'address' ? '发送验证码' : '验证码登录'
                : isForgot
                  ? '重 置 密 码'
                  : isReg
                    ? '注 册'
                    : '登 录'}
          </button>
        </form>

        {!isForgot && !isEmail && (
          <button
            type="button"
            onClick={() => onMode('email')}
            className="mt-3 w-full rounded-lg border border-outline-variant/30 py-2 font-label text-[11px] font-semibold tracking-wider text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary"
          >
            使用邮箱验证码登录
          </button>
        )}

        <div className="mt-3.5 text-center font-label text-xs text-on-surface-variant/60">
          {isEmail ? '想用用户名和密码？' : isForgot ? '想起来了？' : isReg ? '已有账号？' : '还没有账号？'}
          <button
            type="button"
            onClick={() => onMode(isEmail || isForgot || isReg ? 'login' : 'register')}
            className="font-semibold text-primary hover:underline"
          >
            {isEmail ? '去登录' : isForgot ? '回去登录' : isReg ? '去登录' : '去注册'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-outline-variant/30 bg-surface-container-high px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70'

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-3.5">
      <label className="mb-1.5 block font-label text-[10px] uppercase tracking-wider text-on-surface-variant/80">
        {label}
      </label>
      {children}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">{children}</p>
}

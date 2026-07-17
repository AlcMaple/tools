// 登录 / 注册 / 找回密码 弹窗 —— 压在暗化的周历上，MD3 卡片。
// 登录：用户名 + 密码（带「忘记密码？」入口）；注册：多一个确认密码；
// 找回密码：账号 + 密保问题（预设下拉）+ 答案 + 新密码 + 确认。
// Enter 提交、ESC / 背景 / × 关闭。
import { useEffect, useRef, useState } from 'react'
import { auth, fetchQuestions } from './auth'
import type { SecurityQuestion } from './auth'
import { Icon } from './Icon'
import { Select } from './Select'

export type AuthMode = 'login' | 'register' | 'forgot'

const TITLE: Record<AuthMode, string> = { login: '登录', register: '注册', forgot: '找回密码' }

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
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [questions, setQuestions] = useState<SecurityQuestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const userRef = useRef<HTMLInputElement>(null)

  const isReg = mode === 'register'
  const isForgot = mode === 'forgot'

  useEffect(() => {
    if (!open) return
    setUsername('')
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
  }, [mode])

  useEffect(() => {
    if (isForgot && questions.length === 0) {
      void fetchQuestions().then(setQuestions).catch(() => undefined)
    }
  }, [isForgot, questions.length])

  if (!open) return null

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
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

        {!isForgot && (
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
          <Field label={isForgot ? '登录账号' : '用户名'}>
            <input
              ref={userRef}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={isForgot ? '你的用户名' : '起个用户名'}
              maxLength={12}
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

          {mode === 'login' && (
            <div className="-mt-2 mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => onMode('forgot')}
                className="font-label text-[11.5px] font-semibold text-primary hover:underline"
              >
                忘记密码？
              </button>
            </div>
          )}

          {error && <p className="mb-3 font-label text-[11px] text-error">{error}</p>}
          {okMsg && <p className="mb-3 font-label text-[11px] text-primary">{okMsg}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-0.5 w-full rounded-lg bg-primary py-2.5 text-sm font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '请稍候…' : isForgot ? '重 置 密 码' : isReg ? '注 册' : '登 录'}
          </button>
        </form>

        <div className="mt-3.5 text-center font-label text-xs text-on-surface-variant/60">
          {isForgot ? '想起来了？' : isReg ? '已有账号？' : '还没有账号？'}
          <button
            type="button"
            onClick={() => onMode(isForgot || isReg ? 'login' : 'register')}
            className="font-semibold text-primary hover:underline"
          >
            {isForgot ? '回去登录' : isReg ? '去登录' : '去注册'}
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

// 登录 / 注册弹窗 —— 还原效果稿，接 server/auth.ts。压在暗化的周历上，MD3 卡片。
// 登录：用户名 + 密码；注册：多一个确认密码。Enter 提交、ESC / 背景 / × 关闭。
import { useEffect, useRef, useState } from 'react'
import { auth } from './auth'
import { Icon } from './Icon'

export type AuthMode = 'login' | 'register'

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
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const userRef = useRef<HTMLInputElement>(null)

  const isReg = mode === 'register'

  // 每次打开重置表单；打开时聚焦用户名、绑 ESC。
  useEffect(() => {
    if (!open) return
    setUsername('')
    setPassword('')
    setConfirm('')
    setError(null)
    setSubmitting(false)
    userRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 切换登录/注册时清掉上一次的报错。
  useEffect(() => setError(null), [mode])

  if (!open) return null

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    if (isReg && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    try {
      if (isReg) await auth.register(username.trim(), password, confirm)
      else await auth.login(username.trim(), password)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '出错了，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-[360px] rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="absolute right-3.5 top-3.5 flex h-6 w-6 items-center justify-center rounded text-on-surface-variant/50 transition-colors hover:bg-surface-container-high hover:text-on-surface"
        >
          <Icon name="close" size={16} />
        </button>

        <div className="font-label text-[10px] uppercase tracking-[0.2em] text-primary">MapleTools</div>
        <h2 className="mt-1.5 text-lg font-extrabold text-on-surface">{isReg ? '注册' : '登录'}</h2>
        <p className="mb-4 font-label text-xs text-on-surface-variant/70">
          {isReg ? '开放注册，起个用户名和密码即可，追番数据只属于你。' : '登录后即可把追番同步到云端，换设备也在。'}
        </p>

        {/* 分段切换 */}
        <div className="mb-4 grid grid-cols-2 gap-1.5 rounded-md bg-surface-container p-1">
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onMode(m)}
              className={`rounded border py-1.5 text-sm font-semibold transition-colors ${
                mode === m
                  ? 'border-primary/30 bg-primary/12 text-primary'
                  : 'border-transparent text-on-surface-variant/70 hover:text-on-surface'
              }`}
            >
              {m === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <form onSubmit={submit}>
          <div className="mb-3.5">
            <label className="mb-1.5 block font-label text-[10px] uppercase tracking-wider text-on-surface-variant/80">
              用户名
            </label>
            <input
              ref={userRef}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="起个用户名"
              autoComplete="username"
              className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-high px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70"
            />
          </div>

          <div className="mb-3.5">
            <label className="mb-1.5 block font-label text-[10px] uppercase tracking-wider text-on-surface-variant/80">
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入密码"
              autoComplete={isReg ? 'new-password' : 'current-password'}
              className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-high px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70"
            />
            {isReg && <p className="mt-1.5 font-label text-[10px] text-on-surface-variant/40">至少 6 位</p>}
          </div>

          {isReg && (
            <div className="mb-3.5">
              <label className="mb-1.5 block font-label text-[10px] uppercase tracking-wider text-on-surface-variant/80">
                确认密码
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再输一次密码"
                autoComplete="new-password"
                className={`w-full rounded-lg border bg-surface-container-high px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70 ${
                  error === '两次输入的密码不一致' ? 'border-error/70' : 'border-outline-variant/30'
                }`}
              />
            </div>
          )}

          {error && <p className="mb-3 font-label text-[11px] text-error">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-0.5 w-full rounded-lg bg-primary py-2.5 text-sm font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '请稍候…' : isReg ? '注 册' : '登 录'}
          </button>
        </form>

        <div className="mt-3.5 text-center font-label text-xs text-on-surface-variant/60">
          {isReg ? '已有账号？' : '还没有账号？'}
          <button
            type="button"
            onClick={() => onMode(isReg ? 'login' : 'register')}
            className="font-semibold text-primary hover:underline"
          >
            {isReg ? '去登录' : '去注册'}
          </button>
        </div>
      </div>
    </div>
  )
}

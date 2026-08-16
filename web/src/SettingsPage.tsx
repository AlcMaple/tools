// 设置页 —— 左栏「身份卡 + 模块导航」，右栏模块面板。设计取自参考站的思路（对比后定的）：
//   - 键值用**两列紧挨着**（标签固定窄宽 + 值紧跟其后），不用 space-between 把值甩到最右，
//     否则眼睛要横跳几百 px
//   - 右栏**不套厚卡片边框**，靠标题 + 分隔线 + 间距分组；边框套边框正是「闷」的来源
//   - 表单**限宽**，别把密码框拉成整个面板那么宽
// 模块导航按可独立加载的面板组织，后续还能继续增加追番偏好 / 数据同步等。
import { useEffect, useRef, useState } from 'react'
import {
  fetchXifanAuthStatus,
  fetchXifanCaptcha,
  loginXifanAccount,
  logoutXifanAccount,
  signalXifanAuthChanged,
  XIFAN_AUTH_EVENT_KEY,
  XIFAN_CAPTCHA_EVENT_KEY,
} from './api'
import {
  auth,
  bindEmailStart,
  bindEmailVerify,
  fetchOauthProviders,
  fetchQuestions,
  rebindEmailViaGoogle,
  unbindEmailStart,
  unbindEmailVerify,
  useAuth,
} from './auth'
import type { SecurityQuestion } from './auth'
import { GoogleMark, Icon } from './Icon'
import { PasswordInput } from './PasswordInput'
import { Select } from './Select'

type Module = 'profile' | 'security' | 'xifan'

export function SettingsPage(): JSX.Element | null {
  const { user } = useAuth()
  const [module, setModule] = useState<Module>(() => (
    window.location.hash === '#/settings/xifan' ? 'xifan' : 'profile'
  ))
  const [xifanOpened, setXifanOpened] = useState(module === 'xifan')

  useEffect(() => {
    const onHashChange = (): void => {
      if (window.location.hash === '#/settings/xifan') {
        setXifanOpened(true)
        setModule('xifan')
      } else if (window.location.hash === '#/settings') setModule('profile')
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const selectModule = (next: Module): void => {
    setModule(next)
    if (next === 'xifan') setXifanOpened(true)
    const hash = next === 'xifan' ? '#/settings/xifan' : '#/settings'
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
  }

  if (!user) return null

  return (
    // md 以下没有侧栏可言，整页就是一条**中轴**：标题 / 头像 / tab / 主体全部居中对齐。
    // 之前左对齐 → 右边一大片死区；只把头像居中 → 中轴和左对齐的内容各走各的，更散。
    // md 起恢复「220px 侧栏 + 面板」，一切回到左对齐。
    <div className="px-4 pb-16 md:px-6">
      {/* 标题在**居中列之外** —— 它要贴页面左边距，跟周历页的 h1 同一个位置；
          放进居中列里就会缩到列的左边缘（页面中间偏左），两页对不上 */}
      <div className="pt-4 pb-3">
        <h1 className="text-2xl font-black tracking-tighter text-on-surface md:text-3xl">设置</h1>
      </div>

      <div className="mx-auto w-full max-w-[480px] md:max-w-none">
        <div className="grid gap-6 md:grid-cols-[220px_1fr] md:gap-10">
          <aside className="self-start md:sticky md:top-[72px]">
            <IdCard username={user.username} />
            {/* 窄屏：tab 居中，跟上面的头像页头对齐成一条中轴。md 起回到侧栏的竖排左对齐 */}
            <nav className="mt-4 flex justify-center gap-1 md:mt-3.5 md:flex-col md:justify-start md:gap-1.5">
              <SideItem
                icon="person"
                active={module === 'profile'}
                onClick={() => selectModule('profile')}
              >
                个人信息
              </SideItem>
              {user.hasPassword && (
                <SideItem
                  icon="lock"
                  active={module === 'security'}
                  onClick={() => selectModule('security')}
                >
                  账号安全
                </SideItem>
              )}
              <SideItem
                icon="play_arrow"
                active={module === 'xifan'}
                onClick={() => selectModule('xifan')}
              >
                稀饭账号
              </SideItem>
              <div className="hidden px-2.5 pb-1.5 pt-3 font-label text-[10px] uppercase tracking-[0.16em] text-on-surface-variant/35 md:block">
                后续
              </div>
              <SideItem icon="favorite" ghost>
                追番偏好
              </SideItem>
              <SideItem icon="sync" ghost>
                数据同步
              </SideItem>
            </nav>
          </aside>

          <div>
            {module !== 'xifan' && (
              module === 'profile' || !user.hasPassword ? (
                <ProfileModule onGoSecurity={() => selectModule('security')} />
              ) : (
                <SecurityModule />
              )
            )}
            {xifanOpened && (
              <div className={module === 'xifan' ? undefined : 'hidden'}>
                <XifanAccountModule />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// 身份区。两种形态都是「竖排居中」，差别只在**要不要卡片外观**：
//   窄屏 = 页头，不套框 —— 套了就是页面正中一个孤零零的小盒子（撑满又是条空长条，两头不讨好）
//   md 起 = 220px 侧栏里的身份卡，这时框才有意义（它把侧栏和右边面板分开）
function IdCard({ username }: { username: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2.5 md:rounded-xl md:border md:border-outline-variant/10 md:bg-surface-container/70 md:p-5">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-[26px] font-extrabold text-primary md:h-[54px] md:w-[54px] md:rounded-xl md:text-[22px]">
        {username.charAt(0).toUpperCase()}
      </div>
      <div className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-base font-extrabold text-on-surface md:text-[14.5px]">
        {username}
      </div>
    </div>
  )
}

function SideItem({
  icon,
  active,
  ghost,
  onClick,
  children,
}: {
  icon: 'person' | 'lock' | 'play_arrow' | 'favorite' | 'sync'
  active?: boolean
  ghost?: boolean
  onClick?: () => void
  children: React.ReactNode
}): JSX.Element {
  if (ghost) {
    return (
      <span className="hidden items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-semibold text-on-surface-variant/30 md:flex">
        <Icon name={icon} size={15} className="shrink-0" />
        {children}
        <span className="ml-auto rounded bg-on-surface-variant/10 px-1 py-px font-label text-[9px]">待开发</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-2 text-left text-[12.5px] font-semibold transition-colors md:gap-2.5 md:px-2.5 md:text-[13.5px] ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-on-surface-variant/75 hover:bg-on-surface/5 hover:text-on-surface'
      }`}
    >
      <Icon name={icon} size={15} className="shrink-0" />
      {children}
    </button>
  )
}

// 窄屏只留分隔线，不重复标题 —— 正上方那个高亮的 tab 已经说了在哪个模块，
// 再写一遍是同一件事说两遍。md 起 tab 在侧栏里，面板才需要自己的标题。
function PaneHead({ title }: { title: string }): JSX.Element {
  return (
    <div className="mb-1.5 border-b border-outline-variant/15 md:pb-3">
      <h2 className="hidden text-base font-extrabold text-on-surface md:block">{title}</h2>
    </div>
  )
}

// 键值行 —— 两列紧挨着（标签 96px + 值），值左对齐紧跟标签
function Kv({ k, v, note }: { k: string; v: string; note?: string }): JSX.Element {
  return (
    <div className="grid grid-cols-[96px_1fr] items-baseline gap-4 border-b border-outline-variant/10 py-3.5 last:border-b-0">
      <div className="text-[13px] font-semibold text-on-surface-variant/70">{k}</div>
      <div className="text-[13.5px] text-on-surface">
        {v}
        {note && <span className="mt-1 block text-[11.5px] text-on-surface-variant/40">{note}</span>}
      </div>
    </div>
  )
}

function ProfileModule({ onGoSecurity }: { onGoSecurity: () => void }): JSX.Element | null {
  const { user } = useAuth()
  const [providers, setProviders] = useState<{ google: boolean; email: boolean } | null>(null)
  const [flash, setFlash] = useState<{ msg: string; error: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    // Google 绑定回跳结果（登录流程的 oauth=failed 由 App 处理，不会走到这）。
    const params = new URLSearchParams(window.location.search)
    const result = params.get('oauth')
    if (
      result === 'bound' ||
      result === 'conflict' ||
      result === 'bind_failed' ||
      result === 'already_bound'
    ) {
      params.delete('oauth')
      const qs = params.toString()
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
      )
      setFlash(
        result === 'bound'
          ? { msg: 'Google 账号已绑定', error: false }
          : result === 'conflict'
            ? { msg: '该 Google 账号已绑定其它用户', error: true }
            : result === 'already_bound'
              ? { msg: '本账号已绑定 Google，请先解绑再绑定新的', error: true }
              : { msg: 'Google 绑定未完成，请重试', error: true },
      )
    }
    void fetchOauthProviders()
      .then((r) => {
        if (alive) setProviders(r)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (!user) return null

  return (
    <>
      <PaneHead title="个人信息" />
      {/* 窄屏整块居中但给足宽度（400px）：键值行能放下，登录方式行的标题 + 按钮也能同行不换行。
          md 起铺满面板（那时右边还有内容撑着）。 */}
      <div className="mx-auto w-full max-w-[400px] md:max-w-none">
        <UsernameRow />
        <Kv k="注册时间" v={user.createdAt.slice(0, 10)} />
        {/* 无密码的验证码账号不能使用依赖原始密码的密保设置，也不展示一条无从处理的状态。 */}
        {user.hasPassword && (
          <Kv
            k="密保"
            v={user.hasSecurity ? '已设置' : '未设置'}
            note={user.hasSecurity || user.hasEmail ? undefined : '忘记密码将无法找回账号'}
          />
        )}

        {/* 登录方式统一管理：一个账号 = 密码 ×1 + 邮箱 ×1（邮箱即身份，
            Gmail 可额外走 Google 快捷登录免验证码） */}
        <div className="mt-5 border-t border-outline-variant/10 pt-4">
          <div className="mb-1 font-label text-[10px] uppercase tracking-[0.16em] text-on-surface-variant/45">
            登录方式
          </div>
          <div className="divide-y divide-outline-variant/10">
            <PasswordRow onGoSecurity={onGoSecurity} />
            <EmailLoginCard emailEnabled={providers?.email === true} googleEnabled={providers?.google === true} flash={flash} />
          </div>
        </div>
      </div>
    </>
  )
}

/** 用户名行：随机 maple-xxxx 是系统起的，用户应该能改一个记得住的。
 *  凭据门槛与换绑同级：有密码账号验密码，无密码账号用当前邮箱验证码（改用户名不换身份）。
 *  另一行内可展开，与登录方式区块同款交互。 */
function UsernameRow(): JSX.Element | null {
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [challengeId, setChallengeId] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!cooldown) return
    const timer = window.setInterval(() => setCooldown((n) => Math.max(0, n - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  if (!user) return null

  const reset = (): void => {
    setEditing(false)
    setName('')
    setPassword('')
    setChallengeId('')
    setCode('')
    setSentTo('')
    setError(null)
    setOkMsg(null)
  }

  const sendCode = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const r = await auth.requestCodeForCurrentEmail()
      setChallengeId(r.challengeId)
      setSentTo(r.email)
      setCooldown(60)
      setOkMsg(`验证码已发送至 ${r.email}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    setError(null)
    if (!name.trim()) {
      setError('请输入新用户名')
      return
    }
    setBusy(true)
    try {
      const next = await auth.changeUsername(
        user.hasPassword
          ? { username: name.trim(), currentPassword: password || undefined }
          : { username: name.trim(), challengeId, code: code.trim() },
      )
      setOkMsg(`用户名已改为 ${next}`)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-outline-variant/10 py-3.5">
      <div className="grid grid-cols-[96px_1fr] items-baseline gap-4">
        <div className="text-[13px] font-semibold text-on-surface-variant/70">用户名</div>
        <div className="flex min-h-[28px] flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-[13.5px] text-on-surface">{user.username}</span>
          {!editing && (
            <button
              type="button"
              onClick={() => {
                setName('')
                setPassword('')
                setCode('')
                setChallengeId('')
                setError(null)
                setOkMsg(null)
                setEditing(true)
              }}
              className="shrink-0 rounded-lg border border-outline-variant/30 px-3 py-1.5 text-[12px] font-bold text-on-surface-variant transition-colors hover:border-primary/50 hover:text-primary"
            >
              修改
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-3 md:max-w-[360px]">
          <Field label="新用户名" tight>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="2–12 个字符：中文 / 字母 / 数字 / _ -"
              maxLength={12}
              className={inputCls}
            />
          </Field>
          {user.hasPassword ? (
            <Field label="当前密码" tight>
              <PasswordInput
                value={password}
                onChange={setPassword}
                placeholder="输入当前密码"
              />
            </Field>
          ) : (
            <Field label="邮箱验证码" tight>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={sentTo ? '输入 6 位验证码' : '先发送验证码'}
                  autoComplete="one-time-code"
                  maxLength={6}
                  className={inputCls}
                />
                <button
                  type="button"
                  disabled={busy || cooldown > 0}
                  onClick={() => void sendCode()}
                  className="shrink-0 rounded-lg border border-outline-variant/30 px-3 text-[12px] font-bold text-primary transition-colors hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {cooldown > 0 ? `${cooldown}s` : sentTo ? '重发' : '发验证码'}
                </button>
              </div>
              {sentTo && <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">已发送至 {sentTo}</p>}
            </Field>
          )}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={busy || (user.hasPassword ? !password : code.length !== 6)}
              onClick={() => void submit()}
              className="rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? '修改中…' : '确认修改'}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg px-2 py-2 text-[12.5px] font-semibold text-on-surface-variant/70 transition-colors hover:text-on-surface"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        className={`min-h-[18px] pt-1.5 font-label text-[11px] ${error ? 'text-error' : 'text-primary'}`}
      >
        {error || okMsg}
      </p>
    </div>
  )
}

/** 密码行：无密码账号（Google / 验证码注册）在此首次设置密码；已设置的跳账号安全修改。 */
function PasswordRow({ onGoSecurity }: { onGoSecurity: () => void }): JSX.Element | null {
  const { user } = useAuth()
  const [editing, setEditing] = useState(false)
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  if (!user) return null

  const submit = async (): Promise<void> => {
    setError(null)
    setOkMsg(null)
    if (next.length < 6) {
      setError('密码至少 6 位')
      return
    }
    if (next !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      await auth.setPassword(next, confirm)
      setOkMsg('密码已设置，现在可以用用户名 + 密码登录')
      setEditing(false)
      setNext('')
      setConfirm('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="py-3">
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon name="lock" size={18} className="shrink-0 text-on-surface-variant/70" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-on-surface">密码</div>
            <div className="truncate text-[11.5px] text-on-surface-variant/55">
              {user.hasPassword ? '已设置，登录页可用用户名 + 密码登录' : '未设置，设置后可用用户名 + 密码登录'}
            </div>
          </div>
        </div>
        {user.hasPassword ? (
          <button
            type="button"
            onClick={onGoSecurity}
            className="shrink-0 rounded-lg border border-outline-variant/30 px-3.5 py-2 text-[12.5px] font-bold text-on-surface-variant transition-colors hover:border-primary/50 hover:text-primary"
          >
            修改
          </button>
        ) : (
          !editing && (
            <button
              type="button"
              onClick={() => {
                setError(null)
                setOkMsg(null)
                setEditing(true)
              }}
              className="shrink-0 rounded-lg border border-outline-variant/30 px-3.5 py-2 text-[12.5px] font-bold text-on-surface-variant transition-colors hover:border-primary/50 hover:text-primary"
            >
              设置
            </button>
          )
        )}
      </div>

      {editing && !user.hasPassword && (
        <div className="mt-3 space-y-3 md:max-w-[360px]">
          <Field label="新密码" tight>
            <PasswordInput
              value={next}
              onChange={setNext}
              placeholder="设置密码（至少 6 位）"
              autoComplete="new-password"
            />
          </Field>
          <Field label="确认新密码" tight>
            <PasswordInput
              value={confirm}
              onChange={setConfirm}
              placeholder="再输一次"
              autoComplete="new-password"
            />
          </Field>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? '设置中…' : '确认设置'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setNext('')
                setConfirm('')
                setError(null)
                setOkMsg(null)
              }}
              className="rounded-lg px-2 py-2 text-[12.5px] font-semibold text-on-surface-variant/70 transition-colors hover:text-on-surface"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        className={`min-h-[18px] pt-1.5 font-label text-[11px] ${error ? 'text-error' : 'text-primary'}`}
      >
        {error || okMsg}
      </p>
    </div>
  )
}

/**
 * 邮箱登录行 —— 邮箱即身份，一个账号一个邮箱（Gmail 或非 Gmail 皆可）：
 *  - 换绑：Gmail 且 Google 启用时可走「Google 授权」免验证码（授权即证明控制该邮箱）；
 *    其它邮箱走验证码。两者都是先证明控制新邮箱再替换。
 *  - 解绑：向**当前邮箱**发验证码证明仍控制它，且要求账号已设密码（否则解掉身份本身）。
 */
function EmailLoginCard({
  emailEnabled,
  googleEnabled,
  flash,
}: {
  emailEnabled: boolean
  googleEnabled: boolean
  flash: { msg: string; error: boolean } | null
}): JSX.Element | null {
  const { user } = useAuth()
  const [status, setStatus] = useState<string | null>(flash?.msg ?? null)
  const [statusError, setStatusError] = useState(flash?.error ?? false)
  // 绑定 / 换绑（验证码路径）
  const [bindStep, setBindStep] = useState<'idle' | 'address' | 'code'>('idle')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [challengeId, setChallengeId] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  // Google 换绑（需先验密码）
  const [googlePwdOpen, setGooglePwdOpen] = useState(false)
  const [googlePwd, setGooglePwd] = useState('')
  // 解绑
  const [unbindStep, setUnbindStep] = useState<'idle' | 'code'>('idle')
  const [unbindId, setUnbindId] = useState('')
  const [unbindCode, setUnbindCode] = useState('')
  const [unbindEmail, setUnbindEmail] = useState('')
  const [unbindCooldown, setUnbindCooldown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cooldown) return
    const timer = window.setInterval(() => setCooldown((n) => Math.max(0, n - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])
  useEffect(() => {
    if (!unbindCooldown) return
    const timer = window.setInterval(() => setUnbindCooldown((n) => Math.max(0, n - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [unbindCooldown])

  if (!user) return null

  const say = (msg: string, isError: boolean): void => {
    setStatus(msg)
    setStatusError(isError)
  }
  const resetAll = (): void => {
    setBindStep('idle')
    setGooglePwdOpen(false)
    setGooglePwd('')
    setUnbindStep('idle')
    setChallengeId('')
    setCode('')
    setUnbindId('')
    setUnbindCode('')
    setEmail('')
    setPassword('')
    setError(null)
  }

  const sendBindCode = async (): Promise<void> => {
    setError(null)
    if (!email.trim()) {
      setError('请输入邮箱地址')
      return
    }
    setBusy(true)
    try {
      const r = await bindEmailStart(email.trim(), password || undefined)
      setChallengeId(r.challengeId)
      setBindStep('code')
      setCooldown(60)
      say(`验证码已发送至 ${email.trim()}`, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  const confirmBind = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await bindEmailVerify(challengeId, code.trim())
      say(`邮箱已更新为 ${r.email}`, false)
      resetAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const goGoogleRebind = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const url = await rebindEmailViaGoogle(googlePwd)
      window.location.href = url // 整页跳 Google，回来带 ?oauth= 结果码
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起 Google 授权失败')
      setBusy(false)
    }
  }

  const sendUnbindCode = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const r = await unbindEmailStart()
      setUnbindId(r.challengeId)
      setUnbindEmail(r.email)
      setUnbindStep('code')
      setUnbindCooldown(60)
      say(`验证码已发送至 ${r.email}`, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码发送失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  const confirmUnbind = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await unbindEmailVerify(unbindId, unbindCode.trim())
      say('邮箱已解绑，账号数据保留，可重新绑定新邮箱', false)
      resetAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : '解绑失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const isGmail = (user.email ?? '').endsWith('@gmail.com') || (user.email ?? '').endsWith('@googlemail.com')
  // Google 换绑入口只看服务端是否启用——密码门槛在下一步（输密码 / 提示先设密码）处理，
  // 不在入口处隐藏：163 换 Gmail 同样能走免验证码路径。
  const canGoogleRebind = googleEnabled
  const showBind = bindStep === 'address'
  const showCode = bindStep === 'code'
  const showUnbindCode = unbindStep === 'code'

  return (
    <div className="py-3">
      {/* 按钮紧跟文字左聚拢（本页设计原则：别用 space-between 把操作甩到最右） */}
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon name="mail" size={18} className="shrink-0 text-on-surface-variant/70" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-on-surface">邮箱</span>
              {isGmail && (
                <span className="flex items-center gap-1 rounded bg-surface-container-high px-1.5 py-0.5 font-label text-[9px] font-semibold text-on-surface-variant/70">
                  <GoogleMark size={9} /> 快捷登录已开通
                </span>
              )}
            </div>
            <div className="truncate text-[11.5px] text-on-surface-variant/55">
              {user.email ?? '未绑定，绑定后可用邮箱验证码登录'}
            </div>
          </div>
        </div>
        {bindStep === 'idle' && unbindStep === 'idle' && !googlePwdOpen && (
          <div className="flex shrink-0 items-center gap-2">
            {user.email && (
              <button
                type="button"
                onClick={() => {
                  say(null as unknown as string, false)
                  setBindStep('address')
                }}
                className="rounded-lg border border-outline-variant/30 px-3.5 py-2 text-[12.5px] font-bold text-on-surface-variant transition-colors hover:border-primary/50 hover:text-primary"
              >
                换绑
              </button>
            )}
            {!user.email && (
              <button
                type="button"
                onClick={() => {
                  say(null as unknown as string, false)
                  setBindStep('address')
                }}
                className="rounded-lg border border-outline-variant/30 px-3.5 py-2 text-[12.5px] font-bold text-on-surface-variant transition-colors hover:border-primary/50 hover:text-primary"
              >
                绑定
              </button>
            )}
            {user.email && user.hasPassword && (
              <button
                type="button"
                onClick={() => void sendUnbindCode()}
                disabled={busy}
                className="rounded-lg border border-outline-variant/30 px-3.5 py-2 text-[12.5px] font-bold text-on-surface-variant transition-colors hover:border-error/45 hover:text-error disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? '发送中…' : '解绑'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 换绑第一步：选路径 */}
      {showBind && (
        <div className="mt-3 space-y-3 md:max-w-[360px]">
          {canGoogleRebind && (
            <>
              <button
                type="button"
                onClick={() => {
                  setBindStep('idle')
                  setGooglePwdOpen(true)
                }}
                className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-white py-2.5 text-[12.5px] font-semibold text-[#1f1f1f] transition hover:brightness-95"
              >
                <GoogleMark size={16} />
                使用 Google 继续
              </button>
              <div className="flex items-center gap-3" aria-hidden="true">
                <span className="h-px flex-1 bg-outline-variant/30" />
                <span className="font-label text-[10px] text-on-surface-variant/50">或</span>
                <span className="h-px flex-1 bg-outline-variant/30" />
              </div>
            </>
          )}
          <Field label="新邮箱地址" tight>
            <input
              type="text"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="输入要换绑的邮箱地址"
              autoComplete="email"
              maxLength={254}
              className={inputCls}
            />
          </Field>
          {user.hasPassword && (
            <Field label="当前密码" tight>
              <PasswordInput
                value={password}
                onChange={setPassword}
                placeholder="输入当前密码"
              />
              <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">
                验证当前密码后才会发送验证码
              </p>
            </Field>
          )}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={busy || !emailEnabled}
              onClick={() => void sendBindCode()}
              className="rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? '发送中…' : '发送验证码'}
            </button>
            <button
              type="button"
              onClick={resetAll}
              className="rounded-lg px-2 py-2 text-[12.5px] font-semibold text-on-surface-variant/70 transition-colors hover:text-on-surface"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 换绑第二步：验证码 */}
      {showCode && (
        <div className="mt-3 space-y-3 md:max-w-[360px]">
          <Field label="邮箱验证码" tight>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="输入 6 位验证码"
              autoComplete="one-time-code"
              maxLength={6}
              className={inputCls}
            />
            <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">已发送至 {email.trim()}</p>
          </Field>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={busy || code.length !== 6}
              onClick={() => void confirmBind()}
              className="rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? '验证中…' : '确认换绑'}
            </button>
            <button
              type="button"
              disabled={busy || cooldown > 0}
              onClick={() => void sendBindCode()}
              className="rounded-lg px-2 py-2 font-label text-[11px] font-semibold text-primary transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {cooldown > 0 ? `${cooldown}s 后重发` : '重新发送'}
            </button>
            <button
              type="button"
              onClick={resetAll}
              className="rounded-lg px-2 py-2 text-[12.5px] font-semibold text-on-surface-variant/70 transition-colors hover:text-on-surface"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Google 换绑：验密码后整页跳授权 */}
      {googlePwdOpen && (
        <div className="mt-3 space-y-3 md:max-w-[360px]">
          {user.hasPassword ? (
            <Field label="当前密码" tight>
              <PasswordInput
                value={googlePwd}
                onChange={setGooglePwd}
                placeholder="输入当前密码"
              />
              <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">
                验证后跳转 Google 授权，授权即完成换绑，无需验证码
              </p>
            </Field>
          ) : (
            <p className="rounded-lg border border-outline-variant/15 bg-surface-container-high/50 px-3 py-2.5 text-[12px] text-on-surface-variant/75">
              更换邮箱前需要先在上方「密码」行设置密码——邮箱是账号的身份标识，没有密码的账号不能更换它。
            </p>
          )}
          <div className="flex items-center gap-2.5">
            {user.hasPassword && (
              <button
                type="button"
                disabled={busy || !googlePwd}
                onClick={() => void goGoogleRebind()}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[12.5px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? '跳转中…' : '去 Google 授权'}
              </button>
            )}
            <button
              type="button"
              onClick={resetAll}
              className="rounded-lg px-2 py-2 text-[12.5px] font-semibold text-on-surface-variant/70 transition-colors hover:text-on-surface"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 解绑第二步：验证码 */}
      {showUnbindCode && (
        <div className="mt-3 space-y-3 md:max-w-[360px]">
          <Field label="邮箱验证码" tight>
            <input
              type="text"
              inputMode="numeric"
              value={unbindCode}
              onChange={(e) => setUnbindCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="输入 6 位验证码"
              autoComplete="one-time-code"
              maxLength={6}
              className={inputCls}
            />
            <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">
              已发送至 {unbindEmail}，验证后解绑
            </p>
          </Field>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={busy || unbindCode.length !== 6}
              onClick={() => void confirmUnbind()}
              className="rounded-lg bg-error/90 px-4 py-2 text-[12.5px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? '解绑中…' : '确认解绑'}
            </button>
            <button
              type="button"
              disabled={busy || unbindCooldown > 0}
              onClick={() => void sendUnbindCode()}
              className="rounded-lg px-2 py-2 font-label text-[11px] font-semibold text-primary transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {unbindCooldown > 0 ? `${unbindCooldown}s 后重发` : '重新发送'}
            </button>
            <button
              type="button"
              onClick={resetAll}
              className="rounded-lg px-2 py-2 text-[12.5px] font-semibold text-on-surface-variant/70 transition-colors hover:text-on-surface"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        className={`min-h-[18px] pt-1.5 font-label text-[11px] ${error || statusError ? 'text-error' : 'text-primary'}`}
      >
        {error || status}
      </p>
    </div>
  )
}

function SecurityModule(): JSX.Element {
  const { user } = useAuth()
  const [questions, setQuestions] = useState<SecurityQuestion[]>([])
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [questionId, setQuestionId] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void fetchQuestions().then(setQuestions).catch(() => undefined)
  }, [])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    setOkMsg(null)
    if (next && next !== confirm) {
      setError('两次输入的新密码不一致')
      return
    }
    setSaving(true)
    try {
      await auth.saveSettings({
        currentPassword: current,
        newPassword: next || undefined,
        confirm: confirm || undefined,
        questionId: questionId || undefined,
        answer: answer || undefined,
      })
      setOkMsg('已保存')
      setCurrent('')
      setNext('')
      setConfirm('')
      setQuestionId('')
      setAnswer('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PaneHead title="账号安全" />
      {/* md 以下不限宽：外层已经收进 560 的居中列了，再限 440 只会在右边又留一条死区 */}
      <form onSubmit={submit} className="pt-4 md:max-w-[440px]">
        <Field label="原始密码" required>
          <PasswordInput
            value={current}
            onChange={setCurrent}
            placeholder="输入当前密码以验证身份"
          />
        </Field>

        <SegNote>修改密码</SegNote>
        {/* 「留空 = 不改」由 placeholder 直接说，不再另开一条提示条重复一遍 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="新密码" tight>
            <PasswordInput
              value={next}
              onChange={setNext}
              placeholder="留空 = 不改"
              autoComplete="new-password"
            />
            <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">至少 6 位</p>
          </Field>
          <Field label="确认新密码" tight>
            <PasswordInput
              value={confirm}
              onChange={setConfirm}
              placeholder="留空 = 不改"
              autoComplete="new-password"
            />
          </Field>
        </div>

        <SegNote>找回密码用的密保</SegNote>
        {/* 只报「设没设」，绝不回显问题和答案 —— 问题本身也是秘密 */}
        <div className="mb-3.5 flex flex-wrap items-center gap-x-1.5 rounded border border-outline-variant/15 bg-surface-container-high/50 px-3 py-2.5 text-xs text-on-surface-variant/75">
          <span>当前状态：</span>
          <span className={`font-bold ${user?.hasSecurity ? 'text-primary' : 'text-error'}`}>
            {user?.hasSecurity ? '已设置' : '未设置'}
          </span>
        </div>
        <Field label="找回密码问题">
          <Select
            options={questions}
            value={questionId}
            onChange={setQuestionId}
            placeholder="请选择一个问题…"
          />
        </Field>
        <Field label="找回密码答案">
          <input
            type="text"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="输入答案"
            className={inputCls}
          />
          <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">
            不区分大小写和首尾空格
          </p>
        </Field>

        {/* 状态位固定在按钮右侧的空位里：出现/消失都不挤动任何东西。
            原来是在按钮上方插一行 <p>，一「已保存」整行按钮就被顶下去。 */}
        <div className="mt-5 flex items-center gap-3.5">
          <button
            type="submit"
            disabled={saving}
            className="shrink-0 rounded-lg bg-primary px-5 py-2.5 text-[13px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? '保存中…' : '保存修改'}
          </button>
          <span className={`font-label text-[11.5px] ${error ? 'text-error' : 'text-primary'}`}>
            {error || okMsg}
          </span>
        </div>
      </form>
    </>
  )
}

function XifanAccountModule(): JSX.Element {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [verify, setVerify] = useState('')
  const [captcha, setCaptcha] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const captchaRequest = useRef(0)
  const statusRequest = useRef(0)

  const loadCaptcha = async (clearError = true): Promise<string | null> => {
    if (!mounted.current) return null
    const request = ++captchaRequest.current
    setVerify('')
    setCaptchaLoading(true)
    if (clearError) setError(null)
    try {
      const data = await fetchXifanCaptcha()
      if (!mounted.current || request !== captchaRequest.current) return null
      setCaptcha(`data:${data.mime};base64,${data.imageB64}`)
      return null
    } catch (requestError) {
      if (!mounted.current || request !== captchaRequest.current) return null
      const message = requestError instanceof Error ? requestError.message : '验证码加载失败'
      setCaptcha('')
      setError(message)
      return message
    } finally {
      if (mounted.current && request === captchaRequest.current) setCaptchaLoading(false)
    }
  }

  const loadStatus = async (notifyIfLoggedIn = false): Promise<void> => {
    if (!mounted.current) return
    const request = ++statusRequest.current
    setLoggedIn(null)
    setError(null)
    try {
      const status = await fetchXifanAuthStatus()
      if (!mounted.current || request !== statusRequest.current) return
      setLoggedIn(status.loggedIn)
      if (status.loggedIn) {
        if (notifyIfLoggedIn) signalXifanAuthChanged()
      } else await loadCaptcha()
    } catch (requestError) {
      if (!mounted.current || request !== statusRequest.current) return
      setError(requestError instanceof Error ? requestError.message : '登录状态校验失败')
    }
  }

  useEffect(() => {
    mounted.current = true
    void loadStatus(true)
    return () => {
      mounted.current = false
      captchaRequest.current += 1
      statusRequest.current += 1
    }
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === XIFAN_AUTH_EVENT_KEY) {
        void loadStatus()
      } else if (event.key === XIFAN_CAPTCHA_EVENT_KEY) {
        captchaRequest.current += 1
        setCaptchaLoading(false)
        setCaptcha('')
        setVerify('')
        if (loggedIn === false) setError('验证码已在其他页面刷新，请重新获取')
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [loggedIn])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    if (!username.trim() || !password || !verify.trim()) {
      setError('请填写账号、密码和验证码')
      return
    }
    setBusy(true)
    try {
      await loginXifanAccount(username.trim(), password, verify.trim())
      if (!mounted.current) return
      setLoggedIn(true)
      setUsername('')
      setPassword('')
      setVerify('')
      setCaptcha('')
    } catch (requestError) {
      if (!mounted.current) return
      const message = requestError instanceof Error ? requestError.message : '登录失败'
      setError(message)
      const captchaError = await loadCaptcha(false)
      if (mounted.current) setError(captchaError ? `${message}；${captchaError}` : message)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await logoutXifanAccount()
      if (!mounted.current) return
      await loadCaptcha()
      if (mounted.current) setLoggedIn(false)
    } catch (requestError) {
      if (!mounted.current) return
      setError(requestError instanceof Error ? requestError.message : '退出失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <>
      <PaneHead title="稀饭账号" />
      <div className="pt-4 md:max-w-[440px]">
        {loggedIn === null ? (
          <div className="flex min-h-[132px] flex-col items-start justify-center gap-3 border-b border-outline-variant/10">
            {error ? (
              <>
                <span role="alert" className="text-[12.5px] font-semibold text-error">{error}</span>
                <button
                  type="button"
                  onClick={() => void loadStatus(true)}
                  className="rounded-lg border border-outline-variant/30 px-4 py-2 text-[12.5px] font-bold text-on-surface transition-colors hover:border-primary/50 hover:text-primary"
                >
                  重新检查
                </button>
              </>
            ) : (
              <span className="flex items-center gap-2 text-[12.5px] font-semibold text-on-surface-variant/60">
                <Icon name="refresh" size={16} className="animate-spin" />
                正在校验登录状态
              </span>
            )}
          </div>
        ) : loggedIn ? (
          <div className="flex min-h-[72px] items-center justify-between gap-4 border-b border-outline-variant/10 pb-4">
            <div>
              <div className="font-label text-[10px] uppercase text-on-surface-variant/55">登录状态</div>
              <div className="mt-1.5 flex items-center gap-2 text-[13.5px] font-bold text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                已登录
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void logout()}
              className="flex shrink-0 items-center gap-2 rounded-lg border border-outline-variant/30 px-3.5 py-2 text-[12.5px] font-bold text-on-surface-variant transition-colors hover:border-error/45 hover:text-error disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Icon name="logout" size={15} />
              {busy ? '退出中…' : '退出登录'}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} aria-describedby="xifan-auth-error">
            <Field label="账号" htmlFor="xifan-username" required>
              <input
                id="xifan-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="手机 / 登录账号"
                autoComplete="username"
                aria-required="true"
                maxLength={100}
                className={inputCls}
              />
            </Field>
            <Field label="密码" htmlFor="xifan-password" required>
              <PasswordInput
                value={password}
                onChange={setPassword}
                placeholder="输入密码"
              />
            </Field>
            <Field label="验证码" htmlFor="xifan-verify" required>
              <div className="grid grid-cols-[minmax(0,1fr)_104px_42px] gap-2">
                <input
                  id="xifan-verify"
                  type="text"
                  value={verify}
                  onChange={(event) => setVerify(event.target.value)}
                  placeholder="输入验证码"
                  autoComplete="off"
                  aria-required="true"
                  maxLength={32}
                  className={inputCls}
                />
                <div className="flex h-[42px] w-[104px] items-center justify-center overflow-hidden rounded-lg border border-outline-variant/30 bg-surface-container-high">
                  {captcha ? (
                    <img src={captcha} alt="验证码" draggable={false} className="h-full w-full object-contain" />
                  ) : (
                    <Icon name="image" size={18} className="text-on-surface-variant/30" />
                  )}
                </div>
                <button
                  type="button"
                  title="刷新验证码"
                  aria-label="刷新验证码"
                  disabled={captchaLoading}
                  onClick={() => void loadCaptcha()}
                  className="flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-outline-variant/30 text-on-surface-variant transition-colors hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="refresh" size={17} className={captchaLoading ? 'animate-spin' : undefined} />
                </button>
              </div>
            </Field>

            <div className="mt-5 flex min-h-[42px] items-center gap-3.5">
              <button
                type="submit"
                disabled={busy || captchaLoading || !captcha}
                className="shrink-0 rounded-lg bg-primary px-5 py-2.5 text-[13px] font-bold text-on-primary transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? '登录中…' : '登录'}
              </button>
              <span
                id="xifan-auth-error"
                role="alert"
                aria-live="polite"
                className="min-w-0 font-label text-[11.5px] text-error"
              >
                {error}
              </span>
            </div>
          </form>
        )}
      </div>
    </>
  )
}

const inputCls =
  'w-full rounded-lg border border-outline-variant/30 bg-surface-container-high px-3 py-2.5 text-sm text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70'

function Field({
  label,
  htmlFor,
  required,
  tight,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  tight?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className={tight ? '' : 'mb-4'}>
      <label htmlFor={htmlFor} className="mb-1.5 block font-label text-[10px] uppercase tracking-wider text-on-surface-variant/80">
        {label}
        {required && <span className="ml-1.5 normal-case tracking-normal text-error">必填</span>}
      </label>
      {children}
    </div>
  )
}

function SegNote({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="my-4 flex items-center gap-2.5 font-label text-[10.5px] uppercase tracking-[0.14em] text-on-surface-variant/40 before:h-px before:flex-1 before:bg-outline-variant/15 after:h-px after:flex-1 after:bg-outline-variant/15">
      {children}
    </div>
  )
}

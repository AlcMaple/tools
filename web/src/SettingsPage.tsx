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
import { auth, fetchQuestions, useAuth } from './auth'
import type { SecurityQuestion } from './auth'
import { Icon } from './Icon'
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
              <SideItem
                icon="lock"
                active={module === 'security'}
                onClick={() => selectModule('security')}
              >
                账号安全
              </SideItem>
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
            {module !== 'xifan' && (module === 'profile' ? <ProfileModule /> : <SecurityModule />)}
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

function ProfileModule(): JSX.Element | null {
  const { user } = useAuth()
  if (!user) return null
  return (
    <>
      <PaneHead title="个人信息" />
      {/* 窄屏把键值块收窄到「标签 + 值刚好填满」再整块居中 —— 铺满整列的话内容只占左边 40%，
          右边一条死区，跟上面居中的头像/tab 对不上。md 起铺满面板（那时右边还有内容撑着）。 */}
      <div className="mx-auto w-full max-w-[320px] md:max-w-none">
        <Kv k="用户名" v={user.username} />
        <Kv k="注册时间" v={user.createdAt.slice(0, 10)} />
        {/* note 只在没有任何可恢复凭据时警告；已验证邮箱也能让用户重新登录。 */}
        <Kv
          k="密保"
          v={user.hasSecurity ? '已设置' : '未设置'}
          note={user.hasSecurity || user.hasEmail ? undefined : '忘记密码将无法找回账号'}
        />
        <Kv
          k="邮箱登录"
          v={user.hasEmail ? '已验证' : '未绑定'}
          note={user.hasEmail ? '可用邮箱验证码或邮箱 + 密码登录' : '邮箱快捷注册会创建独立账号'}
        />
      </div>
    </>
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
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="输入当前密码以验证身份"
            autoComplete="current-password"
            className={inputCls}
          />
        </Field>

        <SegNote>修改密码</SegNote>
        {/* 「留空 = 不改」由 placeholder 直接说，不再另开一条提示条重复一遍 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="新密码" tight>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="留空 = 不改"
              autoComplete="new-password"
              className={inputCls}
            />
            <p className="mt-1.5 font-label text-[11px] text-on-surface-variant/40">至少 6 位</p>
          </Field>
          <Field label="确认新密码" tight>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="留空 = 不改"
              autoComplete="new-password"
              className={inputCls}
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
              <input
                id="xifan-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="输入密码"
                autoComplete="current-password"
                aria-required="true"
                maxLength={200}
                className={inputCls}
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

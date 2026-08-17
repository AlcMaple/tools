// 设置页 —— 皮肤 = 原型稿 settings.html：借书卡身份页 + 纸口袋手风琴（hash 深链），
// 键值行两列紧挨着（标签固定窄宽 + 值紧跟其后），表单限宽、稿纸输入框。
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
import { Ic, Spinner } from './SketchIcon'
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

  const isGmail =
    (user.email ?? '').endsWith('@gmail.com') || (user.email ?? '').endsWith('@googlemail.com')

  return (
    <>
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 className="title-sketch" style={{ fontSize: 34 }}>
            设置
          </h1>
          <p className="muted small mt8">账号、安全和播放源，都收在这几个口袋里</p>
        </div>
      </div>

      {/* 手机：立绘内联（桌面在右侧驻场，CSS 切换） */}
      <div className="rig-inline mt16">
        <img className="rig" src="/assets/chara_04.png" alt="千寿ムラマサ · 官方立绘" />
        <div className="bubble rig-bubble">
          <span>书架整理好了，接下来交给我吧。</span>
        </div>
      </div>

      <div className="hero-split top mt16">
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 借书卡身份页 */}
          <div className="id-card">
            <span className="tape tr gold" />
            <span className="avatar-init" style={{ width: 58, height: 58, fontSize: 26 }} aria-hidden="true">
              {user.username.charAt(0).toUpperCase()}
            </span>
            <div className="id-lines">
              <b>{user.username}</b> <span className="faint font-hand">no.{user.createdAt.slice(0, 10).replace(/-/g, '')}</span>
              <br />
              邮箱 <b>{user.email ?? '未绑定'}</b> · 密码 <b>{user.hasPassword ? '已设置' : '未设置'}</b>
              {user.hasPassword && (
                <>
                  {' '}· 密保 <b>{user.hasSecurity ? '已设置' : '未设置'}</b>
                </>
              )}
            </div>
            {isGmail && (
              <span className="tagx mine" style={{ alignSelf: 'center' }}>
                <Ic name="google" cls="ic ic-sm" />
                Gmail 快捷登录已开通
              </span>
            )}
          </div>

          {/* 个人信息 */}
          <section className={`pocket${module === 'profile' ? ' open' : ''}`} data-mod="profile" style={{ marginTop: 14 }}>
            <button className="pocket-tab" type="button" onClick={() => selectModule('profile')}>
              <Ic name="user" />
              个人信息
              <span className="pocket-hint">用户名 · 邮箱 · 登录方式</span>
              <Ic name="chev" cls="ic chev" />
            </button>
            <div className="pocket-body">
              {module === 'profile' && (
                <div style={{ paddingTop: 6 }}>
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
                  <div className="pocket-sub"><span className="hl font-hand">登录方式</span></div>
                  <ProfileLoginWays onGoSecurity={() => selectModule('security')} />
                </div>
              )}
            </div>
          </section>

          {/* 账号安全（无密码账号不依赖原始密码，进不了这页） */}
          {user.hasPassword && (
            <section className={`pocket${module === 'security' ? ' open' : ''}`} data-mod="security">
              <button className="pocket-tab" type="button" onClick={() => selectModule('security')}>
                <Ic name="pencil" />
                账号安全
                <span className="pocket-hint">密码 · 密保问题</span>
                <Ic name="chev" cls="ic chev" />
              </button>
              <div className="pocket-body">{module === 'security' && <SecurityModule />}</div>
            </section>
          )}

          {/* 稀饭账号：打开过就保持挂载（验证码状态不丢），开合由口袋 CSS 管 */}
          <section className={`pocket${module === 'xifan' ? ' open' : ''}`} data-mod="xifan">
            <button className="pocket-tab" type="button" onClick={() => selectModule('xifan')}>
              <Ic name="play" />
              稀饭账号
              <span className="pocket-hint">在线播放源 · 验证码登录</span>
              <Ic name="chev" cls="ic chev" />
            </button>
            <div className="pocket-body">{xifanOpened && <XifanAccountModule />}</div>
          </section>

          {/* 后续预留 */}
          <section className="pocket">
            <button className="pocket-tab" type="button" disabled style={{ cursor: 'default' }}>
              <Ic name="star" />
              追番偏好
              <span className="pocket-hint">待开发</span>
            </button>
          </section>
          <section className="pocket">
            <button className="pocket-tab" type="button" disabled style={{ cursor: 'default' }}>
              <Ic name="refresh" />
              数据同步
              <span className="pocket-hint">待开发</span>
            </button>
          </section>
        </div>

        <div className="rig-box">
          <img className="rig" src="/assets/chara_04.png" alt="千寿ムラマサ · 官方立绘" />
          <div className="bubble rig-bubble">
            <span>书架整理好了，接下来交给我吧。</span>
          </div>
          <span className="kira" style={{ bottom: 74, right: -8, transform: 'rotate(5deg)' }}>
            ムラママ
          </span>
        </div>
      </div>
    </>
  )
}

// 键值行 —— 两列紧挨着（标签 92px + 值），值左对齐紧跟标签（原型稿 .kv-row）
function Kv({ k, v, note }: { k: string; v: string; note?: string }): JSX.Element {
  return (
    <div className="kv-row">
      <span className="kv-label">{k}</span>
      <span className="kv-val">
        {v}
        {note && <span className="muted">{note}</span>}
      </span>
    </div>
  )
}

/** 登录方式区块：密码行 + 邮箱行（拉 providers 决定 Google / 邮箱通道是否可用）。 */
function ProfileLoginWays({ onGoSecurity }: { onGoSecurity: () => void }): JSX.Element | null {
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
      <PasswordRow onGoSecurity={onGoSecurity} />
      <EmailLoginCard emailEnabled={providers?.email === true} googleEnabled={providers?.google === true} flash={flash} />
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
    <div className="kv-row" style={{ display: 'block' }}>
      <div className="kv-row" style={{ border: 'none', padding: '13px 0' }}>
        <span className="kv-label">用户名</span>
        <span className="kv-val">{user.username}</span>
        <span className="kv-act">
          {!editing && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setName('')
                setPassword('')
                setCode('')
                setChallengeId('')
                setError(null)
                setOkMsg(null)
                setEditing(true)
              }}
            >
              修改
            </button>
          )}
        </span>
      </div>

      {editing && (
        <div className="field-stack">
          <Field label="新用户名">
            <span className="field-row">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="2–12 个字符：中文 / 字母 / 数字 / _ -"
                maxLength={12}
              />
            </span>
          </Field>
          {user.hasPassword ? (
            <Field label="当前密码">
              <PasswordInput value={password} onChange={setPassword} placeholder="输入当前密码" />
            </Field>
          ) : (
            <Field label="邮箱验证码">
              <span className="field-row">
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={sentTo ? '输入 6 位验证码' : '先发送验证码'}
                  autoComplete="one-time-code"
                  maxLength={6}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ flex: 'none', marginLeft: 8 }}
                  disabled={busy || cooldown > 0}
                  onClick={() => void sendCode()}
                >
                  {cooldown > 0 ? `${cooldown}s` : sentTo ? '重发' : '发验证码'}
                </button>
              </span>
              {sentTo && <span className="field-hint">已发送至 {sentTo}</span>}
            </Field>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || (user.hasPassword ? !password : code.length !== 6)}
              onClick={() => void submit()}
            >
              {busy ? '修改中…' : '确认修改'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={reset}>
              取消
            </button>
          </div>
        </div>
      )}

      {(error || okMsg) && (
        <p className={`form-note${error ? ' err' : ''}`} role="status" aria-live="polite">
          {error || okMsg}
        </p>
      )}
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
      <div className="kv-row" style={{ display: 'block' }}>
      <div className="kv-row" style={{ border: 'none', padding: '13px 0' }}>
        <span className="kv-label">密码</span>
        <span className="kv-val">
          {user.hasPassword ? '已设置，登录页可用用户名 + 密码登录' : '未设置，设置后可用用户名 + 密码登录'}
        </span>
        <span className="kv-act">
          {user.hasPassword ? (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onGoSecurity}>
              修改
            </button>
          ) : (
            !editing && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setError(null)
                  setOkMsg(null)
                  setEditing(true)
                }}
              >
                设置
              </button>
            )
          )}
        </span>
      </div>

      {editing && !user.hasPassword && (
        <div className="field-stack">
          <Field label="新密码">
            <PasswordInput value={next} onChange={setNext} placeholder="设置密码（至少 6 位）" autoComplete="new-password" />
          </Field>
          <Field label="确认新密码">
            <PasswordInput value={confirm} onChange={setConfirm} placeholder="再输一次" autoComplete="new-password" />
          </Field>
          <div className="row">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? '设置中…' : '确认设置'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setEditing(false)
                setNext('')
                setConfirm('')
                setError(null)
                setOkMsg(null)
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {(error || okMsg) && (
        <p className={`form-note${error ? ' err' : ''}`} role="status" aria-live="polite">
          {error || okMsg}
        </p>
      )}
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
      <div className="kv-row" style={{ display: 'block' }}>
      <div className="kv-row" style={{ border: 'none', padding: '13px 0' }}>
        <span className="kv-label">邮箱</span>
        <span className="kv-val">
          {user.email ?? '未绑定，绑定后可用邮箱验证码登录'}
          {isGmail && <span className="muted">Gmail 快捷登录已开通</span>}
        </span>
        <span className="kv-act row" style={{ gap: 8 }}>
          {bindStep === 'idle' && unbindStep === 'idle' && !googlePwdOpen && (
            <>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setStatus(null)
                  setStatusError(false)
                  setBindStep('address')
                }}
              >
                {user.email ? '换绑' : '绑定'}
              </button>
              {user.email && user.hasPassword && (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => void sendUnbindCode()}
                  disabled={busy}
                >
                  {busy ? '发送中…' : '解绑'}
                </button>
              )}
            </>
          )}
        </span>
      </div>

      {/* 换绑第一步：选路径 */}
      {showBind && (
        <div className="field-stack">
          {canGoogleRebind && (
            <>
              <button
                type="button"
                className="btn btn-google btn-block"
                onClick={() => {
                  setBindStep('idle')
                  setGooglePwdOpen(true)
                }}
              >
                <Ic name="google" cls="ic" />
                使用 Google 继续
              </button>
              <div className="or-line" aria-hidden="true">
                或
              </div>
            </>
          )}
          <Field label="新邮箱地址">
            <span className="field-row">
              <input
                type="text"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="输入要换绑的邮箱地址"
                autoComplete="email"
                maxLength={254}
              />
            </span>
          </Field>
          {user.hasPassword && (
            <Field label="当前密码">
              <PasswordInput value={password} onChange={setPassword} placeholder="输入当前密码" />
              <span className="field-hint">验证当前密码后才会发送验证码</span>
            </Field>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !emailEnabled}
              onClick={() => void sendBindCode()}
            >
              {busy ? '发送中…' : '发送验证码'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetAll}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 换绑第二步：验证码 */}
      {showCode && (
        <div className="field-stack">
          <Field label="邮箱验证码">
            <span className="field-row">
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="输入 6 位验证码"
                autoComplete="one-time-code"
                maxLength={6}
              />
            </span>
            <span className="field-hint">已发送至 {email.trim()}</span>
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || code.length !== 6}
              onClick={() => void confirmBind()}
            >
              {busy ? '验证中…' : '确认换绑'}
            </button>
            <button
              type="button"
              className="link"
              disabled={busy || cooldown > 0}
              onClick={() => void sendBindCode()}
            >
              {cooldown > 0 ? `${cooldown}s 后重发` : '重新发送'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetAll}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* Google 换绑：验密码后整页跳授权 */}
      {googlePwdOpen && (
        <div className="field-stack">
          {user.hasPassword ? (
            <Field label="当前密码">
              <PasswordInput value={googlePwd} onChange={setGooglePwd} placeholder="输入当前密码" />
              <span className="field-hint">验证后跳转 Google 授权，授权即完成换绑，无需验证码</span>
            </Field>
          ) : (
            <p className="sugg-note" style={{ textAlign: 'left' }}>
              更换邮箱前需要先在上方「密码」行设置密码——邮箱是账号的身份标识，没有密码的账号不能更换它。
            </p>
          )}
          <div className="row">
            {user.hasPassword && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || !googlePwd}
                onClick={() => void goGoogleRebind()}
              >
                {busy ? '跳转中…' : '去 Google 授权'}
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetAll}>
              取消
            </button>
          </div>
        </div>
      )}

      {/* 解绑第二步：验证码 */}
      {showUnbindCode && (
        <div className="field-stack">
          <Field label="邮箱验证码">
            <span className="field-row">
              <input
                type="text"
                inputMode="numeric"
                value={unbindCode}
                onChange={(e) => setUnbindCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="输入 6 位验证码"
                autoComplete="one-time-code"
                maxLength={6}
              />
            </span>
            <span className="field-hint">已发送至 {unbindEmail}，验证后解绑</span>
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy || unbindCode.length !== 6}
              onClick={() => void confirmUnbind()}
            >
              {busy ? '解绑中…' : '确认解绑'}
            </button>
            <button
              type="button"
              className="link"
              disabled={busy || unbindCooldown > 0}
              onClick={() => void sendUnbindCode()}
            >
              {unbindCooldown > 0 ? `${unbindCooldown}s 后重发` : '重新发送'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetAll}>
              取消
            </button>
          </div>
        </div>
      )}

      {(error || status) && (
        <p className={`form-note${error || statusError ? ' err' : ''}`} role="status" aria-live="polite">
          {error || status}
        </p>
      )}
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
    <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 400, paddingTop: 16 }}>
      <Field label="当前密码" required>
        <PasswordInput value={current} onChange={setCurrent} placeholder="输入当前密码以验证身份" />
      </Field>

      <div className="pocket-sub" style={{ margin: '4px 0 2px' }}><span className="hl font-hand">修改密码</span></div>
      {/* 「留空 = 不改」由 placeholder 直接说，不再另开一条提示条重复一遍 */}
      <div className="field-grid">
        <Field label="新密码">
          <PasswordInput value={next} onChange={setNext} placeholder="留空 = 不改" autoComplete="new-password" />
          <span className="field-hint">至少 6 位</span>
        </Field>
        <Field label="确认新密码">
          <PasswordInput value={confirm} onChange={setConfirm} placeholder="留空 = 不改" autoComplete="new-password" />
        </Field>
      </div>

      <div className="pocket-sub" style={{ margin: '4px 0 2px' }}><span className="hl font-hand">找回密码用的密保</span></div>
      {/* 只报「设没设」，绝不回显问题和答案 —— 问题本身也是秘密 */}
      <p className="faint small">
        当前状态：
        <b style={{ color: user?.hasSecurity ? 'var(--teal)' : 'var(--sakura)' }}>
          {user?.hasSecurity ? '已设置' : '未设置'}
        </b>
      </p>
      <Field label="找回密码问题">
        <Select options={questions} value={questionId} onChange={setQuestionId} placeholder="请选择一个问题…" />
      </Field>
      <Field label="找回密码答案">
        <span className="field-row">
          <input
            type="text"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="输入答案"
          />
        </span>
        <span className="field-hint">不区分大小写和首尾空格</span>
      </Field>

      {/* 状态位固定在按钮右侧的空位里：出现/消失都不挤动任何东西 */}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? '保存中…' : '保存修改'}
        </button>
        <span className={`form-note${error ? ' err' : ''}`} style={{ margin: 0 }}>
          {error || okMsg}
        </span>
      </div>
    </form>
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
    <div style={{ paddingTop: 10 }}>
      {loggedIn === null ? (
        <div className="page-state" style={{ padding: '36px 8px' }}>
          {error ? (
            <>
              <span role="alert" className="form-note err" style={{ margin: 0 }}>
                {error}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void loadStatus(true)}>
                重新检查
              </button>
            </>
          ) : (
            <span className="row faint small">
              <Spinner size={16} />
              正在校验登录状态
            </span>
          )}
        </div>
      ) : loggedIn ? (
        <div className="kv-row">
          <span className="kv-label">登录状态</span>
          <span className="kv-val" style={{ color: 'var(--teal)', fontWeight: 600 }}>
            已登录
          </span>
          <span className="kv-act">
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void logout()}>
              <Ic name="logout" cls="ic ic-sm" />
              {busy ? '退出中…' : '退出登录'}
            </button>
          </span>
        </div>
      ) : (
        <form onSubmit={submit} aria-describedby="xifan-auth-error" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="账号" htmlFor="xifan-username" required>
            <span className="field-row">
              <input
                id="xifan-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="手机 / 登录账号"
                autoComplete="username"
                aria-required="true"
                maxLength={100}
              />
            </span>
          </Field>
          <Field label="密码" htmlFor="xifan-password" required>
            <PasswordInput id="xifan-password" value={password} onChange={setPassword} placeholder="输入密码" />
          </Field>
          <Field label="验证码" htmlFor="xifan-verify" required>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <span className="field-row" style={{ flex: 1 }}>
                <input
                  id="xifan-verify"
                  type="text"
                  value={verify}
                  onChange={(event) => setVerify(event.target.value)}
                  placeholder="输入验证码"
                  autoComplete="off"
                  aria-required="true"
                  maxLength={32}
                />
              </span>
              <span className="captcha-img" style={{ width: 104, height: 42, flex: 'none' }}>
                {captcha ? (
                  <img src={captcha} alt="验证码" draggable={false} />
                ) : (
                  <Ic name="search" cls="ic ic-sm" />
                )}
              </span>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 42, height: 42, flex: 'none' }}
                title="刷新验证码"
                aria-label="刷新验证码"
                disabled={captchaLoading}
                onClick={() => void loadCaptcha()}
              >
                <Ic name="refresh" cls={captchaLoading ? 'ic animate-spin' : 'ic'} />
              </button>
            </div>
          </Field>

          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || captchaLoading || !captcha}>
              {busy ? '登录中…' : '登录'}
            </button>
            <span id="xifan-auth-error" role="alert" aria-live="polite" className={`form-note err${error ? '' : ' empty'}`} style={{ margin: 0 }}>
              {error}
            </span>
          </div>
        </form>
      )}
    </div>
  )
}

// 稿纸表单字段（原型稿 .field），tight 场景由调用方自己控制外距
function Field({
  label,
  htmlFor,
  required,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">
        {label}
        {required && <span style={{ color: 'var(--sakura)', marginLeft: 6 }}>必填</span>}
      </span>
      {children}
    </label>
  )
}

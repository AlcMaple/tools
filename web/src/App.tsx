// 应用外壳 —— 皮肤 = 原型稿的「书脊 + 内页」骨架：桌面左侧书脊侧栏（索引贴导航 + 用户卡），
// 移动端顶栏 + 底部标签栏（CSS 切换，不写 JS 分支）。页面本体在 CalendarPage / TracksPage /
// SettingsPage；这里只管壳、路由、全局登录弹窗、密保提示和便签 Toast。
import { useCallback, useEffect, useState } from 'react'
import { AnnouncementModal } from './AnnouncementModal'
import { auth, useAuth } from './auth'
import { AuthModal, type AuthMode } from './AuthModal'
import { CalendarPage } from './CalendarPage'
import { NagBar } from './NagBar'
import { navigate, useRoute, type Route } from './router'
import { SettingsPage } from './SettingsPage'
import { TracksPage } from './TracksPage'
import { Ic, SketchSprite, type SketchIconName } from './SketchIcon'
import { Splash } from './Splash'
import { toast, ToastRoot } from './Toast'

// 各页书脊的小 accents：胶带色 / 印章 / 拟声词（原型稿逐页配置）
const SPINE: Record<Route, { tape: string; stamp: string; stampCls: string; kira: string }> = {
  calendar: { tape: 'tape tl teal', stamp: '紗霧', stampCls: 'st-sakura', kira: 'キラキラ…' },
  tracks: { tape: 'tape tl gold', stamp: '在看', stampCls: 'st-teal', kira: 'キラキラ…' },
  settings: { tape: 'tape tl', stamp: '整理', stampCls: 'st-gold', kira: 'サラサラ…' },
}

const ROUTE_HREF: Record<Route, string> = { calendar: '#/', tracks: '#/tracks', settings: '#/settings' }

export default function App(): JSX.Element {
  const route = useRoute()
  const { user, ready } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [oauthError, setOauthError] = useState<string | null>(null)
  const [announcementArmed, setAnnouncementArmed] = useState(false)

  useEffect(() => void auth.init(), [])

  // 第三方登录失败回跳：服务端带回 ?oauth=failed（用户在 Google 页面主动取消时不带）。
  // 摘掉参数避免刷新重复触发，弹登录框说明原因。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('oauth') !== 'failed') return
    params.delete('oauth')
    const qs = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
    setOauthError('Google 登录未完成，请重试')
    setAuthMode('login')
    setAuthOpen(true)
  }, [])

  // 设置页要登录才有意义：先保留目标地址并弹登录，成功后直接落在原模块。
  useEffect(() => {
    if (ready && route === 'settings' && !user) {
      setAuthMode('login')
      setAuthOpen(true)
    }
  }, [ready, route, user])

  // 公告只属于本次开场的首页：开屏途中切到别页、或公告已出现后离开首页，都不在返回时补弹。
  useEffect(() => {
    if (route !== 'calendar') setAnnouncementArmed(false)
  }, [route])

  const go = (r: Route): void => navigate(r)
  const closeAnnouncement = useCallback(() => setAnnouncementArmed(false), [])
  const announceAfterSplash = useCallback(() => {
    if (route === 'calendar') setAnnouncementArmed(true)
  }, [route])
  const openLogin = (): void => {
    setAuthMode('login')
    setAuthOpen(true)
  }
  const sp = SPINE[route]

  return (
    <>
      <SketchSprite />
      <Splash onComplete={announceAfterSplash} />
      <AnnouncementModal active={announcementArmed && route === 'calendar'} onClose={closeAnnouncement} />

      {/* 移动端顶栏（桌面隐藏） */}
      <header className="m-top">
        <a className="brand" href="#/" style={{ fontSize: 18 }}>
          <Ic name="pencil" />
          MapleTools
        </a>
        <span style={{ marginLeft: 'auto' }} />
        {!ready ? null : user ? (
          <span
            className="avatar-init"
            style={{ width: 30, height: 30, fontSize: 15 }}
            title={user.username}
            aria-label={user.username}
          >
            {user.username.charAt(0).toUpperCase()}
          </span>
        ) : (
          <button className="btn btn-sm btn-primary" type="button" onClick={openLogin}>
            登录 / 注册
          </button>
        )}
      </header>

      <div className="shell">
        {/* 书脊（桌面侧栏） */}
        <aside className="spine">
          <span className={sp.tape} style={{ width: 88 }} />
          <div>
            <a className="brand" href="#/">
              <Ic name="pencil" />
              MapleTools <span className="sparkle">✦</span>
            </a>
            <div className="brand-sub">SAGIRI · SKETCHFOLIO</div>
          </div>

          <nav className="idx-nav">
            <IdxLink route="calendar" active={route === 'calendar'} icon="calendar">
              番剧周历
            </IdxLink>
            <IdxLink route="tracks" active={route === 'tracks'} icon="tracks">
              我的追番
            </IdxLink>
            <IdxLink route="settings" active={route === 'settings'} icon="settings">
              设置
            </IdxLink>
          </nav>

          <div className="spine-deco">
            <span className="kira" style={{ top: 0, left: 26 }}>
              {sp.kira}
            </span>
            <span className={`stamp ${sp.stampCls}`} style={{ position: 'absolute', top: 6, right: 14 }}>
              {sp.stamp}
            </span>
            <span className="sparkle s2" style={{ position: 'absolute', top: 52, left: 40, fontSize: 13 }}>
              ✦
            </span>
          </div>

          <div className="spine-foot">
            {ready && user ? (
              <>
                <div className="spine-user">
                  <span className="avatar-init" style={{ width: 34, height: 34, fontSize: 17 }} aria-hidden="true">
                    {user.username.charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <b>{user.username}</b>
                    <span className="faint">{user.email ?? '已登录'}</span>
                  </div>
                </div>
                <div className="spine-acts">
                  {/* 设置入口只在上方索引贴留一个，底部不重复 */}
                  <button
                    className="btn btn-sm btn-danger w100"
                    type="button"
                    onClick={() => {
                      void auth.logout().then(() => {
                        toast('已退出登录，回来记得找我')
                        go('calendar')
                      })
                    }}
                  >
                    <Ic name="logout" cls="ic ic-sm" />
                    退出登录
                  </button>
                </div>
              </>
            ) : ready ? (
              <button className="btn btn-primary" type="button" onClick={openLogin}>
                登录 / 注册
              </button>
            ) : null}
          </div>
        </aside>

        {/* 内页 */}
        <main className="sheet">
          <div className="sheet-wrap">
            <NagBar onGoSettings={() => go('settings')} />
            {route === 'settings' ? <SettingsPage /> : route === 'tracks' ? <TracksPage /> : <CalendarPage />}
          </div>
        </main>
      </div>

      {/* 移动端底部标签栏（桌面隐藏） */}
      <nav className="m-tabs">
        <MTab route="calendar" active={route === 'calendar'} icon="calendar">
          番剧周历
        </MTab>
        <MTab route="tracks" active={route === 'tracks'} icon="tracks">
          我的追番
        </MTab>
        <MTab route="settings" active={route === 'settings'} icon="settings">
          设置
        </MTab>
      </nav>

      <AuthModal
        open={authOpen}
        mode={authMode}
        onMode={setAuthMode}
        presetError={oauthError}
        onClose={() => {
          setAuthOpen(false)
          setOauthError(null)
          if (route === 'settings' && !auth.user) navigate('calendar')
        }}
      />
      <ToastRoot />
    </>
  )
}

function IdxLink({
  route,
  active,
  icon,
  children,
}: {
  route: Route
  active: boolean
  icon: SketchIconName
  children: React.ReactNode
}): JSX.Element {
  return (
    <a className={`idx-a${active ? ' on' : ''}`} href={ROUTE_HREF[route]}>
      <Ic name={icon} />
      {children}
    </a>
  )
}

function MTab({
  route,
  active,
  icon,
  children,
}: {
  route: Route
  active: boolean
  icon: SketchIconName
  children: React.ReactNode
}): JSX.Element {
  return (
    <a className={`m-tab${active ? ' on' : ''}`} href={ROUTE_HREF[route]}>
      <Ic name={icon} />
      {children}
    </a>
  )
}

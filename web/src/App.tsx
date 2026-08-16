// 应用外壳 —— 顶栏 + 密保提示条 + 按路由出页面 + 全局登录弹窗。
// 页面本身在 CalendarPage / SettingsPage 里；这里只管壳和路由。
import { useEffect, useState } from 'react'
import { auth, useAuth } from './auth'
import { AuthModal, type AuthMode } from './AuthModal'
import { CalendarPage } from './CalendarPage'
import { NagBar } from './NagBar'
import { Nav } from './Nav'
import { navigate, useRoute, type Route } from './router'
import { SettingsPage } from './SettingsPage'
import { TracksPage } from './TracksPage'

export default function App(): JSX.Element {
  const route = useRoute()
  const { user, ready } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [oauthError, setOauthError] = useState<string | null>(null)

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

  const go = (r: Route): void => navigate(r)

  return (
    <div className="relative min-h-full bg-background">
      <Nav
        route={route}
        onNavigate={go}
        onLogin={() => {
          setAuthMode('login')
          setAuthOpen(true)
        }}
      />
      <NagBar onGoSettings={() => go('settings')} />

      {route === 'settings' ? <SettingsPage /> : route === 'tracks' ? <TracksPage /> : <CalendarPage />}

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
    </div>
  )
}

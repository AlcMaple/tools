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

export default function App(): JSX.Element {
  const route = useRoute()
  const { user, ready } = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('login')

  useEffect(() => void auth.init(), [])

  // 设置页要登录才有意义：未登录直接踢回周历并弹登录（比如别人分享了 #/settings 链接）
  useEffect(() => {
    if (ready && route === 'settings' && !user) {
      navigate('calendar')
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

      {route === 'settings' ? <SettingsPage /> : <CalendarPage />}

      <AuthModal
        open={authOpen}
        mode={authMode}
        onMode={setAuthMode}
        onClose={() => setAuthOpen(false)}
      />
    </div>
  )
}

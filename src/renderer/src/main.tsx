import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Self-hosted fonts — no CDN dependency at runtime. Fixes blank icons / fallback
// glyphs when the device has no internet (or no VPN against blocked CDNs).
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/900.css'
import '@fontsource/space-grotesk/300.css'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import 'material-symbols/outlined.css'

import './index.css'

// 渲染进程未捕获错误 / Promise rejection → 转发主进程统一落盘(同 main.log),
// 让线上崩溃也能事后查到。best-effort,不阻断默认行为。
window.addEventListener('error', (e) => {
  void window.systemApi?.logError?.('renderer', e.error?.stack || e.message || String(e.error))
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { stack?: string; message?: string } | undefined
  void window.systemApi?.logError?.('renderer:promise', r?.stack || r?.message || String(r))
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// 告诉主进程"渲染就绪"，让它一次性显示窗口（避免首帧 show 后字体/图标
// 陆续跳出来的闪烁）。等下一帧（React 已提交首屏）+ 字体加载完才发信号；
// fonts.ready 卡住时 1.5s 兜底，主进程那边还有 4s 总兜底，双保险不黑窗。
{
  let signaled = false
  const signalReady = (): void => {
    if (signaled) return
    signaled = true
    window.systemApi?.signalReady?.()
  }
  requestAnimationFrame(() => {
    const fontsReady = document.fonts?.ready ?? Promise.resolve()
    fontsReady.then(signalReady).catch(signalReady)
    setTimeout(signalReady, 1500)
  })
}

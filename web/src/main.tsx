import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 字体：正文走系统中日韩栈、标题/数字用手写体 Yusei Magic（woff2 在 src/assets/fonts，
// 由 sketch-tokens.css 的 @font-face 引入并经 Vite 打包）。不再引入 Inter / Space Grotesk。
import App from './App'
import { registerCoverCacheWorker } from './coverCache'
import './index.css'

type CaptureRecoverableError = (error: unknown, componentStack?: string) => void

// 监控属于旁路能力，首屏渲染先完成。移动 Safari 恢复长期挂起的标签页时，动态分片可能
// 迟迟不返回；先挂载 React，应用仍能打开，监控分片回来后再接收可恢复错误。
const monitoringReady: Promise<CaptureRecoverableError | undefined> = import.meta.env.VITE_SENTRY_DSN?.trim()
  ? import('./monitoring')
      .then((monitoring) => {
        monitoring.initBrowserMonitoring()
        return monitoring.captureRecoverableReactError
      })
      .catch((error: unknown) => {
        // 监控脚本加载失败不影响产品本身启动；此时还没有可用的上报通道，留在控制台即可。
        console.error('[monitoring] browser initialization failed', error)
        return undefined
      })
  : Promise.resolve(undefined)

registerCoverCacheWorker()
createRoot(document.getElementById('root')!, {
  onRecoverableError: import.meta.env.VITE_SENTRY_DSN?.trim()
    ? (error, info) => {
        void monitoringReady.then((capture) => capture?.(error, info.componentStack ?? undefined))
      }
    : undefined,
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

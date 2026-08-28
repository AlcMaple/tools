import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 字体：正文走系统中日韩栈、标题/数字用手写体 Yusei Magic（woff2 在 src/assets/fonts，
// 由 sketch-tokens.css 的 @font-face 引入并经 Vite 打包）。不再引入 Inter / Space Grotesk。
import App from './App'
import { registerCoverCacheWorker } from './coverCache'
import './index.css'

async function bootstrap(): Promise<void> {
  let captureRecoverableError: ((error: unknown, componentStack?: string) => void) | undefined
  if (import.meta.env.VITE_SENTRY_DSN?.trim()) {
    try {
      const monitoring = await import('./monitoring')
      monitoring.initBrowserMonitoring()
      captureRecoverableError = monitoring.captureRecoverableReactError
    } catch (error) {
      // 监控脚本加载失败不能挡住产品本身启动；此时还没有可用的上报通道，只能留在控制台。
      console.error('[monitoring] browser initialization failed', error)
    }
  }

  registerCoverCacheWorker()
  createRoot(document.getElementById('root')!, {
    onRecoverableError: captureRecoverableError
      ? (error, info) => captureRecoverableError?.(error, info.componentStack ?? undefined)
      : undefined,
  }).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()

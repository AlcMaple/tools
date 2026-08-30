/// <reference types="vite/client" />

interface Window {
  /** 由 src/monitoring.ts 在 Sentry 初始化后挂上，供 public/white-screen-probe.js 调用。 */
  __mapleMonitoring?: {
    captureMessage: (message: string) => void
    setUser: (user: { id: number | string; username?: string } | null) => void
  }
}

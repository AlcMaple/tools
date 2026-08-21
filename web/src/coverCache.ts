// Bangumi 封面走同源 `/api/cover/*` 代理：URL 本身带内容 hash，适合 cache-first。
// 用 Service Worker 把图片字节留在 Cache Storage，路由切换重新挂载 `<img>` 时也无需
// 再向代理（更不用向 lain.bgm.tv）取一次。用户上传封面属于账号私有资源，绝不能放进这份
// 跨会话缓存，见 public/cover-cache-sw.js 的精确路径限制。
export function registerCoverCacheWorker(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return

  void navigator.serviceWorker.register('/cover-cache-sw.js', { scope: '/' }).catch(() => {
    // Service Worker 在隐私模式、受限 WebView 等环境可能不可用；`/api/cover` 原有的 HTTP
    // 缓存头仍会继续工作，不能因为这层加速失效影响正常看图。
  })
}

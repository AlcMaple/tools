// 白屏兜底探针 —— 独立静态文件，不进 Vite 打包。
//
// 为什么是外部文件而不是 index.html 里的内联 <script>：生产 CSP 是
// `script-src 'self' https://user.alcmaple.cn`，没有 'unsafe-inline'，内联脚本会被直接拦掉
// （见 server/security.ts / vite.config.ts）。`/white-screen-probe.js` 属于 'self'，放行。
//
// 覆盖范围：主包已加载、但 React 没能把任何东西渲染进 #root（渲染期抛错、hydration 崩等）。
// 主包整个加载失败（网络 / 语法错误）时 window.__mapleMonitoring 不存在，这里只能落到
// console.error —— 那种情况要靠 Sentry 前端之外的手段（如 nginx 日志 / 拨测）发现。
(function () {
  var TIMEOUT_MS = 4000
  var fired = false

  function looksBlank(el) {
    if (!el) return true
    var html = el.innerHTML.trim()
    if (html === '') return true
    // 首屏若将来加了 "加载中" 占位，超时后还停在占位也算白屏
    return /加载中|loading\.\.\./i.test(html) && el.childElementCount <= 1
  }

  function check() {
    if (fired) return
    fired = true
    if (document.visibilityState === 'hidden') return // 后台标签页不算数
    if (!looksBlank(document.getElementById('root'))) return

    var detail = 'path=' + location.pathname + ' ua=' + navigator.userAgent.slice(0, 120)
    // eslint-disable-next-line no-console
    console.error('[white-screen-probe] #root 在 ' + TIMEOUT_MS + 'ms 后仍为空', detail)

    var mon = window.__mapleMonitoring
    if (mon && typeof mon.captureMessage === 'function') {
      mon.captureMessage('应用白屏：#root 未渲染 (' + detail + ')')
    }
  }

  window.addEventListener('load', function () {
    setTimeout(check, TIMEOUT_MS)
  })
})()

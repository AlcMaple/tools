// 白屏兜底探针 —— 独立静态文件，不进 Vite 打包。
//
// 为什么是外部文件而不是 index.html 里的内联 <script>：生产 CSP 是
// `script-src 'self' https://user.alcmaple.cn`，没有 'unsafe-inline'，内联脚本会被直接拦掉
// （见 server/security.ts / vite.config.ts）。`/white-screen-probe.js` 属于 'self'，放行。
//
// 入口脚本 / 样式加载失败时，window.load 也会被延后；探针从执行这一刻起计时，先处理资源
// error，再用一次带恢复参数的入口请求打破旧 HTML 缓存。恢复参数存在时停止重载，避免循环。
(function () {
  var TIMEOUT_MS = 4000
  var RETRY_DELAY_MS = 120
  var RECOVERY_PARAM = 'mt_recover'
  var timer = 0
  var recoveryStarted = false
  var reportSent = false

  function looksBlank(el) {
    if (!el) return true
    var html = el.innerHTML.trim()
    if (html === '') return true
    // 首屏若将来加了 "加载中" 占位，超时后还停在占位也算白屏
    return /加载中|loading\.\.\./i.test(html) && el.childElementCount <= 1
  }

  function cleanRecoveryParam() {
    try {
      var url = new URL(location.href)
      if (!url.searchParams.has(RECOVERY_PARAM)) return
      url.searchParams.delete(RECOVERY_PARAM)
      history.replaceState(null, '', url.pathname + url.search + url.hash)
    } catch (_) {
      // URL / History 受限时只保留恢复标记，不影响页面内容。
    }
  }

  function report(reason) {
    if (reportSent) return
    reportSent = true
    var detail = 'reason=' + reason + ' path=' + location.pathname + ' ua=' + navigator.userAgent.slice(0, 120)
    // eslint-disable-next-line no-console
    console.error('[white-screen-probe] ' + detail)

    var mon = window.__mapleMonitoring
    if (mon && typeof mon.captureMessage === 'function') {
      mon.captureMessage('应用启动资源异常 (' + detail + ')')
    }
  }

  function recover(reason) {
    if (document.visibilityState === 'hidden') return
    if (!looksBlank(document.getElementById('root'))) {
      cleanRecoveryParam()
      return
    }

    var url
    try {
      url = new URL(location.href)
    } catch (_) {
      report(reason + ' url-invalid')
      return
    }
    if (url.searchParams.has(RECOVERY_PARAM)) {
      report(reason + ' recovery-already-attempted')
      return
    }

    recoveryStarted = true
    report(reason)
    url.searchParams.set(RECOVERY_PARAM, Date.now().toString(36))
    location.replace(url.pathname + url.search + url.hash)
  }

  function schedule(reason, delay) {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(function () {
      timer = 0
      if (!recoveryStarted) recover(reason)
    }, delay)
  }

  function resourcePath(target) {
    if (!target || !target.tagName) return ''
    var tag = target.tagName.toLowerCase()
    if (tag === 'script' && target.src) return target.src
    if (tag === 'link' && target.rel === 'stylesheet' && target.href) return target.href
    return ''
  }

  function onResourceError(event) {
    var raw = resourcePath(event.target)
    if (!raw) return
    var path = raw.split(/[?#]/, 1)[0]
    if (/\/assets\/index-[^/]+\.js$/.test(path) || /\/src\/main\.tsx$/.test(path)) {
      schedule('entry-resource-error ' + path, 0)
    } else if (/\.css$/.test(path)) {
      schedule('style-resource-error ' + path, 0)
    }
  }

  function onUnhandledRejection(event) {
    var reason = event && event.reason ? String(event.reason) : 'unknown'
    if (/chunk|import|module|failed to fetch|loading/i.test(reason)) {
      schedule('unhandled-rejection', 0)
    }
  }

  window.addEventListener('error', onResourceError, true)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) schedule('pageshow-persisted', RETRY_DELAY_MS)
  })
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') schedule('visibilitychange', RETRY_DELAY_MS)
  })

  // 不等待 load：入口脚本或外部依赖卡住时，load 本身不会到达。
  schedule('watchdog', TIMEOUT_MS)
})()

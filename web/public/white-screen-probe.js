// 只记录入口异常，不以等待时长或 DOM 是否为空决定刷新。
// 后台回收与恢复由浏览器处理；服务器只为确实失效的入口 hash 返回一次恢复脚本。
(function () {
  var mounted = false
  var reported = false

  function report(reason) {
    if (reported) return
    reported = true
    var detail = ('reason=' + reason + ' state=' + document.readyState).slice(0, 2000)
    console.error('[white-screen-probe] ' + detail)
    var body = JSON.stringify({ detail: detail })
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/boot-log', new Blob([body], { type: 'application/json' }))) return
      fetch('/api/boot-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {})
    } catch (_) {
      // 日志通道也可能断网，不追加网络重试。
    }
  }

  window.__mtAppReady = function () {
    mounted = true
    try {
      var url = new URL(location.href)
      if (!url.searchParams.has('mt_recover') && !url.searchParams.has('mt_stale')) return
      url.searchParams.delete('mt_recover')
      url.searchParams.delete('mt_stale')
      history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    } catch (_) {
      // History 受限不影响已经完成的首屏。
    }
  }

  window.addEventListener('error', function (event) {
    if (mounted) return
    var target = event.target
    var tag = target && target.tagName ? target.tagName.toLowerCase() : ''
    var raw = tag === 'script' ? target.src : tag === 'link' && target.rel === 'stylesheet' ? target.href : ''
    if (raw) {
      var url = new URL(raw, location.href)
      if (url.origin !== location.origin || tag === 'script' && target.type !== 'module') return
      // error 事件没有 HTTP 状态；不能把 429/503 当陈旧缓存重试。
      // 已失效的入口 hash 由服务器返回的恢复脚本准确处理。
      report('resource-error ' + url.pathname)
    } else if (event.error || event.message) {
      if (event.filename && new URL(event.filename, location.href).origin !== location.origin) return
      report(String(event.error && event.error.stack || event.message))
    }
  }, true)
  window.addEventListener('unhandledrejection', function (event) {
    if (mounted) return
    var reason = String(event.reason && event.reason.stack || event.reason || '')
    if (/Loading chunk|dynamically imported module|Importing a module script|module script failed/i.test(reason)) report(reason)
  })
})()

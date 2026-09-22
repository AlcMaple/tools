// 新播放页模板。视觉沿用「纱雾画稿」设计系统（web/public/styles/sketch-*.css），布局照旧页；
// 播放器换成 ArtPlayer，页面脚本只做三件事：拿地址 → 喂给播放器 → 出错时把原因和「重试」摆出来。
//
// 从旧页带过来的、已验证的坑（详见 docs/design/播放页重写方案.md 第四节）：
//   - CSP：不能写内联 style= 属性，状态切换只用 classList；脚本 / <style> 要 nonce；依赖全部自托管
//   - ArtPlayer 靠 style= 属性和运行时 <style> 布局，发不了 nonce：本页 style-src 放开 'unsafe-inline'（见 security.ts），脚本仍只认 nonce
//   - Referrer-Policy: no-referrer；<video> 不加 crossorigin
//   - iOS Chrome：innerHeight 比实际绘制区矮，手机布局按 100lvh；固定元素别用 env()
//   - 首播交给用户手势，不自动 play；断网只记位置，online 后同线路恢复一次，不换线
//   - 换集整页跳转（最省事、不残留上一集状态）
import { PLAYBACK_BEACON } from '../agent/playback-beacon'

export const PLAY_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>继续看</title>
<script nonce="__CSP_NONCE__">window.__PLAYER_MONITOR__ = __MONITOR_CONFIG__</script>
<script src="/api/player/vendor/monitor.js"></script>
<script src="/api/player/vendor/hls.js"></script>
<script src="/api/player/vendor/artplayer.js"></script>
<link rel="stylesheet" href="/styles/sketch-tokens.css">
<link rel="stylesheet" href="/styles/sketch-ui.css">
<style nonce="__CSP_NONCE__">
  .player-scroll { min-height: 100% }
  .sheet-wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; position: relative; z-index: 1 }
  @media (max-width: 960px) {
    html, body { width: 100%; height: 100%; height: 100lvh; min-height: 0; overflow: hidden }
    body { position: relative }
    .player-scroll { position: absolute; inset: 0; width: 100%; height: auto; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch }
    .player-scroll .sheet-wrap { min-height: 100%; padding-bottom: calc(60px + 100lvh - 100svh) }
  }
  .player-frame { position: relative; aspect-ratio: 16/9; background: #000; border: 1.5px solid var(--line-strong); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow-1) }
  #art { position: absolute; inset: 0 }
  .ep-badge-pill { display: inline-flex; align-items: center; font-family: var(--font-hand); font-size: 14px; color: var(--teal); background: var(--teal-wash); border: 1.5px solid var(--teal-line); border-radius: var(--r-pill); padding: 2px 12px; font-variant-numeric: tabular-nums }
  #err { display: none; align-items: center; gap: 12px; margin: 16px 0; padding: 10px 14px; border-radius: var(--r-card); font-size: 13px; font-weight: 600; background: var(--sakura-wash); border: 1.5px solid var(--sakura); color: #923d49 }
  #err.show { display: flex }
  #buf { display: none; margin-top: 8px; font-size: 12px; color: var(--ink-faint); font-variant-numeric: tabular-nums }
  #buf.show { display: block }
  #err-text { min-width: 0; flex: 1 }
  #err-retry, #auth-link { display: none }
  #err-retry.show, #auth-link.show { display: inline-flex }
  .src-seg > button.unbound { color: var(--ink-faint); border: 1.5px dashed var(--line); border-radius: var(--r-pill) }
  .lines-list { display: flex; flex-direction: column; gap: 10px; margin-top: 14px }
  .hd-row { align-items: flex-end }
  .player-title { font-size: 24px }
  .section-title { font-size: 18px }
  .icon-sprite { display: none }
  .ep-good-note { display: none; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px 14px; border-radius: var(--r-card); background: var(--gold-hl); border: 1.5px solid var(--gold); color: #6b5416; font-size: 13px; line-height: 1.6 }
  .ep-good-note.show { display: flex }
  .ep-good-note::before { content: '★'; flex: none; margin-top: 1px; color: var(--gold) }
</style>
</head>
<body data-page="player">
<div class="player-scroll">
<div class="sheet-wrap">
  <a class="btn btn-sm btn-ghost" href="/#/tracks">
    <svg class="ic ic-sm"><use href="#i-back"></use></svg>回到我的追番
  </a>
  <div class="spread hd-row mt16">
    <div>
      <h1 class="title-sketch player-title" id="ttl">继续看</h1>
      <p class="muted small mt8"><span class="ep-badge-pill font-hand" id="epbadge">EP</span></p>
    </div>
    <div class="seg src-seg" id="sources"></div>
  </div>
  <div class="ep-good-note" id="epgood"></div>
  <div class="player-frame mt16"><div id="art"></div></div>
  <div id="buf" aria-live="polite"></div>
  <div id="err" role="alert" aria-live="polite">
    <span id="err-text"></span>
    <button id="err-retry" class="btn btn-sm">重试</button>
    <a id="auth-link" class="btn btn-sm btn-ghost" href="/#/settings/xifan" target="_blank" rel="noopener">去登录</a>
  </div>
  <div class="spread mt24"><h2 class="title-sketch section-title">选集</h2></div>
  <div class="ep-grid mt16" id="eps"></div>
  <h2 class="title-sketch section-title mt24">线路</h2>
  <div class="lines-list" id="lines"></div>
</div>
</div>
<svg class="icon-sprite" aria-hidden="true"><symbol id="i-back" viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5"/></symbol></svg>
<script nonce="__CSP_NONCE__">
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var ARGS = __PAGE_ARGS__
  var sourceOptions = __PLAYER_SOURCES__
  var src = ARGS.src, id = ARGS.id, ep = ARGS.ep, bgmId = ARGS.bgmId
${PLAYBACK_BEACON}
  agentReport('page_ready', 'ep ' + ep)

  // ——— 日志：面包屑 + 带胶片上报 + 回终端 ———
  var TAPE_MAX = 30, tape = [], tapeTimer = null, tapeAt = 0
  function slog(msg, withTape){
    var reported = false
    try {
      if (window.playerMonitor){
        window.playerMonitor.breadcrumb(msg)
        if (withTape){ window.playerMonitor.report(msg, { tape: tape.slice() }); reported = true }
      }
    } catch (e) {}
    try {
      var payload = withTape && tape.length ? { msg: msg, tape: tape.slice() } : { msg: msg }
      if (reported) payload.sdk = 1
      var body = JSON.stringify(payload)
      if (navigator.sendBeacon) navigator.sendBeacon('/api/player/client-log', new Blob([body], { type: 'application/json' }))
      else fetch('/api/player/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
    } catch (e) {}
  }
  function snapshot(v){
    var ahead = 0
    for (var i = 0; i < v.buffered.length; i++)
      if (v.buffered.start(i) <= v.currentTime + .05 && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime
    return 't=' + (v.currentTime || 0).toFixed(1) + ' ahead=' + ahead.toFixed(1) + ' rs=' + v.readyState + ' ns=' + v.networkState
      + ' err=' + (v.error ? v.error.code : '-') + (v.paused ? ' paused' : '')
  }
  function startTape(v){
    if (tapeTimer !== null) clearInterval(tapeTimer)
    tape = []; tapeAt = performance.now()
    tapeTimer = setInterval(function(){
      tape.push(Math.round((performance.now() - tapeAt) / 100) / 10 + 's ' + snapshot(v))
      if (tape.length > TAPE_MAX) tape.shift()
    }, 2000)
  }

  // ——— 状态 ———
  var lines = [], eps = [], cur = null, resolved = {}, art = null, hls = null
  var goodEps = {}, goodNotes = {}
  var generation = 0
  var offlineAt = null, offlineTime = 0, offlineWasPlaying = false
  var RESUME_KEY = 'player:resume:' + src + ':' + id + ':' + ep
  // iOS 把后台标签页整个回收后浏览器会自己重载：进度和「当时在不在播」先记下，重载后从原地接着。
  function stashResume(){
    try {
      if (!art) return
      var v = art.video, t = v.currentTime || 0
      if (t > 1) sessionStorage.setItem(RESUME_KEY, JSON.stringify({ t: t, playing: !v.paused, at: Date.now() }))
    } catch (e) {}
  }
  function takeResume(){
    try {
      var raw = sessionStorage.getItem(RESUME_KEY)
      sessionStorage.removeItem(RESUME_KEY)
      var r = raw ? JSON.parse(raw) : null
      return r && r.t > 1 && Date.now() - r.at < 6 * 3600 * 1000 ? r : null
    } catch (e) { return null }
  }
  function mediaUrl(pl){
    return (pl.kind === 'hls' ? '/api/player/hls' : '/api/player/stream') + '?u=' + encodeURIComponent(pl.url) + '&s=' + pl.s
  }
  function fail(txt, code, retry){
    agentReport('failed', code || txt)
    $('err-text').textContent = txt
    $('auth-link').classList.toggle('show', code === 'XIFAN_AUTH_REQUIRED' || code === 'AUTH_REQUIRED')
    $('err-retry').classList.toggle('show', !!retry)
    $('err-retry').onclick = retry || null
    $('err').classList.add('show')
  }
  function clearFail(){ $('err').classList.remove('show'); $('err-retry').onclick = null }

  // ——— 播放器 ———
  function destroyPlayer(){
    generation++
    if (tapeTimer !== null){ clearInterval(tapeTimer); tapeTimer = null }
    if (stallTimer !== null){ clearInterval(stallTimer); stallTimer = null }
    $('buf').classList.remove('show')
    if (hls){ try { hls.destroy() } catch (e) {} hls = null }
    if (art){ try { art.destroy(false) } catch (e) {} art = null }
    $('art').textContent = ''
  }

  // ——— 卡住时要看得见：转圈 + 一行「缓冲中 · 领先 N 秒」———
  // ArtPlayer 自己的 loading 在 seeked / progress 一到就收（iOS 上 seeked 立刻就发、progress 一有字节就发），
  // 所以真卡住的时候它反而是不转的。这里按「没暂停、currentTime 一秒多没走」自己判，判到就把圈亮回去。
  var stallTimer = null, stallSince = 0, lastT = -1, lastTAt = 0, stallReported = false, bufOwned = false
  function aheadOf(v){
    for (var i = 0; i < v.buffered.length; i++)
      if (v.buffered.start(i) <= v.currentTime + .05 && v.buffered.end(i) >= v.currentTime) return v.buffered.end(i) - v.currentTime
    return 0
  }
  function setBuffering(v, on, label){
    var box = $('buf')
    // 只收自己亮起来的圈：起播前 ArtPlayer 在拿到时长之前一直转圈，看门狗每 500ms 判一次「暂停中 → 不算卡」，
    // 不加这个闸就会把那个圈掐掉，画面变成 00:00 / 00:00 的黑框干等（真机 2026-09-23）。
    if (!on){ box.classList.remove('show'); if (art && bufOwned) art.loading.show = false; bufOwned = false; return }
    var ahead = aheadOf(v)
    box.textContent = (label || '缓冲中') + ' · 第 ' + fmt(v.currentTime) + ' · 已缓冲 ' + ahead.toFixed(1) + ' 秒'
    box.classList.add('show')
    if (art) art.loading.show = true
    bufOwned = true
  }
  function fmt(t){ t = Math.max(0, Math.floor(t || 0)); var m = Math.floor(t / 60), s2 = t % 60; return m + ':' + (s2 < 10 ? '0' : '') + s2 }
  function startStallWatch(v){
    if (stallTimer !== null) clearInterval(stallTimer)
    stallSince = 0; lastT = -1; lastTAt = performance.now(); stallReported = false; bufOwned = false
    stallTimer = setInterval(function(){
      if (!art || art.video !== v) return
      var now = performance.now(), t = v.currentTime
      if (v.paused || v.ended){ if (!v.seeking) setBuffering(v, false); lastT = t; lastTAt = now; return }
      if (t !== lastT){
        if (stallSince && !stallReported && now - stallSince > 1500) slog('stall recovered after ' + Math.round(now - stallSince) + 'ms ' + snapshot(v))
        lastT = t; lastTAt = now; stallSince = 0; stallReported = false
        setBuffering(v, false)
        return
      }
      if (now - lastTAt < 1200) return
      if (!stallSince) stallSince = lastTAt
      setBuffering(v, true, '缓冲中')
      if (!stallReported && now - stallSince > 20000){ stallReported = true; slog('stall 20s ' + snapshot(v), true) }
    }, 500)
  }

  function mount(pl, resumeAt, autoplay){
    destroyPlayer()
    var gen = generation
    cur = pl; clearFail(); renderLines()
    agentReport('source_selected', 'line ' + pl.source + ' ' + pl.kind)
    slog('mount line=' + pl.source + ' kind=' + pl.kind + (resumeAt ? ' resume=' + resumeAt.toFixed(1) : ''))
    art = new Artplayer({
      container: '#art',
      url: mediaUrl(pl),
      type: pl.kind === 'hls' ? 'm3u8' : 'mp4',
      id: src + ':' + id + ':' + ep,
      autoplay: !!autoplay,
      playsInline: true,
      autoPlayback: !resumeAt,
      autoOrientation: true,
      setting: true,
      playbackRate: true,
      fullscreen: true,
      fullscreenWeb: true,
      hotkey: true,
      miniProgressBar: true,
      fastForward: true,
      lock: true,
      airplay: true,
      lang: 'zh-cn',
      theme: '#2f7d5e',
      customType: {
        m3u8: function(video, url){
          if (window.Hls && Hls.isSupported()){
            var noRetry = { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 }
            var policy = { default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000, timeoutRetry: noRetry, errorRetry: noRetry } }
            hls = new Hls({ maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 60,
              manifestLoadPolicy: policy, playlistLoadPolicy: policy, keyLoadPolicy: policy, fragLoadPolicy: policy })
            hls.on(Hls.Events.ERROR, function(e, data){
              if (gen === generation && data && data.fatal) onMediaError('hls ' + data.type + '/' + data.details)
            })
            hls.loadSource(url); hls.attachMedia(video)
          } else if (video.canPlayType('application/vnd.apple.mpegurl')){
            video.src = url
          } else {
            onMediaError('浏览器不支持 HLS')
          }
        }
      }
    })
    var v = art.video
    startTape(v)
    startStallWatch(v)
    agentWatch(v)
    if (resumeAt){
      v.addEventListener('loadedmetadata', function once(){
        v.removeEventListener('loadedmetadata', once)
        if (gen !== generation) return
        try { v.currentTime = Math.min(resumeAt, Number.isFinite(v.duration) ? Math.max(0, v.duration - .25) : resumeAt) } catch (e) {}
      })
    }
    art.on('video:canplay', function(){ agentReport('media_canplay') })
    art.on('video:playing', function(){ agentReport('media_canplay'); agentReport('playing') })
    // 只认**当前这台**播放器的错：换线 / 重试销毁旧实例时，旧 <video> 被清 src 也会冒一个 code=4，
    // 不挡就会把刚挂好的新播放器盖上一条「播放出错」（真机截图：能播、进度条正常，红框却在）。
    art.on('video:error', function(){
      if (gen !== generation || !v.error) return
      onMediaError('video code=' + v.error.code)
    })
    // 没起播前别转圈：ArtPlayer 在 canplay 之前一直显示 loading，可首播要等用户点，那不是「在加载」。
    art.on('ready', function(){ if (!autoplay) art.loading.show = false; agentReport('player_ready', 'line ' + pl.source) })
  }

  // 播放出错：不换线、不探测。只区分「断网」和「这条线路真坏了」，两种都给用户一个明确的出口。
  var autoRetries = 0
  function onMediaError(why){
    if (!cur || !art) return
    var v = art.video
    slog('media error ' + why + ' ' + snapshot(v) + ' url=' + cur.url, true)
    var at = v.currentTime || 0, pl = cur
    if (!navigator.onLine){ holdForNetwork(); return }
    // 源站建连慢时服务端偶尔还是会 502 → code=4。第一次别急着红框，等 2 秒自己重挂一次（保留进度），
    // 第二次才把「重试」交给用户。换线 / 换集会把计数清零。
    if (autoRetries < 1){
      autoRetries++
      setBuffering(v, true, '线路没响应，正在重试')
      setTimeout(function(){ if (cur === pl) mount(pl, at, true) }, 2000)
      return
    }
    fail('这条线路播放出错（' + why + '）', 'MEDIA_ERROR', function(){ autoRetries = 0; mount(pl, at, true) })
  }

  // ——— 断网：记住位置，online 后同线路恢复一次 ———
  function holdForNetwork(){
    if (!art || offlineAt !== null) return
    var v = art.video
    offlineAt = performance.now(); offlineTime = v.currentTime || 0; offlineWasPlaying = !v.paused
    try { v.pause() } catch (e) {}
    fail('网络已断开 · 恢复后接着播', 'OFFLINE', function(){ recover() })
  }
  function recover(){
    if (offlineAt === null || !cur) return
    var t = offlineTime, playing = offlineWasPlaying, pl = cur
    offlineAt = null
    fetch('/api/health?playback=1', { cache: 'no-store' }).then(function(r){
      if (!r.ok) throw new Error('health ' + r.status)
      clearFail(); mount(pl, t, playing)
    }).catch(function(){ offlineAt = performance.now(); offlineTime = t; offlineWasPlaying = playing })
  }
  window.addEventListener('offline', holdForNetwork)
  window.addEventListener('online', function(){ setTimeout(recover, 600) })
  window.addEventListener('pagehide', function(){ if (art){ try { art.video.pause() } catch (e) {} } stashResume() })
  // 后台挂久了回来只查一件确定的事：登录还在不在。过期就回追番页——不然接下来的媒体请求全是 401，
  // 用户只看到「播放出错」。视频本身不动：没坏就照常接着播，真坏了走上面原有的报错 / 自动重试。
  // 历史：09-21 曾「离开 3 分钟整页刷新」，没坏也刷新、要重新缓冲，已撤掉。
  var RETURN_CHECK_MS = 60 * 1000, hiddenAt = null
  function checkLogin(why){
    fetch('/api/player/alive', { cache: 'no-store' }).then(function(r){
      if (r.status === 401){ slog('return: session expired (' + why + ')'); location.href = '/#/tracks' }
    }).catch(function(){ /* 断网交给 offline / online 那套 */ })
  }
  window.addEventListener('pageshow', function(e){ if (e.persisted) checkLogin('bfcache') })
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden'){ hiddenAt = Date.now(); stashResume(); return }
    if (hiddenAt === null) return
    var away = Date.now() - hiddenAt; hiddenAt = null
    if (away >= RETURN_CHECK_MS) checkLogin('hidden ' + Math.round(away / 1000) + 's')
  })

  // ——— 线路 / 选集 / 源 ———
  var lineRequest = 0
  async function selectLine(source){
    if (cur && cur.source === source) return
    var req = ++lineRequest
    clearFail()
    var pl = resolved[source]
    if (!pl){
      try {
        var r = await fetch('/api/player/resolve?src=' + src + '&id=' + encodeURIComponent(id) + '&ep=' + ep + '&source=' + source, { cache: 'no-store' })
        var d = await r.json()
        if (!r.ok || !d.url) throw Object.assign(new Error(d.error || ('HTTP ' + r.status)), { code: d.code })
        pl = resolved[source] = d
      } catch (e){
        if (req !== lineRequest) return
        slog('resolve failed source=' + source + ' msg=' + (e && e.message))
        fail('线路 ' + source + ' 解析失败：' + (e && e.message), e && e.code, function(){ selectLine(source) })
        return
      }
    }
    if (req !== lineRequest) return
    autoRetries = 0
    mount(pl, 0, true)
  }
  function renderLines(){
    var box = $('lines'); box.textContent = ''
    lines.forEach(function(l){
      var b = document.createElement('button'); b.type = 'button'
      b.className = 'line-card' + (cur && l.source === cur.source ? ' on' : '')
      var dot = document.createElement('span'); dot.className = 'lc-dot'
      var name = document.createElement('span'); name.className = 'lc-name'
      name.textContent = '线路 ' + l.source + (l.name ? ' ' + l.name : '')
      b.appendChild(dot); b.appendChild(name)
      b.onclick = function(){ selectLine(l.source) }
      box.appendChild(b)
    })
  }
  function goEp(n){
    var q = new URLSearchParams({ src: src, id: id, ep: String(n) })
    if (bgmId) q.set('bgmId', String(bgmId))
    destroyPlayer(); location.search = '?' + q.toString()
  }
  function renderEps(){
    var box = $('eps'); box.textContent = ''
    if (!eps.length){ var one = document.createElement('div'); one.className = 'ep-cell on'; one.textContent = ep; box.appendChild(one); return }
    eps.forEach(function(n){
      var b = document.createElement('button'); b.type = 'button'
      b.className = 'ep-cell' + (n === ep ? ' on' : '') + (goodEps[n] ? ' good' : '')
      b.textContent = n
      b.onclick = function(){ if (n !== ep) goEp(n) }
      box.appendChild(b)
    })
  }
  // 源切换：绑定表给的是旧播放页地址，这里只借它的 animeId 换成新页地址。
  function renderSources(){
    var box = $('sources'); box.textContent = ''
    sourceOptions.forEach(function(s){
      var b = document.createElement('button'); b.type = 'button'
      b.className = (s.active ? 'on' : '') + (!s.href ? ' unbound' : '')
      b.textContent = s.label + (!s.href ? ' · 未关联' : '')
      if (s.active) b.setAttribute('aria-current', 'true')
      // href 由服务端 playerSourceOptions 直接生成（已是 /api/player/page?src=&id=&ep=&bgmId=），原样跳。
      // 早先这里还按旧播放页的 animeId 参数重新拼，拼出来 id 为空 → 整页变成一行 JSON「animeId 不合法」。
      else if (s.href) b.onclick = function(){ destroyPlayer(); location.assign(s.href) }
      else b.onclick = function(){ fail(s.label + ' 尚未关联，请回「我的追番」选择片源') }
      box.appendChild(b)
    })
  }
  function loadGoodEpisodes(){
    if (!bgmId) return Promise.resolve()
    return fetch('/api/tracks/' + bgmId + '/good-episodes', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null })
      .then(function(d){ if (!d) return; (d.goodEpisodes || []).forEach(function(n){ goodEps[n] = true }); goodNotes = d.goodEpisodeNotes || {} })
      .catch(function(){})
  }
  function renderGoodNote(){
    var box = $('epgood')
    if (!goodEps[ep]){ box.classList.remove('show'); box.textContent = ''; return }
    box.textContent = goodNotes[ep] ? ('这集我标过好看：' + goodNotes[ep]) : '这集我标过好看，就是没留下备注'
    box.classList.add('show')
  }

  async function boot(){
    renderSources()
    $('epbadge').textContent = 'EP ' + ep
    renderEps()
    var good = loadGoodEpisodes()
    try {
      var r = await fetch('/api/player/playlist?src=' + src + '&id=' + encodeURIComponent(id) + '&ep=' + ep, { cache: 'no-store' })
      var d = await r.json()
      if (!r.ok || d.error){ fail('加载失败：' + (d.error || r.status), d.code, boot); return }
      lines = d.lines || []; eps = d.eps || []
      if (d.title){ $('ttl').textContent = d.title; document.title = d.title + ' · EP' + ep }
      await good
      renderEps(); renderLines(); renderGoodNote()
      var resume = takeResume()
      if (resume) slog('resume from ' + resume.t.toFixed(1) + (resume.playing ? ' (was playing)' : ''))
      if (d.first){ resolved[d.first.source] = d.first; mount(d.first, resume ? resume.t : 0, !!(resume && resume.playing)) }
      else fail('这一集解析不到 —— 可能还没更新，点上面别的集试试', 'LINE_EMPTY')
    } catch (e){
      if (!navigator.onLine){ fail('网络已断开', 'OFFLINE', boot); return }
      fail('请求失败：' + (e && e.message || e), 'FETCH_FAILED', boot)
    }
  }
  boot()
})()
</script>
</body>
</html>`

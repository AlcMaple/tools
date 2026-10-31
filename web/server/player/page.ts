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
    <a class="btn btn-sm" href="/#/feedback?from=player" target="_blank" rel="noopener">反馈此问题</a>
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
      + ' err=' + (v.error ? v.error.code : '-') + (v.paused ? ' paused' : '') + (fillRate >= 0 ? ' fill=' + fillRate.toFixed(2) + 'x' : '')
  }
  // 下载速度按「每过 1 秒缓冲区多出几秒画面」算：≥1 才跟得上播放。比 Mbps 直接——不用知道码率，
  // 2026-10-10 iPhone 43 集不起播时 fill≈0.3x（家宽到香港被 cubic 压到 0.6Mbps，开 BBR 后好了）；服务器那边只看得到数据已交给 nginx。
  var fillRate = -1, fillEnd = -1, fillAt = 0
  function sampleFill(v){
    var now = performance.now(), end = v.currentTime + aheadOf(v)
    var full = Number.isFinite(v.duration) && end >= v.duration - 1
    if (fillEnd >= 0 && !full && !v.seeking && end >= fillEnd){
      fillRate = (end - fillEnd) / ((now - fillAt) / 1000)
      if (qos){ qos.fillSum += fillRate; qos.fillN++; if (fillRate < 1.2) qos.fillLow++ }
    } else if (full) fillRate = -1
    fillEnd = end; fillAt = now
  }
  function startTape(v){
    if (tapeTimer !== null) clearInterval(tapeTimer)
    tape = []; tapeAt = performance.now()
    fillRate = -1; fillEnd = -1
    tapeTimer = setInterval(function(){
      sampleFill(v)
      tape.push(Math.round((performance.now() - tapeAt) / 100) / 10 + 's ' + snapshot(v))
      if (tape.length > TAPE_MAX) tape.shift()
    }, 2000)
  }

  // ——— 状态 ———
  var lines = [], eps = [], cur = null, resolved = {}, art = null, hls = null, emptyLines = {}
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
  // Girigiri 的 HLS 由手机直连源站：源站允许本站跨域取播放表和分片，2026-10-12 真机同一时刻同几片对比
  // 直连 6.2Mbps、经本站 4.0Mbps，本站出口在高码率段（7~9Mbps）追不上。只走这一条，失败显示原因，不回退到经本站。
  function mediaUrl(pl){
    if (pl.localHash) return '/media-cache/' + pl.localHash + (pl.kind === 'hls' ? '/index.m3u8' : '')
    if (src === 'girigiri' && pl.kind === 'hls' && !pl.viaServer) return pl.url
    return (pl.kind === 'hls' ? '/api/player/hls' : '/api/player/stream') + '?u=' + encodeURIComponent(pl.url) + '&s=' + pl.s
  }
  // ——— 本地缓存：浏览器自己直连源站下整集写进 OPFS，<video> 经 SW 从本地读（public/media-cache-worker.js）———
  // 能不能直连读按源站（host）自动记：第一次碰到的源站先试一次，一个字节都没读到就因 HTTP / 跨域失败的记为不可用，
  // 7 天后再试。apn.moedot.net 跳到的联通网盘见到 Origin 头就 403，就是这样被记下来、继续走服务端。
  // TUNE 只调下载方式（2026-10-30 本机经代理实测），conns = 一片拆成几段 Range 并发，par = HLS 同时拉几片：
  //   play.xfvod.pro  mp4  单连接 20.5Mbps，6 连接合计 14Mbps
  //   ana.girigirilove.com  mp4  单连接 15.1Mbps，6 连接 14.7Mbps
  //   akua.girigirilove.com  HLS  单连接 9.8Mbps，6 连接 8.2Mbps；但一片只有 0.2~2MB、首字节 1.5~4 秒，顺序拉只有约 2Mbps
  //   dl.playxf.top  HLS  单连接 1.5Mbps、6 连接 23.6Mbps，按连接限速，码率约 4.2Mbps
  // 没列的源站 mp4 单连接顺序拉，HLS 同时拉 4 片。
  // SW 没接管本页、浏览器没 OPFS 时完全走原来的方式。本地这条出错就退回原方式，不再碰本地缓存。
  var TUNE = {
    'play.xfvod.pro': { conns: 1, par: 1 },
    'ana.girigirilove.com': { conns: 1, par: 1 },
    'akua.girigirilove.com': { conns: 1, par: 4 },
    'dl.playxf.top': { conns: 6, par: 1 }
  }
  var localOff = false, localComplete = false, cacheWorker = null, cacheTitle = '', nextQueued = false, dl = null
  function hostOf(url){ try { return new URL(url).hostname } catch (e) { return '' } }
  function tuneOf(pl){ return TUNE[hostOf(pl.url)] || (pl.kind === 'hls' ? { conns: 1, par: 4 } : { conns: 1, par: 1 }) }

  // ——— 线路速度：全站共享（服务端 line-speed.ts），按源站记、永久保留，只收真实直连下载的字节 ———
  // 播放列表顺带给出各线路的全站速度，新番打开就能排序，不用先解析试探。
  // 「这台设备连不上某源站」只记本机：同一源站有的运营商直连饿死、有的很快（AGENTS.md iPhone 事故）。
  // 它保留 7 天，因为被标记后不会再直连，没有新样本能纠正，换了网络也得有机会再试
  var BLOCK_KEY = 'mt-host-blocked', WEEK = 7 * 86400000, speeds = {}, speedSentAt = 0
  function readStore(k){ try { return JSON.parse(localStorage.getItem(k) || '{}') || {} } catch (e) { return {} } }
  function writeStore(k, o){ try { localStorage.setItem(k, JSON.stringify(o)) } catch (e) {} }
  function blockedHost(host){
    var r = readStore(BLOCK_KEY)[host]
    return !!(r && Date.now() - r.at < WEEK)
  }
  function noteSpeed(host, bps){
    // Girigiri 所有线路在同一个源站，没得挑，服务端也不收
    if (src !== 'xifan' || !host || !(bps > 0) || Date.now() - speedSentAt < 4000) return
    speedSentAt = Date.now()
    fetch('/api/player/line-speed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ src: src, host: host, bps: Math.round(bps) }), keepalive: true })
      .then(function(r){ if (!r.ok) slog('line speed rejected ' + host + ' ' + r.status) }, function(e){ slog('line speed post failed ' + (e && e.message)) })
  }
  function noteBlocked(host, why){
    if (!host) return
    var all = readStore(BLOCK_KEY)
    all[host] = { at: Date.now(), why: String(why).slice(0, 80) }
    writeStore(BLOCK_KEY, all)
    slog('host blocked ' + host + ' ' + why)
  }
  function mergeSpeeds(d){ if (d && d.speeds) for (var k in d.speeds) speeds[k] = d.speeds[k] }
  function lineSpeed(source){ return speeds[source] || 0 }
  function rankedLines(except, list){
    return (list || lines).map(function(l, i){ return { source: l.source, bps: lineSpeed(l.source), i: i } })
      .filter(function(x){ return x.source !== except && !(list ? false : emptyLines[x.source]) })
      .sort(function(a, b){ return b.bps - a.bps || a.i - b.i })
  }

  function localEligible(pl){
    if (localOff || pl.viaServer || (pl.kind !== 'mp4' && pl.kind !== 'hls')) return false
    if (blockedHost(hostOf(pl.url))) return false
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller || !navigator.storage || !navigator.storage.getDirectory) return false
    return typeof Worker !== 'undefined' && !!window.crypto && !!crypto.subtle
  }
  // 官方播放器实际播的是去掉 :8088 的 443（AGENTS.md），身份按 host + 路径，签名换了也认得出同一集。
  function directUrl(pl){
    var u = new URL(pl.url)
    if (u.hostname === 'play.xfvod.pro') u.port = ''
    return u
  }
  async function localJob(pl, n){
    var u = directUrl(pl)
    var key = u.hostname + u.pathname
    var digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key))
    var hash = Array.from(new Uint8Array(digest)).map(function(b){ return b.toString(16).padStart(2, '0') }).join('')
    var t = tuneOf(pl)
    return { hash: hash, key: key, url: u.toString(), kind: pl.kind, conns: t.conns, par: t.par, src: src, id: id, ep: n, bgmId: bgmId || null, title: cacheTitle }
  }
  async function prepareLocal(pl, seed){
    if (!localEligible(pl)) return pl
    try {
      var job = await localJob(pl, ep)
      if (seed && seed !== job.hash) job.seed = seed
      return Object.assign({}, pl, { localHash: job.hash, localJob: job })
    } catch (e) { slog('local cache skipped ' + (e && e.message)); return pl }
  }

  // ——— 同一个文件：mp4 长度相同，HLS 分片数和每片时长都相同，才算画面完全一致 ———
  // 读不到（走服务端的源站、请求失败）就当不是同一个文件，宁可不切。apn.moedot.net 跳去的网盘对浏览器
  // 一直不回（10-30 实测 20 秒以上才报错），每个请求最多等 4 秒；跨域被拒的源站顺手记为不能直连
  var prints = {}
  function peek(u, method){ return fetch(u, { method: method, cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(4000) }) }
  async function fingerprint(pl){
    var k = pl.source + ':' + pl.url
    if (prints[k] !== undefined) return prints[k]
    var fp = null
    try {
      if (blockedHost(hostOf(pl.url))) throw new Error('not direct')
      var u = directUrl(pl).toString()
      if (pl.kind === 'mp4'){
        var h = await peek(u, 'HEAD')
        var len = Number(h.headers.get('content-length'))
        if (h.ok && len > 0) fp = 'mp4:' + len
      } else {
        var text = await (await peek(u, 'GET')).text()
        if (text.indexOf('#EXT-X-STREAM-INF') >= 0){
          var ls = text.split('\\n'), at = ls.findIndex(function(l){ return l.indexOf('#EXT-X-STREAM-INF') === 0 })
          var sub = ls.slice(at + 1).find(function(l){ return l.trim() && l.charAt(0) !== '#' })
          text = await (await peek(new URL(sub.trim(), u).href, 'GET')).text()
        }
        var durs = text.split('\\n').filter(function(l){ return l.indexOf('#EXTINF:') === 0 })
          .map(function(l){ return parseFloat(l.slice(8)).toFixed(3) })
        if (durs.length) fp = 'hls:' + durs.length + ':' + durs.join(',')
      }
    } catch (e) {
      slog('fingerprint failed line=' + pl.source + ' ' + (e && e.message))
      if (e instanceof TypeError && navigator.onLine) noteBlocked(hostOf(pl.url), 'fingerprint ' + e.message)
    }
    prints[k] = fp
    return fp
  }

  function ensureWorker(){
    if (cacheWorker) return cacheWorker
    cacheWorker = new Worker('/media-cache-worker.js')
    cacheWorker.onmessage = function(e){
      var m = e.data
      if (m.type === 'log') slog(m.msg)
      else if (m.type === 'speed') noteSpeed(m.host, m.bps)
      else if (m.type === 'start' && cur && cur.localHash === m.hash) dl = { hash: m.hash, kind: m.kind, total: m.total, chunk: m.chunk, segs: m.segs, have: new Set(m.have) }
      else if (m.type === 'progress' && dl && dl.hash === m.hash) dl.have.add(m.chunk)
      else if (m.type === 'complete' && cur && cur.localHash === m.hash){ localComplete = true; queueNextEp() }
      else if (m.type === 'failed' && m.early && m.http && navigator.onLine && cur && cur.localHash === m.hash) noteBlocked(hostOf(cur.url), m.reason)
    }
    try { navigator.storage.persist() } catch (e) {}
    return cacheWorker
  }
  // 调用前播放器已经销毁（mount → destroyPlayer），这里才中止旧下载、开新的，顺序见 AGENTS.md。
  function switchDownload(pl){
    dl = null
    // 离线开播的那份没有下载任务、本来就是整集；其余换了线路都要等新的下载器报「下完」
    if (pl.localJob || !pl.localHash) localComplete = false
    if (pl.localJob) ensureWorker().postMessage({ type: 'job', priority: 'current', job: pl.localJob })
    else if (cacheWorker) cacheWorker.postMessage({ type: 'stop' })
  }
  // 这一集下完就下一集：只解析一次，失败只记一行，不重试。
  async function queueNextEp(){
    if (nextQueued || eps.indexOf(ep + 1) < 0) return
    nextQueued = true
    try {
      var r = await fetch('/api/player/playlist?src=' + src + '&id=' + encodeURIComponent(id) + '&ep=' + (ep + 1), { cache: 'no-store' })
      var d = await r.json()
      if (!r.ok || !d.first){ slog('local cache next ep skipped ' + (d.code || d.error || r.status)); return }
      mergeSpeeds(d)
      d.first = await pickFastest(d.first, ep + 1, d.lines || [])
      if (!localEligible(d.first)){ slog('local cache next ep not direct ' + d.first.kind); return }
      var job = await localJob(d.first, ep + 1)
      ensureWorker().postMessage({ type: 'job', priority: 'next', job: job })
    } catch (e) { slog('local cache next ep failed ' + (e && e.message)) }
  }

  // 本机下完的这一集，不管是哪条线路、哪个站下的：同一站同一番，或同一个 Bangumi 条目（稀饭 / Girigiri 互认）。
  // 联网开播时先查它，有就直接播，不再挑线路；断网 / 本站连不上时也靠它，没下完的缺口在断网时等不来。
  // 选集只列本机已下完的集，换集照常整页跳转（页面本身由 SW 的离线壳兜住）。
  function sameAnime(meta){ return (meta.src === src && String(meta.id) === String(id)) || (!!bgmId && String(meta.bgmId) === String(bgmId)) }
  async function findOffline(){
    if (!navigator.storage || !navigator.storage.getDirectory || !navigator.serviceWorker || !navigator.serviceWorker.controller) return null
    var top
    try { top = await (await navigator.storage.getDirectory()).getDirectoryHandle('media-cache') } catch (e) { return null }
    var hit = null, done = []
    for await (var entry of top.entries()){
      if (entry[1].kind !== 'directory') continue
      try {
        var meta = JSON.parse(await (await (await entry[1].getFileHandle('meta.json')).getFile()).text())
        if (!meta.complete || !sameAnime(meta)) continue
        if (done.indexOf(meta.ep) < 0) done.push(meta.ep)
        if (meta.ep === ep) hit = { hash: entry[0], meta: meta }
      } catch (e) {}
    }
    if (hit) hit.eps = done.sort(function(a, b){ return a - b })
    return hit
  }
  async function bootOffline(why){
    var hit = await findOffline()
    if (!hit) return false
    slog('offline play ' + why + ' hash=' + hit.hash.slice(0, 8))
    eps = hit.eps
    // 离线时的页面可能借自别的番（SW 离线壳），换源按钮是那一番的；换源本来也要联网，直接收起
    sourceOptions = []; renderSources()
    cacheTitle = hit.meta.title || ''
    if (cacheTitle){ $('ttl').textContent = cacheTitle; document.title = cacheTitle + ' · EP' + ep }
    renderEps(); renderLines(); renderGoodNote()
    localComplete = true
    var resume = takeResume()
    mount({ source: 0, kind: hit.meta.kind || 'mp4', url: hit.meta.key, localHash: hit.hash }, resume ? resume.t : 0, !!(resume && resume.playing))
    return true
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
  // ——— 卡顿汇总上报：每台播放器一条，PC 上几秒的短卡也进 Sentry ———
  // 「stall 20s」只在卡满 20 秒才报，PC 上反复「播 1~2 秒卡几秒」一条都不会进 Sentry（2026-10-06）。
  // 这里按次累计：跳进度后的等待单独算（那是在等源站下到新位置），其余的卡顿才是「不该卡」。
  // 消息固定成一句，Sentry 里聚成一个 Issue，数字放 extra。
  var qos = null
  function qosStart(line){
    qos = { line: line, mountAt: performance.now(), readyMs: -1, playAt: 0, startupMs: -1, stalls: 0, stallMs: 0, longest: 0,
      seeks: 0, seekMs: 0, seekLongest: 0, lastSeekAt: -1e9, fillSum: 0, fillN: 0, fillLow: 0, sent: false }
  }
  function qosStall(ms, since){
    if (!qos) return
    if (since - qos.lastSeekAt < 1500){ qos.seeks++; qos.seekMs += ms; qos.seekLongest = Math.max(qos.seekLongest, ms) }
    else { qos.stalls++; qos.stallMs += ms; qos.longest = Math.max(qos.longest, ms) }
  }
  function qosFlush(why){
    if (!qos || qos.sent) return
    if (stallSince) qosStall(performance.now() - stallSince, stallSince)
    var q = qos
    q.sent = true
    var bad = q.stalls > 0 || q.readyMs > 15000 || q.startupMs > 10000 || q.seekLongest > 10000
    var s1 = function(ms){ return (ms / 1000).toFixed(1) + 's' }
    var summary = 'stalls=' + q.stalls + ' stallTotal=' + s1(q.stallMs) + ' longest=' + s1(q.longest)
      + ' ready=' + (q.readyMs < 0 ? '-' : s1(q.readyMs)) + ' startup=' + (q.startupMs < 0 ? '-' : s1(q.startupMs)) + ' seekWaits=' + q.seeks + ' seekLongest=' + s1(q.seekLongest)
      + ' fill=' + (q.fillN ? (q.fillSum / q.fillN).toFixed(2) + 'x' : '-') + ' fillLow=' + q.fillLow + '/' + q.fillN
      + ' line=' + q.line + ' ep=' + ep + ' watched=' + s1(performance.now() - q.mountAt) + ' end=' + why
    slog('qos ' + summary)
    if (bad && window.playerMonitor){
      try { window.playerMonitor.report('playback qos', { summary: summary, stalls: q.stalls, stallTotalMs: Math.round(q.stallMs),
        longestMs: Math.round(q.longest), readyMs: Math.round(q.readyMs), startupMs: Math.round(q.startupMs), seekLongestMs: Math.round(q.seekLongest), fill: q.fillN ? +(q.fillSum / q.fillN).toFixed(2) : null, fillLow: q.fillLow, line: q.line, ep: ep }) } catch (e) {}
    }
  }

  function destroyPlayer(){
    qosFlush('switch')
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
        if (stallSince && now - stallSince > 1500) qosStall(now - stallSince, stallSince)
        lastT = t; lastTAt = now; stallSince = 0; stallReported = false
        setBuffering(v, false)
        watchSlow(v, now)
        return
      }
      watchSlow(v, now)
      if (now - lastTAt < 1200) return
      if (!stallSince) stallSince = lastTAt
      setBuffering(v, true, '缓冲中')
      if (!stallReported && now - stallSince > 20000){ stallReported = true; slog('stall 20s ' + snapshot(v), true) }
    }, 500)
  }

  // ——— 变慢就提前换：看下载领先播放多少秒。不到 30 秒且还在减少就在后台备好退路；不到 10 秒还没好转、
  // 或已经卡满 3 秒（起播前和跳转后的等待放宽到 8 秒，边下边播起播本来就要 1.4~10 秒）就切，从当前时间点、保持播放 / 暂停接着播 ———
  // 退路只能是画面完全一致的：同一个文件的其他线路，或同一条线路改走服务端（拉的是同一个文件）。
  // 不同压制版本同一时间点可能差几秒，只在下一集开始时按速度换。
  // 本地缓存时 <video> 自己的缓冲被浏览器限量，代表不了下载进度，按下载器报的已落盘块 / 片算
  // 「开始播了没」「上次跳转」自己记：qos 在页面藏到后台时会重开一份，不能拿它当依据
  var slow = null, triedLines = {}, switchAt = 0, playedGen = -1, seekAt = -1e9, pendingResume = 0, firstGen = -1
  function downloadAhead(v){
    if (!cur || !cur.localHash) return aheadOf(v)
    if (localComplete) return Infinity
    if (!dl || !Number.isFinite(v.duration) || v.duration <= 0) return aheadOf(v)
    var t = v.currentTime
    if (dl.kind === 'mp4'){
      var rate = dl.total / v.duration, at = t * rate, i = Math.floor(at / dl.chunk)
      while (dl.have.has(i)) i++
      return Math.max(0, (Math.min(dl.total, i * dl.chunk) - at) / rate)
    }
    var start = 0, k = 0
    while (k < dl.segs.length && start + dl.segs[k][1] <= t){ start += dl.segs[k][1]; k++ }
    var end = start
    while (k < dl.segs.length && dl.have.has(dl.segs[k][0])){ end += dl.segs[k][1]; k++ }
    return Math.max(0, end - t)
  }
  function watchSlow(v, now){
    if (!slow || slow.gen !== generation) slow = { gen: generation, hist: [], fb: null, preparing: false, switching: false }
    if (v.paused || playedGen !== generation || slow.switching) return
    var ahead = downloadAhead(v)
    slow.hist.push([now, ahead])
    while (now - slow.hist[0][0] > 5000) slow.hist.shift()
    var settled = now - slow.hist[0][0] >= 4000, before = slow.hist[0][1]
    var stalled = stallSince ? now - stallSince : 0
    var afterSeek = stallSince && stallSince - seekAt < 1500
    var stuck = stalled >= (afterSeek || firstGen !== generation ? 8000 : 3000)
    if ((settled && ahead < 30 && ahead < before - .5) || stuck) prepareFallback()
    // 已经卡住时不等同文件线路找完（要解析、要读文件信息），有同一条线路改走服务端就先切过去
    var fb = slow.fb || (stuck ? slow.server : null)
    if (fb && (stuck || (settled && ahead < 10 && ahead <= before))) switchFallback(v, ahead, fb)
  }
  async function prepareFallback(){
    var st = slow, pl = cur, gen = generation
    if (st.preparing) return
    st.preparing = true
    var direct = pl.localHash || (src === 'girigiri' && pl.kind === 'hls')
    if (direct && !pl.viaServer) st.server = Object.assign(plainOf(pl), { viaServer: true })
    var mine = await fingerprint(pl)
    if (gen !== generation) return
    if (mine){
      var base = lineSpeed(pl.source), tries = 0
      for (var x of rankedLines(pl.source)){
        if (triedLines[x.source] || (x.bps && base && x.bps <= base)) continue
        var cand = resolved[x.source]
        if (!cand){
          // 稀饭解析接口有限流：一次最多再解析两条
          if (tries >= 2) break
          tries++
          try { cand = await resolveSource(x.source, ep) } catch (e){ slog('fallback resolve failed source=' + x.source + ' ' + (e && e.message)); continue }
        }
        if (gen !== generation) return
        if (await fingerprint(cand) === mine){ st.fb = cand; break }
        slog('fallback line=' + x.source + ' not same file')
      }
    }
    if (gen !== generation) return
    if (!st.fb) st.fb = st.server || null
    slog('fallback ' + (st.fb ? 'ready line=' + st.fb.source + (st.fb.viaServer ? ' server' : '') : 'none') + ' from line=' + pl.source + ' fp=' + (mine ? mine.slice(0, 24) : '-'))
  }
  async function switchFallback(v, ahead, fb){
    var st = slow
    if (st.switching) return
    st.switching = true
    // 续播位置还没跳过去就卡住了（拿不到时长），按原本要去的位置接
    var from = cur, at = pendingResume || v.currentTime || 0, playing = !v.paused, gen = generation
    triedLines[from.source] = true
    slog('slow switch line=' + from.source + (from.localHash ? ' local' : '') + ' -> line=' + fb.source + (fb.viaServer ? ' server' : '')
      + ' t=' + at.toFixed(1) + ' ahead=' + ahead.toFixed(1) + ' stalled=' + (stallSince ? Math.round(performance.now() - stallSince) : 0) + 'ms')
    var next = fb.viaServer ? fb : await prepareLocal(fb, from.localHash)
    if (gen !== generation) return
    switchAt = performance.now()
    mount(next, at, playing)
  }
  function plainOf(pl){ var p = Object.assign({}, pl); delete p.localHash; delete p.localJob; return p }

  function mount(pl, resumeAt, autoplay){
    destroyPlayer()
    var gen = generation
    cur = pl; clearFail(); renderLines()
    switchDownload(pl)
    agentReport('source_selected', 'line ' + pl.source + ' ' + pl.kind)
    slog('mount line=' + pl.source + ' kind=' + pl.kind + (pl.localHash ? ' local' : '') + (resumeAt ? ' resume=' + resumeAt.toFixed(1) : ''))
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
            // 本地缓存的分片要等下载器整片落盘才回头，首字节天然比直连晚，放宽等待；不加重试。
            var policy = { default: { maxTimeToFirstByteMs: pl.localHash ? 30000 : 10000, maxLoadTimeMs: pl.localHash ? 45000 : 30000, timeoutRetry: noRetry, errorRetry: noRetry } }
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
    qosStart(pl.source)
    // ready = 打开到播放按钮可点（拿到时长）；startup = 点播放到画面开始走
    v.addEventListener('loadedmetadata', function(){ if (qos && qos.readyMs < 0) qos.readyMs = performance.now() - qos.mountAt })
    v.addEventListener('play', function(){ if (qos && !qos.playAt) qos.playAt = performance.now() })
    v.addEventListener('playing', function(){ if (qos && qos.playAt && qos.startupMs < 0) qos.startupMs = performance.now() - qos.playAt })
    if (switchAt){
      var t0 = switchAt
      switchAt = 0
      v.addEventListener('playing', function once(){ v.removeEventListener('playing', once); slog('slow switch playing after ' + Math.round(performance.now() - t0) + 'ms t=' + v.currentTime.toFixed(1)) })
    }
    v.addEventListener('seeking', function(){ seekAt = performance.now(); if (qos) qos.lastSeekAt = seekAt })
    v.addEventListener('play', function(){ if (gen === generation) playedGen = gen })
    v.addEventListener('playing', function(){ if (gen === generation) firstGen = gen })
    startTape(v)
    startStallWatch(v)
    agentWatch(v)
    pendingResume = resumeAt || 0
    if (resumeAt){
      v.addEventListener('loadedmetadata', function once(){
        v.removeEventListener('loadedmetadata', once)
        if (gen !== generation) return
        pendingResume = 0
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
  var autoRetries = 0, bootFirst = null
  function onMediaError(why){
    if (!cur || !art) return
    var v = art.video
    slog('media error ' + why + ' ' + snapshot(v) + ' url=' + cur.url, true)
    var at = v.currentTime || 0, pl = cur
    if (!navigator.onLine){ holdForNetwork(); return }
    if (pl.localHash && !pl.source && bootFirst){
      // 开播直接用了本机下完的那份（可能是别的线路 / 别的站下的），坏了就回到正常挑线路
      localOff = true
      var playing = !v.paused
      pickFastest(bootFirst, ep, lines).then(function(p){ mount(p, at, playing) })
      return
    }
    if (pl.localHash){
      localOff = true
      var plain = plainOf(pl)
      resolved[pl.source] = plain
      mount(plain, at, !v.paused)
      return
    }
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
    // 整集已经在本机：断网不影响播放，不打断
    if (cur && cur.localHash && localComplete) return
    var v = art.video
    offlineAt = performance.now(); offlineTime = v.currentTime || 0; offlineWasPlaying = !v.paused
    slog('offline t=' + offlineTime.toFixed(1))
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
  window.addEventListener('pagehide', function(){ qosFlush('leave'); if (art){ try { art.video.pause() } catch (e) {} } stashResume() })
  // 历史：09-21 曾「离开 3 分钟整页刷新」、之后又试过「回前台查登录」，都撤掉了——没坏也刷新要重新缓冲；
  // 刷新后看到一行 JSON 的真因（换源拼错地址、/page 未登录回 JSON）已在服务端修掉。
  // 这里只在藏到后台时记一下进度：iOS 回收整个标签页后浏览器自己重载，boot() 取回接着播。
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'hidden'){ stashResume(); qosFlush('hidden'); if (art && cur) qosStart(cur.source) } })

  // ——— 线路 / 选集 / 源 ———
  var lineRequest = 0
  async function selectLine(source){
    if (cur && cur.source === source) return
    var req = ++lineRequest
    clearFail()
    if (emptyLines[source]){ noEpisode(source); return }
    var pl = resolved[source]
    if (!pl){
      try {
        pl = await resolveSource(source, ep)
      } catch (e){
        if (req !== lineRequest) return
        slog('resolve failed source=' + source + ' msg=' + (e && e.message))
        if (e && e.code === 'LINE_EMPTY'){ emptyLines[source] = true; renderLines(); noEpisode(source); return }
        fail('线路 ' + source + ' 解析失败：' + (e && e.message), e && e.code, function(){ selectLine(source) })
        return
      }
    }
    if (req !== lineRequest) return
    autoRetries = 0
    pl = await prepareLocal(pl)
    if (req !== lineRequest) return
    mount(pl, 0, true)
  }
  async function resolveSource(source, n){
    if (n === ep && resolved[source]) return resolved[source]
    var r = await fetch('/api/player/resolve?src=' + src + '&id=' + encodeURIComponent(id) + '&ep=' + n + '&source=' + source, { cache: 'no-store' })
    var d = await r.json()
    if (!r.ok || !d.url){
      if (n === ep && d.code === 'LINE_EMPTY'){ emptyLines[source] = true; renderLines() }
      throw Object.assign(new Error(d.error || ('HTTP ' + r.status)), { code: d.code })
    }
    if (n === ep) resolved[source] = d
    return d
  }
  // 开播时只按速度挑：服务端给的第一条之外，只去解析比它明显快（记录快 15% 以上）的线路，最多两条，
  // 不把所有线路都解析一遍（稀饭解析接口有限流）。没有这一集的线路解析会失败，换下一条。
  // 6Mbps = 番剧 1080p 码率 2.7~4.2Mbps 留一倍余量。第一条已经够这个数就不换：全站速度表有误差，
  // 为 20 比 15 这种差距换线只会来回折腾；第一条还没测过时，已知的线路至少这么快才换过去，
  // 测过但更慢的线路不该压过没测过的
  var KNOWN_FAST = 6e6
  async function pickFastest(first, n, list){
    var base = lineSpeed(first.source), tries = 0
    if (base >= KNOWN_FAST) return first
    var bar = base ? base * 1.15 : KNOWN_FAST
    for (var x of rankedLines(first.source, list)){
      if (x.bps <= bar || tries >= 2) break
      tries++
      try {
        var pl = await resolveSource(x.source, n)
        if (lineSpeed(pl.source) > bar){
          slog('auto line ep' + n + ' ' + first.source + ' -> ' + pl.source + ' ' + (lineSpeed(pl.source) / 1e6).toFixed(1) + 'Mbps vs ' + (base / 1e6).toFixed(1))
          return pl
        }
      } catch (e){ slog('auto line resolve failed ep' + n + ' source=' + x.source + ' ' + (e && e.message)) }
    }
    return first
  }
  function lineName(source){
    var l = lines.find(function(x){ return x.source === source })
    return (l && l.name) || ('线路 ' + source)
  }
  function noEpisode(source){
    fail('「' + lineName(source) + '」没有第 ' + ep + ' 集，请选其他线路' + (cur ? '，当前继续播放「' + lineName(cur.source) + '」' : ''), 'LINE_EMPTY')
  }
  function renderLines(){
    var box = $('lines'); box.textContent = ''
    lines.forEach(function(l){
      var b = document.createElement('button'); b.type = 'button'
      b.className = 'line-card' + (cur && l.source === cur.source ? ' on' : '')
      var dot = document.createElement('span'); dot.className = 'lc-dot'
      var name = document.createElement('span'); name.className = 'lc-name'
      name.textContent = l.name || ('线路 ' + l.source)
      b.appendChild(dot); b.appendChild(name)
      if (emptyLines[l.source]){
        var meta = document.createElement('span'); meta.className = 'lc-meta'
        meta.textContent = '没有第 ' + ep + ' 集'
        b.appendChild(meta)
      }
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
      if (r.status >= 500 && await bootOffline('playlist ' + r.status)) return
      var d = await r.json()
      if (!r.ok || d.error){ fail('加载失败：' + (d.error || r.status), d.code, boot); return }
      lines = d.lines || []; eps = d.eps || []
      mergeSpeeds(d)
      cacheTitle = d.title || ''
      if (d.title){ $('ttl').textContent = d.title; document.title = d.title + ' · EP' + ep }
      await good
      renderEps(); renderLines(); renderGoodNote()
      var resume = takeResume()
      if (resume) slog('resume from ' + resume.t.toFixed(1) + (resume.playing ? ' (was playing)' : ''))
      bootFirst = d.first || null
      if (d.first) resolved[d.first.source] = d.first
      var have = await findOffline()
      if (have){
        slog('local done ep' + ep + ' from ' + have.meta.src + ':' + have.meta.id + ' hash=' + have.hash.slice(0, 8))
        localComplete = true
        mount({ source: 0, kind: have.meta.kind || 'mp4', url: have.meta.key, localHash: have.hash }, resume ? resume.t : 0, !!(resume && resume.playing))
        queueNextEp()
        return
      }
      if (d.first){
        resolved[d.first.source] = d.first
        var pick = await pickFastest(d.first, ep, lines)
        mount(await prepareLocal(pick), resume ? resume.t : 0, !!(resume && resume.playing))
      }
      else fail('这一集解析不到 —— 可能还没更新，点上面别的集试试', 'LINE_EMPTY')
    } catch (e){
      if (await bootOffline('playlist ' + (e && e.message))) return
      if (!navigator.onLine){ fail('网络已断开，这一集没有下载到本机', 'OFFLINE', boot); return }
      fail('请求失败：' + (e && e.message || e), 'FETCH_FAILED', boot)
    }
  }
  boot()
})()
</script>
</body>
</html>`

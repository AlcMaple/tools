// Girigiri 在线观看与追番定位 API。
//
// 播放页返回同源裸 HTML，视频地址仍由浏览器直接访问 Girigiri CDN；服务端只负责抓取
// 播放页的元数据和 player_aaaa，不承担视频流量。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { getSession } from './auth'
import { db } from './db'
import { bindingsFor, getBinding, putBinding } from './girigiri/bindings'
import { locate } from './girigiri/locate'
import {
  getGirigiriCaptcha,
  GIRIGIRI_SEARCH_MAX_LENGTH,
  searchGirigiri,
  verifyGirigiriCaptcha,
} from './girigiri/search'
import { BASE_URL, getPlaylist, isGirigiriId, resolveLine } from './girigiri/resolve'
import { playerPageSecurity, renderNonce } from './security'
import { parsePlayerBgmId, playerSourceOptions, serializePlayerSources } from './player-sources'

const girigiri = new Hono()

let hlsJsCache: string | null = null
girigiri.get('/hls.js', (c) => {
  if (!hlsJsCache) hlsJsCache = readFileSync(join(process.cwd(), 'node_modules/hls.js/dist/hls.min.js'), 'utf8')
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(hlsJsCache)
})

girigiri.get('/playlist', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const id = (c.req.query('animeId') ?? '').trim().toUpperCase()
  const ep = Number(c.req.query('ep') ?? '1')
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法（应为 GV 开头的编号）' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await getPlaylist(id, ep))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 播放页解析失败' }, 502)
  }
})

girigiri.get('/resolve', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const id = (c.req.query('animeId') ?? '').trim().toUpperCase()
  const ep = Number(c.req.query('ep') ?? '1')
  const source = Number(c.req.query('source') ?? '0')
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  if (!Number.isInteger(source) || source < 1) return c.json({ error: 'source 不合法' }, 400)
  try {
    const line = await resolveLine(id, ep, source)
    c.header('Cache-Control', 'no-store')
    return line ? c.json(line) : c.json({ error: '此线路解析不到这一集' }, 404)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 线路解析失败' }, 502)
  }
})

// 与稀饭的 source-page 保持同一点击链路：前端先打开本站地址，服务端确定默认线路后
// 302 到 Girigiri 源站。当前 Girigiri 播放页的默认线路仍是线路 1，失败时也明确回落。
girigiri.get('/source-page', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const id = (c.req.query('animeId') ?? '').trim().toUpperCase()
  const ep = Number(c.req.query('ep') ?? '1')
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法（应为 GV 开头的编号）' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)

  c.header('Cache-Control', 'no-store')
  try {
    const playlist = await getPlaylist(id, ep)
    const source = playlist.first?.source
    const selected = typeof source === 'number' && Number.isInteger(source) && source > 0 ? source : 1
    return c.redirect(`${BASE_URL}/play${id}-${selected}-${ep}/`, 302)
  } catch (error) {
    console.warn('[girigiri] 默认线路定位失败，回落线路 1：', error)
    return c.redirect(`${BASE_URL}/play${id}-1-${ep}/`, 302)
  }
})

girigiri.get('/play-page', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const id = (c.req.query('animeId') ?? '').trim().toUpperCase()
  const ep = Number(c.req.query('ep') ?? '1')
  const bgmIdRaw = c.req.query('bgmId')
  const bgmId = parsePlayerBgmId(bgmIdRaw)
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  if (bgmIdRaw && bgmId == null) return c.json({ error: 'bgmId 不合法' }, 400)
  c.header('Cache-Control', 'no-store')
  const sources = serializePlayerSources(playerSourceOptions('girigiri', id, ep, bgmId))
  const page = renderNonce(PLAY_PAGE.replace('__PLAYER_SOURCES__', sources))
  playerPageSecurity(c, page.nonce)
  return c.html(page.html)
})

// 搜索验证码会话按 MapleTools 用户隔离；不登录不开放站点搜索代理。
girigiri.get('/captcha', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await getGirigiriCaptcha(session.uid))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 验证码请求失败' }, 502)
  }
})

girigiri.post('/captcha/verify', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown }
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code || code.length > 32) return c.json({ error: '验证码格式不合法' }, 400)
  try {
    return c.json(await verifyGirigiriCaptcha(session.uid, code))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 验证码校验失败' }, 502)
  }
})

girigiri.post('/search', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { keyword?: unknown }
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
  if (!keyword) return c.json({ error: '请输入搜索词' }, 400)
  if (keyword.length > GIRIGIRI_SEARCH_MAX_LENGTH) {
    return c.json({ error: `搜索词不能超过 ${GIRIGIRI_SEARCH_MAX_LENGTH} 个字符` }, 400)
  }
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await searchGirigiri(session.uid, keyword))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 搜索失败' }, 502)
  }
})

girigiri.post('/locate', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; titles?: unknown; rebind?: unknown }
  const bgmId = Number(body.bgmId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const titles = Array.isArray(body.titles) ? body.titles.filter((title): title is string => typeof title === 'string') : []
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await locate(bgmId, titles, { rebind: body.rebind === true }))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Girigiri 周表请求失败' }, 502)
  }
})

girigiri.post('/bind', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; girigiriId?: unknown; girigiriName?: unknown }
  const bgmId = Number(body.bgmId)
  const id = typeof body.girigiriId === 'string' ? body.girigiriId.trim().toUpperCase() : ''
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  if (!isGirigiriId(id)) return c.json({ error: 'girigiriId 不合法' }, 400)
  putBinding(bgmId, id, String(body.girigiriName ?? '').slice(0, 200))
  return c.json({ ok: true, binding: getBinding(bgmId) })
})

girigiri.get('/bindings', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ data: {} })
  const rows = db.prepare('SELECT bgm_id FROM tracks WHERE user_id = ?').all(session.uid) as { bgm_id: number }[]
  return c.json({ data: bindingsFor(rows.map((row) => row.bgm_id)) })
})

export default girigiri

// 视觉照「纱雾画稿 Sagiri Sketchfolio」设计系统（docs/design-mockups/web/anime-sketchfolio/player.html）：
// tokens/组件 CSS 引用同一份静态副本（web/public/styles/，见该目录文件头注释），与 xifan 播放页同一套。
const PLAY_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>继续看 · Girigiri</title>
<script src="/api/girigiri/hls.js"></script>
<link rel="stylesheet" href="/styles/sketch-tokens.css">
<link rel="stylesheet" href="/styles/sketch-ui.css">
<style nonce="__CSP_NONCE__">
  .sheet-wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 60px; position: relative; z-index: 1 }
  .player-frame { position: relative; aspect-ratio: 16/9; background: #000; border: 1.5px solid var(--line-strong); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow-1) }
  video, iframe.player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; display: none }
  /* video/iframe/err 用 classList 切换而不是 JS 里直接写 el.style.display —— 后者是内联样式，
     同样受 style-src 这条 CSP 约束，没有 nonce/hash 会被浏览器悄悄吞掉，表现成「怎么切都不生效」。 */
  video.on, iframe.player.on { display: block }
  .ep-badge-pill { display: inline-flex; align-items: center; font-family: var(--font-hand); font-size: 14px; color: var(--teal); background: var(--teal-wash); border: 1.5px solid var(--teal-line); border-radius: var(--r-pill); padding: 2px 12px; font-variant-numeric: tabular-nums }
  #err { display: none; align-items: center; gap: 12px; margin: 16px 0; padding: 10px 14px; border-radius: var(--r-card); font-size: 13px; font-weight: 600; background: var(--sakura-wash); border: 1.5px solid var(--sakura); color: #923d49 }
  #err.show { display: flex }
  #err.retryable { cursor: pointer }
  .src-seg > button.unbound { color: var(--ink-faint); border: 1.5px dashed var(--line); border-radius: var(--r-pill) }
  .lines-list { display: flex; flex-direction: column; gap: 10px; margin-top: 14px }
  /* CSP style-src 不放行内联 style 属性（nonce 只保护 <style>/<script> 标签本身），
     所以原型稿里随手写的内联字号/对齐这里都得落成类。 */
  .hd-row { align-items: flex-end }
  .player-title { font-size: 24px }
  .section-title { font-size: 18px }
  .icon-sprite { display: none }
  /* 好看集提示条：这集是不是我标过的，不用 hover——手机上根本没有 hover。
     文字可能比较长（备注），不截断、正常换行，卡片跟着撑高。 */
  .ep-good-note { display: none; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px 14px; border-radius: var(--r-card); background: var(--gold-hl); border: 1.5px solid var(--gold); color: #6b5416; font-size: 13px; line-height: 1.6; }
  .ep-good-note.show { display: flex }
  .ep-good-note::before { content: '★'; flex: none; margin-top: 1px; color: var(--gold); }
</style>
</head>
<body data-page="player">
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
  <div class="player-frame mt16">
    <video id="v" controls playsinline preload="auto"></video>
    <iframe id="frame" class="player" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"></iframe>
  </div>
  <div id="err"></div>
  <div class="spread mt24">
    <h2 class="title-sketch section-title">选集</h2>
  </div>
  <div class="ep-grid mt16" id="eps"></div>
  <h2 class="title-sketch section-title mt24">线路</h2>
  <div class="lines-list" id="lines"></div>
</div>
<svg class="icon-sprite" aria-hidden="true"><symbol id="i-back" viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5"/></symbol></svg>
<script nonce="__CSP_NONCE__">
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var q = new URLSearchParams(location.search)
  var animeId = q.get('animeId') || ''
  var ep = q.get('ep') || '1'
  var bgmId = q.get('bgmId') || ''
  var sourceOptions = __PLAYER_SOURCES__
  var v = $('v'), frame = $('frame')
  var lines = [], eps = [], curPl = null, resolvedMap = {}, hls = null, lineRequest = 0, playGeneration = 0
  var goodEps = {}, goodNotes = {}
  var networkInterrupted = false, networkCheck = null, networkRetry = null, failureGeneration = -1
  var resumeTime = 0, resumeWasPlaying = false, resumePending = false, resumeKey = '', recoverTimer = null

  window.addEventListener('pagehide', function(){ stopAll() })
  window.addEventListener('pageshow', function(e){ if (e.persisted) location.reload() })
  window.addEventListener('offline', function(){ rememberNetworkPosition(); networkInterrupted = true })
  window.addEventListener('online', function(){
    if (!networkInterrupted){ resumePending = false; resumeWasPlaying = false; return }
    if (recoverTimer !== null) clearTimeout(recoverTimer)
    var attempt = async function(second){
      recoverTimer = null
      if (!networkInterrupted) return
      if (await checkNetwork()){ recoverCurrentLine(); return }
      if (!second) recoverTimer = setTimeout(function(){ attempt(true) }, 3000)
    }
    recoverTimer = setTimeout(function(){ attempt(false) }, 600)
  })

  function fail(txt){ var e = $('err'); e.textContent = txt; e.classList.add('show') }
  function clearFail(){ var e = $('err'); e.classList.remove('show', 'retryable'); e.onclick = null }
  function inFrame(){ return frame.classList.contains('on') }
  function rememberNetworkPosition(){
    if (Number.isFinite(v.currentTime)) resumeTime = v.currentTime
    resumeWasPlaying = resumeWasPlaying || !v.paused
    resumePending = true
    resumeKey = (curPl ? curPl.source : 'none') + ':' + ep
  }
  function checkNetwork(){
    if (!navigator.onLine) return Promise.resolve(false)
    if (networkCheck) return networkCheck
    var controller = new AbortController()
    var timeout = setTimeout(function(){ controller.abort() }, 3000)
    networkCheck = fetch('/api/health?playback=1', { cache: 'no-store', signal: controller.signal })
      .then(function(r){ return r.ok })
      .catch(function(){ return false })
      .finally(function(){ clearTimeout(timeout); networkCheck = null })
    return networkCheck
  }
  function holdForNetwork(retry){
    rememberNetworkPosition()
    networkInterrupted = true
    if (retry) networkRetry = retry
    try { v.pause() } catch (e) {}
    fail('网络已断开，恢复后继续当前线路（点击此处可重试）')
    var box = $('err'); box.classList.add('retryable')
    box.onclick = function(){ checkNetwork().then(function(online){ if (online) recoverCurrentLine() }) }
  }
  function classifyMediaFailure(fallback, retry){
    var generation = playGeneration
    if (failureGeneration === generation) return
    if (!navigator.onLine){ holdForNetwork(retry); return }
    failureGeneration = generation
    checkNetwork().then(function(online){
      if (generation !== playGeneration) return
      if (online) fallback()
      else holdForNetwork(retry)
    }).finally(function(){ if (failureGeneration === generation) failureGeneration = -1 })
  }
  function recoverCurrentLine(){
    if (!networkInterrupted) return
    var retry = networkRetry
    var pl = curPl
    networkInterrupted = false; networkRetry = null; clearFail()
    if (retry) retry()
    else if (pl) playLine(pl)
  }
  v.addEventListener('loadedmetadata', function(){
    if (!resumePending) return
    if (resumeKey !== (curPl ? curPl.source : 'none') + ':' + ep){ resumePending = false; resumeWasPlaying = false; return }
    try { v.currentTime = Math.min(resumeTime, Number.isFinite(v.duration) ? Math.max(0, v.duration - .25) : resumeTime) } catch (e) {}
    if (resumeWasPlaying){ var rp = v.play(); if (rp && rp.catch) rp.catch(function(){}) }
  })
  v.addEventListener('playing', function(){ resumePending = false; resumeWasPlaying = false; networkInterrupted = false })
  function destroyHls(){ if (hls){ try { hls.destroy() } catch (e) {} hls = null } }
  function stopAll(){ playGeneration++; destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load(); frame.src = 'about:blank' }
  function renderSources(){
    var box = $('sources'); box.textContent = ''
    sourceOptions.forEach(function(source){
      var control = document.createElement('button')
      control.type = 'button'
      control.className = (source.active ? 'on' : '') + (!source.href ? ' unbound' : '')
      control.textContent = source.label + (!source.href ? ' · 未关联' : '')
      control.title = source.href ? source.label : source.label + ' 尚未关联，请先在“我的追番”选择片源'
      if (source.active) control.setAttribute('aria-current', 'true')
      else if (source.href) control.onclick = function(){ stopAll(); location.assign(source.href) }
      else control.onclick = function(){ fail(source.label + ' 尚未关联，请回“我的追番”选择片源') }
      box.appendChild(control)
    })
  }
  function renderChips(){
    var box = $('lines'); box.textContent = ''
    lines.forEach(function(l){
      var b = document.createElement('button')
      b.type = 'button'
      b.className = 'line-card' + (curPl && l.source === curPl.source ? ' on' : '')
      var dot = document.createElement('span'); dot.className = 'lc-dot'
      var name = document.createElement('span'); name.className = 'lc-name'
      name.textContent = '线路 ' + l.source + (l.name ? ' ' + l.name : '')
      b.appendChild(dot); b.appendChild(name)
      b.onclick = function(){ selectLine(l.source) }
      box.appendChild(b)
    })
  }
  function officialPage(){ return 'https://ani.girigirilove.com/play' + animeId + '-' + (curPl ? curPl.source : 1) + '-' + ep + '/' }
  function embed(){
    curPl = curPl || { source: 1 }
    destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load()
    v.classList.remove('on'); frame.classList.add('on'); renderChips(); frame.src = officialPage()
  }
  v.addEventListener('error', function(){
    if (!curPl || inFrame() || !v.getAttribute('src')) return
    var failed = curPl
    classifyMediaFailure(function(){ embed() }, function(){ playLine(failed) })
  })
  function playLine(pl){
    curPl = pl; clearFail(); stopAll(); renderChips()
    v.classList.add('on'); frame.classList.remove('on')
    if (pl.kind === 'hls'){
      if (window.Hls && Hls.isSupported()){
        var noRetry = { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 }
        hls = new Hls({
          maxBufferLength: 90,
          maxMaxBufferLength: 120,
          maxBufferSize: 96 * 1000 * 1000,
          backBufferLength: 60,
          manifestLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000,
            timeoutRetry: noRetry, errorRetry: noRetry
          } },
          playlistLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000,
            timeoutRetry: noRetry, errorRetry: noRetry
          } },
          keyLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 30000,
            timeoutRetry: noRetry, errorRetry: noRetry
          } },
          fragLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 30000,
            timeoutRetry: noRetry,
            errorRetry: noRetry
          } }
        })
        hls.on(Hls.Events.ERROR, function(e, data){
          if (data && data.fatal) classifyMediaFailure(function(){ embed() }, function(){ playLine(pl) })
        })
        hls.loadSource(pl.url); hls.attachMedia(v)
        var pp = v.play(); if (pp && pp.catch) pp.catch(function(){})
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = pl.url; var np = v.play(); if (np && np.catch) np.catch(function(){})
      } else embed()
    } else {
      v.src = pl.url; v.load(); var mp = v.play(); if (mp && mp.catch) mp.catch(function(){})
    }
  }
  async function selectLine(source){
    if (curPl && curPl.source === source && !inFrame() && !networkInterrupted) return
    var request = ++lineRequest
    clearFail()
    stopAll()
    var pl = resolvedMap[source]
    if (!pl){
      try {
        var r = await fetch('/api/girigiri/resolve?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep) + '&source=' + source)
        var d = await r.json()
        if (!r.ok || !d || d.error || !d.url){ if (request === lineRequest) fail(d && d.error ? d.error : '这条线路解析不到'); return }
        pl = d; resolvedMap[source] = pl
      } catch (e){
        if (request !== lineRequest) return
        classifyMediaFailure(
          function(){ if (request === lineRequest) fail('解析请求失败：' + (e && e.message || e)) },
          function(){ if (request === lineRequest) selectLine(source) }
        )
        return
      }
    }
    if (request !== lineRequest) return
    playLine(pl)
  }
  function goEp(n){
    if (n < 1) return
    var next = new URLSearchParams({ animeId: animeId, ep: String(n) })
    if (/^[0-9]+$/.test(bgmId)) next.set('bgmId', bgmId)
    stopAll(); location.search = '?' + next.toString()
  }
  function renderEps(){
    var box = $('eps'); box.textContent = ''; var cur = Number(ep) || 1
    if (!eps.length){ var one = document.createElement('div'); one.className = 'ep-cell on'; one.textContent = cur; box.appendChild(one); return }
    eps.forEach(function(n){ var b = document.createElement('button'); b.type = 'button'; b.className = 'ep-cell' + (n === cur ? ' on' : '') + (goodEps[n] ? ' good' : ''); b.textContent = n; b.onclick = function(){ if (n !== cur) goEp(n) }; box.appendChild(b) })
  }
  // 这集是不是我标过的好看集——不用 hover（手机没有 hover），直接常驻在播放框上方一条。
  // 没登录 / 没带 bgmId / 没追这部番时接口都只返回空，安安静静不显示，不算错误。
  function loadGoodEpisodes(){
    if (!/^[0-9]+$/.test(bgmId)) return Promise.resolve()
    return fetch('/api/tracks/' + bgmId + '/good-episodes', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null })
      .then(function(d){
        if (!d) return
        ;(d.goodEpisodes || []).forEach(function(n){ goodEps[n] = true })
        goodNotes = d.goodEpisodeNotes || {}
      })
      .catch(function(){})
  }
  function renderGoodNote(){
    var box = $('epgood')
    var cur = Number(ep) || 1
    if (!goodEps[cur]){ box.classList.remove('show'); box.textContent = ''; return }
    var note = goodNotes[cur]
    box.textContent = note ? ('这集我标过好看：' + note) : '这集我标过好看，就是没留下备注'
    box.classList.add('show')
  }
  async function boot(){
    if (!/^GV[0-9]+$/i.test(animeId) || !/^[0-9]+$/.test(ep)){ fail('URL 参数不合法'); return }
    renderSources()
    $('epbadge').textContent = 'EP ' + ep; renderEps()
    var goodPromise = loadGoodEpisodes()
    try {
      var r = await fetch('/api/girigiri/playlist?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep))
      var d = await r.json()
      if (!r.ok || d.error){ fail('加载失败：' + (d.error || 'Girigiri 播放页解析失败')); return }
      lines = d.lines || []; eps = d.eps || []; if (d.title) $('ttl').textContent = d.title
      await goodPromise
      renderEps(); renderChips(); renderGoodNote()
      if (d.first){ resolvedMap[1] = d.first; playLine(d.first) } else fail('这一集解析不到，点上面其他线路试试')
    } catch (e){
      classifyMediaFailure(
        function(){ fail('请求失败：' + (e && e.message || e)) },
        function(){ boot() }
      )
    }
  }
  boot()
})();
</script>
</body>
</html>`

// 稀饭在线观看 —— 懒加载播放器（用户 2026-07-21 定：不并行、不自动选最优）。
//
//   GET  /api/xifan/playlist?animeId=&ep=          → 一次抓取：线路 1 地址 + 全部线路名单
//   GET  /api/xifan/resolve?animeId=&ep=&source=N  → 用户手动点线路 N 时才解析那一条
//   GET  /api/xifan/play-page?animeId=&ep=         → 播放器页（默认播线路 1，直连失败套娃兜底）
//   GET  /api/xifan/hls.js                         → 自托管 hls.js（不走可能被墙的 jsdelivr）
//   POST /api/xifan/locate                         → bgmId + 标题 → 稀饭候选（周表免验证码匹配，见 locate.ts）
//   GET  /api/xifan/captcha                      → 全站搜索验证码图片（按登录用户隔离 cookie）
//   POST /api/xifan/captcha/verify               → 校验全站搜索验证码
//   POST /api/xifan/search                       → 搜索非周历稀饭资源（需要先过验证码）
//   POST /api/xifan/bind                           → 用户点候选确认，落库绑定（要登录）
//   GET  /api/xifan/bindings                       → 当前用户追番已建的绑定，页面加载时一次拿齐（要登录）
//
// 播放器页是「服务端返回的一张裸 HTML」，跟生产 SPA 同源，<video> 加载源 CDN 就是跨源＝真实场景。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getPlaylist, resolveLine, XifanBusyError, XifanUpstreamError } from './xifan/resolve'
import { locate } from './xifan/locate'
import { getBinding, putBinding, bindingsFor } from './xifan/bindings'
import { getXifanCaptcha, searchXifan, verifyXifanCaptcha, XIFAN_SEARCH_MAX_LENGTH } from './xifan/search'
import { getSession } from './auth'
import { db } from './db'
import { playerPageSecurity, renderNonce } from './security'

const xifan = new Hono()

function upstreamFailure(c: Context, error: unknown, fallback: string): Response {
  const message = error instanceof Error ? error.message : fallback
  if (error instanceof XifanBusyError) {
    c.header('Retry-After', String(error.retryAfterSec))
    return c.json({ error: message }, 429)
  }
  if (error instanceof XifanUpstreamError) {
    c.header('X-Upstream-Status', String(error.status))
    if (error.status === 429) {
      if (error.retryAfterSec !== null) c.header('Retry-After', String(error.retryAfterSec))
      return c.json({ error: message, upstreamStatus: error.status }, 429)
    }
    return c.json({ error: message, upstreamStatus: error.status }, 502)
  }
  return c.json({ error: message }, 502)
}

// 自托管 hls.js —— 不走 jsdelivr（国内无魔法可能加载不到）。首次请求读一次、进程内缓存。
let hlsJsCache: string | null = null
xifan.get('/hls.js', (c) => {
  if (!hlsJsCache) hlsJsCache = readFileSync(join(process.cwd(), 'node_modules/hls.js/dist/hls.min.js'), 'utf8')
  c.header('Content-Type', 'application/javascript; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=86400')
  return c.body(hlsJsCache)
})

// 打开播放页：一次抓 source 1 → 线路 1 地址 + 全部线路名单（不碰线路 2/3）
xifan.get('/playlist', async (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法（要纯数字，如 3543）' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  c.header('Cache-Control', 'no-store')
  try {
    return c.json(await getPlaylist(animeId, ep))
  } catch (error) {
    return upstreamFailure(c, error, '稀饭播放页解析失败')
  }
})

// 用户手动点线路 N：只抓那一条
xifan.get('/resolve', async (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  const source = Number(c.req.query('source') ?? '0')
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  if (!Number.isInteger(source) || source < 1) return c.json({ error: 'source 不合法' }, 400)
  c.header('Cache-Control', 'no-store')
  try {
    const line = await resolveLine(animeId, ep, source)
    return line ? c.json(line) : c.json({ error: '此线路解析不到（可能此线路没有这一集）' }, 404)
  } catch (error) {
    return upstreamFailure(c, error, '稀饭线路解析失败')
  }
})

xifan.get('/play-page', (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  c.header('Cache-Control', 'no-store')
  const page = renderNonce(PLAY_PAGE)
  playerPageSecurity(c, page.nonce)
  // pan.wo 的下载响应带 attachment；保持来源信息时 Chromium 会把它判成不可播放媒体。
  // 稀饭自己的 player.moedot 页面同样用 no-referrer，复测后可让 <video> 正常直连。
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(page.html)
})

// 全站搜索的验证码 / cookie 会话按登录用户隔离；不登录就不能把服务器当成匿名搜索代理。
xifan.get('/captcha', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await getXifanCaptcha(session.uid))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : '验证码请求失败' }, 502)
  }
})

xifan.post('/captcha/verify', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown }
  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!code || code.length > 32) return c.json({ error: '验证码格式不合法' }, 400)
  try {
    return c.json(await verifyXifanCaptcha(session.uid, code))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : '验证码校验失败' }, 502)
  }
})

xifan.post('/search', async (c) => {
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { keyword?: unknown }
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
  if (!keyword) return c.json({ error: '请输入搜索词' }, 400)
  if (keyword.length > XIFAN_SEARCH_MAX_LENGTH) {
    return c.json({ error: `搜索词不能超过 ${XIFAN_SEARCH_MAX_LENGTH} 个字符` }, 400)
  }
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await searchXifan(session.uid, keyword))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : '稀饭搜索失败' }, 502)
  }
})

// 定位：bgmId + 追番标题 → 周表候选（或已绑定则直接给 bound）。不写库、不要登录（纯解析）。
xifan.post('/locate', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; titles?: unknown }
  const bgmId = Number(body.bgmId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const titles = Array.isArray(body.titles) ? body.titles.filter((t): t is string => typeof t === 'string') : []
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await locate(bgmId, titles))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : '周表请求失败' }, 502)
  }
})

// 建绑定：用户点候选确认才走这条，落库（全局表）。要登录 —— 防匿名乱写别人也会命中的全局绑定。
xifan.post('/bind', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ error: '未登录' }, 401)
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; xifanId?: number; xifanName?: string }
  const bgmId = Number(body.bgmId)
  const xifanId = Number(body.xifanId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  if (!Number.isInteger(xifanId) || xifanId <= 0) return c.json({ error: 'xifanId 不合法' }, 400)
  putBinding(bgmId, xifanId, String(body.xifanName ?? '').slice(0, 200))
  return c.json({ ok: true, binding: getBinding(bgmId) })
})

// 当前用户追番里已建的绑定，一次拿齐（前端据此把绑过的「继续看」直接渲染成链接）。
xifan.get('/bindings', async (c) => {
  const s = await getSession(c)
  if (!s) return c.json({ data: {} }) // 未登录没有追番，空即可，不当错误
  const rows = db.prepare('SELECT bgm_id FROM tracks WHERE user_id = ?').all(s.uid) as { bgm_id: number }[]
  return c.json({ data: bindingsFor(rows.map((r) => r.bgm_id)) })
})

export default xifan

// 播放器页 —— 客户端 JS 只用字符串拼接（不用模板串），避开外层模板串的 ${}。<video> 不加 crossorigin。
const PLAY_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>继续看 · 稀饭</title>
<script src="/api/xifan/hls.js"></script>
<style nonce="__CSP_NONCE__">
  /* 配色对齐 app / web 暗色主题：玫瑰粉主色（--color-primary 的 dark 版）+ 分层深色卡片 */
  :root { color-scheme: dark; --rose: #ffb3b8; --rose-dim: rgba(255,179,184,.14); --rose-bd: rgba(255,179,184,.30) }
  * { box-sizing: border-box }
  body { margin: 0 auto; background: #0e0e0e; color: #e2e2e2; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 22px 18px 40px; max-width: 960px }
  .hd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap }
  h1 { font-size: 18px; font-weight: 800; letter-spacing: -.01em; margin: 0 }
  .ep-badge { font-size: 12px; font-weight: 700; color: var(--rose); background: var(--rose-dim); border: 1px solid var(--rose-bd); border-radius: 6px; padding: 1px 9px; font-variant-numeric: tabular-nums }
  .player-wrap { position: relative; aspect-ratio: 16/9; background: #000; border: 1px solid #242424; border-radius: 14px; overflow: hidden; margin-bottom: 12px }
  video, iframe.player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; display: none }
  #buffering { position: absolute; z-index: 3; left: 50%; top: 50%; transform: translate(-50%, -50%); display: none; align-items: center; gap: 9px; padding: 9px 13px; border-radius: 999px; color: #eee; background: rgba(18,18,18,.86); border: 1px solid #3a3436; box-shadow: 0 8px 24px rgba(0,0,0,.3); pointer-events: none; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums }
  #buffering.show { display: flex }
  .buffer-spin { width: 14px; height: 14px; border: 2px solid rgba(255,179,184,.25); border-top-color: var(--rose); border-radius: 50%; animation: spin .7s linear infinite }
  @keyframes spin { to { transform: rotate(360deg) } }
  /* 只在真出错时才现（加载失败 / 这集没更新 / 线路解析不到）—— 平时不显示任何提示文字 */
  #err { display: none; margin: 0 0 12px; padding: 9px 12px; border-radius: 9px; font-size: 12.5px; font-weight: 600; background: rgba(247,118,142,.12); border: 1px solid rgba(247,118,142,.35); color: #f7768e }
  .card { background: #171717; border: 1px solid #242424; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px }
  .card-label { font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #767676; margin-bottom: 10px }
  .lines { display: flex; flex-wrap: wrap; gap: 7px }
  .chip { border: 1px solid #333; background: #141414; color: #c8c8c8; border-radius: 9px; padding: 6px 13px; font-size: 12.5px; cursor: pointer; transition: border-color .12s, background .12s, color .12s }
  .chip:hover { border-color: #565656 }
  .chip.active { border-color: var(--rose); background: var(--rose-dim); color: var(--rose) }
  /* 集数网格 —— 参考 app 播放页的「集数」区 */
  .eps { display: grid; grid-template-columns: repeat(auto-fill, minmax(50px, 1fr)); gap: 7px }
  .ep { border: 1px solid #2c2c2c; background: #141414; color: #bdbdbd; border-radius: 8px; padding: 8px 0; font-size: 13px; font-weight: 600; text-align: center; cursor: pointer; font-variant-numeric: tabular-nums; transition: border-color .12s, background .12s, color .12s }
  .ep:hover { border-color: #565656; color: #fff }
  .ep.cur { border-color: var(--rose); background: var(--rose); color: #5a1923 }
</style>
</head>
<body>
  <div class="hd"><h1 id="ttl">继续看</h1><span class="ep-badge" id="epbadge">EP</span></div>
  <div class="player-wrap">
    <video id="v" controls playsinline preload="auto"></video>
    <iframe id="frame" class="player" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"></iframe>
    <div id="buffering" role="status" aria-live="polite"><span class="buffer-spin"></span><span id="bufferText">正在积攒缓冲</span></div>
  </div>
  <div id="err"></div>
  <div class="card"><div class="card-label">线路</div><div class="lines" id="lines"></div></div>
  <div class="card"><div class="card-label">选集</div><div class="eps" id="eps"></div></div>
<script nonce="__CSP_NONCE__">
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var q = new URLSearchParams(location.search)
  var animeId = q.get('animeId') || ''
  var ep = q.get('ep') || '1'
  var v = $('v'), frame = $('frame')
  var lines = [], eps = [], curPl = null, resolvedMap = {}, resolvingMap = {}, hls = null
  var BUFFER_TARGET = 10, BUFFER_RATE = .0625, BUFFER_STALL_MS = 6000, BUFFER_MAX_MS = 15000
  var BUFFER_SAMPLE_MS = 6000, BUFFER_MIN_MEDIA_RATE = 1.15, bufferTimer = null, bufferToken = 0
  var resumeAfterBuffer = false, bufferAnchor = 0, savedRate = 1, savedMuted = false, internalSeek = false
  var bufferStartedAt = 0, bufferLastProgressAt = 0, bufferLastAhead = 0, bufferSampleAt = 0, bufferSampleAhead = 0
  var internalSeekTimer = null, gateOnPlay = false, lineRequest = 0

  function fail(txt){ var e = $('err'); e.textContent = txt; e.style.display = 'block' }
  function clearFail(){ $('err').style.display = 'none' }
  function inFrame(){ return frame.style.display === 'block' }

  function bufferedAhead(){
    for (var i = 0; i < v.buffered.length; i++){
      if (v.buffered.start(i) <= v.currentTime + .05 && v.buffered.end(i) >= v.currentTime) return Math.max(0, v.buffered.end(i) - v.currentTime)
    }
    return 0
  }

  function bufferGoal(){
    if (!Number.isFinite(v.duration)) return BUFFER_TARGET
    return Math.max(0, Math.min(BUFFER_TARGET, v.duration - v.currentTime - .25))
  }

  function hideBuffer(){ $('buffering').classList.remove('show') }

  function clearInternalSeek(){
    if (internalSeekTimer !== null) clearTimeout(internalSeekTimer)
    internalSeekTimer = null; internalSeek = false
  }

  function markInternalSeek(){
    clearInternalSeek(); internalSeek = true
    internalSeekTimer = setTimeout(function(){ internalSeek = false; internalSeekTimer = null }, 800)
  }

  function resetBufferWatch(ahead){
    var now = performance.now()
    bufferStartedAt = now; bufferLastProgressAt = now; bufferLastAhead = ahead
    bufferSampleAt = now; bufferSampleAhead = ahead
  }

  function restorePlaybackState(){
    try { v.playbackRate = savedRate } catch (e) {}
    v.muted = savedMuted
  }

  function cancelBufferGate(resetPosition){
    if (resetPosition === undefined) resetPosition = false
    var wasBuffering = resumeAfterBuffer
    bufferToken++
    if (bufferTimer !== null) clearInterval(bufferTimer)
    bufferTimer = null; resumeAfterBuffer = false; hideBuffer()
    if (wasBuffering){
      restorePlaybackState()
      if (resetPosition && Number.isFinite(bufferAnchor)){
        markInternalSeek()
        try { v.currentTime = bufferAnchor } catch (e) { clearInternalSeek() }
      }
    }
  }

  function finishBufferGate(token){
    if (token !== bufferToken || !resumeAfterBuffer) return
    if (bufferTimer !== null) clearInterval(bufferTimer)
    bufferTimer = null; resumeAfterBuffer = false; hideBuffer()
    // 缓冲期间用极低速静音播放来保持浏览器继续拉流；达标后回到用户 seek 的原位置，
    // 再恢复原速与静音状态。锚点已经落在 buffered 内，不会重新走网络。
    markInternalSeek()
    try { v.currentTime = bufferAnchor } catch (e) { clearInternalSeek() }
    restorePlaybackState()
    gateOnPlay = false
  }

  function fallbackBufferGate(token){
    if (token !== bufferToken || !resumeAfterBuffer || !curPl || inFrame()) return
    var pl = curPl
    cancelBufferGate(false)
    embed(pl)
  }

  function checkBufferGate(token){
    if (token !== bufferToken || !resumeAfterBuffer || !curPl || curPl.kind !== 'mp4' || inFrame()) return
    // 切 src / loadedmetadata 时 Chromium 可能把 playbackRate 重置成 1；缓冲期间持续钉回
    // 极低速，确保下载在继续而播放位置几乎不动。
    v.muted = true
    if (v.playbackRate !== BUFFER_RATE){
      try { v.playbackRate = BUFFER_RATE } catch (e) { v.playbackRate = .25 }
    }
    var ahead = bufferedAhead(), goal = bufferGoal(), now = performance.now()
    if (ahead > bufferLastAhead + .05){ bufferLastAhead = ahead; bufferLastProgressAt = now }
    $('bufferText').textContent = '正在积攒缓冲 ' + Math.floor(ahead) + ' / ' + Math.ceil(goal) + ' 秒'
    if (ahead + .25 >= goal || v.ended){ finishBufferGate(token); return }
    if (now - bufferLastProgressAt >= BUFFER_STALL_MS || now - bufferStartedAt >= BUFFER_MAX_MS){
      fallbackBufferGate(token)
      return
    }
    if (now - bufferSampleAt >= BUFFER_SAMPLE_MS){
      var elapsed = Math.max(.001, (now - bufferSampleAt) / 1000)
      var mediaRate = (ahead - bufferSampleAhead) / elapsed + BUFFER_RATE
      if (mediaRate < BUFFER_MIN_MEDIA_RATE) fallbackBufferGate(token)
    }
  }

  function beginBufferGate(fromSeek){
    if (!curPl || curPl.kind !== 'mp4' || inFrame()) return
    var goal = bufferGoal()
    var ahead = bufferedAhead()
    gateOnPlay = false
    if (ahead + .25 >= goal) return
    if (bufferTimer !== null){
      if (fromSeek){ bufferAnchor = v.currentTime; resetBufferWatch(ahead) }
      return
    }
    resumeAfterBuffer = true
    bufferAnchor = v.currentTime
    savedRate = v.playbackRate
    savedMuted = v.muted
    v.muted = true
    try { v.playbackRate = BUFFER_RATE } catch (e) { v.playbackRate = .25 }
    var token = ++bufferToken
    resetBufferWatch(ahead)
    $('buffering').classList.add('show')
    checkBufferGate(token)
    bufferTimer = setInterval(function(){ checkBufferGate(token) }, 250)
  }

  // mp4 直连意外失败（少数编码问题）→ 静默切套娃。HLS 失败交给 hls.js 的 fatal。
  // 切套娃时会给 <video> removeAttribute+load，也会冒一个 error —— 用 inFrame()/有无 src 挡掉，别再回切。
  v.addEventListener('error', function(){
    if (!curPl || inFrame() || !v.getAttribute('src')) return
    // hls.js 自己处理错误；Safari / iOS 原生 HLS 没有 hls 实例，仍需回退官方播放器。
    if (curPl.kind === 'hls' && hls) return
    cancelBufferGate()
    embed(curPl)
  })
  v.addEventListener('seeking', function(){
    if (internalSeek) return
    gateOnPlay = true
    if (!v.paused || resumeAfterBuffer) beginBufferGate(true)
  })
  v.addEventListener('seeked', function(){ if (internalSeek) clearInternalSeek() })
  v.addEventListener('playing', function(){ if (gateOnPlay && !internalSeek && !resumeAfterBuffer) beginBufferGate(false) })
  v.addEventListener('waiting', function(){ if (!internalSeek && !v.paused){ gateOnPlay = true; beginBufferGate(false) } })
  v.addEventListener('progress', function(){ if (bufferTimer !== null) checkBufferGate(bufferToken) })
  v.addEventListener('pause', function(){
    // 用户主动暂停时停止自动恢复，并把进度退回本次缓冲开始的位置。
    if (curPl && curPl.kind === 'mp4' && !internalSeek) gateOnPlay = true
    if (bufferTimer !== null && !internalSeek) cancelBufferGate(true)
  })
  v.addEventListener('ended', function(){ gateOnPlay = false; cancelBufferGate(false) })

  function destroyHls(){ if (hls){ try { hls.destroy() } catch (e) {} hls = null } }
  function stopAll(){ cancelBufferGate(false); clearInternalSeek(); destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load(); frame.src = 'about:blank'; gateOnPlay = false }

  function renderChips(){
    var box = $('lines'); box.textContent = ''
    lines.forEach(function(l){
      var b = document.createElement('button')
      b.className = 'chip' + (curPl && l.source === curPl.source ? ' active' : '')
      b.textContent = '线路 ' + l.source + (l.name ? ' ' + l.name : '')
      b.onclick = function(){ selectLine(l.source) }
      box.appendChild(b)
    })
  }

  function playLine(pl){
    curPl = pl; clearFail(); stopAll(); renderChips()
    gateOnPlay = pl.kind === 'mp4'
    v.style.display = 'block'; frame.style.display = 'none'
    if (pl.kind === 'hls'){
      if (window.Hls && Hls.isSupported()){
        // 90–120 秒足够覆盖网络抖动，同时避免旧配置一次抓 10–15 分钟、产生上百个分片请求。
        hls = new Hls({
          maxBufferLength: 90,
          maxMaxBufferLength: 120,
          maxBufferSize: 96 * 1000 * 1000,
          backBufferLength: 60,
          fragLoadPolicy: { default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 30000,
            timeoutRetry: { maxNumRetry: 1, retryDelayMs: 500, maxRetryDelayMs: 1000 },
            errorRetry: { maxNumRetry: 1, retryDelayMs: 1000, maxRetryDelayMs: 2000 }
          } }
        })
        hls.on(Hls.Events.ERROR, function(e, data){ if (data && data.fatal) embed(pl) })
        hls.loadSource(pl.url); hls.attachMedia(v)
        var pp = v.play(); if (pp && pp.catch) pp.catch(function(){})
      } else if (v.canPlayType('application/vnd.apple.mpegurl')){
        v.src = pl.url; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function(){}) // iOS 原生 HLS
      } else { embed(pl) }
    } else {
      v.src = pl.url; v.load(); var p = v.play(); if (p && p.catch) p.catch(function(){})
    }
  }

  // 套娃：直连播不了 → 嵌稀饭自己的真实播放器（跟你在稀饭看一样）
  function embed(pl){
    curPl = pl
    cancelBufferGate(false); destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load()
    gateOnPlay = false; v.style.display = 'none'; frame.style.display = 'block'; renderChips()
    frame.src = 'https://player.moedot.net/player/index.php?code=xfdm1&from=cf&url=' + encodeURIComponent(pl.url)
  }

  function resolveSource(source){
    if (resolvingMap[source]) return resolvingMap[source]
    var controller = new AbortController()
    var timeout = setTimeout(function(){ controller.abort() }, 16000)
    var url = '/api/xifan/resolve?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep) + '&source=' + source
    var job = fetch(url, { signal: controller.signal }).then(async function(r){
      var d = await r.json()
      if (!r.ok || !d || d.error || !d.url) throw new Error(d && d.error ? d.error : '这条线路解析不到')
      resolvedMap[source] = d
      return d
    }).catch(function(e){
      if (e && e.name === 'AbortError') throw new Error('线路解析等待超过 16 秒')
      throw e
    }).finally(function(){
      clearTimeout(timeout)
      if (resolvingMap[source] === job) delete resolvingMap[source]
    })
    resolvingMap[source] = job
    return job
  }

  async function selectLine(source){
    if (curPl && curPl.source === source && !inFrame()) return
    var request = ++lineRequest
    clearFail()
    var pl = resolvedMap[source]
    if (!pl){
      try {
        pl = await resolveSource(source)
      } catch (e){ if (request === lineRequest) fail('解析请求失败：' + (e && e.message || e)); return }
    }
    if (request !== lineRequest) return
    playLine(pl)
  }

  // 换集 —— 直接改地址重载整页（裸页，全量重启最省事、也不残留上一集的 hls/buffer 状态）
  function goEp(n){ if (n < 1) return; location.search = '?animeId=' + encodeURIComponent(animeId) + '&ep=' + n }
  // 集数网格（参考 app 播放页「集数」区）：当前集高亮，点其余集换过去；扒不到集数就退化成只显示当前集
  function renderEps(){
    var box = $('eps'); box.textContent = ''
    var cur = Number(ep) || 1
    if (!eps.length){
      var one = document.createElement('div'); one.className = 'ep cur'; one.textContent = cur; box.appendChild(one)
      return
    }
    eps.forEach(function(n){
      var b = document.createElement('button'); b.type = 'button'
      b.className = 'ep' + (n === cur ? ' cur' : '')
      b.textContent = n
      b.onclick = function(){ if (n !== cur) goEp(n) }
      box.appendChild(b)
    })
  }

  async function boot(){
    if (!/^[0-9]+$/.test(animeId) || !/^[0-9]+$/.test(ep)){ fail('URL 参数不合法'); return }
    $('epbadge').textContent = 'EP ' + ep
    renderEps() // 先按 URL 的 ep 画一版占位，拿到 playlist 的整季集数再重画
    try {
      var r = await fetch('/api/xifan/playlist?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep))
      var d = await r.json()
      if (d.error){ fail('加载失败：' + d.error); return }
      lines = d.lines || []
      eps = d.eps || []
      if (d.title){ $('ttl').textContent = d.title }
      renderEps(); renderChips()
      if (d.first){ resolvedMap[1] = d.first; playLine(d.first) }
      else { fail('这一集解析不到 —— 可能还没更新，点上面别的集试试') }
    } catch (e){
      fail('请求失败：' + (e && e.message || e))
    }
  }
  boot()
})();
</script>
</body>
</html>`

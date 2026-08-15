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
import { getPlaylist, isGirigiriId, resolveLine } from './girigiri/resolve'
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

girigiri.get('/play-page', (c) => {
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
  const body = (await c.req.json().catch(() => ({}))) as { bgmId?: number; titles?: unknown }
  const bgmId = Number(body.bgmId)
  if (!Number.isInteger(bgmId) || bgmId <= 0) return c.json({ error: 'bgmId 不合法' }, 400)
  const titles = Array.isArray(body.titles) ? body.titles.filter((title): title is string => typeof title === 'string') : []
  try {
    c.header('Cache-Control', 'no-store')
    return c.json(await locate(bgmId, titles))
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

const PLAY_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>继续看 · Girigiri</title>
<script src="/api/girigiri/hls.js"></script>
<style nonce="__CSP_NONCE__">
  :root { color-scheme: dark; --rose: #ffb3b8; --rose-dim: rgba(255,179,184,.14); --rose-bd: rgba(255,179,184,.30) }
  * { box-sizing: border-box }
  body { margin: 0 auto; background: #0e0e0e; color: #e2e2e2; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 22px 18px 40px; max-width: 960px }
  .hd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap }
  h1 { font-size: 18px; font-weight: 800; letter-spacing: -.01em; margin: 0 }
  .ep-badge { font-size: 12px; font-weight: 700; color: var(--rose); background: var(--rose-dim); border: 1px solid var(--rose-bd); border-radius: 6px; padding: 1px 9px; font-variant-numeric: tabular-nums }
  .player-wrap { position: relative; aspect-ratio: 16/9; background: #000; border: 1px solid #242424; border-radius: 14px; overflow: hidden; margin-bottom: 12px }
  video, iframe.player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; display: none }
  #err { display: none; margin: 0 0 12px; padding: 9px 12px; border-radius: 9px; font-size: 12.5px; font-weight: 600; background: rgba(247,118,142,.12); border: 1px solid rgba(247,118,142,.35); color: #f7768e }
  .card { background: #171717; border: 1px solid #242424; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px }
  .card-label { font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: #767676; margin-bottom: 10px }
  .sources, .lines { display: flex; flex-wrap: wrap; gap: 7px }
  .chip { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #333; background: #141414; color: #c8c8c8; border-radius: 9px; padding: 6px 13px; font: inherit; font-size: 12.5px; line-height: 1.5; text-decoration: none; cursor: pointer; transition: border-color .12s, background .12s, color .12s }
  .chip:hover { border-color: #565656 }
  .chip.active { border-color: var(--rose); background: var(--rose-dim); color: var(--rose); cursor: default }
  .chip.unbound { border-style: dashed; color: #767676 }
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
  </div>
  <div id="err"></div>
  <div class="card"><div class="card-label">播放源</div><div class="sources" id="sources"></div></div>
  <div class="card"><div class="card-label">线路</div><div class="lines" id="lines"></div></div>
  <div class="card"><div class="card-label">选集</div><div class="eps" id="eps"></div></div>
<script nonce="__CSP_NONCE__">
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var q = new URLSearchParams(location.search)
  var animeId = q.get('animeId') || ''
  var ep = q.get('ep') || '1'
  var bgmId = q.get('bgmId') || ''
  var sourceOptions = __PLAYER_SOURCES__
  var v = $('v'), frame = $('frame')
  var lines = [], eps = [], curPl = null, resolvedMap = {}, hls = null

  window.addEventListener('pagehide', function(){ stopAll() })
  window.addEventListener('pageshow', function(e){ if (e.persisted) location.reload() })

  function fail(txt){ var e = $('err'); e.textContent = txt; e.style.display = 'block' }
  function clearFail(){ $('err').style.display = 'none' }
  function inFrame(){ return frame.style.display === 'block' }
  function destroyHls(){ if (hls){ try { hls.destroy() } catch (e) {} hls = null } }
  function stopAll(){ destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load(); frame.src = 'about:blank' }
  function renderSources(){
    var box = $('sources'); box.textContent = ''
    sourceOptions.forEach(function(source){
      var control = document.createElement('button')
      control.type = 'button'
      control.className = 'chip' + (source.active ? ' active' : '') + (!source.href ? ' unbound' : '')
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
      b.className = 'chip' + (curPl && l.source === curPl.source ? ' active' : '')
      b.textContent = '线路 ' + l.source + (l.name ? ' ' + l.name : '')
      b.onclick = function(){ selectLine(l.source) }
      box.appendChild(b)
    })
  }
  function officialPage(){ return 'https://ani.girigirilove.com/play' + animeId + '-' + (curPl ? curPl.source : 1) + '-' + ep + '/' }
  function embed(){
    curPl = curPl || { source: 1 }
    destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load()
    v.style.display = 'none'; frame.style.display = 'block'; renderChips(); frame.src = officialPage()
  }
  v.addEventListener('error', function(){ if (curPl && !inFrame() && v.getAttribute('src')) embed() })
  function playLine(pl){
    curPl = pl; clearFail(); stopAll(); renderChips()
    v.style.display = 'block'; frame.style.display = 'none'
    if (pl.kind === 'hls'){
      if (window.Hls && Hls.isSupported()){
        hls = new Hls({ maxBufferLength: 600, maxMaxBufferLength: 900, maxBufferSize: 240 * 1000 * 1000, backBufferLength: 90 })
        hls.on(Hls.Events.ERROR, function(e, data){ if (data && data.fatal) embed() })
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
    if (curPl && curPl.source === source && !inFrame()) return
    clearFail()
    var pl = resolvedMap[source]
    if (!pl){
      try {
        var r = await fetch('/api/girigiri/resolve?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep) + '&source=' + source)
        var d = await r.json()
        if (!r.ok || !d || d.error || !d.url){ fail(d && d.error ? d.error : '这条线路解析不到'); return }
        pl = d; resolvedMap[source] = pl
      } catch (e){ fail('解析请求失败：' + (e && e.message || e)); return }
    }
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
    if (!eps.length){ var one = document.createElement('div'); one.className = 'ep cur'; one.textContent = cur; box.appendChild(one); return }
    eps.forEach(function(n){ var b = document.createElement('button'); b.type = 'button'; b.className = 'ep' + (n === cur ? ' cur' : ''); b.textContent = n; b.onclick = function(){ if (n !== cur) goEp(n) }; box.appendChild(b) })
  }
  async function boot(){
    if (!/^GV[0-9]+$/i.test(animeId) || !/^[0-9]+$/.test(ep)){ fail('URL 参数不合法'); return }
    renderSources()
    $('epbadge').textContent = 'EP ' + ep; renderEps()
    try {
      var r = await fetch('/api/girigiri/playlist?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep))
      var d = await r.json()
      if (!r.ok || d.error){ fail('加载失败：' + (d.error || 'Girigiri 播放页解析失败')); return }
      lines = d.lines || []; eps = d.eps || []; if (d.title) $('ttl').textContent = d.title
      renderEps(); renderChips()
      if (d.first){ resolvedMap[1] = d.first; playLine(d.first) } else fail('这一集解析不到，点上面其他线路试试')
    } catch (e){ fail('请求失败：' + (e && e.message || e)) }
  }
  boot()
})();
</script>
</body>
</html>`

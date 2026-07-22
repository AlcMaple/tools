// 稀饭在线观看 —— 懒加载播放器（用户 2026-07-21 定：不并行、不自动选最优）。
//
//   GET  /api/xifan/playlist?animeId=&ep=          → 一次抓取：线路 1 地址 + 全部线路名单
//   GET  /api/xifan/resolve?animeId=&ep=&source=N  → 用户手动点线路 N 时才解析那一条
//   GET  /api/xifan/play-page?animeId=&ep=         → 播放器页（默认播线路 1，直连失败套娃兜底）
//   GET  /api/xifan/hls.js                         → 自托管 hls.js（不走可能被墙的 jsdelivr）
//   POST /api/xifan/locate                         → bgmId + 标题 → 稀饭候选（周表免验证码匹配，见 locate.ts）
//   POST /api/xifan/bind                           → 用户点候选确认，落库绑定（要登录）
//   GET  /api/xifan/bindings                       → 当前用户追番已建的绑定，页面加载时一次拿齐（要登录）
//
// 播放器页是「服务端返回的一张裸 HTML」，跟生产 SPA 同源，<video> 加载源 CDN 就是跨源＝真实场景。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { getPlaylist, resolveLine } from './xifan/resolve'
import { locate } from './xifan/locate'
import { getBinding, putBinding, bindingsFor } from './xifan/bindings'
import { getSession } from './auth'
import { db } from './db'

const xifan = new Hono()

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
  return c.json(await getPlaylist(animeId, ep))
})

// 用户手动点线路 N：只抓那一条
xifan.get('/resolve', async (c) => {
  const animeId = c.req.query('animeId') ?? ''
  const ep = Number(c.req.query('ep') ?? '1')
  const source = Number(c.req.query('source') ?? '0')
  if (!/^\d+$/.test(animeId)) return c.json({ error: 'animeId 不合法' }, 400)
  if (!Number.isInteger(ep) || ep < 1) return c.json({ error: 'ep 不合法' }, 400)
  if (!Number.isInteger(source) || source < 1) return c.json({ error: 'source 不合法' }, 400)
  const line = await resolveLine(animeId, ep, source)
  c.header('Cache-Control', 'no-store')
  return line ? c.json(line) : c.json({ error: '此线路解析不到（可能此线路没有这一集）' }, 404)
})

xifan.get('/play-page', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.html(PLAY_PAGE)
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
<title>继续看 · 稀饭</title>
<script src="/api/xifan/hls.js"></script>
<style>
  /* 配色对齐 app / web 暗色主题：玫瑰粉主色（--color-primary 的 dark 版）+ 分层深色卡片 */
  :root { color-scheme: dark; --rose: #ffb3b8; --rose-dim: rgba(255,179,184,.14); --rose-bd: rgba(255,179,184,.30) }
  * { box-sizing: border-box }
  body { margin: 0 auto; background: #0e0e0e; color: #e2e2e2; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 22px 18px 40px; max-width: 960px }
  .hd { display: flex; align-items: center; gap: 10px; flex-wrap: wrap }
  h1 { font-size: 18px; font-weight: 800; letter-spacing: -.01em; margin: 0 }
  .ep-badge { font-size: 12px; font-weight: 700; color: var(--rose); background: var(--rose-dim); border: 1px solid var(--rose-bd); border-radius: 6px; padding: 1px 9px; font-variant-numeric: tabular-nums }
  .player-wrap { position: relative; aspect-ratio: 16/9; background: #000; border: 1px solid #242424; border-radius: 14px; overflow: hidden; margin-bottom: 12px }
  video, iframe.player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; display: none }
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
    <iframe id="frame" class="player" allow="autoplay; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"></iframe>
  </div>
  <div id="err"></div>
  <div class="card"><div class="card-label">线路</div><div class="lines" id="lines"></div></div>
  <div class="card"><div class="card-label">选集</div><div class="eps" id="eps"></div></div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var q = new URLSearchParams(location.search)
  var animeId = q.get('animeId') || ''
  var ep = q.get('ep') || '1'
  var v = $('v'), frame = $('frame')
  var lines = [], eps = [], curPl = null, resolvedMap = {}, hls = null

  function fail(txt){ var e = $('err'); e.textContent = txt; e.style.display = 'block' }
  function clearFail(){ $('err').style.display = 'none' }
  function inFrame(){ return frame.style.display === 'block' }

  // mp4 直连意外失败（少数编码问题）→ 静默切套娃。HLS 失败交给 hls.js 的 fatal。
  // 切套娃时会给 <video> removeAttribute+load，也会冒一个 error —— 用 inFrame()/有无 src 挡掉，别再回切。
  v.addEventListener('error', function(){
    if (!curPl || curPl.kind === 'hls' || inFrame() || !v.getAttribute('src')) return
    embed(curPl)
  })

  function destroyHls(){ if (hls){ try { hls.destroy() } catch (e) {} hls = null } }
  function stopAll(){ destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load(); frame.src = 'about:blank' }

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
    // 下载型链接（网盘代理）直连必失败还触发浏览器下载 —— 服务端已判死为 iframe，直接套娃，不碰 <video>
    if (pl.kind === 'iframe'){ embed(pl); return }
    v.style.display = 'block'; frame.style.display = 'none'
    if (pl.kind === 'hls'){
      if (window.Hls && Hls.isSupported()){
        // 深缓冲：目标前向 10 分钟 / 240MB（暂停也灌）；hls.js 致命错误（含空壳 manifest）→ 套娃
        hls = new Hls({ maxBufferLength: 600, maxMaxBufferLength: 900, maxBufferSize: 240 * 1000 * 1000, backBufferLength: 90 })
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
    destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load()
    v.style.display = 'none'; frame.style.display = 'block'; renderChips()
    frame.src = 'https://player.moedot.net/player/index.php?code=xfdm1&from=cf&url=' + encodeURIComponent(pl.url)
  }

  async function selectLine(source){
    if (curPl && curPl.source === source && !inFrame()) return
    clearFail()
    var pl = resolvedMap[source]
    if (!pl){
      try {
        var r = await fetch('/api/xifan/resolve?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep) + '&source=' + source)
        var d = await r.json()
        if (!d || d.error || !d.url){ fail('这条线路解析不到' + (d && d.error ? '：' + d.error : '')); return }
        pl = d; resolvedMap[source] = pl
      } catch (e){ fail('解析请求失败：' + (e && e.message || e)); return }
    }
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
    if (!/^[0-9]+$/.test(animeId)){ fail('URL 里缺 animeId'); return }
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

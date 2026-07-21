// 稀饭在线观看 —— 懒加载播放器（用户 2026-07-21 定：不并行、不自动选最优）。
//
//   GET /api/xifan/playlist?animeId=&ep=          → 一次抓取：线路 1 地址 + 全部线路名单
//   GET /api/xifan/resolve?animeId=&ep=&source=N  → 用户手动点线路 N 时才解析那一条
//   GET /api/xifan/play-page?animeId=&ep=         → 播放器页（默认播线路 1，直连失败套娃兜底）
//   GET /api/xifan/hls.js                         → 自托管 hls.js（不走可能被墙的 jsdelivr）
//
// 播放器页是「服务端返回的一张裸 HTML」，跟生产 SPA 同源，<video> 加载源 CDN 就是跨源＝真实场景。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { getPlaylist, resolveLine } from './xifan/resolve'

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
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; background: #0d0d0d; color: #e6e6e6; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 16px; max-width: 900px; margin: 0 auto }
  h1 { font-size: 17px; margin: 0 0 2px }
  .sub { color: #8a8a8a; font-size: 12px; margin: 0 0 12px }
  #status { color: #9a9a9a; font-size: 12.5px; min-height: 18px; margin-bottom: 8px }
  video { width: 100%; background: #000; border-radius: 10px; display: none; aspect-ratio: 16/9 }
  iframe.player { width: 100%; aspect-ratio: 16/9; border: 0; border-radius: 10px; background: #000; display: none }
  .verdict { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; font-weight: 600; display: none }
  .verdict.ok { display: block; background: #16311a; border: 1px solid #2f6b39; color: #9ece6a }
  .verdict.bad { display: block; background: #3a1620; border: 1px solid #7a2a3a; color: #f7768e }
  .verdict.info { display: block; background: #1a1a1a; border: 1px solid #333; color: #b8b8b8 }
  .lines { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 }
  .chip { border: 1px solid #3a3a3a; background: #1a1a1a; color: #c8c8c8; border-radius: 999px; padding: 5px 12px; font-size: 12.5px; cursor: pointer }
  .chip.active { border-color: #7aa2f7; background: #1a2540; color: #a9c2ff }
  .chip .tag { font-size: 10px; opacity: .65; margin-left: 5px }
  #play { color: #8a8a8a; font-size: 11.5px; font-family: ui-monospace, Menlo, Consolas, monospace; min-height: 18px; margin-top: 6px }
</style>
</head>
<body>
  <h1 id="ttl">继续看</h1>
  <p class="sub">默认播线路 1；线路 2/3 点了才解析（不一次性并发，防反爬）。直连播不了自动套娃（稀饭自己的播放器）。</p>
  <div id="status">准备中…</div>
  <div class="verdict" id="verdict"></div>
  <video id="v" controls playsinline preload="auto"></video>
  <iframe id="frame" class="player" allow="autoplay; fullscreen" allowfullscreen sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"></iframe>
  <div class="lines" id="lines"></div>
  <div id="play"></div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var q = new URLSearchParams(location.search)
  var animeId = q.get('animeId') || ''
  var ep = q.get('ep') || '1'
  var stalls = 0, fragCount = 0, v = $('v'), frame = $('frame')
  var lines = [], curPl = null, resolvedMap = {}, hls = null, mode = 'direct'

  function fmt(n){ return Math.round(n * 10) / 10 }
  function setV(cls, txt){ $('verdict').className = 'verdict ' + cls; $('verdict').textContent = txt }
  function curSrc(){ return curPl ? curPl.source : 0 }

  function updateReadout(){
    if (mode !== 'direct' || !curPl) return
    var ahead = 0
    try { if (v.buffered.length) ahead = v.buffered.end(v.buffered.length - 1) - v.currentTime } catch (e) {}
    $('play').textContent = '进度 ' + fmt(v.currentTime) + 's / ' + (isFinite(v.duration) ? fmt(v.duration) : '?') +
      's　·　缓冲领先 ' + fmt(ahead) + 's' + (v.paused ? '（暂停中，仍在缓冲）' : '') +
      (curPl.kind === 'hls' ? '　·　已载分片 ' + fragCount : '') + '　·　卡顿 ' + stalls + ' 次'
  }
  v.addEventListener('timeupdate', updateReadout)
  setInterval(updateReadout, 500) // 暂停时 timeupdate 不触发，靠它才看得到缓冲还在涨

  v.addEventListener('playing', function(){
    if (mode !== 'direct') return
    setV('ok', '✅ 直连播放中 · 线路 ' + curSrc() + (curPl && curPl.kind === 'hls' ? ' · HLS（hls.js 深缓冲）' : '') + '（视频不经服务器）')
  })
  v.addEventListener('waiting', function(){ if (mode === 'direct') stalls++ })
  v.addEventListener('error', function(){
    // mp4 直连失败（如 content-disposition 的 code4）→ 套娃兜底。HLS 的失败交给 hls.js 的 fatal。
    if (mode !== 'direct' || !curPl || curPl.kind === 'hls') return
    embed(curPl, '线路 ' + curSrc() + ' 直连播不了（多半 content-disposition / 编码），已自动切稀饭播放器')
  })

  function destroyHls(){ if (hls){ try { hls.destroy() } catch (e) {} hls = null } }
  function stopAll(){ destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load(); frame.src = 'about:blank' }

  function renderChips(){
    var box = $('lines'); box.textContent = ''
    lines.forEach(function(l){
      var b = document.createElement('button')
      var on = curPl && l.source === curPl.source
      b.className = 'chip' + (on ? ' active' : '')
      b.textContent = '线路 ' + l.source + (l.name ? ' ' + l.name : '')
      var rp = resolvedMap[l.source]
      if (rp){ var s = document.createElement('span'); s.className = 'tag'; s.textContent = rp.kind === 'hls' ? 'HLS' : 'mp4'; b.appendChild(s) }
      b.onclick = function(){ selectLine(l.source) }
      box.appendChild(b)
    })
  }

  function playLine(pl){
    curPl = pl; mode = 'direct'; stalls = 0; fragCount = 0
    stopAll(); renderChips()
    v.style.display = 'block'; frame.style.display = 'none'
    if (pl.kind === 'hls'){
      setV('info', '⏳ 线路 ' + pl.source + ' HLS 加载中（hls.js 预取深缓冲）…')
      if (window.Hls && Hls.isSupported()){
        // 深缓冲：目标前向 10 分钟 / 240MB（暂停也灌）；hls.js 致命错误（含空壳 manifest）→ 套娃
        hls = new Hls({ maxBufferLength: 600, maxMaxBufferLength: 900, maxBufferSize: 240 * 1000 * 1000, backBufferLength: 90 })
        hls.on(Hls.Events.ERROR, function(e, data){ if (data && data.fatal) embed(pl, '线路 ' + pl.source + ' HLS 播不了（' + (data.details || data.type) + '），已自动切稀饭播放器') })
        hls.on(Hls.Events.FRAG_LOADED, function(){ fragCount++ })
        hls.loadSource(pl.url); hls.attachMedia(v)
        var pp = v.play(); if (pp && pp.catch) pp.catch(function(){})
      } else if (v.canPlayType('application/vnd.apple.mpegurl')){
        v.src = pl.url; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function(){}) // iOS 原生 HLS
      } else { embed(pl, '此浏览器不支持 HLS，改用稀饭播放器') }
    } else {
      setV('info', '⏳ 线路 ' + pl.source + ' mp4 加载中…')
      v.src = pl.url; v.load(); var p = v.play(); if (p && p.catch) p.catch(function(){})
    }
  }

  // 套娃：某条线自研播不了 → 嵌稀饭自己的真实播放器（跟你在稀饭看一样）
  function embed(pl, why){
    mode = 'iframe'; curPl = pl
    destroyHls(); try { v.pause() } catch (e) {} v.removeAttribute('src'); v.load()
    v.style.display = 'none'; frame.style.display = 'block'; renderChips()
    setV('info', '🪆 ' + (why || '线路 ' + pl.source + ' 用稀饭真实播放器'))
    $('play').textContent = '（套娃模式下拿不到跨源缓冲读数）'
    frame.src = 'https://player.moedot.net/player/index.php?code=xfdm1&from=cf&url=' + encodeURIComponent(pl.url)
  }

  async function selectLine(source){
    if (curPl && curPl.source === source && mode === 'direct') return
    var pl = resolvedMap[source]
    if (!pl){
      setV('info', '解析线路 ' + source + '…（点了才抓，避免一次性并发）')
      try {
        var r = await fetch('/api/xifan/resolve?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep) + '&source=' + source)
        var d = await r.json()
        if (!d || d.error || !d.url){ setV('bad', '线路 ' + source + ' 解析不到' + (d && d.error ? '：' + d.error : '')); return }
        pl = d; resolvedMap[source] = pl
      } catch (e){ setV('bad', '解析请求失败：' + (e && e.message || e)); return }
    }
    playLine(pl)
  }

  async function boot(){
    if (!/^[0-9]+$/.test(animeId)){ $('status').textContent = 'URL 里缺 animeId（例：/api/xifan/play-page?animeId=3543&ep=1）'; return }
    $('ttl').textContent = '继续看 · EP ' + ep
    $('status').textContent = '加载中…（只抓 1 次：线路 1 地址 + 线路名单）'
    try {
      var r = await fetch('/api/xifan/playlist?animeId=' + encodeURIComponent(animeId) + '&ep=' + encodeURIComponent(ep))
      var d = await r.json()
      if (d.error){ $('status').textContent = '加载失败：' + d.error; return }
      lines = d.lines || []
      $('status').textContent = (d.title ? d.title + ' · ' : '') + '共 ' + lines.length + ' 条线路，默认播线路 1（其余点了才解析）'
      if (d.first){ resolvedMap[1] = d.first; playLine(d.first) }
      else { renderChips(); setV('bad', '线路 1 解析不到（反爬 / 页面改版 / 传错 animeId）') }
    } catch (e){
      $('status').textContent = '请求失败：' + (e && e.message || e)
    }
  }
  boot()
})();
</script>
</body>
</html>`

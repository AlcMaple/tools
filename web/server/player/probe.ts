// 阶段 0 测速页 —— 播放页重写前唯一要先回答的问题：**VPS → 这台手机的出口单连接能跑多快**。
//
// devlog 08-21 实测「单连接 2.2Mbps < 码率 2.67Mbps」，预转 HLS / 分区 / 名额那整套机制都是为它而生。
// 那是一个多月前在一条链路上的一次测量。新页是「纯 mp4 透传」还是「出口也要多连接」，
// 全看这里重测的结果（判据见 docs/design/播放页重写方案.md 第三节）。
//
// 一键顺序跑三组测试，全部同源请求代理地址，浏览器侧不碰源站：
//   1. <video> 真播 180s          → 播放器实际拿到多少；buffered 领先量每 2s 一格
//      （排第一：iOS 起播要手势，点「开始」后紧接着点播放键就够了，后面全自动）
//   2. fetch 单连接 30s × 2       → 纯网络上限（<video> 自己会限流，测不出网络；跑两遍避开一次慢启动）
//   3. fetch 4 路并发 30s         → 多连接有没有收益（方案 B 的前提）
// 结果三个去处：页面 <pre>（手机上就能看）、sendBeacon 回服务端 stdout、服务端自己按响应字节数算的速率。
// 服务端那份是真相：客户端的 <video> 读不到字节数，只能按 buffered 秒数估。

import { Readable, Transform } from 'node:stream'
import { Hono } from 'hono'
import { getSession } from '../auth'
import { playerPageSecurity, renderNonce } from '../security'
import { serveStream } from '../xifan/stream'

const player = new Hono()

// 只登录用户能用：/stream 会占服务器出口，不能是匿名下片口。
player.get('/probe', async (c) => {
  if (!await getSession(c)) return c.text('请先登录网页版，再打开本页', 401)
  c.header('Cache-Control', 'no-store')
  const page = renderNonce(PROBE_PAGE)
  playerPageSecurity(c, page.nonce)
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(page.html)
})

// 测速专用流路由（新页正式用的是 index.ts 的 /stream，带签名）：直接调 serveStream，不走慢源名额。
// probe=1 时按 2s 一格把实际送出的字节数打进终端 —— 这是出口速率唯一可信的来源。
let probeSeq = 0
player.get('/probe-stream', async (c) => {
  const raw = c.req.query('u') ?? ''
  if (!raw) return c.json({ error: '缺少 u' }, 400)
  const session = await getSession(c)
  if (!session) return c.json({ error: '未登录' }, 401)
  let r
  try {
    r = await serveStream(raw, c.req.header('range'), false, String(session.uid))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '代理失败' }, 502)
  }
  if (c.req.query('probe') !== '1' || !r.body) {
    return new Response(r.body, { status: r.status, headers: r.headers })
  }
  const id = ++probeSeq
  const tag = c.req.query('tag') ?? '-'
  const startedAt = Date.now()
  let total = 0, lastAt = startedAt, lastTotal = 0
  const tick = () => {
    const now = Date.now()
    const kbps = ((total - lastTotal) / 1024) / Math.max(0.001, (now - lastAt) / 1000)
    console.log(`[player:probe] #${id} ${tag} +${kbps.toFixed(0)}KB/s (${(kbps * 8 / 1024).toFixed(2)}Mbps) total=${(total / 1048576).toFixed(1)}MB t=${((now - startedAt) / 1000).toFixed(0)}s`)
    lastAt = now; lastTotal = total
  }
  let timer: ReturnType<typeof setInterval> | null = null
  let finished = false
  const done = (why: string) => {
    if (finished) return
    finished = true
    if (timer) clearInterval(timer)
    timer = null
    const sec = Math.max(0.001, (Date.now() - startedAt) / 1000)
    console.log(`[player:probe] #${id} ${tag} ${why} avg=${(total / 1024 / sec).toFixed(0)}KB/s (${(total / 1024 / sec * 8 / 1024).toFixed(2)}Mbps) total=${(total / 1048576).toFixed(1)}MB in ${sec.toFixed(0)}s range=${c.req.header('range') ?? '-'}`)
  }
  console.log(`[player:probe] #${id} ${tag} open range=${c.req.header('range') ?? '-'} status=${r.status}`)
  // serveStream 透传时给的是 undici 的 Node Readable。**别用 Readable.toWeb 再 pipeThrough**：
  // 客户端中途断开（iOS 的 <video> 一集里会断开重连几十次）时 Node 的适配器会在 controller 关闭后
  // 继续 enqueue，抛未捕获的 ERR_INVALID_STATE 把整个进程打死（2026-09-16 真机第一跑就撞上，pm2 重启了一次）。
  // Node 侧用 Transform 计数，背压和销毁都交给 pipe。
  const body = r.body as unknown as ReadableStream<Uint8Array> | Readable
  timer = setInterval(tick, 2000)
  let counted: ReadableStream<Uint8Array> | Readable
  if (body instanceof Readable) {
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) { total += chunk.byteLength; cb(null, chunk) },
      flush(cb) { done('end'); cb() },
    })
    counter.once('close', () => { done('close'); body.destroy() })
    counter.on('error', () => { /* 下游断开时的 EPIPE 之类，已在 close 里收尾 */ })
    body.on('error', (e) => { counter.destroy(e) })
    body.pipe(counter)
    counted = counter
  } else {
    counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { total += chunk.byteLength; controller.enqueue(chunk) },
      flush() { done('end') },
    }))
    c.req.raw.signal.addEventListener('abort', () => done('abort'), { once: true })
  }
  return new Response(counted as unknown as ReadableStream, { status: r.status, headers: r.headers })
})

// 页面把每一格结果打回来，落终端。无鉴权口子按最坏情况卡死长度。
player.post('/probe-log', async (c) => {
  if (!await getSession(c)) return c.body(null, 401)
  let body: unknown
  try { body = await c.req.json() } catch { return c.body(null, 204) }
  const lines = body && typeof body === 'object' && Array.isArray((body as { lines?: unknown }).lines)
    ? ((body as { lines: unknown[] }).lines).slice(0, 50).map((l) => String(l).slice(0, 200))
    : []
  for (const line of lines) console.log('[player:probe:client] ' + line)
  return c.body(null, 204)
})

export default player

// 客户端脚本只用字符串拼接，不用模板串 —— 避开外层模板串的 ${}。
const PROBE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>播放测速 · 阶段 0</title>
<script src="/api/player/vendor/hls.js"></script>
<style nonce="__CSP_NONCE__">
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 16px; background: #faf8f3; color: #222 }
  h1 { font-size: 18px; margin: 0 0 12px }
  label { display: block; margin: 8px 0 4px; font-size: 13px; color: #555 }
  input, select { width: 100%; box-sizing: border-box; font-size: 16px; padding: 8px; border: 1px solid #bbb; border-radius: 6px }
  .row { display: flex; gap: 8px } .row > * { flex: 1 }
  button { font-size: 16px; padding: 10px 14px; border-radius: 8px; border: 1px solid #333; background: #fff; margin: 12px 8px 0 0 }
  button:disabled { opacity: .4 }
  video { width: 100%; aspect-ratio: 16/9; background: #000; margin-top: 12px; display: none }
  video.on { display: block }
  pre { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 10px; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 50vh; overflow: auto; margin-top: 12px }
  .hint { font-size: 12px; color: #777 }
</style>
</head>
<body>
<h1>播放测速 · 阶段 0</h1>
<p class="hint">只需两下：点「开始」→ 视频出现后点一次播放键。之后全自动跑约 5 分钟，别切走页面。结果会自动送到服务器。</p>
<div class="row">
  <div><label>animeId</label><input id="animeId" inputmode="numeric" placeholder="如 3543"></div>
  <div><label>ep</label><input id="ep" inputmode="numeric" value="1"></div>
  <div><label>线路</label><input id="source" inputmode="numeric" value="2"></div>
</div>
<div><button id="btnStart">开始</button></div>
<video id="v" controls playsinline preload="auto"></video>
<pre id="log"></pre>
<script nonce="__CSP_NONCE__">
(function(){
  var $ = function(id){ return document.getElementById(id) }
  var logEl = $('log'), v = $('v'), mediaUrl = '', pending = [], flushTimer = null
  function log(msg){
    var line = new Date().toISOString().slice(11, 19) + ' ' + msg
    logEl.textContent += line + '\\n'; logEl.scrollTop = logEl.scrollHeight
    pending.push(line)
    if (flushTimer === null) flushTimer = setTimeout(flush, 800)
  }
  function flush(){
    flushTimer = null
    if (!pending.length) return
    var body = JSON.stringify({ lines: pending.splice(0, 50) })
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/player/probe-log', new Blob([body], { type: 'application/json' }))))
        fetch('/api/player/probe-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function(){})
    } catch (e) {}
    if (pending.length) flushTimer = setTimeout(flush, 800)
  }
  function proxy(u, tag){ return '/api/player/probe-stream?u=' + encodeURIComponent(u) + '&probe=1&tag=' + encodeURIComponent(tag) }
  function mbps(bytes, ms){ return (bytes * 8 / 1024 / 1024 / Math.max(.001, ms / 1000)).toFixed(2) }
  var q = new URLSearchParams(location.search)
  ;['animeId', 'ep', 'source'].forEach(function(k){ if (q.get(k)) $(k).value = q.get(k) })

  async function resolve(){
    var r = await fetch('/api/player/resolve?src=xifan&id=' + encodeURIComponent($('animeId').value.trim()) + '&ep=' + encodeURIComponent($('ep').value.trim()) + '&source=' + encodeURIComponent($('source').value.trim()))
    var d = await r.json()
    if (!r.ok || !d.url) throw new Error(d.error || ('HTTP ' + r.status))
    log('url ' + d.url + ' kind=' + d.kind)
    return d.url
  }

  // 一条连接读 ms 毫秒：纯网络上限。
  async function fetchOne(range, tag, ms){
    var ctrl = new AbortController(), at = performance.now(), bytes = 0, lastAt = at, lastBytes = 0
    var timer = setTimeout(function(){ ctrl.abort() }, ms)
    var tick = setInterval(function(){
      var now = performance.now()
      log(tag + ' +' + mbps(bytes - lastBytes, now - lastAt) + 'Mbps total=' + (bytes / 1048576).toFixed(1) + 'MB')
      lastAt = now; lastBytes = bytes
    }, 2000)
    var total = null
    try {
      var r = await fetch(proxy(mediaUrl, tag), { headers: { Range: range }, cache: 'no-store', signal: ctrl.signal })
      var cr = r.headers.get('Content-Range'); if (cr) total = Number(cr.split('/')[1])
      log(tag + ' status=' + r.status + ' ttfb=' + Math.round(performance.now() - at) + 'ms total=' + total)
      var reader = r.body.getReader()
      while (true){ var s = await reader.read(); if (s.done) break; bytes += s.value.byteLength }
    } catch (e){ if (!(e && e.name === 'AbortError')) log(tag + ' error ' + e) }
    clearTimeout(timer); clearInterval(tick)
    var el = performance.now() - at
    log(tag + ' 结束 avg=' + mbps(bytes, el) + 'Mbps ' + (bytes / 1048576).toFixed(1) + 'MB in ' + Math.round(el / 1000) + 's')
    return { bytes: bytes, ms: el, total: total }
  }

  // 4 路错开起点并发：加起来比单路快多少，就是多连接的收益。
  // 起点各占文件四分之一处 —— 都从 0 起会被代理合并成同一个会话，测不出并发。
  async function fetchParallel(fileTotal){
    var at = performance.now(), jobs = []
    for (var i = 0; i < 4; i++){
      var start = Math.floor(fileTotal * i / 4 / 1048576) * 1048576
      jobs.push(fetchOne('bytes=' + start + '-', 'par' + i, 30000))
    }
    var rs = await Promise.all(jobs), sum = 0
    rs.forEach(function(r){ sum += r.bytes })
    log('par 合计 avg=' + mbps(sum, performance.now() - at) + 'Mbps ' + (sum / 1048576).toFixed(1) + 'MB')
  }

  // 真播：<video> 能拿到多少。buffered 领先量掉到 0 就是「卡」；每 2s 一格。
  function ahead(){
    for (var i = 0; i < v.buffered.length; i++)
      if (v.buffered.start(i) <= v.currentTime + .05 && v.buffered.end(i) >= v.currentTime) return v.buffered.end(i) - v.currentTime
    return 0
  }
  function playVideo(ms){
    return new Promise(function(resolve){
      v.classList.add('on')
      var stalls = 0, waiting = false, at = performance.now(), lastEnd = 0, started = false
      var onWaiting = function(){ waiting = true; stalls++; log('video waiting t=' + v.currentTime.toFixed(1)) }
      var onPlaying = function(){ waiting = false; started = true; log('video playing t=' + v.currentTime.toFixed(1)) }
      var onErr = function(){ log('video error code=' + (v.error ? v.error.code : '?')) }
      v.addEventListener('waiting', onWaiting); v.addEventListener('playing', onPlaying); v.addEventListener('error', onErr)
      var tick = setInterval(function(){
        var end = 0
        for (var i = 0; i < v.buffered.length; i++) end = Math.max(end, v.buffered.end(i))
        log('video t=' + v.currentTime.toFixed(1) + ' ahead=' + ahead().toFixed(1) + 's bufEnd=' + end.toFixed(1)
          + ' (+' + (end - lastEnd).toFixed(1) + 's/2s) rs=' + v.readyState + ' ns=' + v.networkState + (v.paused ? ' paused' : '') + (waiting ? ' WAIT' : ''))
        lastEnd = end
        // 用户还没点播放时不计时；点了之后满 ms 收尾。
        if (!started){ at = performance.now(); return }
        if (performance.now() - at > ms){
          clearInterval(tick)
          v.removeEventListener('waiting', onWaiting); v.removeEventListener('playing', onPlaying); v.removeEventListener('error', onErr)
          log('video 结束 played=' + v.currentTime.toFixed(0) + 's stalls=' + stalls + ' bufEnd=' + end.toFixed(0) + 's')
          try { v.pause() } catch (e) {}
          v.removeAttribute('src'); v.load(); v.classList.remove('on')
          resolve()
        }
      }, 2000)
      v.src = proxy(mediaUrl, 'video')
      v.load()
      log('video src 已设，请点播放器上的播放键')
    })
  }

  $('btnStart').onclick = async function(){
    $('btnStart').disabled = true
    try {
      mediaUrl = await resolve()
      log('== 1/4 真播 180s（请点播放键）')
      await playVideo(180000)
      log('== 2/4 fetch 单连接 30s 第一遍')
      var a = await fetchOne('bytes=0-', 'single1', 30000)
      log('== 3/4 fetch 单连接 30s 第二遍')
      var b = await fetchOne('bytes=0-', 'single2', 30000)
      var total = a.total || b.total
      if (total){ log('== 4/4 fetch 4 路 30s'); await fetchParallel(total) }
      else log('拿不到文件总长，跳过并发测试')
      log('== 全部完成，可以关页面了')
    } catch (e){ log('失败 ' + (e && e.message || e)) }
    flush()
    $('btnStart').disabled = false
  }
  window.addEventListener('pagehide', flush)
})()
</script>
</body>
</html>`

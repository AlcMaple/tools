// 播放页的本地缓存下载器：浏览器用本机网速直连源站，把整集按 4MB 一块写进 OPFS，
// Service Worker（cover-cache-sw.js）再按 Range 从这些块里回答 <video> 的请求——播放和下载只拉一份流。
//
// 为什么切块而不是写一个大文件：同步写句柄独占文件，SW 在它打开期间 getFile() 会被锁挡住；
// createWritable 要等 close 才可见。每块写完、flush、close 之后才广播「这块到了」，
// 读取端看见的永远是已经落盘的字节（AGENTS.md「边下边读」）。
//
// 2026-10-30 本机实测 play.xfvod.pro：去掉 :8088 走 443 单连接约 23Mbps，6 连接并发合计反而只有 14Mbps，
// 所以只开一条连接顺序拉；SW 要的块（尾部 moov、用户跳到的位置）插队。
//
// HLS 一片本来就是一个完整文件：整片下完写成 `r<序号>`，播放表改写成指向这些文件的 `index.m3u8`。
// dl.playxf.top 按连接限速（10-30 实测单连接 1.5Mbps、6 连接 23.6Mbps，码率约 4.2Mbps），
// 一片要按 Range 切成 job.conns 段并发拉；只开多条连接排队拉不同片的话，每一片都要等近 30 秒，起播和跳转都等不起。
// akua.girigirilove.com 正相反：一片只有 0.2~2MB，每片首字节要等 1.5~4 秒，一片一片顺序拉只有约 2Mbps，
// 所以同时拉 job.par 片。
const CHUNK = 4 * 1024 * 1024
const DIR = 'media-cache'
const RESUME_DELAYS = [2000, 6000, 15000]
// 等响应头、或两次收到数据之间超过这么久就当连接卡死，按传输中断续传。10-30 实测 akua 分片会一直挂着不回。
const IDLE_MS = 20000
const channel = new BroadcastChannel('mt-media-cache')

let queue = []
let current = null
// 收到的字节（还没落盘也算），只给测速用；推进「已落盘」看的是 state.have
let received = 0

function post(msg) { self.postMessage(msg) }
function log(msg) { post({ type: 'log', msg: '[media-cache] ' + msg }) }

class HttpError extends Error {}

const farFrom = (at, want) => want < at || want > at + 3

channel.onmessage = (e) => {
  const m = e.data
  if (m && m.type === 'need' && current && m.hash === current.job.hash && !current.have.has(m.chunk)) {
    current.needs.push(m.chunk)
    // 正在拉的这条流离 SW 要的块很远时立刻断开，从需要的位置重开一条；就在前方几块内的顺着拉过去更快。
    if (current.streamAt >= 0 && farFrom(current.streamAt, m.chunk) && current.streamCtrl) current.streamCtrl.abort('jump')
  }
}

self.onmessage = (e) => {
  const m = e.data
  if (m.type === 'stop') { stopAll(); return }
  if (m.type !== 'job') return
  if (m.priority === 'current') {
    if (current && current.job.hash === m.job.hash) { queue = []; return }
    stopAll()
    queue = [m.job]
  } else if (!queue.some((j) => j.hash === m.job.hash) && !(current && current.job.hash === m.job.hash)) {
    queue.push(m.job)
  }
  if (!current) void pump()
}

function stopAll() {
  queue = []
  if (current) {
    current.stopped = true
    if (current.streamCtrl) current.streamCtrl.abort('stop')
  }
}

async function pump() {
  while (queue.length) {
    const job = queue.shift()
    const state = { job, have: new Set(), needs: [], stopped: false, streamCtrl: null, streamAt: -1 }
    current = state
    const meter = startMeter(state)
    try {
      await (job.kind === 'hls' ? runHls(state) : run(state))
    } catch (err) {
      if (!state.stopped) {
        const reason = err instanceof Error ? err.message : String(err)
        log('ep' + job.ep + ' 下载失败 ' + reason + (err instanceof HttpError ? '' : ' ' + (err && err.stack || '')))
        channel.postMessage({ type: 'failed', hash: job.hash, reason })
        post({ type: 'failed', hash: job.hash, reason, early: state.have.size === 0, http: err instanceof HttpError || err instanceof TypeError })
      }
    }
    clearInterval(meter)
    if (current === state) current = null
  }
}

// 每 5 秒报一次这段时间里收到的字节，播放页按源站记速度、选线路。前后两个窗口都有数据才算：
// 首个窗口含建连，最后一个窗口下完就停，都不完整。
function startMeter(state) {
  let last = received, lastAt = performance.now(), warm = false
  let host = ''
  try { host = new URL(state.job.url).hostname } catch {}
  return setInterval(() => {
    const now = performance.now(), delta = received - last
    if (warm && delta > 0) post({ type: 'speed', hash: state.job.hash, host, bps: delta * 8 / ((now - lastAt) / 1000) })
    warm = delta > 0
    last = received; lastAt = now
  }, 5000)
}

// 同一个文件换了线路：上一条线路下好的块直接搬过来（同目录系统里改名，不复制字节）。页面已确认 mp4 长度一致、HLS 每片时长一致。
async function adoptSeed(top, dir, seed, ok, isPart) {
  if (!seed) return 0
  let from
  try { from = await top.getDirectoryHandle(seed) } catch { return 0 }
  const seedMeta = await readMeta(from)
  if (!seedMeta || !ok(seedMeta)) return 0
  let moved = 0
  const parts = []
  for await (const entry of from.entries()) if (isPart(entry[0])) parts.push(entry)
  for (const [name, handle] of parts) {
    if (typeof handle.move !== 'function') continue
    try { await handle.move(dir, name); moved++ } catch {}
  }
  try { await top.removeEntry(seed, { recursive: true }) } catch {}
  return moved
}

async function jobDir(hash) {
  const root = await navigator.storage.getDirectory()
  const top = await root.getDirectoryHandle(DIR, { create: true })
  return { top, dir: await top.getDirectoryHandle(hash, { create: true }) }
}

async function readMeta(dir) {
  try {
    const file = await (await dir.getFileHandle('meta.json')).getFile()
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}

async function writeFile(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true })
  const access = await handle.createSyncAccessHandle()
  try {
    access.truncate(0)
    access.write(bytes, { at: 0 })
    access.flush()
  } finally {
    access.close()
  }
}

// 先写临时名再改名：页面在写到一半时被关掉，留下的只会是 t 开头的残片，不会是一个看着「已落盘」的 r 文件。
async function writeFileAtomic(dir, name, bytes) {
  await writeFile(dir, 't' + name, bytes)
  const tmp = await dir.getFileHandle('t' + name)
  if (typeof tmp.move === 'function') { await tmp.move(name); return }
  await writeFile(dir, name, bytes)
  await dir.removeEntry('t' + name)
}

const writeMeta = (dir, meta) => writeFile(dir, 'meta.json', new TextEncoder().encode(JSON.stringify(meta)))
const chunkLen = (total, i) => Math.min(CHUNK, total - i * CHUNK)

async function run(state) {
  const job = state.job
  let { top, dir } = await jobDir(job.hash)
  let meta = await readMeta(dir)
  const now = Date.now()
  if (meta && meta.complete) {
    await writeMeta(dir, { ...meta, savedAt: now })
    post({ type: 'complete', hash: job.hash, total: meta.total, cached: true })
    return
  }

  const { res: head } = await fetchBytes(job.url, { method: 'HEAD' }, null, (res) => {
    if (!res.ok) throw new HttpError('HEAD HTTP ' + res.status)
  })
  if (state.stopped) return
  const total = Number(head.headers.get('content-length'))
  if (!Number.isFinite(total) || total <= 0) throw new HttpError('源站没给文件长度')
  if (meta && meta.total !== total) {
    // 同一路径换了内容（签名换了不算），旧块全作废，不然会串片。
    log('ep' + job.ep + ' 源站长度 ' + total + ' ≠ 本地 ' + meta.total + '，重下')
    await top.removeEntry(job.hash, { recursive: true })
    dir = await top.getDirectoryHandle(job.hash, { create: true })
    meta = null
  }

  const n = Math.ceil(total / CHUNK)
  const seeded = await adoptSeed(top, dir, job.seed, (m) => m.total === total && !m.kind, (name) => /^\d+\.bin$/.test(name))
  if (seeded) log('ep' + job.ep + ' 从上一条线路接过 ' + seeded + ' 块')
  for await (const [name, handle] of dir.entries()) {
    const m = /^(\d+)\.bin$/.exec(name)
    if (!m) continue
    const i = Number(m[1])
    if (i < n && (await handle.getFile()).size === chunkLen(total, i)) state.have.add(i)
  }

  const missing = (n - state.have.size) * CHUNK
  const est = await navigator.storage.estimate()
  if (est.quota && est.quota - (est.usage || 0) < missing + 64 * 1024 * 1024) throw new HttpError('QUOTA 空间不够')

  if (state.stopped) return
  meta = { key: job.key, src: job.src, id: job.id, ep: job.ep, bgmId: job.bgmId || null, title: job.title,
    total, chunk: CHUNK, createdAt: meta ? meta.createdAt : now, savedAt: now, complete: false }
  await writeMeta(dir, meta)
  channel.postMessage({ type: 'meta', hash: job.hash })
  log('ep' + job.ep + ' 开始 ' + (total / 1048576).toFixed(0) + 'MB，已有 ' + state.have.size + '/' + n + ' 块')
  post({ type: 'start', hash: job.hash, kind: 'mp4', total, chunk: CHUNK, have: Array.from(state.have) })

  const startedAt = performance.now()
  let fetchedBytes = 0, failures = 0
  const order = [0, n - 1]
  for (let i = 1; i < n - 1; i++) order.push(i)
  const pickNext = () => {
    while (state.needs.length) {
      const i = state.needs.shift()
      if (!state.have.has(i)) return i
    }
    return order.find((i) => !state.have.has(i))
  }

  for (;;) {
    if (state.stopped) return
    const start = pickNext()
    if (start === undefined) break
    let end = start
    while (end + 1 < n && !state.have.has(end + 1)) end++
    const ctrl = new AbortController()
    state.streamCtrl = ctrl
    state.streamAt = start
    let idle = 0
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort('idle'), IDLE_MS) }
    arm()
    try {
      const res = await fetch(job.url, {
        headers: { Range: 'bytes=' + start * CHUNK + '-' + (Math.min(total, (end + 1) * CHUNK) - 1) },
        referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl.signal,
      })
      if (res.status !== 206) throw new HttpError('Range HTTP ' + res.status)
      const reader = res.body.getReader()
      let i = start, buf = new Uint8Array(chunkLen(total, i)), filled = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        received += value.length
        let off = 0
        while (off < value.length) {
          const take = Math.min(buf.length - filled, value.length - off)
          buf.set(value.subarray(off, off + take), filled)
          filled += take; off += take
          if (filled === buf.length) {
            await writeFile(dir, i + '.bin', buf)
            state.have.add(i)
            fetchedBytes += buf.length
            failures = 0
            channel.postMessage({ type: 'chunk', hash: job.hash, chunk: i })
            post({ type: 'progress', hash: job.hash, chunk: i, have: state.have.size, n })
            i++
            state.streamAt = i
            if (i > end || state.stopped) { ctrl.abort('done'); break }
            const want = state.needs.find((x) => !state.have.has(x))
            if (want !== undefined && farFrom(i, want)) { ctrl.abort('jump'); break }
            buf = new Uint8Array(chunkLen(total, i)); filled = 0
          }
        }
        if (ctrl.signal.aborted) break
      }
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (ctrl.signal.reason === 'jump' || ctrl.signal.reason === 'done') continue
      if (state.stopped) return
      // 只有传输中断才续传：从第一个缺的块重开，有界、错峰；4xx/5xx 在上面已经直接抛出。
      if (failures >= RESUME_DELAYS.length) throw new Error('传输连续中断 ' + failures + ' 次：' + (err && err.message))
      const wait = RESUME_DELAYS[failures++] * (1 + Math.random() * 0.3)
      const why = ctrl.signal.reason === 'idle' ? IDLE_MS / 1000 + ' 秒没收到数据' : err && err.message
      log('ep' + job.ep + ' 传输中断（' + why + '），' + Math.round(wait / 1000) + ' 秒后续传')
      await new Promise((r) => setTimeout(r, wait))
    } finally {
      clearTimeout(idle)
      state.streamCtrl = null
      state.streamAt = -1
    }
  }

  if (state.stopped) return
  await writeMeta(dir, { ...meta, complete: true, savedAt: Date.now() })
  const sec = (performance.now() - startedAt) / 1000
  log('ep' + job.ep + ' 下完 ' + (fetchedBytes / 1048576).toFixed(0) + 'MB / ' + sec.toFixed(0) + 's = ' + (fetchedBytes * 8 / 1e6 / Math.max(sec, 0.001)).toFixed(1) + 'Mbps')
  post({ type: 'complete', hash: job.hash, total })
}

// 每个请求都有自己的 AbortController：跟随上层（换集 / 停止）一起中止，另加「没数据」超时。
async function fetchBytes(url, init, signal, check) {
  const ctrl = new AbortController()
  const follow = () => ctrl.abort(signal.reason)
  if (signal) signal.addEventListener('abort', follow)
  let timer = 0
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort('idle'), IDLE_MS) }
  arm()
  try {
    const res = await fetch(url, { ...init, referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl.signal })
    check(res)
    if (!res.body) return { res, bytes: new Uint8Array(0) }
    const reader = res.body.getReader()
    const parts = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      received += value.length
      parts.push(value); size += value.length
    }
    const bytes = new Uint8Array(size)
    let off = 0
    for (const p of parts) { bytes.set(p, off); off += p.length }
    return { res, bytes }
  } catch (err) {
    if (ctrl.signal.reason === 'idle') throw new Error(IDLE_MS / 1000 + ' 秒没收到数据')
    throw err
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', follow)
  }
}

async function fetchText(url) {
  const { bytes } = await fetchBytes(url, {}, null, (res) => { if (!res.ok) throw new HttpError('播放表 HTTP ' + res.status) })
  return new TextDecoder().decode(bytes)
}

// 返回改写后的播放表和要下载的资源（分片、密钥、初始化片段，按出现顺序）。多码率表取第一路。
async function loadPlaylist(url) {
  let text = await fetchText(url)
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const lines = text.split(/\r?\n/)
    const at = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'))
    const uri = lines.slice(at + 1).find((l) => l.trim() && !l.startsWith('#'))
    if (!uri) throw new HttpError('多码率播放表里没有子表')
    url = new URL(uri.trim(), url).href
    text = await fetchText(url)
  }
  const res = [], segs = []
  let dur = 0
  const out = text.split(/\r?\n/).map((line) => {
    const inf = /^#EXTINF:([\d.]+)/.exec(line)
    if (inf) dur = Number(inf[1])
    if (/^#EXT-X-(KEY|MAP|SESSION-KEY):/.test(line)) {
      return line.replace(/URI="([^"]+)"/, (_, uri) => { res.push(new URL(uri, url).href); return 'URI="r' + (res.length - 1) + '"' })
    }
    if (!line.trim() || line.startsWith('#')) return line
    res.push(new URL(line.trim(), url).href)
    segs.push([res.length - 1, dur])
    return 'r' + (res.length - 1)
  })
  return { playlist: out.join('\n'), res, segs }
}

async function fetchRange(url, from, to, signal) {
  const { bytes: buf } = await fetchBytes(url, { headers: { Range: 'bytes=' + from + '-' + to } }, signal, (res) => {
    if (res.status !== 206) throw new HttpError('分片 Range HTTP ' + res.status)
  })
  if (buf.length !== to - from + 1) throw new Error('分片段长度不符 ' + buf.length + '/' + (to - from + 1))
  return buf
}

async function fetchWhole(url, conns, signal) {
  if (conns <= 1) {
    return (await fetchBytes(url, {}, signal, (res) => { if (!res.ok) throw new HttpError('分片 HTTP ' + res.status) })).bytes
  }
  const { res: head } = await fetchBytes(url, { method: 'HEAD' }, signal, (res) => {
    if (!res.ok) throw new HttpError('分片 HEAD HTTP ' + res.status)
  })
  const size = Number(head.headers.get('content-length'))
  if (!Number.isFinite(size) || size <= 0) throw new HttpError('分片没给长度')
  const step = Math.ceil(size / conns)
  const parts = []
  for (let from = 0; from < size; from += step) parts.push(fetchRange(url, from, Math.min(size, from + step) - 1, signal))
  const bufs = await Promise.all(parts)
  const whole = new Uint8Array(size)
  let off = 0
  for (const b of bufs) { whole.set(b, off); off += b.length }
  return whole
}

async function runHls(state) {
  const job = state.job
  let { top, dir } = await jobDir(job.hash)
  let meta = await readMeta(dir)
  const now = Date.now()
  if (meta && meta.complete) {
    await writeMeta(dir, { ...meta, savedAt: now })
    post({ type: 'complete', hash: job.hash, total: meta.total, cached: true })
    return
  }

  const { playlist, res, segs } = await loadPlaylist(job.url)
  if (state.stopped) return
  if (meta && meta.count !== res.length) {
    log('ep' + job.ep + ' 播放表分片数 ' + res.length + ' ≠ 本地 ' + meta.count + '，重下')
    await top.removeEntry(job.hash, { recursive: true })
    dir = await top.getDirectoryHandle(job.hash, { create: true })
    meta = null
  }
  const n = res.length
  const seeded = await adoptSeed(top, dir, job.seed, (m) => m.kind === 'hls' && m.count === n, (name) => /^r\d+$/.test(name))
  if (seeded) log('ep' + job.ep + ' 从上一条线路接过 ' + seeded + ' 片')
  let haveBytes = 0
  for await (const [name, handle] of dir.entries()) {
    const m = /^r(\d+)$/.exec(name)
    if (!m || Number(m[1]) >= n) continue
    const size = (await handle.getFile()).size
    if (size > 0) { state.have.add(Number(m[1])); haveBytes += size }
  }

  await writeFile(dir, 'index.m3u8', new TextEncoder().encode(playlist))
  meta = { kind: 'hls', key: job.key, src: job.src, id: job.id, ep: job.ep, bgmId: job.bgmId || null, title: job.title,
    count: n, total: 0, createdAt: meta ? meta.createdAt : now, savedAt: now, complete: false }
  await writeMeta(dir, meta)
  channel.postMessage({ type: 'meta', hash: job.hash })
  post({ type: 'start', hash: job.hash, kind: 'hls', segs, have: Array.from(state.have) })
  log('ep' + job.ep + ' 开始 HLS ' + n + ' 片，同时 ' + (job.par || 1) + ' 片 × 每片 ' + (job.conns || 1) + ' 段，已有 ' + state.have.size + ' 片')

  const startedAt = performance.now()
  let fetchedBytes = 0, failures = 0, quotaChecked = false, fatal = null
  const inflight = new Set()
  const ctrls = new Set()
  // 播放器要了哪片就从哪片往后接着拉（跳进度之后紧接着要的就是后面几片），到尾再回头补前面的缺口。
  let cursor = 0
  const pickNext = () => {
    while (state.needs.length) {
      const i = state.needs.shift()
      if (!state.have.has(i) && !inflight.has(i)) { cursor = i + 1; return i }
    }
    for (let k = 0; k < n; k++) {
      const i = (cursor + k) % n
      if (!state.have.has(i) && !inflight.has(i)) { cursor = i + 1; return i }
    }
    return undefined
  }
  // 几条「车道」各自取下一片：重试预算（failures）全集共用一份，任何一条遇到 HTTP 错误就让所有车道一起停。
  const lane = async () => {
    for (;;) {
      if (state.stopped || fatal) return
      const next = pickNext()
      if (next === undefined) return
      inflight.add(next)
      const ctrl = new AbortController()
      ctrls.add(ctrl)
      try {
        const bytes = await fetchWhole(res[next], job.conns || 1, ctrl.signal)
        if (state.stopped || fatal) return
        if (!quotaChecked) {
          quotaChecked = true
          const est = await navigator.storage.estimate()
          const need = bytes.length * (n - state.have.size) * 1.2
          if (est.quota && est.quota - (est.usage || 0) < need + 64 * 1024 * 1024) throw new HttpError('QUOTA 空间不够')
        }
        await writeFileAtomic(dir, 'r' + next, bytes)
        state.have.add(next)
        fetchedBytes += bytes.length; haveBytes += bytes.length
        failures = 0
        channel.postMessage({ type: 'chunk', hash: job.hash, chunk: next })
        post({ type: 'progress', hash: job.hash, chunk: next, have: state.have.size, n })
      } catch (err) {
        if (state.stopped || fatal) return
        if (err instanceof HttpError) { fatal = err; for (const c of ctrls) c.abort('fatal'); return }
        if (failures >= RESUME_DELAYS.length) {
          fatal = new Error('传输连续中断 ' + failures + ' 次：' + (err && err.message))
          for (const c of ctrls) c.abort('fatal')
          return
        }
        const wait = RESUME_DELAYS[failures++] * (1 + Math.random() * 0.3)
        log('ep' + job.ep + ' 第 ' + next + ' 片传输中断（' + (err && err.message) + '），' + Math.round(wait / 1000) + ' 秒后续传')
        await new Promise((r) => setTimeout(r, wait))
      } finally {
        inflight.delete(next)
        ctrls.delete(ctrl)
      }
    }
  }
  state.streamCtrl = { abort: (why) => { for (const c of ctrls) c.abort(why) } }
  await Promise.all(Array.from({ length: job.par || 1 }, lane))
  state.streamCtrl = null
  if (fatal) throw fatal

  if (state.stopped) return
  await writeMeta(dir, { ...meta, total: haveBytes, complete: true, savedAt: Date.now() })
  const sec = (performance.now() - startedAt) / 1000
  log('ep' + job.ep + ' 下完 ' + (fetchedBytes / 1048576).toFixed(0) + 'MB / ' + sec.toFixed(0) + 's = ' + (fetchedBytes * 8 / 1e6 / Math.max(sec, 0.001)).toFixed(1) + 'Mbps')
  post({ type: 'complete', hash: job.hash, total: haveBytes })
}

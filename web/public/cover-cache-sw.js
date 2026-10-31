// 只接管公开、内容地址稳定的 Bangumi 封面代理。不能泛化到 `/api/tracks/*`：其中的
// `cover-file` 是登录用户私有图片，同一路径在换账号后可能对应另一份数据。
const CACHE_NAME = 'mt-bgm-cover-v2'
const CACHE_PREFIX = 'mt-bgm-cover-'
const MAX_ENTRIES = 360

function isCacheableCover(request) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  return url.origin === self.location.origin && url.pathname.startsWith('/api/cover/')
}

async function trim(cache) {
  const keys = await cache.keys()
  const overflow = keys.length - MAX_ENTRIES
  if (overflow <= 0) return
  await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)))
}

async function respondWithCachedCover(event) {
  let cache
  try {
    cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(event.request)
    if (cached) return cached
  } catch {
    // 配额耗尽、隐私模式禁用 Cache Storage 等情况不能让图片请求失败；直接退回原代理。
    return fetch(event.request)
  }

  const response = await fetch(event.request)
  const contentType = response.headers.get('content-type') || ''
  if (response.ok && /^image\/(?:png|jpe?g|gif|webp)(?:;|$)/i.test(contentType)) {
    // 不阻塞首张图展示；waitUntil 保证缓存写完前 worker 不会被浏览器过早回收。
    const save = cache.put(event.request, response.clone())
      .then(() => trim(cache))
      .catch(() => undefined)
    try {
      event.waitUntil(save)
    } catch {
      // 极少数实现不接受 fetch 事件的延寿承诺时，响应本身仍照常返回。
      void save
    }
  }
  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) || (name.startsWith('mt-player-shell-') && name !== SHELL_CACHE))
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

// ——— 在线播放的本地缓存 ———
// 播放页把 <video> 指向 /media-cache/<hash>，这里按 Range 从 OPFS 里的 4MB 块拼出响应。
// HLS 则指向 /media-cache/<hash>/index.m3u8，播放表里的分片是同目录的 r<序号>，整片返回。
// 块由 media-cache-worker.js 直连源站下载；还没到的块先发 need 让下载器插队，再等它广播「到了」。
// 等不到（下载器失败 / 页面已没了下载器）就让这条请求出错，播放页据此退回原来的播放方式。
const MEDIA_PATH = /^\/media-cache\/([0-9a-f]{40})(?:\/(index\.m3u8|r(\d+)))?$/
const MEDIA_DIR = 'media-cache'
const CHUNK_WAIT_MS = 45000
const mediaChannel = new BroadcastChannel('mt-media-cache')
const mediaWaiters = new Set()
const mediaFailed = new Map()

mediaChannel.onmessage = (e) => {
  const m = e.data
  if (!m || !m.hash) return
  if (m.type === 'failed') mediaFailed.set(m.hash, m.reason || 'failed')
  if (m.type === 'meta') mediaFailed.delete(m.hash)
  for (const w of [...mediaWaiters]) if (w.hash === m.hash) w.wake()
}

async function mediaDir(hash) {
  const root = await navigator.storage.getDirectory()
  return (await root.getDirectoryHandle(MEDIA_DIR)).getDirectoryHandle(hash)
}

async function tryMeta(hash) {
  try {
    const file = await (await (await mediaDir(hash)).getFileHandle('meta.json')).getFile()
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}

async function tryChunk(hash, i, size) {
  try {
    const file = await (await (await mediaDir(hash)).getFileHandle(i + '.bin')).getFile()
    return file.size === size ? file : null
  } catch {
    return null
  }
}

// 反复调 probe，直到它给出结果；每次下载器广播这一集的消息时重查一遍，不定时轮询。
function waitFor(hash, probe, onMiss) {
  return new Promise((resolve, reject) => {
    let checking = false, again = false
    const waiter = { hash, wake: () => void check() }
    const timer = setTimeout(() => finish(null, new Error('等待本地缓存超时')), CHUNK_WAIT_MS)
    function finish(value, err) {
      clearTimeout(timer)
      mediaWaiters.delete(waiter)
      if (err) reject(err); else resolve(value)
    }
    async function check() {
      if (checking) { again = true; return }
      checking = true
      do {
        again = false
        const value = await probe()
        if (value) { finish(value); return }
        if (mediaFailed.has(hash)) { finish(null, new Error('下载失败：' + mediaFailed.get(hash))); return }
      } while (again)
      checking = false
    }
    mediaWaiters.add(waiter)
    if (onMiss) onMiss()
    void check()
  })
}

async function tryFile(hash, name) {
  try {
    const file = await (await (await mediaDir(hash)).getFileHandle(name)).getFile()
    return file.size > 0 ? file : null
  } catch {
    return null
  }
}

async function serveHls(hash, name, index) {
  try {
    const file = await waitFor(hash, () => tryFile(hash, name), index === null ? null : () => {
      mediaChannel.postMessage({ type: 'need', hash, chunk: index })
    })
    const type = index === null ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
    return new Response(file, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(file.size), 'Cache-Control': 'no-store' } })
  } catch (err) {
    return new Response(String(err && err.message), { status: 504 })
  }
}

async function serveMedia(request, hash) {
  let meta
  try {
    meta = await waitFor(hash, () => tryMeta(hash))
  } catch (err) {
    return new Response(String(err && err.message), { status: 504 })
  }
  const total = meta.total, chunk = meta.chunk
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '')
  let start = 0, end = total - 1
  if (range && range[1]) {
    start = Number(range[1])
    if (range[2]) end = Math.min(total - 1, Number(range[2]))
  } else if (range && range[2]) {
    start = Math.max(0, total - Number(range[2]))
  }
  if (start >= total || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } })
  }

  let pos = start
  const body = new ReadableStream({
    async pull(controller) {
      const i = Math.floor(pos / chunk)
      const size = Math.min(chunk, total - i * chunk)
      try {
        const file = await waitFor(hash, () => tryChunk(hash, i, size), () => {
          mediaChannel.postMessage({ type: 'need', hash, chunk: i })
        })
        const from = pos - i * chunk, to = Math.min(size, end + 1 - i * chunk)
        controller.enqueue(new Uint8Array(await file.slice(from, to).arrayBuffer()))
        pos = i * chunk + to
        if (pos > end) controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  }, { highWaterMark: 0 })

  const headers = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (!range) return new Response(body, { status: 200, headers })
  return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + total } })
}

// ——— 播放页离线壳 ———
// 断网时也要能打开播放页，才谈得上看本地缓存。联网时一律先走网络（页面带登录态和最新线路），
// 网络失败才拿最近一次的副本：同一地址的原样返回；没开过的集借最近一次的页面，只把页面参数换成这一集。
// 页面里的 CSP nonce 和响应头是同一次生成的，整份响应一起存、一起回，两者对得上。
const SHELL_CACHE = 'mt-player-shell-v1'
const SHELL_LAST = '/__player-page-last__'
const SHELL_PAGES_MAX = 60

// SW 里的失败原因回服务端终端（AGENTS.md「调试日志」），失败了也不影响页面本身。
function swLog(msg) {
  fetch('/api/player/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: '[sw] ' + msg }), keepalive: true })
    .catch(() => undefined)
}

function isPlayerPage(request, url) {
  return request.mode === 'navigate' && url.pathname === '/api/player/page'
}

function isPlayerAsset(url) {
  return url.pathname.startsWith('/api/player/vendor/') || url.pathname.startsWith('/styles/') || url.pathname.startsWith('/fonts/')
}

async function trimShell(cache) {
  const pages = (await cache.keys()).filter((r) => new URL(r.url).pathname === '/api/player/page')
  await Promise.all(pages.slice(0, Math.max(0, pages.length - SHELL_PAGES_MAX)).map((r) => cache.delete(r)))
}

async function shellNetworkFirst(event, url, page) {
  try {
    const response = await fetch(event.request)
    // 未登录时 /page 会 302 回首页；只存真正的播放页。
    if (response.ok && response.type === 'basic' && !response.redirected) {
      // clone 必须在把响应交出去之前做：交出去之后正文开始被读，再 clone 会抛「body already used」。
      const copy = response.clone()
      const last = page ? response.clone() : null
      const save = caches.open(SHELL_CACHE).then(async (cache) => {
        await cache.put(event.request, copy)
        if (last) {
          await cache.put(SHELL_LAST, last)
          await trimShell(cache)
        }
      }).catch((err) => swLog('player shell save failed ' + url.pathname + ' ' + (err && err.message)))
      try { event.waitUntil(save) } catch { void save }
    }
    return response
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE)
    const hit = await cache.match(event.request, { ignoreVary: true })
    if (hit) return hit
    if (!page) throw err
    const last = await cache.match(SHELL_LAST)
    if (!last) throw err
    // 和服务端 parseSrc 同样的校验：地址栏可以随便改，不合法的就不借壳。
    const q = url.searchParams
    const src = q.get('src')
    const rawId = (q.get('id') || '').trim()
    const id = src === 'girigiri' ? rawId.toUpperCase() : rawId
    const ep = Number(q.get('ep') || '1')
    const bgmId = Number(q.get('bgmId'))
    const idOk = src === 'xifan' ? /^\d+$/.test(id) : src === 'girigiri' && /^GV\d+$/.test(id)
    if (!idOk || !Number.isInteger(ep) || ep < 1) throw err
    const args = JSON.stringify({ src, id, ep, bgmId: Number.isInteger(bgmId) && bgmId ? bgmId : null })
      .replace(/[<>&\u2028\u2029]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    const html = (await last.text()).replace(/var ARGS = [^\n]*/, () => 'var ARGS = ' + args)
    return new Response(html, { status: 200, headers: last.headers })
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin === self.location.origin && event.request.method === 'GET') {
    const page = isPlayerPage(event.request, url)
    if (page || isPlayerAsset(url)) {
      event.respondWith(shellNetworkFirst(event, url, page))
      return
    }
  }
  const media = url.origin === self.location.origin && event.request.method === 'GET' ? MEDIA_PATH.exec(url.pathname) : null
  if (media) {
    event.respondWith(media[2] ? serveHls(media[1], media[2], media[3] === undefined ? null : Number(media[3])) : serveMedia(event.request, media[1]))
    return
  }
  if (!isCacheableCover(event.request)) return
  event.respondWith(respondWithCachedCover(event))
})

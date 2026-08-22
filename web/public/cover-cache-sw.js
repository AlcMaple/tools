// 只接管公开、内容地址稳定的 Bangumi 封面代理。不能泛化到 `/api/tracks/*`：其中的
// `cover-file` 是登录用户私有图片，同一路径在换账号后可能对应另一份数据。
const CACHE_NAME = 'mt-bgm-cover-v1'
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
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (!isCacheableCover(event.request)) return
  event.respondWith(respondWithCachedCover(event))
})

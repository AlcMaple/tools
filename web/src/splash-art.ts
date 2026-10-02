const ART = '/assets/sagiri-full.webp'
const SEEN_KEY = 'mt-splash-seen'
const BUDGET_MS = 150
let pending: HTMLImageElement | undefined

function report(detail: string): void {
  // 开屏没放只有手机浏览器知道；打回服务端终端，否则只能靠猜。
  const body = JSON.stringify({ detail: '[splash] ' + detail })
  try {
    if (navigator.sendBeacon?.('/api/boot-log', new Blob([body], { type: 'application/json' }))) return
  } catch { /* 落到 fetch */ }
  fetch('/api/boot-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {})
}

// 历史：曾用 fetch(cache: 'only-if-cached') + blob 判断缓存。iPhone Chrome（WebKit）上这条路
// 不可靠，已缓存也拿不到图，开屏几乎从不播放。现在直接用 <img> 加载：命中图片缓存时解码很快，
// 未命中时同一个请求就是后台低优先级下载，预算外迟到的结果一律不补播。
export async function cachedSplashArt(): Promise<string | null> {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  try {
    if (sessionStorage.getItem(SEEN_KEY)) return null
  } catch {
    // 禁用 Storage 的浏览器仍可使用 HTTP 图片缓存。
  }
  const started = performance.now()
  const image = new Image()
  image.fetchPriority = 'low'
  image.src = ART
  pending = image
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true
      resolve(null)
    }, BUDGET_MS)
  })
  const ready = image.decode().then(
    () => {
      if (expired) {
        report(`late ${Math.round(performance.now() - started)}ms`)
        return null
      }
      try { sessionStorage.setItem(SEEN_KEY, '1') } catch { /* Storage 不可用不影响开屏。 */ }
      return ART
    },
    (error: unknown) => {
      report(`decode failed ${Math.round(performance.now() - started)}ms: ${String(error)}`)
      return null
    },
  )
  try {
    return await Promise.race([ready, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function warmSplashArt(): void {
  if (pending) return
  pending = new Image()
  pending.fetchPriority = 'low'
  pending.src = ART
}

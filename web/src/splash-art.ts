const ART = '/assets/sagiri-full.webp'
const SEEN_KEY = 'mt-splash-seen'
let pending: HTMLImageElement | undefined

export async function cachedSplashArt(): Promise<string | null> {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  try {
    if (sessionStorage.getItem(SEEN_KEY)) return null
  } catch {
    // 禁用 Storage 的浏览器仍可使用 HTTP 图片缓存。
  }
  const controller = new AbortController()
  let url: string | undefined
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    // 缓存读锁、blob 读取和解码都可能迟迟不结束；开屏不能无限占住首页挂载。
    timer = setTimeout(() => {
      expired = true
      controller.abort()
      if (url) URL.revokeObjectURL(url)
      resolve(null)
    }, 150)
  })
  const read = async (): Promise<string | null> => {
    const response = await fetch(ART, { cache: 'only-if-cached', mode: 'same-origin', signal: controller.signal })
    if (expired || !response.ok || !response.headers.get('Content-Type')?.startsWith('image/')) return null
    const blob = await response.blob()
    if (expired) return null
    url = URL.createObjectURL(blob)
    const image = new Image()
    image.src = url
    await image.decode()
    if (expired) return null
    try { sessionStorage.setItem(SEEN_KEY, '1') } catch { /* Storage 不可用不影响开屏。 */ }
    return url
  }
  try {
    return await Promise.race([read(), deadline])
  } catch {
    if (url) URL.revokeObjectURL(url)
    return null
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

/**
 * Aowu video URL resolver — FantasyKon (post-2026-05) flow.
 *
 * The new watch page is /w/{animeToken}#s={source_id}&ep={ep_num}. It's a
 * JS-rendered SPA that:
 *   1. Reads the URL hash to figure out which source/ep is selected
 *   2. POSTs to /api/site/secure with an encrypted payload
 *   3. Decrypts the response in-page
 *   4. Sets the resulting CDN URL onto a <video> element's src attribute
 *
 * Replicating the request/response crypto in Node would require reverse-engineering
 * the obfuscated bundle (~520KB minified, no `site/secure` literal). Instead we
 * drive the page in a hidden Electron BrowserWindow and pluck `<video>.src` once
 * the SPA has set it.
 *
 * The resolved URL is a signed ByteDance CDN link
 * (e.g. lf26-imcloud-file-sign.bytetos.com), supports HTTP Range, and stays valid
 * for a few hours — long enough for downstream chunked-Range download to complete.
 */
import { BASE_URL } from './api'
import { navigate, evalInPage, waitFor } from './headless'

/**
 * Run the resolution chain for one watch URL. Returns the final mp4 direct URL.
 *
 * `watchUrl` is `${BASE_URL}/w/{animeToken}#s={src}&ep={ep}` (or accepts the
 * separate parts via the convenience overload below).
 */
export async function resolveAowuMp4(watchUrl: string): Promise<string> {
  const u = new URL(watchUrl)
  if (!u.pathname.startsWith('/w/')) {
    throw new Error(`AOWU_STRUCTURE_CHANGED: 期望 /w/{token}# 形式的播放 URL，收到 ${u.pathname}`)
  }

  await navigate(watchUrl)

  // The SPA sets <video>.src after /api/site/secure POST + in-page decryption.
  // Empirically takes 3–6s; pad the timeout for slow networks / first-load JS bundle.
  await waitFor(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null
    const src = v?.src || ''
    return !!(src && /^https?:\/\//.test(src))
  }, 30000, 250)

  const url = await evalInPage<string>(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null
    return (v?.src || '').toString()
  })

  if (!url || !/^https?:\/\//.test(url)) {
    throw new Error('AOWU_RESOLVE_FAILED: 未在 <video>.src 上找到有效 URL')
  }
  return url
}

/** Convenience: build the watch URL from parts. */
export function buildAowuWatchUrl(animeToken: string, sourceId: number, epNum: number): string {
  return `${BASE_URL}/w/${animeToken}#s=${sourceId}&ep=${epNum}`
}

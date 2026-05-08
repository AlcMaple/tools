/**
 * Aowu video URL resolver — FantasyKon (post-2026-05) flow.
 *
 * Two-step protocol against the encrypted /api/site/secure endpoint:
 *   1. bundle(bundle_page="play", id, source_id, episode) → { play_token: { token } }
 *   2. play(id, token=play_token)                          → { url: <signed CDN mp4> }
 *
 * The resolved URL is a signed ByteDance CDN link (lf*-imcloud-file-sign.bytetos.com),
 * supports HTTP Range, and stays valid for several hours — long enough for the
 * downstream chunked-Range download to complete.
 *
 * `watchUrl` is `${BASE_URL}/w/{idOrToken}#s={src}&ep={ep}`. The hash carries
 * source_id and episode; the path tail carries our `id`. After the BrowserWindow
 * → HTTP refactor we put numeric video ids in the path; legacy queues may carry
 * an opaque play_token there, in which case we route() it first.
 */
import { BASE_URL, callSecure, ERR_STRUCTURE } from './secure'
import { URL } from 'node:url'

interface PlayBundleData {
  data: {
    play_token: { token: string }
  }
}

interface PlayUrlData {
  url: string
  video_id?: number
  episode_no?: number
}

interface RouteData {
  video_id: number
}

interface WatchPathParts {
  id: number
  sourceId: number
  ep: number
}

async function parseWatchUrl(watchUrl: string): Promise<WatchPathParts> {
  const u = new URL(watchUrl)
  const pathM = /^\/w\/([^/?#]+)/.exec(u.pathname)
  if (!pathM) {
    throw new Error(`${ERR_STRUCTURE}: 期望 /w/{token}# 形式的播放 URL，收到 ${u.pathname}`)
  }
  const tail = decodeURIComponent(pathM[1])

  // Hash carries `s=...&ep=...`. URL parses hash as a single string starting with `#`.
  const hash = u.hash.replace(/^#/, '')
  const sM = /(?:^|&)s=(\d+)/.exec(hash)
  const epM = /(?:^|&)ep=(\d+)/.exec(hash)
  if (!sM || !epM) {
    throw new Error(`${ERR_STRUCTURE}: URL hash 缺少 s/ep 参数 (${u.hash})`)
  }
  const sourceId = parseInt(sM[1], 10)
  const ep = parseInt(epM[1], 10)

  let id: number
  if (/^\d+$/.test(tail)) {
    id = parseInt(tail, 10)
  } else {
    // Legacy: tail is an opaque play token. Route it.
    const r = await callSecure<RouteData>({ action: 'route', params: { token: tail } })
    if (!r?.video_id) {
      throw new Error(`${ERR_STRUCTURE}: route 未返回 video_id (token=${tail})`)
    }
    id = r.video_id
  }
  return { id, sourceId, ep }
}

/** Resolve a watch URL to its signed CDN mp4 URL (~200ms over warm key cache). */
export async function resolveAowuMp4(watchUrl: string): Promise<string> {
  const { id, sourceId, ep } = await parseWatchUrl(watchUrl)

  const playRes = await callSecure<PlayBundleData>({
    action: 'bundle',
    params: { id, source_id: sourceId, episode: ep, bundle_page: 'play' },
  })
  const token = playRes?.data?.play_token?.token
  if (!token) {
    throw new Error(`${ERR_STRUCTURE}: bundle(play) 未返回 play_token.token`)
  }

  const r = await callSecure<PlayUrlData>({
    action: 'play',
    params: { id, token },
  })
  const url = r?.url
  if (!url || !/^https?:\/\//.test(url)) {
    throw new Error('AOWU_RESOLVE_FAILED: play 响应缺少有效 url')
  }
  return url
}

/**
 * Construct the watch URL fed to {@link resolveAowuMp4}. Pure formatter — kept
 * around so the IPC handler can build the URL once and pass it through.
 */
export function buildAowuWatchUrl(animeToken: string, sourceId: number, epNum: number): string {
  return `${BASE_URL}/w/${animeToken}#s=${sourceId}&ep=${epNum}`
}

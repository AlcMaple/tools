/**
 * Aowu MP4 download — thin wrapper around shared mp4-range-downloader.
 *
 * Per-ep flow:
 *   - Resolve the real mp4 URL via the 3-step chain in url-resolver.ts (the URL is
 *     a short-lived signed CDN link).
 *   - Apply the `[Aowu] {title}/{title} - EP.mp4` directory + filename convention.
 *   - Hand off to shared downloadByUrl for chunked-Range with resume.
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { safeName, DlEvent } from '../shared/download-types'
import { downloadByUrl, cleanupPartsAt } from '../shared/mp4-range-downloader'
import { resolveAowuMp4, buildAowuWatchUrl } from './url-resolver'

export type { DlEvent }

const LOG_TAG = 'aowu'

function epSavePath(title: string, label: string, saveDir: string | undefined): string {
  const base = saveDir ?? app.getPath('downloads')
  const dir = join(base, `[Aowu] ${safeName(title)}`)
  return join(dir, `${safeName(title)} - ${safeName(label)}.mp4`)
}

export function cleanupParts(title: string, label: string, saveDir: string | undefined): void {
  cleanupPartsAt(epSavePath(title, label, saveDir))
}

export async function downloadSingleEp(
  title: string,
  ep: number,        // the queue's ep id (used for events)
  label: string,     // display label, used in filename
  animeId: string,
  sourceIdx: number,
  saveDir: string | undefined,
  signal: AbortSignal,
  onEvent: (ev: DlEvent) => void
): Promise<void> {
  onEvent({ type: 'ep_start', ep })

  if (!animeId || !sourceIdx) {
    onEvent({ type: 'ep_error', ep, msg: 'Missing animeId or sourceIdx' })
    return
  }
  // After the HTTP refactor, `animeId` is a numeric video id as string (e.g.
  // "2893"). Legacy queues from before the refactor may still carry an opaque
  // play_token like "_2jACJ3_AIQE" — both shapes match this regex and the new
  // resolveAowuMp4 handles them (it routes legacy tokens through `route(token)`).
  // The check rejects malformed values (slashes, empty, null-stringified) up
  // front with a clear message instead of letting them silently fail.
  if (!/^[A-Za-z0-9_-]+$/.test(animeId)) {
    onEvent({ type: 'ep_error', ep, msg: `任务数据已过期（aowuId="${animeId}"）— 请删除该任务并重新搜索添加` })
    return
  }

  const savePath = epSavePath(title, label, saveDir)
  const dir = dirname(savePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Step 1: resolve the watch page → real mp4 URL (signed ByteDance CDN link).
  // resolveAowuMp4 hits /api/site/secure twice (bundle(play) → play) and
  // returns in ~250ms over a warm key cache.
  let mp4Url: string
  try {
    const watchUrl = buildAowuWatchUrl(animeId, sourceIdx, ep)
    mp4Url = await resolveAowuMp4(watchUrl)
  } catch (err) {
    if (signal.aborted) return
    onEvent({ type: 'ep_error', ep, msg: `URL resolve failed: ${(err as Error).message}` })
    return
  }

  if (signal.aborted) return

  // Step 2: chunked Range download via shared module.
  const outcome = await downloadByUrl(mp4Url, savePath, signal, (bytes, _total, pct) => {
    onEvent({ type: 'ep_progress', ep, pct, bytes })
  }, LOG_TAG)

  if (outcome.ok) {
    onEvent({ type: 'ep_done', ep })
    return
  }
  if (outcome.reason === 'aborted') return
  const msg =
    outcome.reason === 'probe_failed' ? 'Probe failed' :
    outcome.reason === 'chunks_failed' ? (outcome.msg ?? 'One or more chunks failed after retries') :
    outcome.reason === 'merge_failed' ? `Merge failed: ${outcome.msg ?? ''}` :
    outcome.reason === 'stream_failed' ? (outcome.msg ?? 'Download failed') :
    'Download failed'
  onEvent({ type: 'ep_error', ep, msg })
}

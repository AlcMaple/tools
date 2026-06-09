/**
 * Xifan MP4 download — thin wrapper around shared mp4-range-downloader.
 *
 * Responsibilities here:
 *   - Resolve the per-ep URL from the source template (`formatEpUrl`,按占位符位宽补零)
 *   - Apply the `[Xifan] {title}/{title} - EP.mp4` directory + filename convention
 *   - Translate the shared downloader's structured outcome into UI events
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { safeName, DlEvent } from '../shared/download-types'
import { downloadByUrl, cleanupPartsAt } from '../shared/mp4-range-downloader'

export type { DlEvent }

const LOG_TAG = 'xifan'

/**
 * 把模板里的集数占位符替换成真实集号,按占位符携带的位宽补零:
 *   {:d}   → 不补零(1 → "1",10 → "10")
 *   {:02d} → 补零到两位(4 → "04")
 * 兼容历史 localStorage 里残留的旧 {:02d} 模板(语义与从前完全一致)。
 */
function formatEpUrl(template: string, ep: number): string {
  return template.replace(/\{:0?(\d*)d\}/, (_, width: string) => {
    const w = width ? parseInt(width, 10) : 0
    return String(ep).padStart(w, '0')
  })
}

function epSavePath(title: string, ep: number, saveDir: string | undefined): string {
  const epStr = String(ep).padStart(2, '0')
  const base = saveDir ?? app.getPath('downloads')
  const dir = join(base, `[Xifan] ${safeName(title)}`)
  return join(dir, `${safeName(title)} - ${epStr}.mp4`)
}

/**
 * Delete part files + final mp4 for a given saved episode. Used when caller switches
 * source: the new URL is unrelated, so any partial bytes are unusable.
 */
export function cleanupParts(title: string, ep: number, saveDir: string | undefined): void {
  cleanupPartsAt(epSavePath(title, ep, saveDir))
}

export async function downloadSingleEp(
  title: string,
  ep: number,
  templates: string[],
  sourceIdx: number,
  saveDir: string | undefined,
  signal: AbortSignal,
  onEvent: (ev: DlEvent) => void
): Promise<void> {
  onEvent({ type: 'ep_start', ep })

  const template = templates[sourceIdx]
  if (!template) {
    onEvent({ type: 'ep_error', ep, msg: `No source at index ${sourceIdx}` })
    return
  }

  const savePath = epSavePath(title, ep, saveDir)
  const dir = dirname(savePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const url = formatEpUrl(template, ep)

  const outcome = await downloadByUrl(url, savePath, signal, (bytes, _total, pct) => {
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

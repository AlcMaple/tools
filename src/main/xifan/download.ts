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
import { resolveEpRealUrl } from './api'

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

/** 取 URL 路径里的文件名(去扩展名),如 .../OVA.mp4 → "OVA"。取不到返回 null。 */
function nameFromUrl(u: string): string | null {
  try {
    const base = new URL(u).pathname.split('/').pop() ?? ''
    const name = decodeURIComponent(base).replace(/\.[^.]+$/, '').trim()
    return name || null
  } catch {
    return null
  }
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
  epPages: string[],
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

  const run = (u: string, path: string): ReturnType<typeof downloadByUrl> =>
    downloadByUrl(u, path, signal, (bytes, _total, pct) => {
      onEvent({ type: 'ep_progress', ep, pct, bytes })
    }, LOG_TAG)

  let outcome = await run(url, savePath)

  // 模板拼出的 URL 404:多半是 OVA 这类特殊集,文件名不是集号(如 .../OVA.mp4),
  // 回源拉该集播放页解析真实地址再下一次(见 docs/regression/xifan-下载链接-集数补零-回归用例.md)。
  // 只认 404(链接是我们自己拼错的);限流/5xx 仍按红线原样上抛给 UI,不在这里重试。
  // epPages 旧任务(升级前的 localStorage)里没有,此时维持原 404 错误,行为同从前。
  if (!outcome.ok && outcome.reason === 'probe_failed' && outcome.status === 404 && epPages[sourceIdx]) {
    try {
      const realUrl = await resolveEpRealUrl(epPages[sourceIdx], ep)
      if (realUrl && realUrl !== url) {
        // 真实直链先同步给渲染层,「复制 mp4 直链」得复制这条,模板拼的那条是 404
        onEvent({ type: 'ep_url', ep, url: realUrl })
        // 文件名跟着真实链接走:.../OVA.mp4 存成 {title} - OVA.mp4,不硬套集号
        const realName = nameFromUrl(realUrl)
        const realPath = realName ? join(dir, `${safeName(title)} - ${safeName(realName)}.mp4`) : savePath
        outcome = await run(realUrl, realPath)
      }
    } catch { /* 回源本身失败 → 保留原 404 outcome,走下面统一错误上报 */ }
  }

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

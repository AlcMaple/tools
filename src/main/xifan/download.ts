/**
 * 稀饭的 mp4 下载 —— 在共享的分片下载器外面包一层,每集都使用源站签发的 URL、
 * 套用目录 / 文件名约定、把下载器的结构化结果翻译成 UI 事件。
 */
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { safeName, DlEvent } from '../shared/download-types'
import { downloadByUrl, cleanupPartsAt } from '../shared/mp4-range-downloader'
import { resolveEpRealUrl } from './api'

export type { DlEvent }

const LOG_TAG = 'xifan'

function epSavePath(title: string, ep: number, saveDir: string | undefined): string {
  const epStr = String(ep).padStart(2, '0')
  const base = saveDir ?? app.getPath('downloads')
  const dir = join(base, `[Xifan] ${safeName(title)}`)
  return join(dir, `${safeName(title)} - ${epStr}.mp4`)
}

/** 删掉某一集的分片和最终 mp4。换源时用:新地址与旧的无关,已下的字节全都用不上。 */
export function cleanupParts(title: string, ep: number, saveDir: string | undefined): void {
  cleanupPartsAt(epSavePath(title, ep, saveDir))
}

export async function downloadSingleEp(
  title: string,
  ep: number,
  _templates: string[],
  sourceIdx: number,
  epPages: string[],
  saveDir: string | undefined,
  signal: AbortSignal,
  onEvent: (ev: DlEvent) => void
): Promise<void> {
  onEvent({ type: 'ep_start', ep })

  if (signal.aborted) return
  const page = epPages[sourceIdx]
  if (!page) {
    onEvent({ type: 'ep_error', ep, msg: '旧任务缺少稀饭选集信息，请重新添加下载任务' })
    return
  }
  let url: string
  try {
    const resolved = await resolveEpRealUrl(page, ep)
    if (!resolved) throw new Error('稀饭未返回播放地址')
    url = resolved
  } catch (error) {
    console.error('[xifan:download] 解析失败：', error)
    if (!signal.aborted) onEvent({ type: 'ep_error', ep, msg: error instanceof Error ? error.message : '稀饭解析失败' })
    return
  }
  if (signal.aborted) return
  onEvent({ type: 'ep_url', ep, url })
  const savePath = epSavePath(title, ep, saveDir)
  const dir = dirname(savePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const run = (u: string, path: string): ReturnType<typeof downloadByUrl> =>
    downloadByUrl(u, path, signal, (bytes, _total, pct) => {
      onEvent({ type: 'ep_progress', ep, pct, bytes })
    }, LOG_TAG)

  const outcome = await run(url, savePath)

  if (outcome.ok) {
    onEvent({ type: 'ep_done', ep })
    return
  }
  if (outcome.reason === 'aborted') return
  const msg =
    outcome.reason === 'probe_failed' ? 'Probe failed' :
    outcome.reason === 'not_media' ? '下载到的不是有效视频(线路返回了错误页),请切换线路重试' :
    outcome.reason === 'chunks_failed' ? (outcome.msg ?? 'One or more chunks failed after retries') :
    outcome.reason === 'merge_failed' ? `Merge failed: ${outcome.msg ?? ''}` :
    outcome.reason === 'stream_failed' ? (outcome.msg ?? 'Download failed') :
    'Download failed'
  onEvent({ type: 'ep_error', ep, msg })
}

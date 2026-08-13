/**
 * 嗷呜的 mp4 下载 —— 在共享分片下载器外面包一层:先解析出真实 mp4 地址(短时效的签名 CDN 链接)
 * 再套用目录 / 文件名约定,交给下载器做带续传的分片下载。
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
  // `animeId` 现在是字符串形式的数字 video id;老队列里可能还是不透明的 play_token —— 两种形状都能
  // 匹配这个正则,下游会自动分辨。这道校验是为了让畸形值(带斜杠、空、字符串化的 null)当场
  // 带着清楚的消息失败,而不是在后面悄悄挂掉。
  if (!/^[A-Za-z0-9_-]+$/.test(animeId)) {
    onEvent({ type: 'ep_error', ep, msg: `任务数据已过期（aowuId="${animeId}"）— 请删除该任务并重新搜索添加` })
    return
  }

  const savePath = epSavePath(title, label, saveDir)
  const dir = dirname(savePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // 第一步:把观看页解析成真实 mp4 地址(要打两趟加密接口,密钥缓存热时约 250ms)。
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

  // 第二步:**单流下载**。签名 mp4 来自对整条 URL 限速的 CDN,多连接
  const outcome = await downloadByUrl(mp4Url, savePath, signal, (bytes, _total, pct) => {
    onEvent({ type: 'ep_progress', ep, pct, bytes })
  }, LOG_TAG, { threadCount: 1 })

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

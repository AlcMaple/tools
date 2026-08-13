/**
 * 稀饭的 mp4 下载 —— 在共享的分片下载器外面包一层,这里只负责:按模板算出每一集的 URL、
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

/** 把模板里的集数占位符换成真实集号,按占位符携带的位宽补零:{:d} 不补零,{:02d} 补到两位。 */
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

/** 取 URL 路径里的文件名(去扩展名),取不到返回 null。 */
function nameFromUrl(u: string): string | null {
  try {
    const base = new URL(u).pathname.split('/').pop() ?? ''
    const name = decodeURIComponent(base).replace(/\.[^.]+$/, '').trim()
    return name || null
  } catch {
    return null
  }
}

/** 删掉某一集的分片和最终 mp4。换源时用:新地址与旧的无关,已下的字节全都用不上。 */
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

  // 模板拼出的 URL 取不到正片,两种情形都属于「我们自己拼错了链接」,要回源读播放页拿真实直链:
  //   - 404:多半是 OVA 这类特殊集,文件名不是集号,模板必拼错;
  //   - 不是媒体:服务器用 HTTP 200 回了几 KB 的 JSON 错误体(假 mp4)。有的 CDN 对同一部番不同集
  //     的文件名并不一致,按第 1 集推断出的模板会给其它集拼出错链接,而只有播放页里才有真实地址。
  if (!outcome.ok && epPages[sourceIdx]) {
    const probe404 = outcome.reason === 'probe_failed' && outcome.status === 404
    const notMedia = outcome.reason === 'not_media'
    if (probe404 || notMedia) try {
      const realUrl = await resolveEpRealUrl(epPages[sourceIdx], ep)
      if (realUrl && realUrl !== url) {
        // 真实直链先同步给渲染层,「复制 mp4 直链」得复制这条,模板拼的那条取不到
        onEvent({ type: 'ep_url', ep, url: realUrl })
        // probe404 多为 OVA 等特殊集:文件名跟着真实链接走(.../OVA.mp4 → {title} - OVA.mp4)。
        // notMedia 是普通集模板拼错(.../RE11.mp4):保持常规集号命名 {title} - 11.mp4,
        // 不能把 URL 里的 RE11 当文件名,否则存成「{title} - RE11.mp4」很怪。
        let realPath = savePath
        if (probe404) {
          const realName = nameFromUrl(realUrl)
          if (realName) realPath = join(dir, `${safeName(title)} - ${safeName(realName)}.mp4`)
        }
        outcome = await run(realUrl, realPath)
      }
    } catch { /* 回源本身失败 → 保留原 outcome,走下面统一错误上报 */ }
  }

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

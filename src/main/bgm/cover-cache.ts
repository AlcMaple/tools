/**
 * 封面本地化 —— 把 BGM / 用户手填的封面 URL 下载到 `userData/covers/`，
 * 返回 `archivist://` 路径供 renderer <img> 直接读本地文件。
 *
 * 为什么要本地化（005/006 阶段决策）：
 *   - **性能**：MyAnime 列表每次打开都从 lain.bgm.tv 重新拉同样的封面是浪费,
 *     本地读秒开
 *   - **离线**：断网 / lain.bgm.tv 抽风时封面照样显示
 *   - **手填封面稳定性**：手动添加时用户给的 URL 可能不稳，落地到本地后
 *     就跟网络解耦了
 *   - **礼貌**：减少对 lain.bgm.tv 的重复请求
 *
 * 注意：封面走的是 lain.bgm.tv 图片 CDN，**不是** api.bgm.tv，跟限流是
 * 两套独立账本，所以这里不需要接 RateLimiter（CDN 天生扛得住图片请求）。
 *
 * 失败语义：下载失败返回 null，调用方 fallback 到原始 URL（renderer 那边
 * 继续用 URL 渲染，只是没本地化的好处）。**不重试**。
 */
import { app, net } from 'electron'
import { join } from 'path'
import { mkdir, writeFile, access } from 'fs/promises'

function coversDir(): string {
  return join(app.getPath('userData'), 'covers')
}

/**
 * 把绝对文件路径转成 archivist:// URL。
 *   - macOS: /Users/mac/.../267215.jpg → archivist:///Users/mac/.../267215.jpg
 *   - Windows: C:\Users\...\267215.jpg → archivist:///C:/Users/.../267215.jpg
 * 逐段 encodeURIComponent（路径里有空格，如 macOS 的 "Application Support"）;
 * 协议处理器那边 decodeURIComponent 还原。
 */
function toArchivistUrl(absPath: string): string {
  const fwd = absPath.replace(/\\/g, '/')
  const withSlash = fwd.startsWith('/') ? fwd : '/' + fwd
  const encoded = withSlash.split('/').map(encodeURIComponent).join('/')
  return 'archivist://' + encoded
}

/** 从 URL 推断图片扩展名；拿不到就默认 jpg。 */
function extFromUrl(url: string): string {
  const m = url.split('?')[0].match(/\.(jpe?g|png|webp|gif|bmp)$/i)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = net.request(url)
    req.on('response', (res) => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 400) {
        reject(new Error(`cover HTTP ${status}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 下载封面到本地，返回 archivist:// 路径。
 *
 * - `url` 已经是 archivist:// 或空 → 原样返回（已本地化 / 没封面，不重复处理）
 * - 本地已有同 key 文件 → 直接返回，**不重复下载**（key 通常是 bgmId，
 *   同一条目封面认为不变；用户删追番再重加也是同 key，命中老文件即可）
 * - 下载失败 → 返回 null，调用方 fallback 到原 URL
 *
 * @param key  文件名（一般传 String(bgmId)；手动添加的负数 id 也 OK）
 * @param url  原始封面 URL（lain.bgm.tv 或用户手填的任意图片 URL）
 */
export async function cacheCover(key: string, url: string): Promise<string | null> {
  if (!url || url.startsWith('archivist://')) return url || null
  try {
    const dir = coversDir()
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${key}.${extFromUrl(url)}`)
    // 已存在 → 直接复用
    try {
      await access(filePath)
      return toArchivistUrl(filePath)
    } catch {
      /* 不存在，继续下载 */
    }
    const buf = await download(url)
    if (buf.length === 0) return null
    await writeFile(filePath, buf)
    return toArchivistUrl(filePath)
  } catch {
    return null
  }
}

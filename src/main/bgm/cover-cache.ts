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
import { app, net, nativeImage } from 'electron'
import { join } from 'path'
import { mkdir, writeFile, access, rm } from 'fs/promises'

// 封面缩到这个最大宽度再存。封面实际只显示到 88–340px，而 BGM 的
// images.large 原图常达 800–1200px+，全尺寸图每次组件重挂载（切页面）
// 都要解码成几 MB 的位图、很贵，表现为"切回来闪一下重新加载"。缩到这个
// 宽度后解码成本降一个数量级，切页面几乎无感；顺带省内存和磁盘。
//
// 两档尺寸：列表 / 周历显示小（88–140px），用 480 足够且解码最省；AnimeInfo
// 详情页显示大（~340px），480 在 retina 上发糊，单独用 600。按尺寸分文件名
// 存（`${key}.${maxWidth}.jpg`），两档互不覆盖。
const COVER_THUMB_WIDTH = 480

// `covers-v2`：从全尺寸缓存（旧 `covers` 目录）迁到缩略缓存。换目录名让
// skip-if-exists 跨重启稳定（v2 目录存在 = 已迁移），旧的全尺寸图一次性作废。
function coversDir(): string {
  return join(app.getPath('userData'), 'covers-v2')
}

// 一次性清掉旧的全尺寸 `covers` 目录，避免迁移后残留几十 MB 垃圾。幂等：
// 删过之后再调用是 force:true 的 noop，所以不用持久化标记。
let oldDirCleaned = false
async function cleanupLegacyCoversDir(): Promise<void> {
  if (oldDirCleaned) return
  oldDirCleaned = true
  try {
    await rm(join(app.getPath('userData'), 'covers'), { recursive: true, force: true })
  } catch {
    /* best-effort，删不掉无所谓 */
  }
}

/**
 * 把绝对文件路径转成 archivist:// URL。
 *   - macOS: /Users/mac/.../267215.jpg → archivist://local/Users/mac/.../267215.jpg
 *   - Windows: C:\Users\...\267215.jpg → archivist://local/C:/Users/.../267215.jpg
 * 逐段 encodeURIComponent（路径里有空格，如 macOS 的 "Application Support"）;
 * 协议处理器那边 decodeURIComponent 还原。
 *
 * **host 用占位的 `local`，不是空 host**：archivist 注册成了 standard scheme
 * （这样响应才能进 Chromium HTTP 缓存、Cache-Control 才生效，封面切页面/滚动
 * 不再重复读盘+解码）。standard scheme 不接受空 host 的 `archivist:///路径`
 * （会让路径解析错乱、封面全 404，已踩过坑），所以必须给一个非空 host 占位,
 * 真正的绝对路径放在 pathname 里。
 */
function toArchivistUrl(absPath: string): string {
  const fwd = absPath.replace(/\\/g, '/')
  const withSlash = fwd.startsWith('/') ? fwd : '/' + fwd
  const encoded = withSlash.split('/').map(encodeURIComponent).join('/')
  return 'archivist://local' + encoded
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
 * @param key       文件名（一般传 String(bgmId)；手动添加的负数 id 也 OK）
 * @param url        原始封面 URL（lain.bgm.tv 或用户手填的任意图片 URL）
 * @param maxWidth   缩略最大宽度，默认 480（列表/周历）；AnimeInfo 详情页传 600
 */
export async function cacheCover(
  key: string,
  url: string,
  maxWidth: number = COVER_THUMB_WIDTH,
): Promise<string | null> {
  if (!url || url.startsWith('archivist://')) return url || null
  try {
    void cleanupLegacyCoversDir()
    const dir = coversDir()
    await mkdir(dir, { recursive: true })
    // 文件名带尺寸（`${key}.${maxWidth}.jpg`）—— 两档尺寸互不覆盖，且统一 jpeg
    // 让 skip-if-exists 不因原图扩展名不同（png/webp）而漏判重复下载。
    const filePath = join(dir, `${key}.${maxWidth}.jpg`)
    // 已存在 → 直接复用
    try {
      await access(filePath)
      return toArchivistUrl(filePath)
    } catch {
      /* 不存在，继续下载 */
    }
    const buf = await download(url)
    if (buf.length === 0) return null
    // 缩放 + 重新编码为 jpeg。封面是不透明海报，转 jpeg 不丢可见信息。
    // nativeImage 解析/缩放失败（极少见的坏图）则原样落盘，保证封面不丢。
    let out = buf
    try {
      const img = nativeImage.createFromBuffer(buf)
      const { width } = img.getSize()
      const sized = width > maxWidth
        ? img.resize({ width: maxWidth, quality: 'better' })
        : img
      const jpeg = sized.toJPEG(85)
      if (jpeg.length > 0) out = jpeg
    } catch {
      /* 保留原始字节 */
    }
    await writeFile(filePath, out)
    return toArchivistUrl(filePath)
  } catch {
    return null
  }
}

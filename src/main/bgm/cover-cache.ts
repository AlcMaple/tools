/**
 * 封面本地化 —— 把封面 URL 下到 `userData/covers-v2/`,返回 `archivist://` 路径给渲染层的
 * <img> 直接读本地文件。列表打开秒显、断网也有图、手填的不稳 URL 落地后与网络解耦。
 *
 * 封面走的是图片 CDN 而不是 api.bgm.tv,与 API 限流是两套独立账本,所以这里不接 RateLimiter。
 * 下载失败返回 null,调用方回落到原始 URL;**不重试**。
 */
import { app, net, nativeImage } from 'electron'
import { join } from 'path'
import { mkdir, writeFile, access, rm } from 'fs/promises'
import { logInfo } from '../shared/logger'

// 封面缩到这个宽度再存。实际只显示到 88~340px,而原图常有 800~1200px,全尺寸图每次组件
// 重挂载都要解码成几 MB 位图,表现为「切回来闪一下重新加载」。缩完解码成本降一个数量级。
// 两档:列表 / 周历用 480,详情页显示到 ~340px,480 在 retina 上发糊、单独用 600。
// 按尺寸分文件名存,两档互不覆盖。
const COVER_THUMB_WIDTH = 480

// `covers-v2`：从全尺寸缓存（旧 `covers` 目录）迁到缩略缓存。换目录名让
// skip-if-exists 跨重启稳定（v2 目录存在 = 已迁移），旧的全尺寸图一次性作废。
function coversDir(): string {
  return join(app.getPath('userData'), 'covers-v2')
}

// 封面目录只建一次。否则打开列表时几十上百张封面各自 mkdir,在 libuv 的 4 线程 fs 池里
// 和 access 抢道、平白翻倍 fs 操作量。失败则清空共享 promise 让下次重试。
let dirReady: Promise<void> | null = null
function ensureCoversDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(coversDir(), { recursive: true })
      .then(() => undefined)
      .catch((e) => { dirReady = null; throw e })
  }
  return dirReady
}

// 一次性清掉旧的全尺寸 `covers` 目录。幂等:删过之后再调是 force:true 的 noop,不用持久化标记。
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
 * 绝对路径 → archivist:// URL,逐段 encodeURIComponent(路径里有空格,如 macOS 的
 * "Application Support"),协议处理器那边再还原。
 *
 * **host 必须是占位的 `local`,不能留空**:archivist 注册成了 standard scheme(响应才能进
 * Chromium 的 HTTP 缓存),而 standard scheme 不接受 `archivist:///路径` —— 路径会解析错乱、
 * 封面全 404。真正的绝对路径放在 pathname 里。
 */
function toArchivistUrl(absPath: string): string {
  const fwd = absPath.replace(/\\/g, '/')
  const withSlash = fwd.startsWith('/') ? fwd : '/' + fwd
  const encoded = withSlash.split('/').map(encodeURIComponent).join('/')
  return 'archivist://local' + encoded
}

/**
 * 直连失败时的图片代理。直连图床在国内常被墙 / 超时(IPv4+IPv6 都不通),回退到 wsrv.nl
 * (Cloudflare,实测国内可达且快):由代理去取原图,顺手缩到目标宽度 + 转 jpg 省流量。
 * 代理只用在主进程抓取这一步,抓到就存本地,渲染层读的始终是本地缓存。
 */
function buildProxyUrl(originalUrl: string, maxWidth: number): string {
  const noScheme = originalUrl.replace(/^https?:\/\//i, '')
  return `https://wsrv.nl/?url=${noScheme}&w=${maxWidth}&output=jpg`
}

/** 拉一张图，带超时（默认 8s）。失败 / 超时 / 非 2~3xx 都 reject。 */
function fetchBuffer(url: string, timeoutMs = 8000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => { if (!settled) { settled = true; fn() } }
    const req = net.request(url)
    const timer = setTimeout(() => {
      try { req.abort() } catch { /* noop */ }
      finish(() => reject(new Error('cover timeout')))
    }, timeoutMs)
    req.on('response', (res) => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 400) {
        clearTimeout(timer)
        finish(() => reject(new Error(`cover HTTP ${status}`)))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { clearTimeout(timer); finish(() => resolve(Buffer.concat(chunks))) })
      res.on('error', (e: Error) => { clearTimeout(timer); finish(() => reject(e)) })
    })
    req.on('error', (e: Error) => { clearTimeout(timer); finish(() => reject(e)) })
    req.end()
  })
}

// 直连熔断:连续失败到阈值就认定当前网络直连不通,本进程内后续封面直接走代理 ——
// 否则串行队列里每张图都要干等 6s 超时,累加成几分钟。计数器只在进程内,重启自然复位
// 网络恢复后又会先试直连。
let consecutiveDirectFails = 0
const DIRECT_OFF_AFTER = 3

/** 先直连(6s),失败回退代理(8s);直连连续失败到阈值后本进程内跳过直连。 */
async function download(url: string, maxWidth: number): Promise<Buffer> {
  const canProxy = /^https?:\/\//i.test(url)
  if (!(canProxy && consecutiveDirectFails >= DIRECT_OFF_AFTER)) {
    try {
      const buf = await fetchBuffer(url, 6000)
      consecutiveDirectFails = 0
      return buf
    } catch {
      if (!canProxy) throw new Error('cover unreachable')
      consecutiveDirectFails++
    }
  }
  return await fetchBuffer(buildProxyUrl(url, maxWidth), 8000)
}

// 串行队列:封面逐张拉,**绝不一次性几十张并发** —— GFW 对突发并发最敏感,单个孤立请求
// 在限速下大概率能过。代价是首次批量回填时封面逐张冒出来,但每张只拉一次、拉到即永久缓存。
// 命中本地缓存的封面在入队前就返回了,不占队列。
let coverQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = coverQueue.then(task, task)
  coverQueue = run.then(() => undefined, () => undefined) // 单张失败不打断后续
  return run
}

/**
 * 下载封面到本地并返回 archivist:// 路径。
 *
 *   - url 已经是 archivist:// 或为空 → 原样返回
 *   - 本地已有同 key 同尺寸的文件 → 直接返回,**不重复下载**
 *   - 下载失败 → 返回 null,调用方回落到原 URL
 *
 * `key` 一般传 String(bgmId)(手动条目的负数 id 也可以),`maxWidth` 列表用 480、详情页 600。
 */
export async function cacheCover(
  key: string,
  url: string,
  maxWidth: number = COVER_THUMB_WIDTH,
): Promise<string | null> {
  if (!url || url.startsWith('archivist://')) return url || null
  // 探子:本地命中本该是两次 fs 操作、毫秒级;冷启动时若主进程被启动扫描挤住,命中也会被拖到
  // 几百 ms~几秒。只记 >100ms 的慢调用,hit/dl 用来区分「被饿着的本地命中」和「真在下载」。
  const t0 = Date.now()
  let outcome = 'dl'
  try {
    void cleanupLegacyCoversDir()
    const dir = coversDir()
    await ensureCoversDir()
    // 文件名带尺寸,两档互不覆盖;统一存成 jpeg,免得原图扩展名不同(png/webp)让 skip-if-exists
    // 漏判、重复下载。
    const filePath = join(dir, `${key}.${maxWidth}.jpg`)
    // 已存在 → 直接复用
    try {
      await access(filePath)
      outcome = 'hit'
      return toArchivistUrl(filePath)
    } catch {
      /* 不存在，继续下载 */
    }
    // 串行入队：避免列表打开时几十张封面并发猛拉触发图床限速。
    const buf = await enqueue(() => download(url, maxWidth))
    if (buf.length === 0) { outcome = 'empty'; return null }
    // 缩放并重编码成 jpeg —— 封面是不透明海报,转 jpeg 不丢可见信息。解析/缩放失败(极少见的
    // 坏图)就原样落盘,保证封面不丢。
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
    outcome = 'err'
    return null
  } finally {
    const ms = Date.now() - t0
    if (ms > 100) logInfo('perf', `cover:${key} ${ms}ms ${outcome}`)
  }
}

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
import { logInfo } from '../shared/logger'

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

// 封面目录只建一次。否则打开 MyAnime 时几十~上百张封面各自 mkdir(recursive),
// 在 libuv 4 线程 fs 池里和 access 抢道、平白翻倍 fs 操作量。用一个共享 promise
// 串住"建目录"这件事;失败则清空让下次重试(不缓存失败)。
let dirReady: Promise<void> | null = null
function ensureCoversDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(coversDir(), { recursive: true })
      .then(() => undefined)
      .catch((e) => { dirReady = null; throw e })
  }
  return dirReady
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

/**
 * 直连失败时的「国内加速」图片代理。
 *
 * 直连 lain.bgm.tv 在国内常被墙 / 超时（实测 IPv4+IPv6 都不通）。回退到 wsrv.nl
 * 图片代理（Cloudflare，实测国内可达且快）：由代理服务端去取原图，顺手缩到目标
 * 宽度 + 转 jpg 省流量。代理只在主进程抓取这一步用 —— 抓到后存本地 archivist://，
 * 渲染层读本地缓存、不直接碰 lain.bgm.tv。想换代理域名改这一处即可。
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

// 直连「熔断」：直连 lain.bgm.tv 连续失败到阈值，就认定当前网络直连不通，本进程
// 内后续封面直接走代理 —— 省掉串行队列里每张图都干等 6s 超时（否则会累加成几分钟）。
// 计数器在进程内，下次启动应用自然复位 → 网络恢复后又会先试直连。
let consecutiveDirectFails = 0
const DIRECT_OFF_AFTER = 3

/**
 * 先直连原图（6s），失败回退 wsrv 代理（8s）。直连连续失败 DIRECT_OFF_AFTER 次后，
 * 本进程内跳过直连、直接走代理。
 */
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

// 串行队列：封面逐张拉，绝不一次性几十张并发猛拉 lain.bgm.tv —— GFW 对突发并发
// 最敏感，单个孤立请求在限速下大概率能过（这也是「一部部加番、封面慢慢就缓存上、
// 从没出问题」的原因）。代价是首次批量回填是逐张冒出来的，但每张只拉一次、拉到即
// 永久缓存，完全可接受。命中本地缓存的封面在入队前就返回了，不占队列。
let coverQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = coverQueue.then(task, task)
  coverQueue = run.then(() => undefined, () => undefined) // 单张失败不打断后续
  return run
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
  // 探子：本地命中(hit)本应是两次 fs 操作、毫秒级；冷启动若主进程被启动扫描/
  // 目录监听挤住,命中也会被拖到几百 ms~几秒。只记 >100ms 的慢调用(warm 时不刷屏),
  // hit/dl 区分"被饿着的本地命中"还是"真在下载",直接定位冷启动卡顿归因。
  const t0 = Date.now()
  let outcome = 'dl'
  try {
    void cleanupLegacyCoversDir()
    const dir = coversDir()
    await ensureCoversDir()
    // 文件名带尺寸（`${key}.${maxWidth}.jpg`）—— 两档尺寸互不覆盖，且统一 jpeg
    // 让 skip-if-exists 不因原图扩展名不同（png/webp）而漏判重复下载。
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
    outcome = 'err'
    return null
  } finally {
    const ms = Date.now() - t0
    if (ms > 100) logInfo('perf', `cover:${key} ${ms}ms ${outcome}`)
  }
}

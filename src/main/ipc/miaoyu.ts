import { ipcMain, app, nativeImage } from 'electron'
import { join } from 'path'
import { mkdir, writeFile, readFile, access } from 'fs/promises'
import { createHash } from 'crypto'

/**
 * 妙语库的用户上传图片落地。
 *
 * 设计：帖子/评论/思考这些文本走 localStorage（后续坚果云同步），**图片走本地
 * 文件 + archivist:// 显示**。数据里只存 `{hash, ext}`（内容寻址、可移植），显示
 * 时用本目录的 archivist base 拼出 URL —— 不持久化任何机器绝对路径（同封面缓存
 * 的本地化思路，见 bgm/cover-cache.ts）。
 */
function imagesDir(): string {
  return join(app.getPath('userData'), 'miaoyu-images')
}

// 目录只建一次；失败清空 promise 让下次重试（不缓存失败）。
let dirReady: Promise<void> | null = null
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(imagesDir(), { recursive: true })
      .then(() => undefined)
      .catch((e) => { dirReady = null; throw e })
  }
  return dirReady
}

// 绝对路径 → archivist:// URL（逐段 encode，host 占位 `local`）。同 cover-cache
// 的 toArchivistUrl —— standard scheme 不接受空 host，必须给非空 host 占位。
function toArchivistUrl(absPath: string): string {
  const fwd = absPath.replace(/\\/g, '/')
  const withSlash = fwd.startsWith('/') ? fwd : '/' + fwd
  return 'archivist://local' + withSlash.split('/').map(encodeURIComponent).join('/')
}

// 上传图最大宽度 —— 截图普遍 ≤1290（手机）/2K（桌面），超过就缩。既省盘，又让
// 后续坚果云同步（图片以 base64 进 JSON blob）的体积可控。截图含文字，JPEG q88
// 仍清晰可读。
const MAX_WIDTH = 1600

// 同步导入/导出只接受「内容寻址文件名」：sha1(hex) + . + 扩展名。挡掉任何带路径
// 分隔符 / `..` 的输入，避免越权读写 miaoyu-images 之外的文件。
const SAFE_NAME = /^[a-f0-9]{8,64}\.[a-z0-9]{1,5}$/i

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function parseDataUrl(dataUrl: string): { buf: Buffer; ext: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) throw new Error('不是合法的图片 data URL')
  const ext = EXT_BY_MIME[m[1].toLowerCase()] ?? 'png'
  return { buf: Buffer.from(m[2], 'base64'), ext }
}

export function registerMiaoyuIpc(): void {
  // 返回图片目录的 archivist base URL（已编码）。渲染端拿到后用 `${base}/${hash}.${ext}`
  // 拼具体图片 URL（hash 是 hex、ext 是字母，无需再编码）。只在页面挂载时取一次。
  ipcMain.handle('miaoyu:images-base', async () => {
    await ensureDir()
    return toArchivistUrl(imagesDir())
  })

  // 存一张图（接收 data URL）。超宽就缩 + 转 JPEG 压体积；按内容 sha1 命名去重
  // （同一张截图反复粘贴只落一次盘）。返回 {hash, ext} 存进数据。
  ipcMain.handle('miaoyu:save-image', async (_e, dataUrl: string) => {
    await ensureDir()
    let { buf, ext } = parseDataUrl(dataUrl)
    // gif 保留动图原样；其余超宽则缩并转 jpg。
    if (ext !== 'gif') {
      const img = nativeImage.createFromBuffer(buf)
      const { width } = img.getSize()
      if (width > MAX_WIDTH) {
        buf = img.resize({ width: MAX_WIDTH }).toJPEG(88)
        ext = 'jpg'
      }
    }
    const hash = createHash('sha1').update(buf).digest('hex')
    const file = join(imagesDir(), `${hash}.${ext}`)
    try {
      await access(file) // 已存在（同内容）→ 跳过写
    } catch {
      await writeFile(file, buf)
    }
    return { hash, ext }
  })

  // 坚果云同步用 —— 把一批图片读成 base64，供渲染端塞进同步的 JSON blob。
  // 只接受 `hash.ext` 形式的文件名（防路径穿越），缺图静默跳过。
  ipcMain.handle('miaoyu:export-images', async (_e, names: string[]) => {
    const dir = imagesDir()
    const out: Record<string, string> = {}
    for (const name of Array.isArray(names) ? names : []) {
      if (typeof name !== 'string' || !SAFE_NAME.test(name)) continue
      try {
        const buf = await readFile(join(dir, name))
        out[name] = buf.toString('base64')
      } catch { /* 缺图就跳过，不阻断整批 */ }
    }
    return out
  })

  // 坚果云同步用 —— 把云端 blob 里的 base64 图片写回本地。按文件名（内容寻址）
  // 跳过已存在，不重新编码/缩放，保证 hash 与帖子里存的 {hash,ext} 一致。
  ipcMain.handle('miaoyu:import-images', async (_e, map: Record<string, string>) => {
    await ensureDir()
    const dir = imagesDir()
    let written = 0
    for (const [name, b64] of Object.entries(map && typeof map === 'object' ? map : {})) {
      if (!SAFE_NAME.test(name) || typeof b64 !== 'string') continue
      const file = join(dir, name)
      try {
        await access(file) // 已有同名（同内容）→ 跳过
      } catch {
        await writeFile(file, Buffer.from(b64, 'base64'))
        written++
      }
    }
    return written
  })
}

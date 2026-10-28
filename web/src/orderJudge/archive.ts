import { proxy, wrap, type Remote } from 'comlink'
import archivePackage from 'libarchive.js/package.json' with { type: 'json' }
import { extOf, kindOf } from '../../shared/order-judge-prepare'

export const ARCHIVE_LIMITS = { bytes: 32 * 1024 * 1024, entries: 100, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, timeoutMs: 30_000 }
export const isArchive = (file: File): boolean => ['zip', 'rar'].includes(extOf(file.name))

export interface ArchiveEntry {
  path: string
  type: string
  size: number
  fileData?: ArrayBuffer
}

interface ArchiveClient {
  open(file: File, ready: () => void): void
  listFiles(): ArchiveEntry[]
  hasEncryptedData(): boolean | null
  extractSingleFile(path: string): ArchiveEntry | undefined
}

export function planArchive(entries: ArchiveEntry[]): { selected: ArchiveEntry[]; skipped: string[] } {
  if (entries.length > ARCHIVE_LIMITS.entries) throw new Error('包内条目超过 100 项，请拆分后再放入')
  const selected: ArchiveEntry[] = [], skipped: string[] = []
  const paths = new Set<string>()
  let total = 0
  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, '/').replace(/^\.\//, '')
    const segments = path.split('/')
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\x00-\x1f]/.test(path) || segments.includes('..')) {
      throw new Error('包内路径异常，请重新打包')
    }
    if (entry.type === 'DIR') continue
    if (paths.has(path)) throw new Error('包内有重名文件，请整理后重新打包')
    paths.add(path)
    if (entry.type !== 'FILE') { skipped.push(`${path}（链接或特殊文件）`); continue }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('包内文件大小异常')
    if (entry.size > ARCHIVE_LIMITS.fileBytes) throw new Error('包内单文件超过 16 MB，请拆分后再放入')
    total += entry.size
    if (total > ARCHIVE_LIMITS.totalBytes) throw new Error('解压内容超过 64 MB，请拆分后再放入')
    if (segments.some(s => s.startsWith('.') || s === '__MACOSX')) continue
    if (kindOf(new File([], path)) === 'other') {
      skipped.push(`${path}（${isArchive(new File([], path)) ? '请单独放入内层压缩包' : '未支持的格式'}）`)
      continue
    }
    selected.push(entry)
  }
  if (!selected.length) throw new Error('包内没有可读取的材料，请解压后检查格式')
  return { selected, skipped }
}

function archiveError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/encrypt|password|passphrase/i.test(message)) return new Error('压缩包已加密，请解密后再放入', { cause: error })
  if (/volume|multivolume|multi.volume|split archive/i.test(message)) return new Error('分卷压缩包请合并后再放入', { cause: error })
  return new Error('压缩包损坏或格式不受支持，请重新打包', { cause: error })
}

export async function expandArchive(file: File, signal?: AbortSignal): Promise<{ files: File[]; skipped: string[] }> {
  signal?.throwIfAborted()
  if (file.size > ARCHIVE_LIMITS.bytes) throw new Error('压缩包超过 32 MB，请拆分后再放入')
  const magic = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const zip = magic[0] === 0x50 && magic[1] === 0x4b && ((magic[2] === 3 && magic[3] === 4) || (magic[2] === 5 && magic[3] === 6))
  const rar = [0x52, 0x61, 0x72, 0x21, 0x1a, 7].every((n, i) => magic[i] === n)
  if ((!zip && !rar) || file.size < (zip ? 22 : 20)) throw new Error('压缩包损坏或格式不受支持，请重新打包')
  signal?.throwIfAborted()
  const worker = new Worker(`/archive/${archivePackage.version}/worker-bundle.js`, { type: 'module' })
  let abort = (): void => {}, fail = (_event: ErrorEvent): void => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException('已取消读取压缩包', 'AbortError'))
    fail = event => reject(new Error('解压组件加载失败，请刷新页面后再试', { cause: event.message }))
    signal?.addEventListener('abort', abort, { once: true })
    worker.addEventListener('error', fail)
    timer = setTimeout(() => reject(new Error('解压超过 30 秒，请拆分后再放入')), ARCHIVE_LIMITS.timeoutMs)
  })
  const run = async (): Promise<{ files: File[]; skipped: string[] }> => {
    // 直接使用目录条目，不让库先把不可信路径拼进普通对象；每个任务拥有独立 Worker。
    const Factory = wrap<new (ready: () => void) => ArchiveClient>(worker)
    let ready!: () => void
    const initialized = new Promise<void>(resolve => { ready = resolve })
    const client: Remote<ArchiveClient> = await new Factory(proxy(() => ready()))
    await initialized
    await new Promise<void>((resolve, reject) => { void client.open(file, proxy(() => resolve())).catch(reject) })
    let entries: ArchiveEntry[]
    try {
      entries = await client.listFiles()
      if (await client.hasEncryptedData()) throw new Error('encrypted archive')
    } catch (error) { throw archiveError(error) }
    const { selected, skipped } = planArchive(entries)
    const files: File[] = []
    for (const entry of selected) {
      signal?.throwIfAborted()
      let extracted: ArchiveEntry | undefined
      try { extracted = await client.extractSingleFile(entry.path) } catch (error) { throw archiveError(error) }
      if (!extracted?.fileData || extracted.fileData.byteLength !== entry.size) throw new Error('压缩包内容不完整，请重新打包')
      files.push(new File([extracted.fileData], `${file.name}/${entry.path.replace(/\\/g, '/')}`))
    }
    return { files, skipped }
  }
  try { return await Promise.race([run(), stopped]) } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    worker.removeEventListener('error', fail)
    worker.terminate()
  }
}

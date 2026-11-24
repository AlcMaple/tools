import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOWNLOAD_KINDS, infoHash, type DownloadLink, type ManualDownloads } from '../../shared/catalog-downloads'
import { dataDir } from '../data-dir'

export function httpsLink(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) return ''
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

export class DownloadEditError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) { super(message) }
}

const directory = join(dataDir, 'catalog-downloads')
const fileOf = (id: number): string => join(directory, `${id}.json`)
export function readManual(id: number): ManualDownloads {
  try { return JSON.parse(readFileSync(fileOf(id), 'utf8')) as ManualDownloads }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: '', links: [] }
    throw error
  }
}

function parseLink(input: unknown, eps: number): DownloadLink {
  if (!input || typeof input !== 'object') throw new DownloadEditError('链接格式不正确')
  const row = input as Record<string, unknown>
  if (typeof row.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.id)) throw new DownloadEditError('链接编号不正确')
  if (typeof row.title !== 'string' || !row.title.trim() || row.title.trim().length > 180) throw new DownloadEditError('请填写 1–180 字的发布名称')
  if (typeof row.quality !== 'string' || row.quality.trim().length > 80) throw new DownloadEditError('字幕和画质最多 80 字')
  if (typeof row.kind !== 'string' || !Object.hasOwn(DOWNLOAD_KINDS, row.kind)) throw new DownloadEditError('链接类型不正确')
  const kind = row.kind as DownloadLink['kind']
  const raw = typeof row.url === 'string' ? row.url.trim() : ''
  const url = kind === 'magnet' ? (infoHash(raw) ? raw : '') : httpsLink(raw)
  if (!url) throw new DownloadEditError(kind === 'magnet' ? '请填写带有效 BT 哈希的磁力链接' : '请填写完整的 HTTPS 链接')
  if (kind === 'file' && /\.(?:m3u8|mpd)(?:$|[?#&])/i.test(url)) throw new DownloadEditError('这是播放清单，请填写视频或压缩包的文件直链')
  const group = row.group
  if (group !== 'season' && group !== 'range' && group !== 'episode' && group !== 'mixed' && group !== 'other') throw new DownloadEditError('请选择收录范围')
  const episode = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > (eps || 99999)) throw new DownloadEditError('集数超出作品范围')
    return value
  }
  const first = group === 'range' || group === 'episode' ? episode(row.first) : null
  const last = group === 'range' ? episode(row.last) : first
  if (group === 'range' && last! <= first!) throw new DownloadEditError('末集须大于起始集')
  return { id: row.id, title: row.title.trim(), kind, url, group, first, last, quality: row.quality.trim() }
}

export function saveManual(id: number, eps: number, input: unknown): ManualDownloads {
  const body = input as Partial<ManualDownloads> | null
  if (!body || typeof body.revision !== 'string' || !Array.isArray(body.links) || body.links.length > 50) throw new DownloadEditError('每部作品最多可补充 50 条链接')
  const links = body.links.map(link => parseLink(link, eps))
  if (new Set(links.map(link => link.id)).size !== links.length) throw new DownloadEditError('链接编号重复')
  // 小型目录写入在同一事件循环内完成。版本随删除最后一条也更新，旧编辑页不能复活已删除的链接
  if (readManual(id).revision !== body.revision) throw new DownloadEditError('链接已被其他管理员修改，请重新打开编辑', 409)
  const next = { revision: randomUUID(), links }
  mkdirSync(directory, { recursive: true })
  const temp = join(directory, `${next.revision}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(next), { flag: 'wx' })
    renameSync(temp, fileOf(id))
  } finally { rmSync(temp, { force: true }) }
  return next
}

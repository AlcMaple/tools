export const DOWNLOAD_KINDS = { file: '文件直链', magnet: '磁力', torrent: '种子文件', page: '发布页' } as const
export type DownloadKind = keyof typeof DOWNLOAD_KINDS
export type DownloadGroup = 'season' | 'range' | 'episode' | 'mixed' | 'other'

export interface DownloadLink {
  id: string
  title: string
  kind: DownloadKind
  url: string
  group: DownloadGroup
  first: number | null
  last: number | null
  quality: string
}

export interface Release extends DownloadLink {
  sources: string[]
  pageUrl?: string
  torrentUrl?: string
  nameMatch?: boolean
}

export interface DownloadResults { items: Release[]; more?: boolean; warning?: string }
export interface ManualDownloads { revision: string; links: DownloadLink[] }
export interface DownloadPanelData extends ManualDownloads { canEdit: boolean; episodes: number }

export function infoHash(value: string): string {
  if (!/^magnet:\?/i.test(value) || value.length > 16384) return ''
  const topics = new URLSearchParams(value.slice(8)).getAll('xt')
  const xt = topics.find(v => /^urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})$/i.test(v))
  if (!xt) return topics.find(v => /^urn:btmh:1220[a-f\d]{64}$/i.test(v))?.slice(9).toLowerCase() ?? ''
  const hash = xt.slice(9).toUpperCase()
  if (hash.length === 40) return hash.toLowerCase()
  // 动漫花园使用 Base32，其他发布站常用十六进制，两者可能指向同一份种子
  let bits = 0, buffer = 0, hex = ''
  for (const char of hash) {
    buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      hex += ((buffer >> bits) & 255).toString(16).padStart(2, '0')
    }
  }
  return hex
}

export function coverageLabel(link: DownloadLink): string {
  if (link.group === 'season') return '整季'
  if (link.group === 'range') return `第 ${link.first}–${link.last} 集`
  if (link.group === 'episode') return `第 ${link.first} 集`
  return link.group === 'mixed' ? '混合收录' : '其他发布'
}

import { Converter } from 'opencc-js/t2cn'
import type { DownloadLink } from '../../shared/catalog-downloads'

export interface DownloadSubject { item: { bgmId: number; name: string; nameCn: string; eps: number; date: string; tags: string[] }; aliases: string[]; endDate?: string }
export type Coverage = Pick<DownloadLink, 'group' | 'first' | 'last'>
export const unknownCoverage: Coverage = { group: 'other', first: null, last: null }
export const videoExtension = /\.(?:mkv|mp4|m4v|avi|webm|m2ts|mts|ts|mov|mpeg|mpg|wmv|flv|ogm|rmvb|vob|iso)$/i
const simplify = Converter({ from: 'tw', to: 'cn' })
const clean = (s: string): string => simplify(s.normalize('NFKC')).toLowerCase()
const seasonNumber = (s: string): string => {
  if (/^\d+$/.test(s)) return String(Number(s))
  const digits = '零一二三四五六七八九'
  const parts = s.split('十')
  return String(parts.length === 1 ? digits.indexOf(s) : (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0))
}
function normalizeSeasons(s: string): string {
  return clean(s).replace(/第\s*([一二三四五六七八九十\d]+)\s*[季期]|\b(?:s|season\s*)(\d{1,2})(?=\b|e\d)|\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/gi,
    (_all, zh: string, en: string, ordinal: string) => ` season${seasonNumber(zh || en || ordinal)} `)
}
function key(s: string): string {
  return normalizeSeasons(s).replace(/[^\p{L}\p{N}!☆★]+/gu, '')
}

export function subjectNames(subject: DownloadSubject): string[] {
  return [...new Set([subject.item.nameCn, subject.item.name, ...subject.aliases].map(t => t.trim()).filter(t => t.length >= 2 && t.length <= 160))].slice(0, 10)
}

const extra = /(?:\b(?:ova|oad|ncop|nced|pv|sp|ost|extras?|specials?)\b|剧场版|映画|番外|特典|漫画|原声|主题曲)/i
const seasons = (s: string): string[] => normalizeSeasons(s).match(/\bseason\d+\b/g) ?? []
export function seasonFits(subject: DownloadSubject, title: string, requireSeason: boolean): boolean {
  const stated = seasons(title)
  const expected = subjectNames(subject).flatMap(seasons)
  if (!stated.length) return !requireSeason || !expected.some(s => s !== 'season1')
  return stated.every(s => expected.length ? expected.includes(s) : s === 'season1')
}
export function isMixed(raw: string): boolean {
  const t = clean(raw)
  return /(?:漫画|音乐|原声|\bOST\b|\bCD\b|剧场版|映画)/i.test(t) && /(?:\bTV\b|动画\s*[+＋]|全集\s*[+＋]|\d+\s*[-~]\s*\d+|\bS0?1\b)/i.test(t)
    || /\bS0?1\s*[-+~]\s*S?0?[2-9]\b/i.test(t) || /第[一1]季\s*[+～~-]\s*第?[二三四五2-5]季/.test(t)
}

// RSS 只有发布名，按完整的中、日或英文片名匹配；只共享标题前缀的续季和重制版不属于当前作品
export function matchesRelease(subject: DownloadSubject, title: string, parsedNames: string[], mixed: boolean): boolean {
  const titles = subjectNames(subject).map(key)
  const raw = clean(title)
  const canonical = key(title)
  if (mixed) return titles.some(t => t.length >= 3 && canonical.includes(t))
  if (!seasonFits(subject, title, true)) return false
  const isMovie = [subject.item.nameCn, subject.item.name, ...subject.item.tags].some(t => /剧场版|劇場版|映画|\bmovie\b/i.test(t))
  if (/剧场版|映画|\bmovie\b/i.test(raw) && !isMovie) return false
  if (extra.test(raw) && !isMovie && !subjectNames(subject).some(t => extra.test(clean(t)))) return false
  const year = raw.match(/[\[(]((?:19|20)\d{2})[\])]/)?.[1]
  if (year && subject.item.date && year !== subject.item.date.slice(0, 4)) return false
  const stripped = raw.replace(/[\[【][^\]】]*[\]】]/g, ' ').replace(/\.(mp4|mkv|torrent)$/i, '')
    .replace(/(?:\s+-\s*|第\s*)\d{1,4}(?=\s*(?:[集话]|\b)).*$/i, '').trim()
  return [...parsedNames, ...stripped.split(/\s+[-|]\s+|[/／]/)].some(part => titles.includes(key(part.trim())))
}

export function episodeNumber(value: string): number | null {
  const s = clean(value)
  if (/(?:\b(?:ncop|nced|pv|sp|ova|oad|special|trailer)\s*\d*\b|特典|预告|番外)/i.test(s)) return null
  // 拒绝 12.5 等特别篇，年份、1080p 和目录名里的 01–12 也不能充当文件集数
  const digits = s.match(/(?:第\s*(\d{1,4})\s*[集话]|\b(?:s\d{1,2}e|ep?\.?\s*)(\d{1,4})(?!\d|\.\d|\s*[-~]\s*\d)|(?:\s[-–]\s*|^\s*|\[)(\d{1,3})(?:v\d+)?(?=\s*(?:\]|【|\[|$|\.(?:mkv|mp4|avi|webm)$)))/i)
  const n = Number(digits?.slice(1).find(Boolean))
  return n > 0 ? n : null
}

export function releaseCoverage(title: string, eps: number, range?: { from?: number; to?: number }, parsedEpisode?: number): Coverage {
  if (isMixed(title)) return { ...unknownCoverage, group: 'mixed' }
  const match = clean(title).match(/(?:\[|第|\s)(\d{1,3})\s*[-~～–]\s*(\d{1,3})(?=[\s\]集话]|$)/)
  const first = range?.from ?? Number(match?.[1])
  const last = range?.to ?? Number(match?.[2])
  if (Number.isSafeInteger(first) && first > 0 && Number.isSafeInteger(last) && last > first) return eps && last > eps ? unknownCoverage : { group: 'range', first, last }
  const n = parsedEpisode ?? episodeNumber(title)
  return n !== null && Number.isSafeInteger(n) && n > 0 && (!eps || n <= eps) ? { group: 'episode', first: n, last: n } : unknownCoverage
}

export function aniSeasonFits(subject: DownloadSubject, fileUrl: string): boolean {
  const month = (date: string) => {
    const match = date.match(/^(\d{4})-(\d{1,2})(?:$|[-/])/)
    return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null
  }
  const archive = month(new URL(fileUrl).pathname.slice(1)), start = month(subject.item.date)
  if (archive === null || start === null) return true
  // ANi 按放送季度建目录。季度末首播可能归到下季，同名旧作不能认领多年后的新版
  return archive + 2 >= start && archive <= (month(subject.endDate || '') ?? start) + 3
}

export function verifiedCoverage(files: string[], complete: boolean, subject: DownloadSubject): Coverage | null {
  const eps = subject.item.eps
  if (!complete || eps <= 1) return null
  const videos = files.filter(f => videoExtension.test(f))
  if (!videos.length) return null
  if (videos.some(f => extra.test(clean(f))) || files.some(f => /\.(?:cbz|cbr|flac|mp3)$/i.test(f))) return { ...unknownCoverage, group: 'mixed' }
  if (videos.some(f => !seasonFits(subject, f, false))) return null
  const numbers = videos.map(f => episodeNumber(f.split(/[/\\]/).pop()!.replace(videoExtension, '')))
  if (numbers.some(n => n === null || n > eps)) return null
  const sorted = [...new Set(numbers as number[])].sort((a, b) => a - b)
  if (sorted.length !== videos.length || sorted.some((n, i) => n !== sorted[0] + i)) return null
  const first = sorted[0], last = sorted[sorted.length - 1]
  return { group: first === 1 && last === eps ? 'season' : first === last ? 'episode' : 'range', first, last }
}

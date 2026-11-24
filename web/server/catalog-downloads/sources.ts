import { load } from 'cheerio'
import { infoHash, type DownloadResults, type Release } from '../../shared/catalog-downloads'
import { httpsLink } from './links'
import { aniSeasonFits, matchesRelease, releaseCoverage, seasonFits, subjectNames, unknownCoverage, verifiedCoverage, videoExtension, type DownloadSubject } from './match'
import { cachedSource, SourceError, sourceReason } from './source-cache'

interface GardenRow {
  provider: string; providerId: string; title: string; type: string; href: string; magnet: string; tracker?: string; subjectId?: number
  metadata?: { anipar?: { title?: string; titles?: string[]; episodeRange?: { from: number; to: number }; episode?: number; language?: string; subtitles?: string; file?: { video?: { resolution?: string } } } }
}
interface GardenPage { resources: GardenRow[]; pagination: { complete: boolean } }
interface GardenDetail { files?: { name: string }[]; hasMoreFiles?: boolean; magnets?: { name?: string; url?: string }[] }
const GARDEN = 'https://api.animes.garden'
const FEED = 'https://api.ani.rip/ani-download.xml'
const PAGE_SIZE = 40

function gardenJson(text: string) {
  const body: unknown = JSON.parse(text)
  if (!body || typeof body !== 'object' || !('status' in body)) throw new SourceError('AnimeGarden 返回的数据格式不正确')
  if (body.status !== 'OK') throw new SourceError(`AnimeGarden 返回 ${sourceReason(body) || String(body.status).slice(0, 100)}`)
  return body
}
const gardenList = cachedSource('AnimeGarden', (text): GardenPage => {
  const body = gardenJson(text) as Partial<GardenPage>
  if (!Array.isArray(body.resources) || typeof body.pagination?.complete !== 'boolean') throw new SourceError('AnimeGarden 返回的列表不完整')
  return { resources: body.resources, pagination: body.pagination }
}, 128)
const gardenDetail = cachedSource('AnimeGarden', (text): GardenDetail => {
  const body = gardenJson(text) as { detail?: GardenDetail | null; isDeleted?: boolean }
  if (body.isDeleted || !body.detail) return {}
  const { files, magnets } = body.detail
  if ((files != null && (!Array.isArray(files) || files.some(f => !f || typeof f.name !== 'string'))) ||
      (magnets != null && (!Array.isArray(magnets) || magnets.some(m => !m || typeof m !== 'object')))) throw new SourceError('AnimeGarden 返回的发布详情格式不正确')
  return body.detail
}, 160)

function listUrl(subject: DownloadSubject, page: number, byName: boolean, bundles = false): string {
  const url = new URL('/resources', GARDEN)
  url.searchParams.set('page', String(page))
  url.searchParams.set('pageSize', bundles ? '8' : String(PAGE_SIZE))
  if (bundles) url.searchParams.set('type', '合集')
  url.searchParams.set('metadata', 'true')
  url.searchParams.set('tracker', 'true')
  if (byName) {
    for (const name of subjectNames(subject)) url.searchParams.append('include', name)
  } else url.searchParams.set('subject', String(subject.item.bgmId))
  return url.href
}

function gardenRelease(subject: DownloadSubject, row: GardenRow): Release | null {
  if (!row || typeof row.title !== 'string' || typeof row.magnet !== 'string' || typeof row.provider !== 'string' || !row.provider || !['动画', '動畫', '合集', '季度全集', '劇場版', '剧场版'].includes(row.type)) return null
  if (row.subjectId && row.subjectId !== subject.item.bgmId) return null
  const hash = infoHash(row.magnet)
  if (!hash) return null
  const parsed = row.metadata?.anipar
  const coverage = releaseCoverage(row.title, subject.item.eps, parsed?.episodeRange, typeof parsed?.episode === 'number' ? parsed.episode : undefined)
  if (coverage.group !== 'mixed' && (subject.item.name || subject.item.nameCn) && !seasonFits(subject, row.title, false)) return null
  const names = [parsed?.title, ...(Array.isArray(parsed?.titles) ? parsed.titles : [])].filter((n): n is string => typeof n === 'string')
  if (!row.subjectId && !matchesRelease(subject, row.title, names, coverage.group === 'mixed')) return null
  const url = row.magnet + (typeof row.tracker === 'string' && row.tracker.startsWith('&') && !row.magnet.includes('&tr=') ? row.tracker : '')
  return { id: hash, title: row.title, kind: 'magnet', url, ...coverage, nameMatch: !row.subjectId,
    sources: [row.provider], quality: [parsed?.file?.video?.resolution, parsed?.language, parsed?.subtitles].filter(s => typeof s === 'string').join(' '),
    pageUrl: httpsLink(row.href) || undefined }
}

async function findGarden(subject: DownloadSubject, page: number, notices: Set<string>): Promise<DownloadResults> {
  const first = await gardenList(listUrl(subject, 1, false), notices)
  const byName = !first.resources.length
  if (byName && !subjectNames(subject).length) return { items: [] }
  const list = !byName && page === 1 ? first : await gardenList(listUrl(subject, page, byName), notices)
  const releases = new Map<string, Release>()
  const candidates: { release: Release; path: string; priority: number }[] = []
  function add(row: GardenRow): void {
    const release = gardenRelease(subject, row)
    if (!release) return
    const previous = releases.get(release.id)
    if (previous) {
      if (!previous.sources.includes(row.provider)) previous.sources.push(row.provider)
      return
    }
    releases.set(release.id, release)
    const batch = release.group === 'range' || /合集|全集|\bbatch\b|\bcomplete\b/i.test(row.type + ' ' + row.title)
    if (batch && release.group !== 'mixed' && /^[a-z0-9-]+$/i.test(row.provider) && typeof row.providerId === 'string' && /^[a-z0-9-]+$/i.test(row.providerId)) {
      candidates.push({ release, path: `/detail/${row.provider}/${row.providerId}`, priority: release.first === 1 && release.last === subject.item.eps ? 0 : 1 })
    }
  }
  list.resources.forEach(add)
  // 连载期间同集多种字幕会占满首页，单独查一次「合集」可捞回更早发布的成套资源
  if (page === 1 && !list.pagination.complete && !notices.size && !candidates.some(c => c.priority === 0)) {
    try { (await gardenList(listUrl(subject, 1, byName, true), notices)).resources.forEach(add) }
    catch (error) { if (!(error instanceof SourceError)) throw error; notices.add(error.message) }
  }
  // 优先核对最有希望的整季，每页至多核对两份文件表。限流时已读到的发布仍可用
  for (const { release, path } of candidates.sort((a,b) => a.priority - b.priority).slice(0, 2)) {
    try {
      const detail = await gardenDetail(GARDEN + path, notices)
      const names = detail.files?.map(f => f.name) ?? []
      const coverage = verifiedCoverage(names, detail.hasMoreFiles === false, subject)
      const filesMatch = !release.nameMatch || coverage?.group !== 'season' || names.filter(n => videoExtension.test(n)).every(n => matchesRelease(subject, n.split(/[/\\]/).pop()!.replace(videoExtension, ''), [], false))
      if (coverage && filesMatch) Object.assign(release, coverage)
      else if (release.group === 'range' && (detail.hasMoreFiles || (names.length && !coverage))) Object.assign(release, unknownCoverage)
      // 动漫花园的「会员专用链接」要求源站 Cookie，不能当作公开的种子下载
      release.torrentUrl = detail.magnets?.map(m => !/会员|會員|member/i.test(m.name ?? '') && httpsLink(m.url)).find((u): u is string => !!u && /\.torrent(?:[?#]|$)/i.test(u))
    } catch (error) {
      if (!(error instanceof SourceError)) throw error
      notices.add(error.message)
      break
    }
  }
  return { items: [...releases.values()], more: !list.pagination.complete }
}

const aniFeed = cachedSource('ANi', (xml): { title: string; url: string }[] => {
  const $ = load(xml, { xmlMode: true })
  if (!$('rss > channel').length) throw new SourceError('ANi 返回的订阅格式不正确')
  return $('channel > item').toArray().flatMap(node => {
    const title = $(node).children('title').text().trim()
    const url = httpsLink($(node).children('link').text().trim())
    if (!url || !title || !/\.(mp4|mkv|zip)$/i.test(title) || new URL(url).hostname !== 'resources.ani.rip') return []
    return [{ title, url }]
  })
}, 1)

export async function findDownloads(subject: DownloadSubject, source: 'garden' | 'ani', page: number): Promise<DownloadResults> {
  const notices = new Set<string>()
  let results: DownloadResults = { items: [] }
  try {
    if (source === 'garden') results = await findGarden(subject, page, notices)
    else if (subjectNames(subject).length) {
      const entries = await aniFeed(FEED, notices)
      results.items = entries.filter(entry => aniSeasonFits(subject, entry.url) && matchesRelease(subject, entry.title, [], false)).map(({ title, url }) => ({
        id: url, title, url, kind: 'file', ...releaseCoverage(title, subject.item.eps), quality: '', sources: ['ANi'],
      }))
    }
  } catch (error) {
    if (!(error instanceof SourceError)) throw error
    notices.add(error.message)
  }
  if (notices.size) results.warning = [...notices].join('，')
  return results
}

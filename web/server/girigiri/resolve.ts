import { getDetail, sourcePageUrl, type GirigiriDetail, type GirigiriSource } from './api'
export { BASE_URL, isGirigiriId } from './api'

export interface GirigiriLineMeta { source: number; name: string }
export interface GirigiriPlayLine { source: number; url: string; kind: 'mp4' | 'hls' }
export interface GirigiriPlaylist {
  title: string
  lines: GirigiriLineMeta[]
  first: GirigiriPlayLine | null
  eps: number[]
}

function assertEp(ep: number): void {
  if (!Number.isSafeInteger(ep) || ep < 1) throw new Error('ep 不合法')
}

function lineOf(source: GirigiriSource | undefined, ep: number): GirigiriPlayLine | null {
  const episode = source?.episodes.find((item) => item.number === ep)
  if (!source || !episode) return null
  if (!episode.url) throw new Error('Girigiri 当前集返回了无效的媒体地址')
  return { source: source.source, url: episode.url, kind: /\.m3u8(?:$|[?#])/i.test(episode.url) ? 'hls' : 'mp4' }
}

function episodesOf(detail: GirigiriDetail): number[] {
  return [...new Set(detail.sources.flatMap((source) => source.episodes.flatMap((ep) => ep.number === null ? [] : [ep.number])))].sort((a, b) => a - b)
}

export async function getPlaylist(id: string, ep: number): Promise<GirigiriPlaylist> {
  assertEp(ep)
  const detail = await getDetail(id)
  return {
    title: detail.title,
    lines: detail.sources.map(({ source, name }) => ({ source, name })),
    first: lineOf(detail.sources[0], ep),
    eps: episodesOf(detail),
  }
}

export async function resolveLine(id: string, ep: number, source: number): Promise<GirigiriPlayLine | null> {
  assertEp(ep)
  if (!Number.isSafeInteger(source) || source < 1) throw new Error('source 不合法')
  return lineOf((await getDetail(id)).sources.find((line) => line.source === source), ep)
}

export async function getSourcePageUrl(id: string, ep: number): Promise<string> {
  assertEp(ep)
  return sourcePageUrl(await getDetail(id), ep)
}

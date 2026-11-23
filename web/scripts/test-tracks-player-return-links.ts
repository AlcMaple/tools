import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { load } from 'cheerio'
import { SOURCES, type Track, type WatchMode } from '../src/api'
import { SourceBindPickerModal } from '../src/tracks/sourceModals'
import { allowsTracksPlayerOpener } from '../src/tracks/playerReturn'

const origin = 'https://return-links.example.invalid'
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: origin + '/#/tracks', origin } } })
try {
  const track: Track = { bgmId: 101, status: 'watching', episode: 11, totalEpisodes: 28, title: 'Return fixture', titleCn: '回程夹具', cover: '', airWeekday: 1, airDate: '', score: 0, bgmTags: [], userTags: [], aliases: [], observeCount: 0, subjectType: 'anime', goodEpisodes: [], goodEpisodeNotes: {}, favorite: 0, createdAt: 1, updatedAt: 1 }
  const candidate = { id: '1001', name: '本地候选', day: 1, remarks: '', score: 1 }
  const render = (mode: WatchMode, returnToTracks: boolean) => load(renderToStaticMarkup(createElement(SourceBindPickerModal, {
    source: SOURCES[0], flow: { source: 'xifan', track, candidates: [candidate], mode, agentAction: 'fixture-action' }, returnToTracks,
    offsetFor: () => 0, onPick: () => {}, onSearch: () => {}, onClose: () => {},
  })))('a.sugg-item')
  const actionLink = render('online', true)
  assert.equal(actionLink.attr('rel'), 'opener', 'an Agent action launched from tracks must retain the same return relationship')
  assert.equal(actionLink.attr('target'), '_blank')
  assert.equal(new URL(actionLink.attr('href')!, origin).searchParams.get('agentAction'), 'fixture-action')
  assert.equal(render('source', true).attr('rel'), 'noreferrer')
  assert.equal(new URL(render('source', true).attr('href')!, origin).searchParams.has('agentAction'), false)
  assert.equal(render('online', false).attr('rel'), 'noreferrer')
  console.log('PASS tracks player return links: rendered Agent candidate uses the actual initiating-page policy; source and non-tracks links stay isolated')
  for (const [url, mode, enabled, expected] of [
    ['/api/player/page?src=xifan&id=1001&ep=11', 'online', true, true],
    ['/api/player/page?src=xifan&id=1001&ep=11', 'source', true, false],
    ['/api/player/page?src=xifan&id=1001&ep=11', 'online', false, false],
    ['/api/xifan/source-page?animeId=1001&ep=11', 'online', true, false],
    ['https://other.example.invalid/api/player/page', 'online', true, false],
    ['https://user:password@return-links.example.invalid/api/player/page', 'online', true, false],
    ['/api/player/page/other', 'online', true, false],
  ] as const) assert.equal(allowsTracksPlayerOpener(url, mode, enabled), expected, `opener boundary: ${url}, ${mode}, enabled=${enabled}`)
  console.log('PASS tracks player return links: exact origin, route, mode, initiator and credential-free URL boundaries')
} finally {
  Reflect.deleteProperty(globalThis, 'window')
}

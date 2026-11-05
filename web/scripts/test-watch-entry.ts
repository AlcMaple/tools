import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CalendarItem, Track } from '../src/api'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearWatchIntent, readWatchIntent, rememberWatchIntent } from '../src/watchIntent'

const cache = mkdtempSync(join(tmpdir(), 'watch-entry-ssr-'))
const vite = await createServer({ cacheDir: cache, envFile: false, root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, server: { host: '127.0.0.1', middlewareMode: true, watch: null, hmr: false }, appType: 'custom', esbuild: { jsx: 'automatic' } })
try {
const { Poster } = await vite.ssrLoadModule('/src/CalendarPage.tsx')
const item: CalendarItem = { id: 101, name: 'Frieren', name_cn: '葬送的芙莉莲', url: 'https://example.invalid/detail', cover: 'https://example.invalid/cover', airDate: '2023-09-29', episodes: 28, score: 8.5 }
const watch = { tracksById: new Map<number, Track>(), bindings: { xifan: {}, girigiri: {} }, locating: null, onContinue: () => {} }
const guest = renderToStaticMarkup(createElement(Poster, { item, weekday: 0, canTrack: false, tracked: false, onToggle: () => {}, watch }))
assert(guest.includes('登录后观看'), 'guest poster must expose a visible login-to-watch action')
assert(!guest.includes('aria-label="追番"'), 'guest must not get authenticated writes')
console.log('PASS guest result exposes login-to-watch without enabling track writes')
const signedIn = renderToStaticMarkup(createElement(Poster, { item, weekday: 0, canTrack: true, tracked: false, onToggle: () => {}, watch }))
assert(signedIn.includes('试看') && signedIn.includes('aria-label="追番"'))
console.log('PASS signed-in trial and tracking actions remain available')

const data = new Map<string, string>()
const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
rememberWatchIntent(item, storage, 1000)
assert.deepEqual(readWatchIntent(storage, 1001), { ...item, url: '', cover: '' })
assert(!JSON.stringify([...data.values()]).includes('example.invalid'))
console.log('PASS reload/OAuth return restores the selected public anime, not external URLs')
for (const key of data.keys()) { const saved = JSON.parse(data.get(key)!) as { anime: Record<string, unknown> }; saved.anime.unexpected = 'fixture-only-extra'; data.set(key, JSON.stringify(saved)) }
assert.deepEqual(readWatchIntent(storage, 1001), { ...item, url: '', cover: '' })
console.log('PASS restored intent also drops unexpected fields')
clearWatchIntent(storage)
assert.equal(readWatchIntent(storage, 1001), null)
console.log('PASS cancel removes the pending watch instead of replaying it at later login')
rememberWatchIntent(item, storage, 1000)
assert.equal(readWatchIntent(storage, 1000 + 30 * 60_000), null)
assert.equal(data.size, 0)
rememberWatchIntent(item, storage, 1000)
for (const key of data.keys()) data.set(key, '{bad json')
assert.equal(readWatchIntent(storage, 1001), null)
rememberWatchIntent({ ...item, id: 0 }, storage, 1000)
assert.equal(data.size, 0)
console.log('PASS expired, corrupt and invalid intents do not trigger playback')

} finally { await vite.close(); rmSync(cache, { recursive: true, force: true }) }

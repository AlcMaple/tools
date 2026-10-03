import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Track } from '../src/api'

const root = fileURLToPath(new URL('../dist/', import.meta.url))
const app = new Hono()
const requests: Record<string, number> = {}
const searchQueries: string[] = []
const tracks: Track[] = Array.from({ length: 240 }, (_, index) => ({
  bgmId: index + 1, title: `回归番剧 ${index + 1}`, titleCn: `回归番剧 ${index + 1}`,
  status: 'watching', episode: 1, totalEpisodes: 12, cover: '', airWeekday: 0,
  airDate: index === 0 ? new Date().toISOString().slice(0, 10) : '2020-01-01', score: 8, bgmTags: ['测试'], userTags: [], aliases: [],
  observeCount: 0, subjectType: 'anime', goodEpisodes: [], goodEpisodeNotes: {}, favorite: 0,
  updatedAt: 1,
}))
app.use('/api/*', async (c, next) => {
  const path = c.req.path
  requests[path] = (requests[path] ?? 0) + 1
  await next()
})
app.get('/fixture', c => c.html('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>390px 追番回归</title><iframe title="手机预览" style="width:390px;height:844px;border:1px solid #888" src="/#/tracks"></iframe>'))
app.get('/metrics', c => c.json(requests))
app.get('/search-metrics', c => c.json(searchQueries))
app.get('/api/auth/me', c => c.json({ id: 1, username: process.env.TRACKS_FIXTURE_USER || 'fixture', createdAt: '', bgmUid: '', email: null, hasSecurity: true, hasEmail: false, hasPassword: true, tracksPublic: false, aiConfig: {}, dailyReward: 0 }))
app.get('/api/tracks', c => {
  if (!c.req.header('Accept')?.includes('application/x-ndjson')) return c.json({ rev: 1, data: tracks })
  c.header('Content-Type', 'application/x-ndjson')
  c.header('X-Accel-Buffering', 'no')
  return stream(c, async output => {
    const packet = (start: number, end: number) => JSON.stringify({
      rev: 1, total: tracks.length, counts: { all: 240, watching: 240, plan: 0, considering: 0, done: 0 },
      indices: Array.from({ length: end - start }, (_, offset) => start + offset), data: tracks.slice(start, end), done: end === tracks.length,
    }) + '\n'
    await output.write(packet(0, 18))
    await new Promise(resolve => setTimeout(resolve, Number(process.env.TRACKS_FIXTURE_DELAY_MS) || 0))
    if (output.aborted || process.env.TRACKS_FIXTURE_TRUNCATE === '1') return
    await output.write(packet(18, tracks.length))
  })
})
app.get('/api/tracks/revision', c => c.json({ rev: 1 }))
app.get('/api/xifan/bindings', c => c.json({ data: {} }))
app.get('/api/girigiri/bindings', c => c.json({ data: {} }))
app.get('/api/search', async c => {
  const q = c.req.query('q') ?? ''
  searchQueries.push(q)
  if (q === '限流') return c.json({ error: '测试：今日额度已用完' }, 429)
  if (q === '失败') return c.json({ error: '测试：离线索引暂时不可读' }, 503)
  if (q === '旧词') await new Promise(resolve => setTimeout(resolve, 1500))
  if (q === '排序') return c.json({ ready: true, source: 'local', data: Array.from({ length: 30 }, (_, i) => ({
    bgmId: 1000 + i, name: `排序 ${i}`, nameCn: `排序 ${i}`, date: `${2000 + i}-01-01`, score: 8,
  })) })
  if (q === '慢') await new Promise(resolve => setTimeout(resolve, 15_000))
  return c.json({ ready: true, builtAt: Date.now(), source: 'local', data: q ? [{ bgmId: 555, name: q, nameCn: q, date: '2020-01-01', score: 8 }] : [] })
})
app.post('/api/xifan/search', c => c.json({ error: '测试：稀饭服务维护中' }, 503))
app.post('/api/xifan/locate', c => c.json({ candidates: [] }))
app.post('/api/request-log', async c => { console.log('[fixture:client]', await c.req.text()); return c.body(null, 204) })
app.post('/api/search-log', async c => { console.log('[fixture:search]', await c.req.text()); return c.body(null, 204) })
app.all('/api/*', c => c.json({ data: [], enabled: false, unread: 0 }))
app.use('/assets/*', serveStatic({ root }))
app.get('/cover-cache-sw.js', c => c.text('', 404))
app.get('*', c => {
  // 测试页仅使用当前构建产物，去掉外部统计脚本，禁止夹具触及生产账号。
  const html = readFileSync(root + 'index.html', 'utf8').replace(/<script\b[^>]*src="https:[^"]*"[^>]*><\/script>/g, '')
  return c.html(html)
})
serve({ fetch: app.fetch, port: 4179, hostname: '127.0.0.1' })
console.log('240 条隔离数据：http://127.0.0.1:4179/#/tracks；390px 预览：/fixture')

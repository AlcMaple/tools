import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync } from 'node:crypto'
import type { Hono } from 'hono'
import { getSession, issueSession } from '../server/auth'

export function addWatchFixture(app: Hono<{ Variables: { agentUid: number } }>, directory: string, database: typeof import('../server/db').db): { password?: string } {
  if (process.env.AGENT_UI_WATCH !== '1' || process.env.AGENT_UI_FIXTURE !== '1') throw new Error('WATCH_FIXTURE_TEST_ONLY')
  let password: string | undefined
  if (process.env.AGENT_UI_WATCH_LOGIN === '1') {
    password = randomBytes(18).toString('hex')
    const salt = randomBytes(16)
    database.prepare("UPDATE users SET pass_hash=? WHERE username='ui_empty'").run(salt.toString('hex') + ':' + scryptSync(password, salt, 64).toString('hex'))
    app.get('/api/auth/oauth/providers', c => c.json({ email: true, google: false, github: false, linuxdo: false }))
    app.post('/api/auth/email/start', c => c.json({ challengeId: 'watch-login-fixture', expiresIn: 600 }))
    app.post('/api/auth/email/verify', async c => {
      const body = await c.req.json() as { challengeId?: string; code?: string }
      if (body.challengeId !== 'watch-login-fixture' || body.code !== '123456') return c.json({ error: '测试验证码不匹配' }, 400)
      const user = database.prepare("SELECT id,username FROM users WHERE username='ui_empty'").get() as { id: number; username: string }
      await issueSession(c, { uid: user.id, username: user.username, tv: 0 })
      return c.json({ username: user.username, hasSecurity: true, hasEmail: true, hasPassword: true })
    })
  }
  const mediaPath = join(directory, 'watch-fixture.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '240k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', '-y', mediaPath])
  const media = readFileSync(mediaPath)
  const items = [
    { bgmId: 101, name: 'Frieren', nameCn: '葬送的芙莉莲', date: '2023-09-29', eps: 28, score: 8.5, cover: '', tags: [] },
    { bgmId: 110, name: 'Fixture', nameCn: '夹具里的另一部番', date: '2024-01-01', eps: 12, score: 7, cover: '', tags: [] },
  ]
  database.prepare("INSERT OR REPLACE INTO xifan_binding(bgm_id,xifan_id,xifan_name,updated_at,source_version) VALUES(101,1001,?,?,'next')").run('葬送的芙莉莲 · 本地验证片', Date.now())
  let mediaRequests = 0, playlistRequests = 0, prefetchRequests = 0
  app.post('/api/player/prefetch-next', c => { prefetchRequests++; return c.json({ ok: true, fixtureOnly: true }) })
  app.get('/__watch-test/status', c => c.json({ fixtureOnly: true, mediaRequests, playlistRequests, prefetchRequests, durationSeconds: 120, productionData: false }))
  app.get('/api/catalog', c => {
    const q = (c.req.query('q') ?? '').trim(), year = Number(c.req.query('year') ?? 0)
    const found = items.filter(item => (!q || item.nameCn.includes(q)) && (!year || item.date.startsWith(String(year))))
    return c.json({ ready: true, admin: false, total: found.length, items: found })
  })
  app.post('/api/xifan/search', async c => {
    if (!await getSession(c)) return c.json({ code: 'AUTH_REQUIRED', error: '请先登录' }, 401)
    return c.json({ needsCaptcha: false, data: [{ xifanId: 1001, xifanName: '葬送的芙莉莲 · 本地验证片', cover: '', episode: '本地播放测试片', year: '2023', area: '测试夹具' }] })
  })
  app.get('/api/player/playlist', async c => {
    if (!await getSession(c)) return c.json({ code: 'AUTH_REQUIRED', error: '请先登录' }, 401)
    playlistRequests++
    return c.json({ title: '本地播放验证片 · 非真实动漫片源', eps: Array.from({ length: 28 }, (_, i) => i + 1), lines: [{ source: 1, name: '本地验证线路' }], first: { source: 1, kind: 'mp4', url: new URL('/api/player/stream', c.req.url).href, s: 'fixture-media' }, speeds: {} })
  })
  app.get('/api/player/stream', async c => {
    if (!await getSession(c)) return c.json({ code: 'AUTH_REQUIRED', error: '请先登录' }, 401)
    mediaRequests++
    const range = /^bytes=(\d+)-(\d*)$/.exec(c.req.header('Range') ?? '')
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1
    if (start > end || start >= media.length) return c.body(null, 416, { 'Content-Range': `bytes */${media.length}` })
    const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Length': String(end - start + 1) }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${media.length}`
    return new Response(new Uint8Array(media.subarray(start, end + 1)), { status: range ? 206 : 200, headers })
  })
  app.get('/api/player/moov', c => c.body(null, 204))
  app.get('/api/player/vendor/:file', c => {
    const paths: Record<string, string> = { 'artplayer.js': '../node_modules/artplayer/dist/artplayer.js', 'hls.js': '../node_modules/hls.js/dist/hls.min.js', 'monitor.js': '../dist/player-monitor.js' }
    const path = paths[c.req.param('file')]
    if (!path) return c.body(null, 404)
    return c.body(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'), 200, { 'Content-Type': 'application/javascript; charset=utf-8' })
  })
  return { password }
}

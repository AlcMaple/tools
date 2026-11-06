import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'player-idle-prefetch-'))
const cwd = process.cwd()
const originalFetch = globalThis.fetch
for (const key of Object.keys(process.env)) if (/^(SENTRY_|VITE_SENTRY_|SMTP_|AI_|GOOGLE_|XIFAN_|BGM_|BANGUMI_|MAPLETOOLS_ENV_FILE$)/.test(key)) delete process.env[key]
process.env.NODE_ENV = 'production'
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
process.env.DATA_DIR = directory
process.chdir(directory)
const issuedEpisodes: number[] = []
let externalRequests = 0
let mediaRequests = 0
const detail = {
  anime: { id: 7, title: '本地选集夹具' },
  sources: [{ id: 5, code: 'fixture', name: '本地验证线路', episodes: [9, 10].map(n => ({ id: 9000 + n, episode_number: n, kind: 'main', title: `第${n}集` })) }],
}
const flight = '<script>self.__next_f.push(' + JSON.stringify([1, '0:' + JSON.stringify(detail) + '\n']) + ')</script>'
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.href === 'https://next.xifanacg.com/anime/7') return new Response(flight)
  if (url.href === 'https://api.xifanacg.com/functions/v1/issue-web-playback') {
    const data = JSON.parse(String(init?.body)) as { episode_id: number; source_id: number }
    issuedEpisodes.push(data.episode_id - 9000)
    return Response.json({ episode_id: data.episode_id, anime_id: 7, source_id: data.source_id, url: `https://fixture-media.invalid/${data.episode_id}.m3u8` })
  }
  if (url.hostname === 'fixture-media.invalid') mediaRequests++
  else externalRequests++
  throw new Error('UNEXPECTED_NETWORK_REQUEST:' + url.origin)
}
let closeDatabase: (() => void) | undefined
let checks = 0
function passed(name: string): void { checks++; console.log(`PASS P${checks} ${name}`) }
try {
  const { Hono } = await import('hono')
  const { db } = await import('../server/db')
  closeDatabase = () => db.close()
  const { issueSession } = await import('../server/auth')
  const { default: player } = await import('../server/player')
  const uid = Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run('idle_prefetch_fixture', 'unused', new Date().toISOString()).lastInsertRowid)
  const app = new Hono()
  app.get('/login', async c => { await issueSession(c, { uid, username: 'idle_prefetch_fixture', tv: 0 }); return c.text('fixture') })
  app.route('/api/player', player)
  const path = '/api/player/playlist?src=xifan&id=7&ep='
  assert.equal((await app.request(path + '9')).status, 401)
  passed('访客认证边界不变')
  const cookie = (await app.request('/login')).headers.get('set-cookie')!.split(';')[0]
  const get = (url: string) => app.request(url, { headers: { Cookie: cookie } })
  assert.equal((await get(path + '0')).status, 400)
  passed('非法集数仍拒绝')
  const current = await get(path + '9')
  assert.equal(current.status, 200)
  const data = await current.json() as { title: string; eps: number[]; first: { kind: string; url: string; s: string } }
  assert.deepEqual(data.eps, [9, 10])
  assert.equal(data.first.kind, 'hls')
  assert.equal(data.first.s.length, 32)
  assert.match(data.first.url, /9009\.m3u8$/)
  assert.deepEqual(issuedEpisodes, [9])
  passed('仅选第9集仍返回完整选集与签名地址')
  // 原路径延迟30秒预取，真实跨过这条边界，不用源码匹配或“没有马上请求”代替覆盖
  const observedAt = Date.now()
  await new Promise(resolve => setTimeout(resolve, 31_100))
  assert(Date.now() - observedAt >= 30_000)
  assert.deepEqual(issuedEpisodes, [9], '只打开第9集，未选择第10集，不应自动签发下一集')
  assert.equal(mediaRequests, 0)
  passed('未开始播放或已离开时，等过预取窗口也不触碰下一集')
  const next = await get(path + '10')
  assert.equal(next.status, 200)
  const selected = await next.json() as { first: { url: string; s: string }; eps: number[] }
  assert.match(selected.first.url, /9010\.m3u8$/)
  assert.equal(selected.first.s.length, 32)
  assert.deepEqual(selected.eps, [9, 10])
  assert.deepEqual(issuedEpisodes, [9, 10])
  passed('用户真正选择第10集时才正常解析该集')
  assert.equal(externalRequests, 0)
  assert.equal(mediaRequests, 0)
  console.log(JSON.stringify({ checks, passed: true, issuedEpisodes, externalRequests, mediaRequests, elapsedObservationMs: Date.now() - observedAt }))
} finally {
  globalThis.fetch = originalFetch
  closeDatabase?.()
  process.chdir(cwd)
  rmSync(directory, { recursive: true, force: true })
}

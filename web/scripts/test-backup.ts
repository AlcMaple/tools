// 备份导入导出回归：导出 → 清空 → 导回逐字段对齐；旧备份不覆盖新进度；别人的备份只导追番；
// 套一层目录的 zip；coverFile 缺失回退；裸 JSON 导入保留已上传封面。
// 跑法：npm run test:backup
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const dir = mkdtempSync(join(tmpdir(), 'maple-backup-')), cwd = process.cwd()
mkdirSync(join(dir, 'data'))
process.chdir(dir)
for (const key of Object.keys(process.env)) if (/^(AI_|AGENT_|SENTRY_|VITE_SENTRY_|SMTP_|GOOGLE_|MAPLETOOLS_ENV_FILE$|VERCEL$)/.test(key)) delete process.env[key]
process.env.NODE_ENV = 'test'
process.env.DATA_DIR = join(dir, 'data')
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
process.env.EMAIL_MODE = 'disabled'

let checks = 0
const check = async (name: string, fn: () => unknown) => { await fn(); console.log(`PASS B${++checks} ${name}`) }

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

try {
  const { db } = await import('../server/db')
  const { Hono } = await import('hono')
  const { issueSession } = await import('../server/auth')
  const { sameOriginGuard, securityHeaders } = await import('../server/security')
  const tracks = (await import('../server/tracks')).default
  const reviews = (await import('../server/reviews')).default
  const backup = (await import('../server/backup')).default
  const { coversDir } = await import('../server/data-dir')

  const app = new Hono()
  app.use('*', securityHeaders())
  app.use('/api/*', sameOriginGuard())
  app.route('/api/tracks', tracks)
  app.route('/api/reviews', reviews)
  app.route('/api/backup', backup)
  const origin = 'http://localhost'

  const addUser = (name: string) => Number(db.prepare('INSERT INTO users(username,pass_hash,created_at) VALUES(?,?,?)').run(name, randomBytes(16).toString('hex'), new Date().toISOString()).lastInsertRowid)
  const cookie = async (uid: number, username: string) => {
    const issuer = new Hono().get('/', async (c) => { await issueSession(c, { uid, username, tv: 0 }); return c.text('ok') })
    return (await issuer.request(origin)).headers.get('set-cookie')!.split(';')[0]
  }
  const alice = addUser('alice'), bob = addUser('bob')
  const aliceCk = await cookie(alice, 'alice'), bobCk = await cookie(bob, 'bob')

  const json = (path: string, method: string, body: unknown, ck: string) =>
    app.request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: ck }, body: body === undefined ? undefined : JSON.stringify(body) })
  const upload = (path: string, file: File, ck: string) => {
    const fd = new FormData()
    fd.append('file', file)
    return app.request(origin + path, { method: 'POST', headers: { Origin: origin, Cookie: ck }, body: fd })
  }
  const exportAs = async (format: string, ck: string) => {
    const res = await app.request(`${origin}/api/backup/export?format=${encodeURIComponent(format)}`, { headers: { Cookie: ck } })
    assert.equal(res.status, 200)
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) }
  }
  const importFile = async (name: string, bytes: Uint8Array | string, ck: string) => {
    const res = await upload('/api/backup/import', new File([bytes as BlobPart], name), ck)
    const body = await res.json() as Record<string, any>
    return { status: res.status, body }
  }
  const rows = (uid: number) => db.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY bgm_id').all(uid) as Record<string, any>[]

  // ── 造数据：两部番、一张本地封面、一条已发布点评 + 一条草稿 ────────────────────────
  assert.equal((await json('/api/tracks/100', 'PUT', { status: 'watching', episode: 3, title: 'Alpha', titleCn: '阿尔法', cover: 'https://lain.bgm.tv/r/400/a.jpg', userTags: ['神作'], goodEpisodes: [1, 2, 5], goodEpisodeNotes: { 5: '神回' }, favorite: 3 }, aliceCk)).status, 200)
  assert.equal((await json('/api/tracks/200', 'PUT', { status: 'done', episode: 12, totalEpisodes: 12, title: 'Beta', cover: 'https://lain.bgm.tv/r/400/b.jpg' }, aliceCk)).status, 200)
  // 新建时进度固定从 0 起，进度要第二次 PUT 才生效
  assert.equal((await json('/api/tracks/100', 'PUT', { episode: 3 }, aliceCk)).status, 200)
  assert.equal((await json('/api/tracks/200', 'PUT', { episode: 12 }, aliceCk)).status, 200)
  assert.equal((await upload('/api/tracks/100/cover', new File([PNG], 'c.png', { type: 'image/png' }), aliceCk)).status, 200)
  db.prepare("INSERT INTO review_contents (user_id,bgm_id,mode,body,published,published_at,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?)").run(alice, 100, 'review', '这是我的点评', 1000, 900, 1000)
  db.prepare("INSERT INTO review_drafts (user_id,bgm_id,mode,body,updated_at) VALUES (?,?,?,?,?)").run(alice, 200, 'recommend', '草稿正文', 1100)
  const before = rows(alice)
  assert.equal(before.find((r) => r.bgm_id === 100)!.cover_mime, 'image/png')

  let zipBytes!: Uint8Array
  await check('导出 zip-md：含 data.json / README.md / covers/100.png', async () => {
    const { res, bytes } = await exportAs('zip-md', aliceCk)
    assert.match(res.headers.get('content-disposition') ?? '', /\.zip/)
    zipBytes = bytes
    const files = unzipSync(bytes)
    assert.deepEqual(Object.keys(files).sort(), ['README.md', 'covers/100.png', 'data.json'])
    const data = JSON.parse(strFromU8(files['data.json']))
    assert.equal(data.format, 'mapletools-backup')
    assert.equal(data.exportedBy.userId, alice)
    const t100 = data.tracks.find((t: any) => t.bgmId === 100)
    assert.equal(t100.coverFile, 'covers/100.png')
    assert.equal(t100.cover, '')
    assert.deepEqual(t100.goodEpisodes, [1, 2, 5])
    assert.equal(t100.favorite, 3)
    assert.equal(data.reviews.length, 2)
    const md = strFromU8(files['README.md'])
    assert.match(md, /\| 阿尔法 \| EP 3 \|/)
    assert.match(md, /第 5 集：神回/)
    assert.match(md, /这是我的点评/)
    assert.match(md, /\*\*草稿\*\*/)
  })

  await check('导出 md：单文件', async () => {
    const { res, bytes } = await exportAs('md', aliceCk)
    assert.match(res.headers.get('content-type') ?? '', /markdown/)
    assert.match(strFromU8(bytes), /^# alice 的追番备份/)
  })

  await check('清空后导回：追番 / 点评 / 封面逐字段对齐', async () => {
    db.prepare('DELETE FROM tracks WHERE user_id = ?').run(alice)
    db.prepare('DELETE FROM review_contents WHERE user_id = ?').run(alice)
    db.prepare('DELETE FROM review_drafts WHERE user_id = ?').run(alice)
    rmSync(join(coversDir, `${alice}_100`))
    const { status, body } = await importFile('backup.zip', zipBytes, aliceCk)
    assert.equal(status, 200, JSON.stringify(body))
    assert.deepEqual(body.tracks, { added: 2, updated: 0, skipped: 0 })
    assert.deepEqual(body.reviews, { imported: 2, skipped: 0 })
    assert.deepEqual(body.covers, { imported: 1, missing: 0 })
    assert.equal(body.foreignBackup, false)
    const after = rows(alice)
    for (const b of before) {
      const a = after.find((r) => r.bgm_id === b.bgm_id)!
      for (const col of ['status', 'episode', 'total_episodes', 'title', 'title_cn', 'cover', 'cover_mime', 'score', 'bgm_tags', 'user_tags', 'aliases', 'extra', 'observe_count', 'updated_at']) {
        assert.equal(a[col], b[col], `${b.bgm_id}.${col}`)
      }
    }
    assert.ok(readFileSync(join(coversDir, `${alice}_100`)).equals(PNG))
    const content = db.prepare('SELECT * FROM review_contents WHERE user_id = ? AND bgm_id = 100').get(alice) as any
    assert.equal(content.body, '这是我的点评')
    assert.equal(content.published, 1)
    assert.equal(content.published_at, 1000)
    const draft = db.prepare('SELECT * FROM review_drafts WHERE user_id = ? AND bgm_id = 200').get(alice) as any
    assert.equal(draft.body, '草稿正文')
  })

  await check('旧备份不覆盖更新的进度；同一份再导一次全 skipped', async () => {
    assert.equal((await json('/api/tracks/100', 'PUT', { episode: 7 }, aliceCk)).status, 200)
    const { body } = await importFile('backup.zip', zipBytes, aliceCk)
    assert.deepEqual(body.tracks, { added: 0, updated: 0, skipped: 2 })
    assert.equal(rows(alice).find((r) => r.bgm_id === 100)!.episode, 7)
  })

  await check('别人的备份：只导追番、封面复制到自己名下、点评不进', async () => {
    const { body } = await importFile('backup.zip', zipBytes, bobCk)
    assert.equal(body.foreignBackup, true)
    assert.equal(body.reviews, null)
    assert.deepEqual(body.tracks, { added: 2, updated: 0, skipped: 0 })
    assert.equal(rows(bob).find((r) => r.bgm_id === 100)!.episode, 3)
    assert.ok(existsSync(join(coversDir, `${bob}_100`)))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM review_contents WHERE user_id = ?').get(bob) as any).n, 0)
  })

  await check('套了一层目录的 zip 也能导', async () => {
    const files = unzipSync(zipBytes)
    const nested: Record<string, Uint8Array> = { '__MACOSX/._x': new Uint8Array([1]) }
    for (const [k, v] of Object.entries(files)) nested[`mapletools-备份/${k}`] = v
    db.prepare('DELETE FROM tracks WHERE user_id = ?').run(bob)
    const { status, body } = await importFile('re.zip', zipSync(nested), bobCk)
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.tracks.added, 2)
    assert.equal(body.covers.imported, 1)
  })

  await check('coverFile 指的文件不在包里：回退网址、计入 missing', async () => {
    const files = unzipSync(zipBytes)
    const data = JSON.parse(strFromU8(files['data.json']))
    data.tracks.find((t: any) => t.bgmId === 100).cover = 'https://lain.bgm.tv/r/400/fallback.jpg'
    db.prepare('DELETE FROM tracks WHERE user_id = ?').run(bob)
    const { body } = await importFile('nocover.zip', zipSync({ 'data.json': strToU8(JSON.stringify(data)) }), bobCk)
    assert.deepEqual(body.covers, { imported: 0, missing: 1 })
    const r = rows(bob).find((r) => r.bgm_id === 100)!
    assert.equal(r.cover, 'https://lain.bgm.tv/r/400/fallback.jpg')
    assert.equal(r.cover_mime, '')
  })

  await check('裸 JSON 导入、条目更新但没带图：保留账号里已上传的封面', async () => {
    // alice 现在 100 有本地封面（上一步导回的）。造一份"更新"的裸 JSON，不带 coverFile。
    const files = unzipSync(zipBytes)
    const data = JSON.parse(strFromU8(files['data.json']))
    const t = data.tracks.find((t: any) => t.bgmId === 100)
    delete t.coverFile
    t.episode = 9
    t.updatedAt = Date.now() + 1
    data.reviews = []
    const { status, body } = await importFile('data.json', JSON.stringify(data), aliceCk)
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.tracks.updated, 1)
    const r = rows(alice).find((r) => r.bgm_id === 100)!
    assert.equal(r.episode, 9)
    assert.equal(r.cover_mime, 'image/png')
    assert.match(r.cover, /cover-file$/)
  })

  await check('拒绝：非备份 JSON / rar / 越界 bgmId', async () => {
    assert.equal((await importFile('x.json', '{"hello":1}', aliceCk)).status, 400)
    assert.equal((await importFile('x.rar', new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]), aliceCk)).status, 400)
    const bad = { format: 'mapletools-backup', version: 1, tracks: [{ bgmId: 0, status: 'watching' }] }
    assert.equal((await importFile('bad.json', JSON.stringify(bad), aliceCk)).status, 400)
    const traversal = { format: 'mapletools-backup', version: 1, tracks: [{ bgmId: 5, status: 'watching', coverFile: '../etc/passwd', updatedAt: 1 }] }
    const { status, body } = await importFile('t.json', JSON.stringify(traversal), aliceCk)
    assert.equal(status, 200)
    assert.equal(body.covers.missing, 1)
  })

  await check('未登录 401', async () => {
    assert.equal((await app.request(`${origin}/api/backup/export`)).status, 401)
    assert.equal((await app.request(`${origin}/api/backup/export-ticket`, { method: 'POST', headers: { Origin: origin } })).status, 401)
  })

  await check('下载票据：不带 Cookie 也能下；改 format 或伪造票据被拒', async () => {
    const res = await json('/api/backup/export-ticket', 'POST', { format: 'md' }, aliceCk)
    assert.equal(res.status, 200)
    const { url } = await res.json() as { url: string }
    assert.match(url, /^\/api\/backup\/export\?format=md&ticket=/)
    const dl = await app.request(origin + url)
    assert.equal(dl.status, 200)
    assert.match(dl.headers.get('content-type') ?? '', /markdown/)
    assert.equal((await app.request(origin + url.replace('format=md', 'format=zip'))).status, 401)
    assert.equal((await app.request(origin + url.slice(0, -4) + 'xxxx')).status, 401)
    assert.equal((await json('/api/backup/export-ticket', 'POST', { format: 'rar' }, aliceCk)).status, 400)
  })

  console.log(`ALL ${checks} PASS`)
} finally {
  process.chdir(cwd)
  rmSync(dir, { recursive: true, force: true })
}

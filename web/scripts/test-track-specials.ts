import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { Track, TracksSnapshot } from '../src/api'
import { episodeLabel } from '../shared/episode-layout'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const web = process.cwd()
const f = await createAgentUiFixture()
const profile = mkdtempSync(join(tmpdir(), 'track-sp-browser-'))
try {
  const indexFile = join(process.env.DATA_DIR!, 'bgm_index.db')
  const old = new Database(indexFile)
  old.exec('CREATE TABLE anime (bgm_id INTEGER PRIMARY KEY, eps INTEGER); INSERT INTO anime VALUES (11577,25)')
  old.close()
  const date = '2011-07-07'
  const id = 11577
  const cover = '/assets/sagiri-avatar.webp'
  f.db.prepare('UPDATE tracks SET cover=?, air_date=?, score=8, bgm_tags=?, aliases=?').run(cover, date, '["动画"]', '["样本"]')
  f.db.prepare('UPDATE tracks SET bgm_id=?, title=?, title_cn=?, episode=25, total_episodes=25, extra=? WHERE user_id=? AND bgm_id=102')
    .run(id, 'THE IDOLM@STER', '偶像大师', '{"goodEpisodes":[25],"goodEpisodeNotes":{"25":"正篇结尾"},"favorite":4}', f.alice)
  const seed = f.db.prepare('INSERT INTO tracks (user_id,bgm_id,title,status,episode,total_episodes,air_date,cover,updated_at) VALUES (?,?,?,?,?,?,?,?,1)')
  seed.run(f.alice, 301, '手填其他总数', 'watching', 2, 15, date, cover)
  seed.run(f.alice, 302, '未定集数', 'watching', 0, null, '2099-01-01', cover)
  seed.run(f.alice, 303, '普通动画', 'plan', 0, 1, date, cover)
  seed.run(f.alice, 305, 'SP 从 1 重新编号', 'watching', 2, 2, date, cover)
  seed.run(f.alice, 306, '只收录特别篇', 'plan', 0, 2, date, cover)
  seed.run(f.alice, 3271, '偶像大师 XENOGLOSSIA', 'done', 26, 26, '2007-04-02', cover)
  seed.run(f.alice, -77, '自定义', 'watching', 1, 1, date, cover)
  seed.run(f.bob, id, '另一个人的同一部番', 'watching', 21, 25, date, cover)
  const login = await f.originalFetch(f.origin + '/__agent-test/login/alice', { redirect: 'manual' })
  const Cookie = login.headers.get('set-cookie')!.split(';')[0]
  const req = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    f.originalFetch(f.origin + '/api/tracks' + path, { method, headers: { Cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const snapshot = async (): Promise<TracksSnapshot> => {
    const res = await req('')
    assert.equal(res.status, 200)
    return res.json()
  }
  const track = (s: TracksSnapshot, key: number): Track => s.data.find(t => t.bgmId === key)!
  const before = await snapshot()
  assert.equal(track(before, id).totalEpisodes, 25)
  assert.equal(track(before, id).episodeLayout, undefined)
  assert.deepEqual(await (await req('/11577/chapters')).json(), { main: [], specials: [] })
  const temp = process.cwd()
  const subjects = [id, 301, 302, 303, 304, 305, 306, 3271].map(key => ({ id: key, type: 2, name: '样本', date }))
  const chapter = (subject_id: number, type: number, sort: number, name_cn = '') => ({ subject_id, id: subject_id * 100 + type * 30 + sort, type, sort, name_cn })
  const chapters = [
    ...Array.from({ length: 25 }, (_, i) => chapter(id, 0, i + 1)),
    // 来源：Bangumi 11577 的 SP 章节 137936；其余条目专门覆盖重号、小数和非观看章节
    { subject_id: id, id: 137936, type: 1, sort: 26, name_cn: '名为765的故事', name: '765プロという物語', airdate: '2012-06-16', duration: '00:25:29' },
    ...[2, 3, 4, 5, 6].map(type => chapter(id, type, 1)),
    ...[301, 302, 304, 305].flatMap(key => [chapter(key, 0, 1), chapter(key, 0, 2), chapter(key, 1, 2.5), chapter(key, 1, 1)]),
    chapter(303, 0, 1), chapter(303, 2, 2),
    chapter(306, 1, 0), chapter(306, 1, 1),
    ...Array.from({ length: 26 }, (_, i) => chapter(3271, 0, 26-i)).map(x => x.sort === 9
      ? { ...x, id: 23347, name: '鍵盤', name_cn: '键盘', airdate: '2007-05-28', duration: '23:40' } : x),
    ...Array.from({ length: 8 }, (_, i) => chapter(3271, 1, i + 1)),
  ]
  const subjectFile = join(temp, 'subject.jsonlines'), episodeFile = join(temp, 'episode.jsonlines')
  for (const [path, rows] of [[subjectFile, subjects], [episodeFile, chapters]] as const) writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n'))
  const build = spawnSync('npm', ['run', 'sync:index', '--', '--file', subjectFile, '--episode-file', episodeFile], { cwd: web, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr + build.stdout)
  const revision = await (await req('/revision')).json()
  assert.notEqual(revision.viewRev, before.viewRev, '旧客户端快照须发现索引更新')
  const after = await snapshot(), anime = track(after, id)
  assert.deepEqual([anime.episode, anime.totalEpisodes, anime.status, anime.updatedAt], [25, 26, 'done', track(before, id).updatedAt])
  assert.deepEqual(anime.episodeLayout, { main: 25, specials: [{ sort: 26, title: '名为765的故事' }] })
  assert.deepEqual(anime.goodEpisodeNotes, {25: '正篇结尾'})
  assert.equal(after.rev, before.rev + 1, '批量校正只更新一次同步版本')
  assert.equal((await req('/sync', 'POST', { baseRev: before.rev, data: before.data })).status, 409)
  assert.deepEqual(await snapshot(), after)
  assert.equal(f.db.prepare('SELECT total_episodes FROM tracks WHERE user_id=? AND bgm_id=?').pluck().get(f.bob, id), 25)
  assert.deepEqual([301, 302, 303, -77].map(key => [track(after,key).totalEpisodes, track(after,key).episodeLayout]), [[15,undefined],[null,undefined],[1,undefined],[1,undefined]])
  const reset = track(after, 305)
  assert.deepEqual([reset.totalEpisodes, episodeLabel(reset.episodeLayout, 3), episodeLabel(reset.episodeLayout, 4)], [4,'SP 1','SP 2.5'])
  assert.equal(episodeLabel(track(after, 306).episodeLayout, 1), 'SP 0')
  assert.equal((await req('/999999/chapters')).status, 404)
  assert.equal((await f.originalFetch(f.origin + '/api/tracks/11577/chapters')).status, 401)
  const bobCookie = (await f.originalFetch(f.origin + '/__agent-test/login/bob', { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]
  assert.equal((await req('/3271/chapters', 'GET', undefined, { Cookie: bobCookie })).status, 404)
  const xeno = await (await req('/3271/chapters')).json()
  assert.deepEqual([xeno.main.length, xeno.specials.length], [26, 8])
  assert.deepEqual(xeno.main[8], { sort: 9, name: '鍵盤', nameCn: '键盘', airdate: '2007-05-28', duration: '23:40' })
  assert(!JSON.stringify(after).includes('23:40'), '逐集资料不应随整个追番列表下发')
  const streamed = await (await req('', 'GET', undefined, { Accept: 'application/x-ndjson' })).text()
  assert.deepEqual(track(JSON.parse(streamed.trim().split('\n')[0]), id).episodeLayout, anime.episodeLayout)
  console.log('PASS 旧索引 25/25 → 25/26；含 SP 26，排除 OP/ED/PV/MAD/其他，保留状态、神回和账号边界')
  console.log('PASS 重新编号、小数 SP、只有 SP、未知总数、自定义条目；缓存与流式快照一致')

  const { epsOf } = await import('../server/bgm/anime-index')
  assert.equal(epsOf(303, 2), 1, '线上汇总含 OP，不覆盖已分类正篇')
  const blocked = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname === 'api.bgm.tv' && url.pathname === '/v0/subjects/304') {
      return Response.json({ name: '样本', date, eps: 2, images: { large: cover }, tags: [{ name: '动画' }], infobox: [{ key: '别名', value: '样本' }], rating: { score: 8 } })
    }
    return blocked(input, init)
  }
  const added = await req('/add', 'POST', { expectedOwner: f.alice, bgmId: 304, title: '新加入样本', titleCn: '', airDate: date, cover, score: 8 })
  assert.equal(added.status, 201)
  assert.equal((await added.json()).totalEpisodes, 4)
  const guard = await (await req('/305/playback-progress')).json()
  assert.equal(guard.totalEpisodes, 4)
  const progress = { ownerId: guard.ownerId, revision: guard.revision }
  assert.equal((await req('/305', 'PUT', { playbackProgress: progress, episode: 5 })).status, 400)
  assert.equal((await (await req('/305', 'PUT', { playbackProgress: progress, episode: 3 })).json()).episode, 3)
  for (const totalEpisodes of [2, null]) {
    assert.equal((await req('/305', 'PUT', { totalEpisodes })).status, 200)
    const manual = track(await snapshot(), 305)
    assert.equal(manual.totalEpisodes, totalEpisodes)
    assert.equal(manual.episodeLayout, undefined)
    const sync = await (await req('/sync')).json()
    for (const row of sync.data) delete row.extra.episodeTotalMode
    assert.equal((await req('/sync', 'POST', { baseRev: sync.rev, data: sync.data })).status, 200)
    assert.equal(track(await snapshot(), 305).totalEpisodes, totalEpisodes)
  }
  await req('/305', 'PUT', { totalEpisodes: 4 })
  assert.equal(track(await snapshot(), 305).episodeTotalManual, true)
  // 模拟上版已记到 SP 的旧记录；仅浏览、提交未变化的可见进度，都不得把 26 写回 25
  await req('/11577', 'PUT', { episode: 26 })
  console.log('PASS 新加番、播放器记进度、手填正篇数及清空、桌面整包往返')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const runner = fileURLToPath(new URL('./track-specials-browser.cjs', import.meta.url))
  const child = spawn(createRequire(import.meta.url)('electron'), [runner, f.browserOrigin, profile], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGTERM'), 65_000)
  const exit = await new Promise<number | null>((res, rej) => { child.once('error', rej); child.once('exit', res) }).finally(() => clearTimeout(timer))
  assert.equal(exit, 0, 'TRACK_SPECIALS_BROWSER_EXIT')
  const saved = await snapshot(), final = track(saved, id)
  assert.deepEqual([final.episode,final.totalEpisodes,final.status,final.goodEpisodes], [26,26,'done',[25,26]])
  assert.deepEqual(track(saved, 304).goodEpisodes, [3], '正篇两集之后的 SP 1 落在手帐第三格，不覆盖第一集')
  assert.equal(f.metrics.externalRequests, 0)
  console.log('PASS 数据库回读：卡片为 25/25，保存的历史位置仍为 26，标记 [25,26]；新增外部请求 0')
} finally {
  await f.close()
  rmSync(profile, { recursive: true, force: true })
}

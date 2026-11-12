import assert from 'node:assert/strict'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
process.env.AGENT_UI_WATCH = '1'
const f = await createAgentUiFixture()
const db = f.db
const author = f.createUser('public_author')
db.prepare('UPDATE users SET tracks_public=1 WHERE id=?').run(author)
const add = db.prepare('INSERT INTO tracks(user_id,bgm_id,title,title_cn,status,episode,total_episodes,cover,score,user_tags,extra,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
for (const [id, title] of [[101, '葬送的芙莉莲'], [110, '夹具里的另一部番'], [-1, '自定义作品'], [120, '非动画书籍']] as const) {
  add.run(author, id, title, title, 'done', 28, 28, `/api/tracks/${id}/cover-file`, 9, '["作者私人偏好"]', JSON.stringify({ subjectType: id === 120 ? 'manga' : 'anime', favorite: 6, goodEpisodes: [20], goodEpisodeNotes: { 20: '不能复制的个人笔记' } }), Date.now())
}
db.prepare("INSERT INTO review_contents(user_id,bgm_id,mode,body,spoiler,published,published_at) VALUES(?,101,'recommend','合成推荐：旅途中的细节值得一看','none',1,?)").run(author, Date.now())
// 元数据补全只回合成响应，所有未列入的请求继续由既有夹具拒绝
const blockedFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === 'api.bgm.tv' && /^\/v0\/subjects\/(101|102|103|104|110)$/.test(url.pathname)) return new Response(JSON.stringify({ name: '合成作品', name_cn: '合成作品', date: '2023-09-29', images: {}, tags: [], infobox: [], rating: { score: 8 }, total_episodes: 28 }), { headers: { 'Content-Type': 'application/json' } })
  return blockedFetch(input, init)
}
const cookieFor = async (owner: string): Promise<string> => (await f.originalFetch(f.origin + '/__agent-test/login/' + owner, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]
const source = { kind: 'profile', username: 'public_author' }
const read = async (id: number, kind = 'reviews') => f.originalFetch(`${f.origin}/api/community/action/${id}?kind=${kind}${kind === 'profile' ? '&username=public_author' : ''}`)
const save = async (id: number, cookie: string, owner: number, from: object = source) => f.originalFetch(`${f.origin}/api/tracks/${id}`, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json', Origin: f.origin }, body: JSON.stringify({ communitySource: from, expectedOwner: owner, status: 'done', episode: 28, userTags: ['不应复制'], cover: '/api/community/public_author/101/cover-file', goodEpisodeNotes: { 20: '不应复制' } }) })
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ browserUrl: f.browserOrigin, dataDir: process.env.DATA_DIR, syntheticAuthor: 'public_author', fixtureOnly: true }))
  for (const sig of ['SIGTERM','SIGINT'] as const) process.once(sig, () => { void f.close().then(() => process.exit(0)) })
} else {
 try {
  add.run(author, 121, '', '', 'plan', 0, 0, '', 0, '[]', '{}', Date.now())
  assert.equal((await read(121,'profile')).status,404,'EMPTY_IDENTITY_MUST_NOT_SILENTLY_DROP_WATCH')
  const publicRead = await read(101)
  assert.equal(publicRead.status, 200, 'PUBLIC_ACTION_IDENTITY_REQUIRED')
  const identity = await publicRead.json() as Record<string, unknown>
  assert.deepEqual(Object.keys(identity).sort(), ['airDate','cover','episodes','id','name','name_cn','score','url'].sort())
  assert.equal(identity.id, 101);assert.equal(identity.episodes, 0);assert.equal(identity.score, 0);assert.equal(identity.cover, '')
  assert.equal((await read(110)).status,404,'UNPUBLISHED_REVIEW_MUST_NOT_ENABLE_ACTION')
  for(const id of [-1,120,999]) assert.equal((await read(id,'profile')).status,404,'ONLY_PUBLIC_POSITIVE_ANIME')
  const alice = await cookieFor('alice'), bob = await cookieFor('bob')
  const before = db.prepare('SELECT * FROM tracks ORDER BY user_id,bgm_id').all()
  const rev = () => (db.prepare('SELECT tracks_rev AS rev FROM users WHERE id=?').get(f.alice) as {rev:number}).rev
  const beforeRev=rev()
  const existing = await save(101,alice,f.alice)
  assert.equal(existing.status,200)
  assert.equal((await existing.json() as {episode:number}).episode,7,'MUST_PRESERVE_OWN_PROGRESS')
  assert.equal(rev(),beforeRev,'EXISTING_MUST_NOT_WRITE')
  assert.deepEqual(db.prepare('SELECT * FROM tracks ORDER BY user_id,bgm_id').all(),before,'EXISTING_AND_AUTHOR_UNCHANGED')
  const fresh=await save(110,alice,f.alice);assert.equal(fresh.status,200)
  const track=await fresh.json() as {status:string;episode:number;cover:string;userTags:string[];goodEpisodeNotes:object}
  assert.equal(track.status,'plan');assert.equal(track.episode,0);assert.equal(track.cover,'');assert.deepEqual(track.userTags,[]);assert.deepEqual(track.goodEpisodeNotes,{})
  assert.equal(rev(),beforeRev+1)
  await save(110,alice,f.alice);assert.equal(rev(),beforeRev+1,'DUPLICATE_SAVE_MUST_BE_NOOP')
  assert.equal((await save(110,bob,f.alice)).status,409,'OWNER_SWITCH_MUST_REJECT')
  assert.equal((await save(110,'',f.alice)).status,401)
  console.log('PASS public identity, positive anime, explicit plan/0, no copied fields, existing progress/revision, duplicate and owner guards')
  db.prepare('UPDATE users SET tracks_public=0 WHERE id=?').run(author)
  assert.equal((await read(101)).status,404,'PRIVATE_AUTHOR_MUST_HIDE_ACTION')
  assert.equal((await save(110,alice,f.alice)).status,404,'WITHDRAWN_PROFILE_MUST_REJECT_SAVE')
  db.prepare('UPDATE users SET tracks_public=1 WHERE id=?').run(author)
  db.prepare('UPDATE review_contents SET published=0 WHERE user_id=?').run(author)
  assert.equal((await read(101)).status,404,'WITHDRAWN_REVIEW_MUST_HIDE_ACTION')
  assert.equal((await save(101,alice,f.alice,{kind:'reviews'})).status,404)
  assert.equal((await read(101,'profile')).status,200)
  assert.equal(f.metrics.externalRequests,0);assert.equal(f.metrics.modelCalls,0)
  console.log('PASS public withdrawal, review withdrawal, source separation, zero external/model requests')
  console.log('COMMUNITY_ACTIONS_COMPLETE')
 } finally { await f.close() }
}

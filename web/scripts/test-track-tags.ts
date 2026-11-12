import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentUiFixture } from './agent-ui-fixture'

process.env.NODE_ENV = 'test'
process.env.AGENT_UI_FIXTURE = '1'
const f = await createAgentUiFixture()
f.db.prepare('DELETE FROM tracks').run()
const insert = f.db.prepare('INSERT INTO tracks(user_id,bgm_id,title,title_cn,status,episode,total_episodes,user_tags,bgm_tags,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
for (const [id, title, tags] of [[-11, '候补手帐一号', []], [-12, '候补手帐二号', []], [-13, '候补手帐三号', []], [-14, '原有计划组', ['周末再看', '接着看']]] as const) insert.run(f.alice,id,title,title,'plan',0,12,JSON.stringify(tags),'["公共题材"]',Date.now())
insert.run(f.bob,-21,'另一账号','另一账号','plan',0,12,'["另一个账号的标签"]','[]',Date.now())
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ browserUrl: f.browserOrigin + '/__agent-test/login/alice', dataDir: process.env.DATA_DIR, fixtureOnly: true }))
  for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal, () => { void f.close().then(() => process.exit(0)) })
} else {
 const profile = mkdtempSync(join(tmpdir(),'track-tags-browser-'))
 try {
  const env = { ...process.env };delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(createRequire(import.meta.url)('electron') as string,[fileURLToPath(new URL('./track-tags-browser.cjs',import.meta.url)),f.browserOrigin,profile],{env,stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',data=>{output+=String(data);process.stdout.write(data)});child.stderr.on('data',data=>process.stderr.write(data))
  const timer=setTimeout(()=>child.kill('SIGTERM'),90_000)
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)}).finally(()=>clearTimeout(timer))
  assert.equal(code,0,'TRACK_TAGS_BROWSER_EXIT');assert(output.includes('TRACK_TAGS_COMPLETE'))
  const tags=(id:number)=>JSON.parse((f.db.prepare('SELECT user_tags FROM tracks WHERE user_id=? AND bgm_id=?').get(f.alice,id) as {user_tags:string}).user_tags)
  assert.deepEqual(tags(-11),['周末再看','新计划']);assert.deepEqual(tags(-12),['周末再看','接着看']);assert.deepEqual(tags(-13),['周末再看','失焦保存']);assert.deepEqual(tags(-14),['周末再看','接着看'])
  assert.equal(f.metrics.externalRequests,0);assert.equal(f.metrics.modelCalls,0)
  console.log('PASS exact persisted tags; source labels unchanged; zero external/model requests')
 } finally {await f.close();rmSync(profile,{recursive:true,force:true})}
}

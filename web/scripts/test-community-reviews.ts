import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AnimeReviewsResult } from '../src/api'

Object.assign(globalThis, { React })
const directory = mkdtempSync(join(tmpdir(), 'community-review-test-'))
process.env.DATA_DIR = directory
const root = resolve(process.env.TEST_PROJECT_ROOT || '.')
const from = (file: string) => import(pathToFileURL(join(root, file)).href)
const { db } = await from('server/db.ts')
let failures = 0
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`) }
}
try {
  const { default: community } = await from('server/community.ts')
  const user = db.prepare("INSERT INTO users(username,pass_hash,created_at,tracks_public) VALUES('fixture','unused','2026-09-12',1)").run().lastInsertRowid
  db.prepare("INSERT INTO tracks(user_id,bgm_id,title,title_cn,status,episode,total_episodes,score,extra,updated_at) VALUES(?,101,'Fixture','测试番','done',12,12,4.1,'{}','2026-09-12')").run(user)
  db.prepare("INSERT INTO review_contents(user_id,bgm_id,mode,body,published) VALUES(?,101,'review','测试点评',1)").run(user)
  const read = async () => {
    const response = await community.request('http://localhost/reviews/101')
    assert.equal(response.status, 200)
    return await response.json() as AnimeReviewsResult
  }
  await check('API 保留个人零分，BGM 分独立', async () => {
    const data = await read()
    assert.equal(data.review[0].score, 0)
    assert.equal(data.review[0].bgmScore, 4.1)
  })
  await check('API 爱心、鉴赏神回、备注折算 6.3 分', async () => {
    db.prepare('UPDATE tracks SET extra=? WHERE user_id=?').run(JSON.stringify({favorite:6,goodEpisodes:[1],goodEpisodeNotes:{1:'喜欢'}}),user)
    assert.equal((await read()).review[0].score, 6.3)
  })
  await check('API 私密账号不公开文章', async () => {
    db.prepare('UPDATE users SET tracks_public=0 WHERE id=?').run(user)
    assert.equal((await community.request('http://localhost/reviews/101')).status,404)
    db.prepare('UPDATE users SET tracks_public=1 WHERE id=?').run(user)
  })
  const { AnimeReviewsView } = await from('src/CommunityPage.tsx')
  const data = await read()
  for (const [reviews, recommends, expected] of [[1,0,'点评正文'],[0,1,'推荐正文'],[1,1,'点评正文'],[0,0,'这一栏还没有人写']] as const) {
    await check(`首屏默认标签 ${reviews}/${recommends}`, () => {
      const entry = {...data.review[0],score:0}
      const html = renderToStaticMarkup(createElement(AnimeReviewsView,{loading:false,error:null,data:{...data,review:reviews?[{...entry,body:'点评正文'}]:[],recommend:recommends?[{...entry,body:'推荐正文'}]:[]}}))
      assert.ok(html.includes(expected), html)
      if (reviews || recommends) assert.match(html,/我的评分 0 \/ 10/)
    })
  }
  const texts: string[] = []
  const context = new Proxy({measureText:(text:string)=>({width:text.length*15}),fillText:(text:string)=>texts.push(text)}, {get(target,key){return Reflect.get(target,key) ?? (()=>{})}})
  Object.assign(globalThis, {
    document:{fonts:{load:async()=>[],ready:Promise.resolve()},createElement:()=>({getContext:()=>context,toBlob:(done:(blob:Blob)=>void)=>done(new Blob(['canvas-command-test']))})},
    Image:class { onerror?:()=>void; set src(_:string){queueMicrotask(()=>this.onerror?.())} },
  })
  const { renderPoster } = await from('src/reviews/poster.ts')
  for (const score of [0,6.3,undefined]) {
    await check(`Canvas 绘制评分 ${score ?? '缺省'}`,async()=>{
      texts.length=0
      await renderPoster({cover:'',titleCn:'测试番',mode:'review',body:'测试点评',spoiler:'none',userScore:score,bgmScore:4.1,qrUrl:'https://example.com',username:'fixture'})
      const compact=texts.map(text=>text.replace(/\s/g,''))
      assert.ok(compact.some(text=>text.includes(score===undefined?'BGMSCORE':'MYSCORE')))
      assert.ok(texts.includes(String(score ?? 4.1)))
      if(score!==undefined)assert.ok(texts.includes('BGM 综合 4.1'))
    })
  }
} finally {
  db.close()
  rmSync(directory,{recursive:true,force:true})
}
console.log(`RESULT failures=${failures}`)
process.exitCode=failures?1:0

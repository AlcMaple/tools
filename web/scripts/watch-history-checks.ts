import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WATCH_EPISODES_KEY, recentWatchEpisode, rememberWatchEpisode, type WatchEpisodeContext } from '../shared/watch-episode-history'
import { PLAY_PAGE } from '../server/player/page'

export function checkWatchHistory(): void {
  let checks = 0
  const check = (name: string, fn: () => void): void => { fn(); console.log(`PASS WH${++checks} ${name}`) }
  const now = 1_800_000_000_000
  const values = new Map<string, string>()
  const storage = { getItem: (key: string): string | null => values.get(key) ?? null, setItem: (key: string, value: string): void => { values.set(key, value) } }
  const context = { ownerId: 1, bgmId: 101, trackUpdatedAt: 1000 }
  const track = { bgmId: 101, updatedAt: 1000, totalEpisodes: 28 }
  check('no history keeps the normal entry', () => assert.equal(recentWatchEpisode(storage,1,track,now),null))
  rememberWatchEpisode(storage,context,2,now)
  check('actual episode remembered independently of the record', () => assert.equal(recentWatchEpisode(storage,1,track,now),2))
  check('other owner is isolated', () => assert.equal(recentWatchEpisode(storage,2,track,now),null,'OWNER_HISTORY_MUST_BE_ISOLATED'))
  check('other anime is isolated', () => assert.equal(recentWatchEpisode(storage,1,{...track,bgmId:102},now),null))
  check('explicit record edit overrides history', () => assert.equal(recentWatchEpisode(storage,1,{...track,updatedAt:1001},now),null,'EDITED_RECORD_MUST_OVERRIDE_HISTORY'))
  check('unknown viewer and untracked previews have no history', () => { assert.equal(recentWatchEpisode(storage,null,track,now),null); assert.equal(recentWatchEpisode(storage,1,{...track,updatedAt:0},now),null) })
  check('episode outside the known total is ignored', () => assert.equal(recentWatchEpisode(storage,1,{...track,totalEpisodes:1},now),null))
  check('history expires at thirty days', () => assert.equal(recentWatchEpisode(storage,1,track,now+30*86400_000),null))
  check('malformed and non-finite input falls back', () => {
    for (const raw of ['bad','{}','[null]','[{}]','[{"ownerId":1,"bgmId":101,"trackUpdatedAt":1000,"episode":1e309,"watchedAt":1800000000000}]',JSON.stringify([{...context,episode:2,watchedAt:now+120_000}]),JSON.stringify([{...context,episode:-1,watchedAt:now}]),'x'.repeat(65537)]) {
      storage.setItem(WATCH_EPISODES_KEY,raw); assert.equal(recentWatchEpisode(storage,1,track,now),null)
    }
  })
  check('invalid writer context does not create history', () => {
    values.clear(); for (const bad of [null,{...context,ownerId:0},{...context,bgmId:-1},{...context,trackUpdatedAt:0}]) rememberWatchEpisode(storage,bad,2,now)
    assert.equal(storage.getItem(WATCH_EPISODES_KEY),null)
  })
  check('replacement and bounded storage', () => {
    values.clear(); for(let i=0;i<120;i++)rememberWatchEpisode(storage,{...context,bgmId:i+1},2,now+i)
    assert.equal(JSON.parse(storage.getItem(WATCH_EPISODES_KEY)!).length,100)
    rememberWatchEpisode(storage,{...context,bgmId:120},3,now+121)
    assert.equal(JSON.parse(storage.getItem(WATCH_EPISODES_KEY)!).length,100)
    assert.equal(recentWatchEpisode(storage,1,{...track,bgmId:120},now+122),3)
  })
  check('storage failures remain observable to the caller', () => assert.throws(()=>rememberWatchEpisode({getItem:()=>null,setItem:()=>{throw new Error('quota')}},context,2,now),/quota/))
  const rememberAt = PLAY_PAGE.indexOf('window.MapleWatchHistory')
  const begin = PLAY_PAGE.lastIndexOf('v.addEventListener(',rememberAt)
  const end = PLAY_PAGE.indexOf('\n    })',rememberAt)+7
  assert(begin>=0 && end>begin,'WATCH_HISTORY_LISTENER_MISSING')
  const listener = PLAY_PAGE.slice(begin,end)
  const callbacks = new Map<string, () => void>()
  const video = { currentTime:0,paused:true,ended:false,seeking:false,addEventListener:(name:string,fn:()=>void):void=>{callbacks.set(name,fn)} }
  const instance = {video}
  let writes = 0
  const scope = {v:video,art:instance,me:instance,ARGS:{watchContext:context as WatchEpisodeContext|null},ep:2,window:{localStorage:storage,MapleWatchHistory:{rememberWatchEpisode:()=>{writes++}}},slog:()=>{}}
  runInNewContext(listener,scope)
  check('src/load and canplay stay paused without recording', () => { callbacks.get('loadedmetadata')?.();callbacks.get('canplay')?.();assert.equal(writes,0,'UNPLAYED_EPISODE_MUST_NOT_BE_RECORDED');assert(video.paused) })
  check('first actual playing records the episode once', () => {video.paused=false;callbacks.get('playing')?.();assert.equal(writes,1)})
  check('destroyed player cannot overwrite history', () => {scope.art={video:{...video}};callbacks.get('playing')?.();assert.equal(writes,1,'STALE_PLAYER_MUST_NOT_RECORD_EPISODE');scope.art=instance})
  check('untracked playback does not create a tracking record', () => {scope.ARGS.watchContext=null;callbacks.get('playing')?.();assert.equal(writes,1)})
  const watchdog = PLAY_PAGE.match(/function startStallWatch\(v\)\{[\s\S]*?\n  \}/)?.[0]
  assert(watchdog)
  let clock=0, tick=():void=>{}, buffering=false
  const timerScope={art:instance,stallTimer:null,stallSince:0,lastT:-1,lastTAt:0,stallReported:false,bufOwned:false,performance:{now:()=>clock},setInterval:(fn:()=>void)=>{tick=fn;return 1},clearInterval:()=>{},governBg:()=>{},setBuffering:(_v:unknown,on:boolean)=>{buffering=on},watchSlow:()=>{},slog:()=>{},qosStall:()=>{},snapshot:()=>''}
  const start = runInNewContext(watchdog+';startStallWatch',timerScope) as (value:typeof video)=>void
  check('fixed first-play/rebuffer event sequence', () => {
    video.currentTime=0;video.paused=true;start(video);tick();clock=500;tick();assert.equal(buffering,false)
    video.paused=false;video.currentTime=.2;clock=600;tick();assert.equal(buffering,false,'first playing must not flash buffering')
    clock=2200;tick();assert.equal(buffering,true,'later waiting can show buffering')
    video.seeking=true;video.currentTime=30;clock=2300;tick();clock=3900;tick();assert.equal(buffering,true,'later seek stall can show buffering')
    video.seeking=false;video.paused=true;clock=4000;tick();assert.equal(buffering,false)
  })
  check('all browser-recovery keys are owner scoped', () => {assert(PLAY_PAGE.includes("id: 'user:' + ARGS.ownerId"));assert(PLAY_PAGE.includes("'player:resume:user:' + ARGS.ownerId"))})
  console.log(`WATCH_EPISODE_GUARDS=${checks}`)
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) checkWatchHistory()

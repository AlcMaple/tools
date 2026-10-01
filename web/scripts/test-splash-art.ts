import assert from 'node:assert/strict'
import { cachedSplashArt, warmSplashArt } from '../src/splash-art'
let seen: string | null = null, cached = false, imageCount = 0, decodeFails = false
let release: (() => void) | undefined
const modes: RequestInit[] = []
Object.defineProperty(globalThis,'window',{value:{matchMedia:()=>({matches:false})},configurable:true})
Object.defineProperty(globalThis,'sessionStorage',{value:{getItem:()=>seen,setItem:(_key:string,value:string)=>{seen=value}},configurable:true})
Object.defineProperty(globalThis,'Image',{value:class {
  src='';fetchPriority='';constructor(){imageCount++}
  decode(){return decodeFails?Promise.reject(new Error('invalid image')):new Promise<void>(resolve=>{release=resolve})}
},configurable:true})
globalThis.fetch=async (_url,init)=>{modes.push(init??{});return cached?new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/webp'}}):new Response(null,{status:504})}
assert.equal(await cachedSplashArt(),null)
assert.equal(imageCount,0);assert.equal(seen,null)
assert.equal(modes[0].cache,'only-if-cached');assert.equal(modes[0].mode,'same-origin');assert(modes[0].signal instanceof AbortSignal)
warmSplashArt();warmSplashArt();assert.equal(imageCount,1)
cached=true
let settled=false
const warm=cachedSplashArt().then(value=>{settled=true;return value})
await new Promise(r=>setTimeout(r,0));assert.equal(settled,false);assert.equal(seen,null)
release!();const url=await warm;assert(url?.startsWith('blob:'));assert.equal(seen,'1');URL.revokeObjectURL(url)
assert.equal(await cachedSplashArt(),null)
seen=null;decodeFails=true;assert.equal(await cachedSplashArt(),null);assert.equal(seen,null)
cached=false;assert.equal(await cachedSplashArt(),null)
console.log('PASS: cache miss skips immediately, background download once, warm cache decodes before mount, failed/evicted cache skips, session marked only after success')

seen=null;decodeFails=false
let finishFetch: ((response: Response) => void) | undefined
let signal: AbortSignal | null | undefined
globalThis.fetch=(_url,init)=>{signal=init?.signal;return new Promise(resolve=>{finishFetch=resolve})}
const before=imageCount
assert.equal(await cachedSplashArt(),null);assert.equal(signal?.aborted,true)
finishFetch!(new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/webp'}}))
await new Promise(r=>setTimeout(r,0));assert.equal(imageCount,before);assert.equal(seen,null)

let finishBody: ((blob: Blob) => void) | undefined
globalThis.fetch=async ()=>{
 const response=new Response(null,{headers:{'Content-Type':'image/webp'}})
 response.blob=()=>new Promise(resolve=>{finishBody=resolve})
 return response
}
assert.equal(await cachedSplashArt(),null)
finishBody!(new Blob([new Uint8Array([1])]))
await new Promise(r=>setTimeout(r,0));assert.equal(imageCount,before);assert.equal(seen,null)

globalThis.fetch=async ()=>new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/webp'}})
assert.equal(await cachedSplashArt(),null)
release!();await new Promise(r=>setTimeout(r,0));assert.equal(seen,null)
console.log('PASS: stuck cache fetch, body read and decode all release startup; late results cannot play or mark splash seen')

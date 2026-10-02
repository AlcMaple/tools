import assert from 'node:assert/strict'
import { cachedSplashArt, warmSplashArt } from '../src/splash-art'
let seen: string | null = null, imageCount = 0
let decode: () => Promise<void> = () => Promise.resolve()
const beacons: string[] = []
Object.defineProperty(globalThis,'window',{value:{matchMedia:()=>({matches:false})},configurable:true})
Object.defineProperty(globalThis,'sessionStorage',{value:{getItem:()=>seen,setItem:(_key:string,value:string)=>{seen=value}},configurable:true})
Object.defineProperty(globalThis,'navigator',{value:{sendBeacon:(_url:string,blob:Blob)=>{void blob.text().then(t=>beacons.push(t));return true}},configurable:true})
Object.defineProperty(globalThis,'Image',{value:class {
  src='';fetchPriority='';constructor(){imageCount++}
  decode(){return decode()}
},configurable:true})

assert.equal(await cachedSplashArt(),'/assets/sagiri-full.webp');assert.equal(seen,'1')
assert.equal(await cachedSplashArt(),null)
console.log('PASS: cached art plays once per session')

seen=null
let release: (() => void) | undefined
decode=()=>new Promise<void>(r=>{release=r})
assert.equal(await cachedSplashArt(),null)
release!();await new Promise(r=>setTimeout(r,10))
assert.equal(seen,null);assert(beacons.some(b=>b.includes('late')))
const before=imageCount;warmSplashArt();assert.equal(imageCount,before)
console.log('PASS: slow load skips without late replay, reuses the same download, reports timing')

decode=()=>Promise.reject(new Error('broken'))
assert.equal(await cachedSplashArt(),null);assert.equal(seen,null)
await new Promise(r=>setTimeout(r,10));assert(beacons.some(b=>b.includes('decode failed')))
console.log('PASS: decode failure skips and reports')

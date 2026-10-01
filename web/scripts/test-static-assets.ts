import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { serveStatic } from '@hono/node-server/serve-static'
import ts from 'typescript'

// 执行实际生产静态路由，避开账号库初始化和监听端口。
const source = readFileSync(new URL('../server/node.ts', import.meta.url), 'utf8')
const routes = source.slice(source.indexOf("app.use('/*'"), source.indexOf('const port ='))
const compiled = ts.transpileModule(routes, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const app = new Hono()
app.get('/api/fixture', c => c.text('unchanged '.repeat(1000)))
new Function('app', 'compress', 'serveStatic', compiled)(app, compress, serveStatic)
const html = readFileSync('dist/index.html', 'utf8')
const paths = [...html.matchAll(/(?:src|href)="(\/assets\/index-[^"]+\.(?:js|css))"/g)].map(m => m[1])
assert.equal(paths.length, 2)
for (const path of paths) {
  const original = readFileSync('dist' + path)
  const plain = await app.request(path)
  assert.equal(plain.headers.get('Content-Encoding'), null)
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), original)
  const compressed = await app.request(path, { headers: { 'Accept-Encoding': 'gzip' } })
  assert.equal(compressed.status, 200)
  assert.equal(compressed.headers.get('Content-Encoding'), 'gzip')
  assert.match(compressed.headers.get('Vary')!, /Accept-Encoding/i)
  assert.match(compressed.headers.get('Cache-Control')!, /immutable/)
  const bytes = Buffer.from(await compressed.arrayBuffer())
  assert.deepEqual(gunzipSync(bytes), original)
  assert(bytes.length < original.length * 0.5)
  console.log(`${path}: ${original.length} -> ${bytes.length} bytes (${(100-bytes.length/original.length*100).toFixed(1)}% less)`)
  const range = await app.request(path, { headers: { 'Accept-Encoding': 'gzip', Range: 'bytes=0-99' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('Content-Encoding'), null)
  assert.equal(range.headers.get('Content-Range'), `bytes 0-99/${original.length}`)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), original.subarray(0,100))
  const head = await app.request(path, { method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' } })
  assert.equal((await head.arrayBuffer()).byteLength, 0)
}
const api = await app.request('/api/fixture', { headers: { 'Accept-Encoding': 'gzip' } })
assert.equal(api.headers.get('Content-Encoding'), null)
const stale = await app.request('/assets/index-obsolete123.js', { headers: { 'Accept-Encoding': 'gzip' } })
assert.equal(stale.headers.get('Cache-Control'), 'no-store')
assert.equal((await app.request('/assets/nonexistent.css')).status, 404)
console.log('PASS: actual production routes, gzip round-trip, cache headers, Range, HEAD, stale entry and API isolation')

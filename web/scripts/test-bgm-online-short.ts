import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'bgm-online-short-'))
process.env.NODE_ENV = 'production'
process.env.DATA_DIR = directory
process.env.AUTH_SECRET = randomBytes(32).toString('hex')
delete process.env.MAPLETOOLS_ENV_FILE

const originalFetch = globalThis.fetch
const requests: { url: string; method?: string; body: unknown }[] = []
let reply = Response.json({ data: [{ id: 370005, name: 'K', date: '2012-10-04', rating: { score: 7 } }] })
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) })
  return reply.clone()
}
try {
  const { db } = await import('../server/db')
  try {
    const { searchOnline } = await import('../server/bgm/search-online')
    const { verifySearchAdditionToken } = await import('../server/bgm/search-additions')
    const now = Date.now()
    assert.deepEqual(await searchOnline('  ', now), { hits: [] })
    assert.equal(requests.length, 0)

    const result = await searchOnline(' k ', now)
    assert.deepEqual(requests, [{
      url: 'https://api.bgm.tv/v0/search/subjects?limit=10',
      method: 'POST',
      body: { keyword: 'k', sort: 'match', filter: { type: [2] } },
    }], 'one-letter query must reach the anime search endpoint exactly once')
    assert.equal(result.error, undefined)
    assert.deepEqual(result.hits.map(hit => hit.name), ['K'])
    const hit = result.hits[0]
    assert('searchAdditionToken' in hit && verifySearchAdditionToken(hit.searchAdditionToken, hit.bgmId, now))
    assert.deepEqual(await searchOnline('K', now + 1), result)
    assert.equal(requests.length, 1, 'case variants reuse a cached reply')

    const limited = await searchOnline('火', now + 2)
    assert.match(limited.error ?? '', /等一下/)
    assert.equal(requests.length, 1)
    reply = Response.json({ data: [] })
    assert.deepEqual(await searchOnline('火', now + 2000), { hits: [] })
    assert.deepEqual(await searchOnline('火', now + 2001), { hits: [] })
    assert.equal(requests.length, 2, 'a genuine empty result is cached')

    reply = new Response(null, { status: 429 })
    const upstreamLimited = await searchOnline('X', now + 4000)
    assert.deepEqual(upstreamLimited.hits, [])
    assert.match(upstreamLimited.error ?? '', /Bangumi.*挤/)
    assert.equal(requests.length, 3, 'an upstream 429 must not retry')
    console.log('PASS online single-character search: anime-only POST, signed hit, cache, empty query/result and rate limits (3 mocked requests, 0 external)')
  } finally {
    db.close()
  }
} finally {
  globalThis.fetch = originalFetch
  rmSync(directory, { recursive: true, force: true })
}

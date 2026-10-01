import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { execFileSync } from 'node:child_process'

const current = readFileSync(new URL('../public/white-screen-probe.js', import.meta.url), 'utf8')
function browser(source = current, href = 'https://example.test/?invite=abc#/tracks') {
  let now = 0, serial = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  const root = { innerHTML: '', childElementCount: 0 }
  const navigations: string[] = [], reports: string[] = []
  const location = { href, origin: 'https://example.test', pathname: '/', replace: (url: string) => navigations.push(url) }
  const history = { state: { keep: true }, replaceState(state: unknown, _title: string, url: string) { assert.deepEqual(state, this.state); location.href = new URL(url, location.href).href } }
  const navigator = { onLine: true, userAgent: 'fixture', sendBeacon: () => { reports.push('sent'); return true } }
  const addEventListener = (name: string, fn: (event: unknown) => void) => handlers.set(name, [...handlers.get(name) ?? [], fn])
  const document = { readyState: 'loading', visibilityState: 'visible', documentElement: { classList: { add() {}, remove() {} } },
    getElementById: (id: string) => id === 'root' ? root : id === 'boot-placeholder' && root.innerHTML.includes('boot-placeholder') ? {} : null, addEventListener }
  const window: { __mtAppReady?: () => void; addEventListener: typeof addEventListener; setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (id: number) => void } = {
    addEventListener,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { at: now + ms, run: fn }); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  const env = { window, document, location, history, navigator, URL, Blob, Date: { now: () => now }, console: { error() {} } }
  runInNewContext(source, env)
  return { root, document, window, navigator, navigations, reports, location,
    run(source: string) { runInNewContext(source, env) },
    event(name: string, event: unknown = {}) { handlers.get(name)?.forEach(fn => fn(event)) },
    mount() { root.innerHTML = '<main>calendar</main>'; root.childElementCount = 1; document.readyState = 'complete'; window.__mtAppReady?.() },
    advance(ms: number) { const end = now + ms; for (;;) { const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; timers.delete(next[0]); next[1].run() }; now = end },
  }
}
for (const [commit, deadline] of [['daf8b75f', 4000], ['0615f5d4', 46000]] as const) {
  const old = execFileSync('git', ['show', `${commit}:web/public/white-screen-probe.js`], { encoding: 'utf8' })
  const before = browser(old)
  before.advance(deadline)
  assert.equal(before.navigations.length, 1, `${commit} 把首次慢加载重载了`)
}
for (const state of ['loading', 'interactive', 'complete']) {
  const first = browser()
  first.document.readyState = state
  first.root.innerHTML = '<div id="boot-placeholder">加载中…</div>'
  first.event('pageshow', { persisted: false })
  first.document.visibilityState = 'hidden'; first.event('visibilitychange')
  first.advance(180000)
  first.document.visibilityState = 'visible'; first.event('visibilitychange'); first.advance(180000)
  assert.equal(first.navigations.length, 0, `首次加载 ${state} 不能重载`)
  assert.equal(first.reports.length, 0)
  first.mount()
}
const healthy = browser()
healthy.mount(); healthy.document.visibilityState = 'hidden'; healthy.event('visibilitychange'); healthy.advance(3600000)
healthy.document.visibilityState = 'visible'; healthy.event('visibilitychange'); healthy.event('pageshow', { persisted: true }); healthy.advance(5000)
assert.equal(healthy.navigations.length, 0, '健康后台页面不打断播放或丢掉表单')

const empty = browser()
empty.mount(); empty.root.innerHTML = ''; empty.document.visibilityState = 'hidden'; empty.event('visibilitychange')
empty.advance(3600000); empty.document.visibilityState = 'visible'; empty.event('visibilitychange')
empty.event('pageshow', { persisted: true }); empty.event('online'); empty.advance(5000)
assert.equal(empty.navigations.length, 0, '不自行设计按 DOM 空白刷新页面的行为')

for (const marker of ['mt_recover', 'mt_stale']) {
  const guarded = browser(current, `https://example.test/?invite=abc&${marker}=old#/tracks`)
  guarded.document.readyState = 'complete'; guarded.event('pageshow', { persisted: true }); guarded.advance(500)
  assert.equal(guarded.navigations.length, 0)
  guarded.mount(); assert.equal(guarded.location.href, 'https://example.test/?invite=abc#/tracks')
}
const nodeSource = readFileSync(new URL('../server/node.ts', import.meta.url), 'utf8')
const staleSource = nodeSource.match(/const STALE_ENTRY_RECOVERY = `([\s\S]*?)`/)![1]
const stale = browser(); stale.run(staleSource)
assert.equal(stale.navigations.length, 1, '过期入口仍会自动刷新')
for (const marker of ['mt_recover','mt_stale']) {
  const guarded = browser(current, `https://example.test/?${marker}=old`); guarded.run(staleSource)
  assert.equal(guarded.navigations.length, 0, '两种恢复共用一次预算')
}
const failed = browser()
failed.event('error', { target: { tagName: 'SCRIPT', type: 'module', src: 'https://example.test/assets/index-live.js' } })
failed.advance(120000)
assert.equal(failed.navigations.length, 0, '资源错误状态未知，不自动重试 HTTP 错误')
assert.equal(failed.reports.length, 1)
const stats = browser()
stats.event('error', { target: { tagName: 'SCRIPT', src: 'https://stats.example/script.js' } })
stats.event('unhandledrejection', { reason: new Error('Failed to fetch stats') })
assert.equal(stats.reports.length, 0)
const { default: bootLog } = await import('../server/boot-log')
assert.equal((await bootLog.request('http://localhost/', { method: 'POST', body: '{}' })).status, 400)
assert.equal((await bootLog.request('http://localhost/', { method: 'POST', body: 'x'.repeat(5000) })).status, 413)
assert.equal((await bootLog.request('http://localhost/', { method: 'POST', body: JSON.stringify({ detail: 'fixture resource-error' }) })).status, 204)
console.log('PASS: deployed 4s and previous 45s reload reproduced; first visit, slow load, browser-managed background/BFCache, stale entry and logs')

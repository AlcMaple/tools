import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { Locator } from 'playwright'
import { createAgentUiFixture } from './agent-ui-fixture'
import type { DownloadLink, DownloadResults, ManualDownloads } from '../shared/catalog-downloads'

process.env.AGENT_UI_FIXTURE = '1'
process.env.NODE_ENV = 'test'
const fixture = await createAgentUiFixture()
process.env.FEEDBACK_ADMIN_USER_IDS = String(fixture.alice)
const addTrack = fixture.db.prepare('INSERT INTO tracks(user_id,bgm_id,title,title_cn,episode,total_episodes,created_at,updated_at) VALUES(?,?,?,?,1,3,?,?)')
const stamp = Date.now()
for (const [id, name] of [[7101, '银河之旅'], [-7112, '手动记录']] as const) addTrack.run(fixture.alice, id, name, name, stamp, stamp)
fixture.db.prepare('UPDATE tracks SET cover=?, bgm_tags=?, aliases=?, air_date=?, score=8').run('/fixture.webp', '["TV"]', '["别名"]', '2023-10-01')
const calendarItem = (id: number, title: string) => ({ id, name: title, name_cn: title, url: '', airDate: '2023-07-01', episodes: 3, score: 8, cover: '' })
const today = new Date().getDay() || 7
const week = Array.from({ length: 7 }, (_, i) => ({
  id: i + 1, label: '星期' + '一二三四五六日'[i],
  items: i + 1 === today ? [calendarItem(7110, '周历新番'), calendarItem(7104, '隐藏作品')] : [],
}))
await writeFile(join(process.env.DATA_DIR!, 'calendar-cache.json'), JSON.stringify({ at: Date.now(), data: week }))
const { recordSeason } = await import('../server/bgm/calendar-history')
recordSeason([{ id: 1, label: '星期一', items: [calendarItem(7111, '往期新番'), calendarItem(7104, '隐藏作品')] }], Date.UTC(2023, 6, 6))
const { saveSearchAddition } = await import('../server/bgm/search-additions')
saveSearchAddition({ bgmId: 7113, name: 'Online Subject', nameCn: '在线加番', date: '2023-10-01', score: 0 })
const indexPath = join(process.env.DATA_DIR!, 'bgm_index.db')
function seedIndex(): void {
  const db = new Database(indexPath)
  db.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)')
  db.exec("DROP TABLE IF EXISTS anime; CREATE TABLE anime(bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, summary TEXT, tags TEXT, score REAL, date TEXT, eps INTEGER, nsfw INTEGER)")
  const insert = db.prepare('INSERT INTO anime VALUES(?,?,?,?,?,?,?,?,?,?)')
  for (const [id, title, alias] of [[7101, '银河之旅', '银河旅行'], [7102, '星际旅人', 'Star Voyage'], [7103, '未收录作品', 'No Release'], [7104, '隐藏作品', 'Hidden'], [7105, '银河之旅 第二季', 'Galaxy S02'], [7106, '银河之旅', '1998 Galaxy']] as const) {
    insert.run(id, alias, title, JSON.stringify([alias]), '用于下载入口验收', '["TV"]', 8, id === 7106 ? '1998-04-03' : '2023-10-01', 3, Number(id === 7104))
  }
  db.close()
}
seedIndex()
const calls: URL[] = []
let failure = 0, detailFailure = false
const magnet = (hash: string): string => `magnet:?xt=urn:btih:${hash}`
const row = (n: number, title: string, id?: number) => ({ provider: 'dmhy', providerId: String(n), title, subjectId: id, type: '动画', magnet: magnet(n.toString(16).padStart(40, '0')), href: `https://example.org/release/${n}` })
const bundle = { ...row(1, '[字幕组] 银河之旅 [01-03 Fin]', 7101), magnet: magnet('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') }
const releases = [
  bundle, { ...bundle, magnet: magnet('0'.repeat(40)), provider: 'moe' }, row(2, '[字幕组] 银河之旅 [02][简日]', 7101),
  row(3, '[字幕组] 银河之旅 [01-02 Fin]', 7101), row(4, '银河之旅 TV + 剧场版 + 漫画', 7101),
]
const feedTitle = '[ANi] 銀河之旅 - 02 [1080P][CHT].mp4'
const feed = (title: string, n: number) => `<item><title><![CDATA[${title}]]></title><link>https://resources.ani.rip/2023-10/${n}?d=mp4</link></item>`
globalThis.fetch = async input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  calls.push(url)
  if (url.hostname === 'api.bgm.tv' && url.pathname === '/v0/subjects/7102') return Response.json({ id: 7102, name: 'Star Voyage', name_cn: '星际旅人', date: '2023-10-01', eps: 3 })
  if (url.hostname === 'api.ani.rip') return new Response(`<rss><channel>${feed(feedTitle, 2)}${feed('[ANi] 銀河之旅 第二季 - 02 [1080P].mp4', 9)}</channel></rss>`)
  assert.equal(url.hostname, 'api.animes.garden')
  if (failure || (detailFailure && url.pathname.startsWith('/detail/'))) return Response.json({ code: 'SOURCE_WINDOW', message: '合成来源暂停查询' }, { status: failure || 503, headers: { 'Retry-After': '900' } })
  if (url.pathname.startsWith('/detail/')) {
    const files = [1, 2, 3].map(n => ({ name: `[字幕组] 银河之旅 [01-03]/银河之旅 - 0${n} [1080p].mkv` }))
    return Response.json({ status: 'OK', detail: { files, hasMoreFiles: url.pathname.endsWith('/3'), magnets: [{ name: '会员专用链接', url: 'https://example.org/locked.torrent' }] } })
  }
  const q = url.searchParams
  const second = q.get('page') === '2'
  const items = q.get('subject') === '7101' ? (second ? [row(5, '银河之旅 [01]', 7101)] : releases)
    : q.get('subject') === '104' ? [row(31, '公开原名 S02 - 01', 104), row(32, '未核实的同名发布', 0)]
    : q.getAll('include').includes('周历新番') ? [row(33, '周历新番 - 01 [1080p]')]
    : q.getAll('include').includes('往期新番') ? [row(34, '往期新番 - 01 [1080p]')]
    : q.getAll('include').includes('Online Subject') ? [row(35, 'Online Subject - 01 [1080p]')]
    : q.getAll('include').includes('Star Voyage') ? [
      row(11, '[字幕组] Star Voyage - 01 [1080p]'), row(12, '[组] Star Voyage S02 - 01 [1080p]'),
      row(13, '星际旅人 TV + 剧场版 + 音乐'), row(14, '星际旅人', 999), row(15, '星际旅人 剧场版 - 01'),
      row(16, 'Star Voyage (2019) - 01'), row(17, 'Star Voyage 外传 - 02'),
    ] : []
  return Response.json({ status: 'OK', resources: items, pagination: { complete: second || q.get('subject') !== '7101' } })
}
const get = (id: number, suffix = '', init?: RequestInit) => fixture.originalFetch(`${fixture.origin}/api/catalog/${id}/downloads${suffix}`, init)
const list = async (id: number, source: string): Promise<DownloadResults> => {
  const res = await get(id, '?source=' + source)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  return res.json()
}
const login = async (who: string) => (await fixture.originalFetch(fixture.origin + '/__agent-test/login/' + who, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]
const put = (id: number, data: ManualDownloads, cookie = '', suffix = '') => get(id, suffix, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(data) })
const link: DownloadLink = { id: randomUUID(), title: '简繁字幕整季包', kind: 'file', url: 'https://example.org/season.zip', group: 'season', first: null, last: null, quality: '1080p' }
const empty: ManualDownloads = { revision: '', links: [] }

if (process.argv.includes('--serve')) {
  console.log(`DOWNLOAD_FIXTURE ${fixture.origin}`)
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => { void fixture.close().then(() => process.exit(0)) })
} else if (process.argv.includes('--browser')) {
  const { chromium } = createRequire(import.meta.url)(process.env.DOWNLOAD_BROWSER_MODULE || 'playwright') as typeof import('playwright')
  const browser = await chromium.launch({ executablePath: process.env.DOWNLOAD_CHROME_BIN, headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1180, height: 840 }, permissions: ['clipboard-read', 'clipboard-write'] })
    const payload = Buffer.from('catalog download fixture')
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.hostname === 'resources.ani.rip') return route.fulfill({ status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="episode-02.mp4"' }, body: payload })
      return url.origin === fixture.origin || url.protocol !== 'https:' ? route.continue() : route.abort()
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    const lookups: URL[] = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (/^\/api\/catalog\/\d+\/downloads$/.test(url.pathname)) lookups.push(url)
    })
    const downloadButton = (name: string) => page.getByRole('button', { name: `下载《${name}》的资源`, exact: true }).first()
    async function openFrom(button: Locator, title: string, release: string, id: number, canEdit: boolean, seasonKey?: string): Promise<void> {
      const start = lookups.length
      await button.click()
      const panel = page.locator('dialog.catalog-details[open]')
      await panel.getByRole('heading', { name: title, exact: true }).waitFor()
      await panel.getByText(release, { exact: true }).waitFor()
      await panel.getByText('正在查找下载资源…').waitFor({ state: 'hidden' })
      assert.equal(await panel.getByRole('button', { name: '补充链接' }).count(), Number(canEdit))
      assert.deepEqual(lookups.slice(start).map(u => [u.pathname, u.searchParams.get('source') ?? 'manual', u.searchParams.get('season')]).sort(),
        ['ani', 'garden', 'manual'].map(source => [`/api/catalog/${id}/downloads`, source, seasonKey ?? null]))
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
      assert(await button.evaluate(el => el === document.activeElement), '关闭后焦点应回到触发入口')
    }
    async function withinCard(button: Locator): Promise<void> {
      await button.scrollIntoViewIfNeeded()
      assert(await button.evaluate(el => {
        const card = el.closest('article')!.getBoundingClientRect()
        const rect = el.getBoundingClientRect()
        return rect.left >= card.left && rect.right <= card.right && el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      }), '下载按钮须在卡片内且可点')
    }
    await page.goto(fixture.origin + '/#/anime')
    const title = page.getByRole('button', { name: '查看 银河之旅 的简介', exact: true }).first()
    await title.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '下载资源' }).waitFor()
    assert.equal(lookups.length, 0)
    await dialog.getByRole('button', { name: '下载资源' }).click()
    await dialog.getByRole('heading', { name: '整季合集' }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '补充链接' }).count(), 0)
    const season = dialog.locator('section').filter({ has: page.getByRole('heading', { name: '整季合集' }) })
    assert((await season.getByRole('link', { name: '打开下载器' }).getAttribute('href'))?.startsWith('magnet:?xt='))
    await season.getByRole('button', { name: '复制磁力' }).click()
    assert((await page.evaluate(() => navigator.clipboard.readText())).startsWith('magnet:?xt=urn:btih:'))
    const file = dialog.getByRole('link', { name: '下载文件' })
    if (process.env.DOWNLOAD_SCREENSHOT_DIR) await dialog.screenshot({ path: join(process.env.DOWNLOAD_SCREENSHOT_DIR, 'downloads-desktop.png') })
    const download = page.waitForEvent('download')
    await file.click()
    const result = await download
    assert.equal(result.suggestedFilename(), 'episode-02.mp4')
    assert.deepEqual(await readFile((await result.path())!), payload)
    await dialog.getByRole('button', { name: '更多 AnimeGarden 发布' }).click()
    await dialog.getByText('银河之旅 [01]', { exact: true }).waitFor()
    await dialog.getByLabel('按集筛选').fill('2')
    assert.equal(await dialog.getByText('银河之旅 [01]', { exact: true }).count(), 0)
    await dialog.getByRole('button', { name: '返回简介' }).click()
    await dialog.getByRole('heading', { name: '简介', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '返回列表' }).click()
    assert(await title.evaluate(el => el === document.activeElement))
    await openFrom(downloadButton('银河之旅'), '银河之旅', bundle.title, 7101, false)
    const beforeCalendar = lookups.length
    await page.goto(fixture.origin + '/#/')
    const current = downloadButton('周历新番')
    await withinCard(current)
    assert.equal(lookups.length, beforeCalendar)
    if (process.env.DOWNLOAD_SCREENSHOT_DIR) await current.locator('xpath=ancestor::article').screenshot({ path: join(process.env.DOWNLOAD_SCREENSHOT_DIR, 'entry-calendar-desktop.png') })
    await openFrom(current, '周历新番', '周历新番 - 01 [1080p]', 7110, false)
    await page.setViewportSize({ width: 360, height: 740 })
    await page.getByRole('button', { name: '纵向', exact: true }).click()
    await page.getByRole('textbox', { name: '在本季周历里搜索番名' }).fill('周历新')
    await withinCard(current)
    if (process.env.DOWNLOAD_SCREENSHOT_DIR) await current.locator('xpath=ancestor::article').screenshot({ path: join(process.env.DOWNLOAD_SCREENSHOT_DIR, 'entry-calendar-mobile.png') })
    await openFrom(current, '周历新番', '周历新番 - 01 [1080p]', 7110, false)
    assert.equal(await page.getByRole('textbox', { name: '在本季周历里搜索番名' }).inputValue(), '周历新')
    assert.equal(await page.getByRole('button', { name: '纵向', exact: true }).getAttribute('aria-pressed'), 'true')
    const beforeHistory = lookups.length
    await page.goto(fixture.origin + '/#/history?s=2023-07')
    const archived = downloadButton('往期新番')
    await withinCard(archived)
    assert.equal(lookups.length, beforeHistory)
    await openFrom(archived, '往期新番', '往期新番 - 01 [1080p]', 7111, false, '2023-07')
    await page.goto(fixture.browserOrigin + '/__agent-test/login/alice')
    const beforeTracks = lookups.length
    const tracked = downloadButton('银河之旅')
    const custom = page.locator('article').filter({ hasText: '手动记录' })
    for (const width of [360, 1180]) {
      await page.setViewportSize({ width, height: 840 })
      for (const view of ['卡片', '列表']) {
        await page.getByRole('group', { name: '追番查看方式' }).getByRole('button', { name: view, exact: true }).click()
        await withinCard(tracked)
        if (width === 360 && view === '卡片') assert.equal(lookups.length, beforeTracks)
        assert.equal(await custom.getByRole('button', { name: '回填 BGM' }).count(), 1)
        assert.equal(await custom.getByRole('button', { name: /下载/ }).count(), 0)
        await openFrom(tracked, '银河之旅', bundle.title, 7101, true)
        assert.match(await tracked.locator('xpath=ancestor::article').innerText(), /1\s*\/\s*3/)
        if (process.env.DOWNLOAD_SCREENSHOT_DIR) await tracked.locator('xpath=ancestor::article').screenshot({ path: join(process.env.DOWNLOAD_SCREENSHOT_DIR, `entry-${view}-${width}.png`) })
      }
    }
    await page.getByRole('button', { name: '时间线', exact: true }).click()
    await page.getByRole('button', { name: '银河之旅', exact: true }).click()
    await openFrom(tracked, '银河之旅', bundle.title, 7101, true)
    await page.getByRole('dialog', { name: '编辑追番' }).getByRole('button', { name: '关闭' }).click()
    assert.equal(await page.getByRole('button', { name: '时间线', exact: true }).getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: '手动记录', exact: true }).click()
    const editTrack = page.getByRole('dialog', { name: '编辑追番' })
    await editTrack.getByRole('button', { name: '回填 BGM' }).click()
    const backfill = page.getByRole('dialog', { name: '回填 BGM' })
    await backfill.getByRole('button', { name: '关闭' }).click()
    await editTrack.getByRole('button', { name: '回填 BGM' }).click()
    await backfill.getByRole('textbox', { name: '搜索要贴进手帐的番剧' }).fill('星际旅人')
    await backfill.getByRole('button', { name: '回填', exact: true }).click()
    await openFrom(downloadButton('星际旅人'), '星际旅人', '[字幕组] Star Voyage - 01 [1080p]', 7102, true)
    await editTrack.getByRole('button', { name: '关闭' }).click()
    await page.setViewportSize({ width: 360, height: 740 })
    await page.goto(fixture.browserOrigin + '/#/anime')
    await title.click()
    await dialog.getByRole('button', { name: '下载资源' }).click()
    await dialog.getByRole('button', { name: '补充链接' }).click()
    await dialog.getByLabel('发布名称').fill('手工合集')
    await dialog.getByLabel('链接地址').fill('https://example.org/season.zip')
    await dialog.getByRole('button', { name: '整季合集' }).click()
    if (process.env.DOWNLOAD_SCREENSHOT_DIR) await dialog.screenshot({ path: join(process.env.DOWNLOAD_SCREENSHOT_DIR, 'downloads-mobile.png') })
    await dialog.getByRole('button', { name: '保存链接' }).click()
    await dialog.getByText('手工合集', { exact: true }).waitFor()
    assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().width <= window.innerWidth))
    await dialog.getByRole('button', { name: '返回列表' }).click()
    await page.goto(fixture.browserOrigin + '/#/tracks')
    await tracked.click()
    const manualRow = dialog.getByRole('listitem').filter({ hasText: '手工合集' })
    await manualRow.getByRole('button', { name: '编辑链接' }).click()
    await dialog.getByLabel('发布名称').fill('手工修订版')
    await dialog.getByRole('button', { name: '磁力', exact: true }).click()
    await dialog.getByLabel('链接地址').fill(magnet('0'.repeat(40)))
    await dialog.getByRole('button', { name: '保存链接' }).click()
    await dialog.getByText('手工修订版', { exact: true }).waitFor()
    assert.equal(await season.getByRole('listitem').count(), 1)
    assert.match(await season.innerText(), /管理员补充 · 动漫花园 · 萌番组/)
    await dialog.getByRole('button', { name: '编辑链接' }).click()
    await dialog.getByRole('button', { name: '移除此链接' }).click()
    await dialog.getByRole('button', { name: '补充链接' }).waitFor()
    assert.equal(await dialog.getByText('手工修订版', { exact: true }).count(), 0)
    assert.equal(await season.getByRole('listitem').count(), 1)
    const touch = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true })
    await touch.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort())
    const phone = await touch.newPage()
    phone.on('pageerror', e => errors.push(e.message))
    await phone.goto(fixture.origin + '/#/')
    await phone.getByRole('button', { name: '知道啦' }).tap()
    const phoneEntry = phone.getByRole('button', { name: '下载《周历新番》的资源' })
    await phoneEntry.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }))
    await phoneEntry.tap()
    const phoneDialog = phone.getByRole('dialog')
    await phoneDialog.getByText('周历新番 - 01 [1080p]', { exact: true }).waitFor()
    await phoneDialog.getByRole('button', { name: '返回', exact: true }).tap()
    await phoneDialog.waitFor({ state: 'detached' })
    assert(await phoneEntry.evaluate(el => el === document.activeElement && el.getBoundingClientRect().height >= 44))
    await touch.close()
    assert.deepEqual(errors, [])
    console.log('PASS Chromium catalog, current and archived calendars, all three tracks views, lazy lookup, restored focus, attachment bytes, clipboard, pagination and administrator edits')
  } finally { await browser.close(); await fixture.close() }
} else {
  const realNow = Date.now
  try {
    assert.equal((await fixture.originalFetch(fixture.origin + '/api/catalog/7101/details')).status, 200)
    assert.deepEqual(await (await get(7101)).json(), { ...empty, canEdit: false, episodes: 3 })
    assert.equal((await get(7104, '?source=garden')).status, 404)
    assert.equal((await get(999, '?source=ani')).status, 404)
    assert.equal((await get(7101, '?source=garden&page=0')).status, 400)
    assert.equal(calls.length, 0)
    const admin = await login('alice'), member = await login('bob')
    assert.equal((await get(7104, '?source=garden&season=2023-07')).status, 404)
    assert.equal((await get(7111, '?source=garden')).status, 404)
    assert.equal((await get(7111, '?source=garden&season=bad')).status, 400)
    assert.equal((await get(-7112, '?source=garden', { headers: { cookie: admin } })).status, 400)
    assert.equal((await get(104, '?source=garden', { headers: { cookie: admin } })).status, 404)
    assert.equal((await get(104, '?source=garden')).status, 404)
    assert.equal((await get(7113, '?source=garden')).status, 404)
    assert.equal(calls.length, 0)
    assert.equal((await list(7110, 'garden')).items[0].title, '周历新番 - 01 [1080p]')
    assert.equal((await list(7111, 'garden&season=2023-07')).items[0].title, '往期新番 - 01 [1080p]')
    const confirmed: DownloadResults = await (await get(7113, '?source=garden', { headers: { cookie: member } })).json()
    assert.equal(confirmed.items[0].title, 'Online Subject - 01 [1080p]')
    const start = calls.length
    const owned: DownloadResults = await (await get(104, '?source=garden', { headers: { cookie: member } })).json()
    assert.deepEqual(owned.items.map(r => r.title), ['公开原名 S02 - 01'])
    assert.deepEqual((await (await get(104, '?source=ani', { headers: { cookie: member } })).json()).items, [])
    assert.deepEqual(calls.slice(start).map(u => [u.searchParams.get('subject'), u.searchParams.has('include')]), [['104', false]])
    console.log('PASS local calendar, archived season and verified online additions before indexing, hidden works and account-only ID matching')
    assert.equal((await get(7104, '', { headers: { cookie: member } })).status, 200)
    const add = { ...empty, links: [link] }
    const historySave = await put(7111, add, admin, '?season=2023-07')
    assert.equal(historySave.status, 200)
    const historyLinks = await (await get(7111, '?season=2023-07')).json()
    assert.deepEqual(historyLinks.links, [link])
    assert.equal(historyLinks.canEdit, false)
    assert.equal((await put(7101, add)).status, 401)
    assert.equal((await put(7101, add, member)).status, 403)
    assert.equal((await put(7101, { ...add, links: [{ ...link, url: 'https://example.org/watch.m3u8' }] }, admin)).status, 400)
    assert.equal((await put(7101, { ...add, links: [{ ...link, url: 'javascript:void(0)' }] }, admin)).status, 400)
    assert.equal((await put(7101, { ...add, links: [{ ...link, kind: 'magnet', url: 'magnet:?xt=no' }] }, admin)).status, 400)
    const v2 = 'magnet:?xt=urn:btmh:1220' + 'a'.repeat(64)
    assert.equal((await put(7102, { ...add, links: [{ ...link, kind: 'magnet', url: v2 }] }, admin)).status, 200)
    const both = await Promise.all([put(7101, add, admin), put(7101, add, admin)])
    assert.deepEqual(both.map(r => r.status).sort(), [200, 409])
    const saved: ManualDownloads = await both.find(r => r.ok)!.json()
    seedIndex()
    assert.deepEqual(await (await get(7101)).json(), { ...saved, canEdit: false })
    const changed: ManualDownloads = await (await put(7101, { revision: saved.revision, links: [{ ...link, title: '第二版' }] }, admin)).json()
    assert.equal(changed.links[0].title, '第二版')
    console.log('PASS on-demand lookup, catalog visibility, admin add/edit, conflicting writes and index rebuild')

    const [garden, again, ani] = await Promise.all([list(7101, 'garden'), list(7101, 'garden'), list(7101, 'ani')])
    assert.deepEqual(garden, again)
    assert.equal(garden.more, true)
    const season = garden.items.find(r => r.group === 'season')!
    assert.equal(season.id, '0'.repeat(40))
    assert.deepEqual(season.sources, ['dmhy', 'moe'])
    assert.equal(season.torrentUrl, undefined)
    assert.equal(garden.items.find(r => r.title.includes('[01-02'))?.group, 'other')
    assert.equal(garden.items.find(r => r.title.includes('漫画'))?.group, 'mixed')
    assert.equal(ani.items.length, 1)
    assert.deepEqual([ani.items[0].title, ani.items[0].kind, ani.items[0].first], [feedTitle, 'file', 2])
    const sequel = await list(7105, 'ani')
    assert.equal(sequel.items.length, 1)
    assert.match(sequel.items[0].title, /第二季/)
    assert.deepEqual((await list(7106, 'ani')).items, [])
    assert.equal(calls.filter(u => u.searchParams.get('subject') === '7101').length, 1)
    assert.equal((await list(7101, 'garden&page=2')).items[0].first, 1)
    const alias = await list(7102, 'garden')
    assert.deepEqual(alias.items.map(r => r.group), ['episode', 'mixed'])
    assert(alias.items.every(r => r.nameMatch))
    assert.deepEqual((await list(7103, 'garden')).items, [])
    console.log('PASS file-list verification, incomplete and mixed packs, hash dedup, pagination, aliases, season/year matching and ANi direct links')

    Date.now = () => realNow() + 21 * 60_000
    detailFailure = true
    const partial = await list(7101, 'garden')
    assert.match(partial.warning!, /503/)
    assert.equal(partial.items.find(r => r.id === season.id)?.group, 'season')
    const count = calls.length
    assert.equal((await get(7104, '?source=ani')).status, 404)
    assert.equal((await list(7103, 'garden')).warning?.includes('503'), true)
    assert.equal(calls.length, count)
    Date.now = () => realNow() + 42 * 60_000
    failure = 429
    const limited = await list(7101, 'garden')
    assert.match(limited.warning!, /429/)
    assert.match(limited.warning!, /SOURCE_WINDOW.*合成来源暂停查询/)
    assert(limited.items.length > 0)
    const after = calls.length
    await list(7102, 'garden')
    const uncached = await list(7105, 'garden')
    assert.match(uncached.warning!, /429/)
    assert.deepEqual(uncached.items, [])
    assert.equal(calls.length, after)
    assert.deepEqual(await (await get(7101)).json(), { ...changed, canEdit: false })
    const removed = await put(7101, { revision: changed.revision, links: [] }, admin)
    assert.equal(removed.status, 200)
    assert.deepEqual((await removed.json()).links, [])
    assert.equal((await put(7101, add, admin)).status, 409)
    console.log('PASS 503 and 429 stop upstream requests across works, preserve cached releases and keep manual links editable')
  } finally { Date.now = realNow; await fixture.close() }
}

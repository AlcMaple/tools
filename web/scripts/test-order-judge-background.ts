import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'

const root = await mkdtemp(join(tmpdir(), 'mt-judge-background-')), repo = resolve(import.meta.dirname, '../..')
process.env.DATA_DIR = join(root, 'server')
process.env.AUTH_SECRET = 'fixture-background-only-not-production'
const require = createRequire(join(repo, 'package.json'))
const electron = require('electron') as string
const { build } = require('esbuild') as typeof import('esbuild')
const { default: auth } = await import('../server/auth')
const { db } = await import('../server/db')
const { judgeData } = await import('../server/order-judge-data')
const { createOrderJudgeApi } = await import('../server/order-judge')
let modelCalls = 0
const prompts: string[] = []
let unavailable = false, rejectedPuts = 0, delayNextPut = false, delayedPutEntered = false
const app = new Hono()
app.use('*', async (c, next) => {
  if (unavailable && c.req.method === 'PUT' && c.req.path.startsWith('/api/order-judge/docs/')) { rejectedPuts++; return c.json({ code: 'FIXTURE_503', error: 'fixture 503' }, 503) }
  if (delayNextPut && c.req.method === 'PUT' && c.req.path.startsWith('/api/order-judge/docs/')) { delayNextPut = false; delayedPutEntered = true; await new Promise(resolve => setTimeout(resolve, 800)) }
  await next()
})
app.route('/api/auth', auth).route('/api/order-judge', createOrderJudgeApi(async () => ({
  source: 'server', model: 'fixture-model', execute: action => action(), call: async body => {
    modelCalls++; prompts.push((body.messages as { content: string }[])[0].content)
    return { choices: [{ message: { content: JSON.stringify({ verdict: '能', title: '共享评估夹具', summary: '夹具', reasons: [], gaps: [], questions: [] }) } }] }
  },
})))
app.get('/api/agent/provider', c => c.json({ enabled: true, ready: true, source: 'server', model: 'fixture-model' }))
app.all('/api/*', c => c.json({ error: 'fixture endpoint not implemented' }, 404))
app.use('/*', serveStatic({ root: join(repo, 'web/dist') }))
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
await new Promise<void>(resolve => server.on('listening', resolve))
const address = server.address(); assert(address && typeof address !== 'string')
const origin = 'http://127.0.0.1:' + address.port
let child: ChildProcess | undefined, nativeChild: ChildProcess | undefined, output = '', nativeOutput = ''
let checks = 0
const pass = (message: string): void => { checks++; console.log(`PASS ${checks}: ${message}`) }
const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 150; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(label + '\n' + output + '\n' + nativeOutput)
}
const stop = async (process: ChildProcess | undefined): Promise<void> => {
  if (!process || process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGTERM')
  await new Promise<void>(resolve => { const timer = setTimeout(() => { process.kill('SIGKILL'); resolve() }, 4000); process.once('exit', () => { clearTimeout(timer); resolve() }) })
}
try {
  const registered = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'background', password: 'fixture-password', confirm: 'fixture-password' }) })
  assert.equal(registered.status, 200)
  const cookie = registered.headers.get('set-cookie')!.split(';')[0], token = cookie.slice(cookie.indexOf('=') + 1)
  const uid = (db.prepare("SELECT id FROM users WHERE username='background'").get() as { id: number }).id
  const source = join(root, 'mac-sources'), data = join(root, 'mac-user-data'), winData = join(root, 'desktop-user-data'), otherPath = join(root, 'other-device-path')
  for (const folder of [source, data, winData, otherPath]) await mkdir(folder)
  const profile = join(source, '能力.md'), log = join(source, '日志.md'), winLog = join(otherPath, '项目日志.md')
  await writeFile(profile, 'PROFILE_HEADLESS_V1'); await writeFile(log, 'LOG_HEADLESS_V1')
  const account = { token, username: 'background', origin, accountId: uid, expired: false }
  for (const folder of [data, winData]) await writeFile(join(folder, 'web_account.json'), JSON.stringify(account))
  await writeFile(join(data, 'order-judge-settings.json'), JSON.stringify({ shared: true, paths: { profile: [profile], log: [log] }, historyImported: true }))
  judgeData.mergePaths(uid, { profile: [{ path: profile, device: 'Mac' }], log: [{ path: log, device: 'Mac' }] })
  const env = { ...process.env, MAPLETOOLS_WEB_URL: origin, MAPLETOOLS_TEST_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, ['.', '--order-judge-sync'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', chunk => { output += String(chunk) }); child.stderr!.on('data', chunk => { output += String(chunk) })
  await waitFor(() => judgeData.doc(uid, 'profile')?.content === 'PROFILE_HEADLESS_V1' && !!judgeData.doc(uid, 'log'), 'background initial publish')
  await waitFor(() => output.includes('windows=0'), 'headless window check')
  assert.equal(modelCalls, 0); pass('真实 Electron 无界面模式发布两份 MD，windows=0，不调用 AI')

  await writeFile(profile + '.tmp', 'PROFILE_HEADLESS_ATOMIC_V2'); await rename(profile + '.tmp', profile)
  await waitFor(() => judgeData.doc(uid, 'profile')?.content === 'PROFILE_HEADLESS_ATOMIC_V2', 'atomic file replacement')
  assert.equal(modelCalls, 0); pass('真实后台父目录监听捕获原子替换并自动发布，没有运行浏览器页面')
  delayNextPut = true
  await writeFile(profile, 'PROFILE_SAVE_INFLIGHT_ONE')
  await waitFor(() => delayedPutEntered, 'first publication is in flight')
  await writeFile(profile, 'PROFILE_SAVE_INFLIGHT_TWO')
  await waitFor(() => judgeData.doc(uid, 'profile')?.content === 'PROFILE_SAVE_INFLIGHT_TWO', 'second file event is drained after first upload')
  pass('上传在途时再保存文件，合并待处理事件并发布最终正文，不漏掉第二次修改')
  const checkpoint = await readFile(join(data, 'order-judge-sync.json'), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(checkpoint) as object), ['deviceId']); assert(!checkpoint.includes(root))
  pass('本机只记设备 ID，路径列表在账号里')

  await writeFile(profile, 'PROFILE_BARRIER_BEFORE_DEBOUNCE')
  const phone = await fetch(origin + '/api/order-judge/judge', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'phone fixture', images: [], requestId: randomUUID() }) })
  assert((await phone.text()).includes('"type":"done"'))
  assert(prompts.at(-1)!.includes('PROFILE_BARRIER_BEFORE_DEBOUNCE')); pass('手机角色提交触发真实后台核对，未等监听延迟也使用本次新正文')

  await writeFile(winLog, judgeData.doc(uid, 'log')!.content)
  await writeFile(join(winData, 'order-judge-settings.json'), JSON.stringify({ keyEnc: 'legacy-key-ignored', profilePath: '', logPath: winLog, shared: false, syncEnabled: true }))
  const legacyId = randomUUID(), legacyDir = join(winData, 'order-judge', legacyId)
  await mkdir(legacyDir, { recursive: true }); await writeFile(join(legacyDir, '01.jpg'), Buffer.from('/9j/2Q==', 'base64'))
  await writeFile(join(winData, 'order-judge-history.json'), JSON.stringify([{ id: legacyId, at: Date.now() - 1000, report: { verdict: '能', title: '本机旧历史', summary: '旧', headline: '', reasons: [], gaps: [], risk: '', questions: [] }, order: 'old local history', images: [{ file: '01.jpg', name: 'legacy' }] }]))
  const harness = join(root, 'native-desktop-fixture.cjs')
  await build({ stdin: { contents: `
    import { app } from 'electron'
    import { writeFile, readFile } from 'fs/promises'
    import { setSharedMode, movePath, getSettings, judge, listHistory, historyBase, deleteHistory, importLocalJudgeHistory } from ${JSON.stringify(join(repo, 'src/main/order-judge/service.ts'))}
    import { sharedJudgeImage, stopSharedJudgeRequests } from ${JSON.stringify(join(repo, 'src/main/order-judge/remote.ts'))}
    import { stopJudgeSync } from ${JSON.stringify(join(repo, 'src/main/order-judge/sync-manager.ts'))}
    app.whenReady().then(async () => {
      const enabled = await setSharedMode(true)
      const merged = enabled.paths.log.map(p => p.path)
      await movePath('log', merged.indexOf(${JSON.stringify(winLog)}), -1)
      const order = (await getSettings()).paths.log.map(p => p.path)
      await writeFile(${JSON.stringify(winLog)}, 'LOG_CHANGED_BY_DESKTOP_SERVICE')
      const migration = await importLocalJudgeHistory(), duplicate = migration
      const saved = await readFile(migration.backupPath + '/order-judge-history.json', 'utf8')
      if (saved !== await readFile(${JSON.stringify(join(winData, 'order-judge-history.json'))}, 'utf8')) throw new Error('BACKUP_MISMATCH')
      const result = await judge({ text: 'desktop fixture', images: [{ name: 'fixture', dataUrl: 'data:image/jpeg;base64,/9j/2Q==' }] }, () => {})
      if (!result.ok) throw new Error(JSON.stringify(result))
      const history = await listHistory(), base = await historyBase()
      const image = await sharedJudgeImage(${JSON.stringify(String(uid))}, result.entry.id, '01.jpg')
      if (image.toString('hex') !== 'ffd8ffd9') throw new Error('IMAGE_BYTES')
      await deleteHistory(result.entry.id)
      const after = await listHistory()
      console.log('NATIVE_RESULT=' + JSON.stringify({ merged, order, id: result.entry.id, ids: history.map(x => x.id), base, deleted: !after.some(x => x.id === result.entry.id), imported: migration.imported, duplicate: duplicate.skipped }))
      stopSharedJudgeRequests(); stopJudgeSync(); app.exit(0)
    }).catch(error => { console.error(error); stopSharedJudgeRequests(); stopJudgeSync(); app.exit(1) })
  `, resolveDir: repo, loader: 'ts' }, outfile: harness, bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['electron'],
    banner: { js: `const __fixtureApp = require('electron').app; __fixtureApp.setPath('userData', ${JSON.stringify(winData)}); __fixtureApp.setAppLogsPath(${JSON.stringify(join(winData, 'logs'))});` } })
  nativeChild = spawn(electron, [harness], { cwd: repo, env: { ...env, MAPLETOOLS_TEST_USER_DATA: winData }, stdio: ['ignore', 'pipe', 'pipe'] })
  nativeChild.stdout!.on('data', chunk => { nativeOutput += String(chunk) }); nativeChild.stderr!.on('data', chunk => { nativeOutput += String(chunk) })
  await waitFor(() => nativeOutput.includes('NATIVE_RESULT='), 'native shared service')
  const native = JSON.parse(nativeOutput.split('NATIVE_RESULT=')[1].split('\n')[0]) as { merged: string[]; order: string[]; id: string; ids: string[]; base: string; deleted: boolean; imported: number; duplicate: number }
  assert(native.ids.includes(native.id) && native.ids.length === 3)
  assert.equal(native.base, 'archivist://judge/' + uid); assert(native.deleted)
  assert(prompts.at(-1)!.includes('LOG_CHANGED_BY_DESKTOP_SERVICE'))
  assert.deepEqual(native.merged, [log, winLog]); assert.deepEqual(native.order, [winLog, log])
  pass('旧版设置迁移；开启共用时本机路径追加进账号，调顺序写回账号')
  assert.equal(native.imported, 0); assert.equal(native.duplicate, 1)
  assert(db.prepare('SELECT 1 FROM order_judge_imports WHERE user_id=? AND source_id=?').get(uid, legacyId)); pass('开启共用时本机旧历史带图自动上传（先备份并校验），再导入全部去重')
  assert.equal(modelCalls, 2); pass('真实桌面服务通过网站评估，同账号两条历史共享；Windows 角色不需要本地能力档案')
  assert.equal(db.prepare('SELECT id FROM order_judge_history WHERE id=?').get(native.id), undefined)
  pass('桌面读取受保护图片、删除共享记录与服务端保持一致，非本地假历史')
  assert.equal(judgeData.doc(uid, 'log')?.sourcePath, winLog); pass('网站记下当前正文来自哪条路径，网页设置里能看到')

  if (process.env.JUDGE_BROWSER_MODULE) {
    judgeData.write(uid, 'profile', { name: 'ability.md', content: 'UI_WEB_UPLOAD_ONLY' })
    await writeFile(profile, 'UI_LOCAL_FILE_ONLY')
    const ui = spawn(process.execPath, [join(repo, 'web/scripts/test-order-judge-ui.cjs')], { cwd: repo, env: { ...process.env, JUDGE_UI_ORIGIN: origin, JUDGE_UI_COOKIE: cookie }, stdio: ['ignore', 'pipe', 'pipe'] })
    let uiOutput = ''
    ui.stdout!.on('data', chunk => { uiOutput += String(chunk) }); ui.stderr!.on('data', chunk => { uiOutput += String(chunk) })
    const code = await new Promise<number | null>(resolve => ui.once('exit', resolve))
    console.log(uiOutput); assert.equal(code, 0, uiOutput)
    assert(prompts.at(-1)!.includes('UI_LOCAL_FILE_ONLY')); assert(!prompts.at(-1)!.includes('UI_WEB_UPLOAD_ONLY'))
    pass('手机网页评估时以电脑上的文件为准，整份覆盖后只发一份正文')
  }

  await writeFile(profile, 'BEFORE_503_SETTLED')
  await waitFor(() => judgeData.doc(uid, 'profile')?.content === 'BEFORE_503_SETTLED', 'source settled before outage')
  unavailable = true
  await writeFile(profile, 'AFTER_503_UNSENT')
  await waitFor(() => rejectedPuts === 1, '503 injected')
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(rejectedPuts, 1); pass('真实后台收到 HTTP 503 后没有自动重试、没有恢复探测')
  const callsBeforeFailure = modelCalls
  const failed = await fetch(origin + '/api/order-judge/judge', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'paused source', images: [], requestId: randomUUID() }) })
  assert((await failed.text()).includes('SYNC_FAILED')); assert.equal(modelCalls, callsBeforeFailure); assert.equal(rejectedPuts, 1)
  pass('来源已知同步失败时，手机评估屏障明确报错，不偷用旧稿、不调用 AI')
  await writeFile(profile, 'AFTER_ERROR_LOCAL_EDIT')
  await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(rejectedPuts, 1)
  unavailable = false; await stop(child)
  child = spawn(electron, ['.', '--order-judge-sync'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', chunk => { output += String(chunk) }); child.stderr!.on('data', chunk => { output += String(chunk) })
  await waitFor(() => judgeData.doc(uid, 'profile')?.content === 'AFTER_ERROR_LOCAL_EDIT', 'explicit restart republishes the latest file')
  assert.equal(modelCalls, callsBeforeFailure); pass('明确重启后重新读取最新源文件并覆盖发布，不自动评估')
  await stop(nativeChild); await stop(child)
  const seq = judgeData.seq(uid)
  await writeFile(profile, 'AFTER_BACKGROUND_STOP')
  await new Promise(resolve => setTimeout(resolve, 450))
  assert.equal(judgeData.seq(uid), seq); pass('停止后台后监听与连接退出，没有遗留继续发布的进程')
  console.log(`RESULT: ${checks}/${checks} passed; actual macOS Electron + HTTP + SQLite; AI boundary mocked; Windows role is not a Windows OS test`)
} finally {
  await stop(nativeChild); await stop(child)
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  db.close(); await rm(root, { recursive: true, force: true })
  console.log('Cleanup: both Electron processes, loopback HTTP, SQLite and fixture files removed')
}

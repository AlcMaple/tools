import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { zipSync, strToU8 } from 'fflate'
import { ARCHIVE_LIMITS, expandArchive, isArchive, planArchive, type ArchiveEntry } from '../src/orderJudge/archive'
import { prepareMaterials } from '../shared/order-judge-prepare'

let checks = 0
const pass = (label: string): void => { console.log(`PASS A${++checks}: ${label}`) }
const entry = (path: string, size = 1, type = 'FILE'): ArchiveEntry => ({ path, size, type })
const hooks = { pdfText: async () => ({ text: '', pages: 0 }), onError: (_tag: string, _error: unknown) => {} }
const archive = new File(['rar'], '小程序.RAR')
assert(isArchive(archive)); assert(isArchive(new File([], '材料.ZIP'))); assert(!isArchive(new File([], '文档.docx')))
pass('RAR/ZIP 大小写扩展名识别，Office 文档不误判为压缩包')
assert.deepEqual(planArchive([entry('目录', 0, 'DIR'), entry('目录/需求.txt'), entry('目录/界面.png'), entry('__MACOSX/._需求.txt'), entry('.DS_Store')]).selected.map(x => x.path), ['目录/需求.txt', '目录/界面.png'])
pass('保留中文相对目录，过滤目录项与系统隐藏文件')
for (const path of ['../需求.txt', '/需求.txt', 'C:\\需求.txt', '目录/../../需求.txt', '目录\u0000/需求.txt']) assert.throws(() => planArchive([entry(path)]), /路径异常/)
pass('拒绝穿越、绝对路径、Windows 路径和控制字符')
assert.throws(() => planArchive([entry('a.txt'), entry('./a.txt')]), /重名/)
assert.equal(planArchive([entry('a.txt'), entry('link.txt', 1, 'SYMLINK')]).skipped.length, 1)
pass('重名文件明确报错，符号链接不跟随')
assert.throws(() => planArchive(Array.from({ length: 101 }, (_, i) => entry(`${i}.txt`))), /100/)
assert.throws(() => planArchive([entry('a.txt', ARCHIVE_LIMITS.fileBytes + 1)]), /16 MB/)
assert.throws(() => planArchive(Array.from({ length: 5 }, (_, i) => entry(`${i}.txt`, ARCHIVE_LIMITS.fileBytes))), /64 MB/)
for (const size of [-1, NaN, Infinity]) assert.throws(() => planArchive([entry('a.txt', size)]), /大小异常/)
pass('解压前检查条目、单文件、总大小及非法长度')
await assert.rejects(expandArchive(new File([new Uint8Array(ARCHIVE_LIMITS.bytes + 1)], 'big.zip')), /32 MB/)
await assert.rejects(expandArchive(new File(['not a rar'], 'fake.rar')), /损坏/)
await assert.rejects(expandArchive(archive, AbortSignal.abort()), { name: 'AbortError' })
pass('压缩体积、文件签名和已取消任务在创建 Worker 前拒绝')
const plan = planArchive([entry('需求.txt'), entry('源码.exe'), entry('内层.zip')])
assert.equal(plan.selected.length, 1); assert.match(plan.skipped.join(), /单独放入内层压缩包/)
assert.throws(() => planArchive([]), /没有可读取/)
assert.throws(() => planArchive([entry('a.exe')]), /没有可读取/)
pass('空包、全不支持文件明确报错，嵌套包不递归展开')
const child = new File(['客户已有小程序，只修复登录错误'], '小程序.RAR/需求.md')
const result = await prepareMaterials('补充文字', [archive], { ...hooks, expandArchive: async () => ({ files: [child], skipped: [] }) })
assert.match(result.text, /客户已有小程序/); assert.match(result.text, /小程序.RAR\/需求.md/)
assert.equal(result.attachments[0], archive); assert.equal(result.attachments.length, 1)
assert.deepEqual(result.unreadable, []); assert.match(result.materialNotes[archive.name], /解包 1 项/)
pass('包内材料进入评估正文，历史仅留原压缩包、不重复存解压文件')
let logged = false
const bad = await prepareMaterials('', [archive], { ...hooks, expandArchive: async () => { throw new Error('压缩包已加密') }, onError: (tag, error) => { logged = tag === 'order-judge:archive' && error instanceof Error } })
assert(logged); assert.deepEqual(bad.unreadable, [archive.name]); assert.equal(bad.materialNotes[archive.name], '压缩包已加密')
pass('具体失败原因同时进入附件状态和终端日志上报钩子')
const partial = await prepareMaterials('', [archive], { ...hooks, expandArchive: async () => ({ files: [new File([], '小程序.RAR/扫描.pdf')], skipped: [] }) })
assert(partial.unreadable.includes(archive.name)); assert.match(partial.materialNotes[archive.name], /未读取：扫描.pdf/)
await assert.rejects(prepareMaterials('', [archive], { ...hooks, expandArchive: async () => { throw new DOMException('cancelled', 'AbortError') } }), { name: 'AbortError' })
pass('包内读取失败归属原附件；取消不吞错、不继续评估')
const plain = new File(['原文'], '原文.txt')
const unchanged = await prepareMaterials('', [plain], hooks)
assert.match(unchanged.text, /原文/); assert.equal(unchanged.attachments[0], plain)
const desktop = await prepareMaterials('', [archive], hooks)
assert.deepEqual(desktop.unreadable, [archive.name])
pass('原有普通材料和未接入解包钩子的桌面端行为保持不变')

if (process.argv.includes('--browser')) {
  assert(process.env.JUDGE_BROWSER_MODULE, '设置 JUDGE_BROWSER_MODULE 指向已安装的 Playwright')
  const root = await mkdtemp(join(tmpdir(), 'judge-archive-'))
  process.env.DATA_DIR = join(root, 'data')
  process.env.AUTH_SECRET = 'fixture-only-archive-test-secret'
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { serveStatic } = await import('@hono/node-server/serve-static')
  const { securityHeaders } = await import('../server/security')
  const { default: auth } = await import('../server/auth')
  const { db } = await import('../server/db')
  const { createOrderJudgeApi } = await import('../server/order-judge')
  const app = new Hono()
  app.use('*', securityHeaders())
  app.route('/api/auth', auth)
  app.route('/api/order-judge', createOrderJudgeApi(async () => ({
    source: 'server', model: 'archive-fixture', execute: action => action(), call: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: '能', title: '压缩包回归通过', summary: '夹具结果', reasons: [], gaps: [], questions: [] }) } }] }),
  })))
  app.get('/api/agent/provider', c => c.json({ enabled: true, ready: true, source: 'server', model: 'archive-fixture' }))
  app.all('/api/*', c => c.json({ error: 'fixture endpoint' }, 404))
  app.use('/*', serveStatic({ root: resolve('dist') }))
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => server.on('listening', resolve))
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const registered = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'archivecheck', password: 'fixture-password', confirm: 'fixture-password' }) })
    assert.equal(registered.status, 200)
    const cookie = registered.headers.get('set-cookie')!.split(';')[0]
    const saved = await fetch(origin + '/api/order-judge/docs/profile', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'profile.md', content: '夹具能力档案' }) })
    assert.equal(saved.status, 200)
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document><w:p><w:r><w:t>DOCX_REQUIREMENT</w:t></w:r></w:p></w:document>') })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=', 'base64')
    await writeFile(join(root, 'materials.zip'), zipSync({ '中文目录/需求.txt': strToU8('客户已有小程序，只修复登录错误'), '中文目录/需求.docx': docx, '界面.png': png, '__MACOSX/._需求.txt': strToU8('IGNORE_ME'), '程序.exe': strToU8('DO_NOT_EXECUTE'), '内层.zip': zipSync({ 'inner.txt': strToU8('NESTED_NOT_READ') }) }))
    await writeFile(join(root, 'empty.zip'), zipSync({}))
    await writeFile(join(root, 'corrupt.rar'), new Uint8Array([82, 97, 114, 33, 26, 7, 1, 0, 5]))
    await writeFile(join(root, 'huge.zip'), zipSync({ 'big.txt': new Uint8Array(ARCHIVE_LIMITS.fileBytes + 1) }))
    await writeFile(join(root, 'traversal.zip'), zipSync({ '../bad.txt': strToU8('NOT_READ') }))
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/test-order-judge-archives-ui.cjs'], { stdio: 'inherit', env: { ...process.env, JUDGE_UI_ORIGIN: origin, JUDGE_UI_COOKIE: cookie, JUDGE_ARCHIVE_FIXTURES: root } })
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`浏览器回归退出 ${code}`)))
    })
    const state = await (await fetch(origin + '/api/order-judge', { headers: { cookie } })).json() as { history: { id: string; order: string; files: { file: string; name: string }[] }[] }
    const zip = state.history.find(h => h.files?.some(f => f.name === 'materials.zip')); assert(zip)
    assert.match(zip.order, /客户已有小程序/); assert.match(zip.order, /DOCX_REQUIREMENT/)
    assert.equal(zip.files.length, 1)
    const original = await fetch(origin + `/api/order-judge/history/${zip.id}/files/${zip.files[0].file}`, { headers: { cookie } })
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), await readFile(join(root, 'materials.zip')))
    pass('真实历史接口保存解包后的正文，原始 ZIP 下载字节完全一致')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    await rm(root, { recursive: true, force: true })
  }
}
console.log(`PASS ${checks} archive checks`)

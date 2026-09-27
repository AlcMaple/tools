const { app, BrowserWindow } = require('electron')
const { build } = require('../node_modules/esbuild')
const { writeFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')
const output = process.env.PRETEXT_CHECK_DIR || '/tmp/maple-pretext-check'

// 隐藏的 Chromium 使用真实 Canvas 字体测量；禁止外网，避免测试触碰账号或封面服务。
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }))
  const bundle = await build({ stdin: { contents: "export {wrapPosterBody} from './src/reviews/poster-text'; export {renderPoster} from './src/reviews/poster'; export {clearCache} from '@chenglou/pretext'", resolveDir: resolve(__dirname, '..'), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'TestPoster', platform: 'browser' })
  await win.loadURL('data:text/html,<html lang="zh-CN"><body></body></html>')
  await win.webContents.executeJavaScript(bundle.outputFiles[0].text)
  const result = await win.webContents.executeJavaScript(`(${run.toString()})()`)
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'browser-results.json'), JSON.stringify(result, null, 2))
  if (result.poster) writeFileSync(resolve(output, 'poster.png'), Buffer.from(result.poster, 'base64'))
  delete result.poster
  console.log(JSON.stringify(result, null, 2))
  win.destroy()
  app.exit(result.failures.length ? 1 : 0)
}).catch(error => { console.error(error); app.exit(1) })

async function run() {
  const { wrapPosterBody, renderPoster, clearCache } = TestPoster
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.font = "400 30px 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', system-ui, sans-serif"
  const failures = []
  const check = (condition, label) => { if (!condition) failures.push(label) }
  // 原实现作为固定对照，测试不依赖工作区之外的备份。
  function baseline(text, width) {
    const out = []
    for (const para of text.replace(/\r/g, '').split('\n')) {
      if (!para) { out.push(''); continue }
      let line = ''
      for (const tk of para.match(/[A-Za-z0-9]+|\s+|[^A-Za-z0-9\s]/g) ?? []) {
        const next = line + tk
        if (ctx.measureText(next).width > width && line) { out.push(line.trimEnd()); line = tk.trimStart() }
        else line = next
      }
      if (line) out.push(line.trimEnd())
    }
    return out
  }
  const samples = [
    '', '第一段\n\n第二段\n', '你好世界。'.repeat(250),
    'The story follows a quiet journey, with thoughtful characters. '.repeat(80),
    '春天到了！少女说：「一起出发吧。」Hello world 👨‍👩‍👧‍👦 e\u0301 👍🏽 🇨🇳 '.repeat(60),
    'https://example.com/' + 'longword'.repeat(100), '  缩进  保留\t空格\r\n下一行',
  ]
  let cases = 0
  for (const text of samples) for (const width of [160, 360, 852]) {
    const lines = wrapPosterBody(text, ctx.font, width)
    check(lines.join('').replace(/\s/g, '') === text.replace(/\s/g, ''), '内容完整 ' + cases)
    const boundaries = new Set([0])
    let offset = 0
    const normalized = text.replace(/\r/g, '')
    for (const item of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(normalized)) boundaries.add(item.index + item.segment.length)
    for (const line of lines) {
      while (offset < normalized.length && /\s/.test(normalized[offset]) && !normalized.slice(offset).startsWith(line)) offset++
      check(boundaries.has(offset) && boundaries.has(offset + line.length), '字素边界 ' + cases)
      offset += line.length
      check(ctx.measureText(line).width <= width + 1, '行宽 ' + cases)
    }
    cases++
  }
  check(JSON.stringify(wrapPosterBody('第一段\n\n第二段\n', ctx.font, 852)) === JSON.stringify(['第一段', '', '第二段', '']), '空段落保留')
  const benchmarks = []
  for (const text of [samples[2], samples[3], samples[4]]) {
    clearCache()
    let start = performance.now(); const oldLines = baseline(text, 852); const oldCold = performance.now() - start
    start = performance.now(); const newLines = wrapPosterBody(text, ctx.font, 852); const newCold = performance.now() - start
    const before = [], after = []
    for (let i = 0; i < 15; i++) {
      start = performance.now(); baseline(text, 852); before.push(performance.now() - start)
      start = performance.now(); wrapPosterBody(text, ctx.font, 852); after.push(performance.now() - start)
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
    benchmarks.push({ characters: text.length, oldCold, newCold, oldMedian: median(before), newMedian: median(after), oldLines: oldLines.length, newLines: newLines.length })
  }
  const blob = await renderPoster({ cover: '', titleCn: '摇曳露营：把喜欢的日常收进手帐', mode: 'review', body: '第一段：节奏舒缓，画面细腻。\n\n第二段：Hello world 👨‍👩‍👧‍👦 e\u0301 👍🏽\n' + '这是一篇关于温柔日常的点评。'.repeat(18), spoiler: 'none', userScore: 8, qrUrl: 'https://example.com/u/test', username: '测试用户' })
  check(blob.type === 'image/png' && blob.size > 1000, '完整海报生成')
  const poster = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob) })
  return { browser: navigator.userAgent, cases, failures, benchmarks, poster }
}

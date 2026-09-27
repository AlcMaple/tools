const { app, BrowserWindow } = require('electron')
const { build } = require('../node_modules/esbuild')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')
const output = process.env.PRETEXT_CHECK_DIR || '/tmp/maple-pretext-wide'
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }))
  const bundle = await build({ entryPoints: [resolve(__dirname, 'pretext-ui-fixture.tsx')], bundle: true, write: false, format: 'iife', globalName: 'Fixture', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } })
  const css = readFileSync(resolve(__dirname, '../src/agent/agent.css'), 'utf8')
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html lang="zh-CN"><style>${css}
    body{font-family:'PingFang SC',Arial,sans-serif}#host{height:600px;width:640px;overflow:auto}article{margin:12px 0}.body{font-size:13.5px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
    </style><div id="host"></div></html>`))
  await win.webContents.executeJavaScript(bundle.outputFiles[0].text)
  const result = await win.webContents.executeJavaScript(`(${run.toString()})()`)
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'ui-results.json'), JSON.stringify(result, null, 2))
  writeFileSync(resolve(output, 'ui.png'), (await win.webContents.capturePage()).toPNG())
  console.log(JSON.stringify(result, null, 2))
  win.destroy(); app.exit(result.failures.length ? 1 : 0)
}).catch(error => { console.error(error); app.exit(1) })

async function run() {
  const failures = [], errors = [], longTasks = [], phases = []; let cases = 0
  const mark = label => phases.push({ label, at: performance.now() })
  const taskObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({duration: entry.duration, phase: phases.findLast(p => p.at <= entry.startTime)?.label ?? 'setup'}) }); taskObserver.observe({ type: 'longtask', buffered: false })
  window.addEventListener('error', e => errors.push(e.message))
  const check = (ok, label) => { cases++; if (!ok) failures.push(label) }
  const host = document.getElementById('host')
  const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const settle = async () => { for (let i = 0; i < 5; i++) await tick() }
  const text = '中文段落：这是一段用于检查长对话布局的文字。Hello world 👨‍👩‍👧‍👦 e\u0301 👍🏽。'.repeat(36)
  const mount = (options) => { const label = phases.at(-1)?.label ?? 'setup'; mark(label + ' / React mount'); Fixture.unmount(); Fixture.mount(host, options); mark(label + ' / enhancement') }
  const active = () => [...host.querySelectorAll('p')].filter(p => p.style.contentVisibility === 'auto')
  const ready = async (count) => { const deadline = performance.now() + 5000; while (active().length < count && performance.now() < deadline) await tick() }
  const heights = {}
  for (const optimized of [false, true]) {
    mark(optimized ? 'optimized-layout' : 'baseline-layout')
    mount({ optimized, count: 80, text }); await settle(); if (optimized) await ready(80)
    check(host.querySelectorAll('p').length === 80, '保留全文 DOM')
    check(host.textContent.includes(text), '保留文字内容')
    if (optimized) check(active().length === 80, '长段落全部接入')
    heights[optimized ? 'estimated' : 'baseline'] = host.scrollHeight
    if (optimized) {
      check(Math.abs(heights.estimated - heights.baseline) / heights.baseline < 0.03, '总高度估算偏差小于 3%')
      host.scrollTop = host.scrollHeight; await settle()
      check(host.scrollHeight - host.scrollTop - host.clientHeight < 4, '滚到底不脱离底部')
      const last = host.querySelector('article:last-child p')
      last.scrollIntoView(); await settle()
      const measured = last.getBoundingClientRect().height
      last.style.contentVisibility = 'visible'
      check(Math.abs(measured - last.getBoundingClientRect().height) < 1, '可见内容使用原生真实高度')
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(last); selection.removeAllRanges(); selection.addRange(range)
      check(selection.toString() === text + '79', '选择复制保留完整文字')
      selection.removeAllRanges()
      host.querySelector('article:last-child button').focus(); check(document.activeElement.tagName === 'BUTTON', '按钮焦点保留')
    }
    host.style.width = '480px'; host.scrollTop = 0; await settle()
    heights[optimized ? 'estimated480' : 'baseline480'] = host.scrollHeight
    if (optimized) check(Math.abs(heights.estimated480 - heights.baseline480) / heights.baseline480 < 0.03, '改宽后总高度仍准确')
    host.style.width = '640px'; await settle()
  }
  mark('initial-bottom-anchor')
  mount({ optimized: true, count: 80, text }); host.scrollTop = host.scrollHeight
  await ready(80); await settle(); check(host.scrollHeight - host.scrollTop - host.clientHeight < 4, '启用优化后保持贴底')
  mark('initial-middle-anchor')
  mount({ optimized: true, count: 80, text }); const anchor = host.querySelectorAll('article')[40]; anchor.scrollIntoView()
  const anchorTop = anchor.getBoundingClientRect().top
  await ready(80); await settle(); check(Math.abs(anchor.getBoundingClientRect().top - anchorTop) < 2, '启用优化后中间阅读位置不跳动')
  const initialLongTasks = longTasks.splice(0); const benchmarks = []
  for (const optimized of [false, true]) {
    mark(optimized ? 'optimized-layout' : 'baseline-layout')
    host.style.width = '640px'; host.scrollTop = 0
    mount({ optimized, count: 80, text }); await settle(); if (optimized) await ready(80)
    const timings = []
    for (let i = 0; i < 18; i++) {
      const start = performance.now(); host.style.width = (i % 2 ? 640 : 480) + 'px'; void host.scrollHeight; timings.push(performance.now() - start)
      await tick()
    }
    timings.sort((a, b) => a - b)
    benchmarks.push({ optimized, widthChangeLayoutMedianMs: timings[9], maxMs: timings.at(-1) })
  }
  mark('functional-checks'); mount({ optimized: true, count: 1, text: '短消息' }); await settle(); check(active().length === 0, '短消息跳过')
  Fixture.mount(host, { optimized: true, count: 1, text }); await settle(); check(active().length === 1, '短改长启用')
  Fixture.mount(host, { optimized: true, count: 1, text: '再次变短' }); await settle(); check(active().length === 0, '长改短清理')
  mount({ optimized: true, count: 2, text, markdown: true, streaming: true }); await settle(); check(active().length === 0, '流式正文跳过')
  Fixture.mount(host, { optimized: true, count: 2, text, markdown: true, streaming: false }); await settle(); check(active().length === 2, '完成后启用')
  Fixture.mount(host, { optimized: true, count: 2, text: text + '**强调** [链接](https://example.com)', markdown: true }); await settle()
  check(active().length === 0 && host.querySelectorAll('strong').length === 2 && host.querySelectorAll('a').length === 2, '富文本原生排版与链接保留')
  mount({ optimized: true, count: 2, text }); await settle()
  document.fonts.dispatchEvent(new Event('loadingdone')); await settle(); check(active().length === 2, '字体变更后重新准备')
  Fixture.unmount(); await settle(); check(host.children.length === 0, '卸载清理')
  const supports = CSS.supports; CSS.supports = () => false
  mount({ optimized: true, count: 2, text }); await settle(); check(active().length === 0 && host.textContent.includes(text), '不支持时原生回退'); CSS.supports = supports
  mount({ optimized: true, count: 80, text }); Fixture.unmount(); await settle(); check(host.children.length === 0, '待处理队列卸载清理')
  mark('single-32000-character-message'); mount({ optimized: true, count: 1, text: text.repeat(17).slice(0, 32000) }); await settle(); check(active().length === 0, '超长单段避免同步准备长任务')
  mark('final-preview'); mount({ optimized: true, count: 3, text }); await settle()
  check(errors.length === 0, '浏览器无错误'); taskObserver.disconnect()
  return { browser: navigator.userAgent, cases, failures, errors, heights, benchmarks, initialLongTasks, longTasks, sample: { messages: 80, charactersPerMessage: text.length, widths: [480, 640] } }
}

const assert = require('node:assert/strict')
const { readFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')
const { build } = require('../node_modules/esbuild')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const web = resolve(__dirname, '..')
const output = process.env.DIALOG_CHECK_DIR

async function main() {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { ContinueWatchAction } from './src/tracks/TrackCard';
        let root;
        export function mount(bound = {}, locating = false) {
          root?.unmount();
          root = createRoot(document.getElementById('host'));
          window.picks = [];
          flushSync(() => root.render(<ContinueWatchAction label="继续看" ep={1}
            bound={bound} locating={locating} onPick={(...args) => window.picks.push(args)} />));
        }
        export function unmount() { root.unmount(); root = undefined; }`,
      resolveDir: web, loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', globalName: 'Fixture',
    platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    // 原版注入只用于确认回归断言能抓住这个故障，不覆盖工作区。
    plugins: process.env.DIALOG_BASELINE ? [{ name: 'baseline', setup(b) {
      b.onLoad({ filter: /\/tracks\/TrackCard\.tsx$/ }, () => ({
        contents: readFileSync(process.env.DIALOG_BASELINE, 'utf8'),
        loader: 'tsx', resolveDir: resolve(web, 'src/tracks'),
      }))
    } }] : [],
  })
  const css = ['sketch-tokens.css', 'sketch-ui.css'].map(name =>
    readFileSync(resolve(web, 'src/styles', name), 'utf8')).join('\n')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.abort())
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    for (const [width, height] of [[1440, 900], [768, 1024], [375, 667], [320, 568], [844, 390]]) {
      await page.setViewportSize({ width, height })
      await page.setContent(`<style>${css}</style><div class="trk-grid" style="width:220px;margin:120px 24px"><article class="trk-row"><div id="host"></div></article></div>`)
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      for (const bound of [{}, { xifan: { name: '非常长的番剧标题'.repeat(30) } }]) {
        await page.evaluate(bound => Fixture.mount(bound), bound)
        const open = async () => {
          await page.getByRole('button', { name: '继续看', exact: true }).click()
          await page.getByRole('dialog').waitFor()
          await page.evaluate(async () => {
            await Promise.allSettled(document.getAnimations().map(animation => animation.finished))
          })
        }
        await open()
        const geometry = await page.evaluate(() => {
          const backdrop = document.querySelector('.dlg-backdrop')
          const dialog = document.querySelector('.dlg-wsrc')
          const r = backdrop.getBoundingClientRect(), d = dialog.getBoundingClientRect()
          return {
            bodyChild: backdrop.parentElement === document.body,
            backdrop: [r.x, r.y, r.width, r.height],
            dialog: [d.x, d.y, d.width, d.height],
            overflow: dialog.scrollWidth > dialog.clientWidth,
            buttons: [...dialog.querySelectorAll('.wsrc-btns .btn')].map(b => b.getBoundingClientRect().height),
          }
        })
        console.log(JSON.stringify({ width, height, bound: !!bound.xifan, ...geometry }))
        if (output) {
          mkdirSync(output, { recursive: true })
          await page.screenshot({ path: resolve(output, `${width}-${bound.xifan ? 'bound' : 'unbound'}.png`) })
        }
        assert.equal(geometry.bodyChild, true, '遮罩必须脱离旋转卡片')
        assert.deepEqual(geometry.backdrop, [0, 0, width, height], '遮罩覆盖完整视口')
        const [x, y, w, h] = geometry.dialog
        assert(x >= 0 && y >= 0 && x + w <= width && y + h <= height, '弹窗在视口内')
        assert.equal(geometry.overflow, false, '弹窗没有横向溢出')
        assert(geometry.buttons.every(h => h < 64), '播放按钮没有挤成竖排')
        await page.keyboard.press('Escape')
        assert.equal(await page.getByRole('dialog').count(), 0)
        await open()
        await page.getByRole('button', { name: '关闭', exact: true }).click()
        assert.equal(await page.getByRole('dialog').count(), 0)
        await open()
        await page.mouse.click(2, 2)
        assert.equal(await page.getByRole('dialog').count(), 0)
        for (let index = 0; index < 4; index++) {
          await open()
          await page.locator('.wsrc-btns .btn').nth(index).click()
          assert.equal(await page.getByRole('dialog').count(), 0)
        }
        assert.deepEqual(await page.evaluate(() => window.picks), [
          ['xifan', 'online'], ['xifan', 'source'], ['girigiri', 'online'], ['girigiri', 'source'],
        ])
        if (bound.xifan) {
          await open()
          await page.getByRole('button', { name: '不对，重认' }).click()
          assert.deepEqual(await page.evaluate(() => window.picks.at(-1)), ['xifan', 'online', true])
        }
        await open()
        await page.evaluate(() => Fixture.unmount())
        assert.equal(await page.getByRole('dialog').count(), 0, '卸载清理 portal')
      }
      await page.evaluate(() => Fixture.mount({}, true))
      assert(await page.getByRole('button', { name: '找片源中…' }).isDisabled())
    }
    assert.deepEqual(errors, [])
    console.log('PASS: 5 viewport sizes; bound/unbound; close/Escape/backdrop; all source actions; unmount; locating')
  } finally {
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

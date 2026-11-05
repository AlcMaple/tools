const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')

const origin = process.argv[2]
assert(origin && new URL(origin).hostname === 'agent-phase4.localhost')
app.setPath('userData', process.argv[3])
app.commandLine.appendSwitch('disable-gpu')
app.on('window-all-closed', () => {})

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const { password } = JSON.parse(Buffer.concat(chunks).toString())
  assert(typeof password === 'string' && password.length > 10)
  await app.whenReady()
  let completedCases = 0
  for (const scenario of ['normal:password', 'normal:register', 'normal:email', 'interrupted:password', 'interrupted:register', 'interrupted:email', 'cancelled:password', 'expired:email']) {
    const [outcome, mode] = scenario.split(':')
    const interrupted = outcome !== 'normal'
    const window = new BrowserWindow({ show: false, width: 1360, height: 980, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    await window.webContents.session.clearStorageData()
    let interruptMe = false
    let interruptedReads = 0
    let credentialPosts = 0
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, done) => {
      const url = new URL(request.url)
      if (url.origin !== origin) return done({ cancel: true })
      if (request.method === 'POST' && ['/api/auth/login', '/api/auth/register', '/api/auth/email/verify'].includes(url.pathname)) {
        credentialPosts++
        interruptMe = interrupted
      }
      if (url.pathname === '/api/auth/me' && interruptMe) {
        interruptMe = false
        interruptedReads++
        return done({ cancel: true })
      }
      done({ cancel: false })
    })
    let navigations = 0
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) navigations++ })
    const read = expression => window.webContents.executeJavaScript(expression)
    const waitFor = async expression => {
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) { if (await read(expression)) return; await delay(25) }
      throw new Error('WATCH_LOGIN_WAIT_TIMEOUT: ' + expression)
    }
    const click = expression => read(`(() => { const target = ${expression}; if (!target) throw new Error('WATCH_LOGIN_TARGET_MISSING'); target.click() })()`)
    const fill = (selector, value, index = 0) => read(`(() => { const input = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!input) throw new Error('WATCH_LOGIN_INPUT_MISSING'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await window.loadURL(origin + '/#/anime')
    await waitFor("Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim()==='登录后观看').length===2")
    await click("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='登录后观看')")
    await waitFor("!!document.querySelector('.auth-pane')")
    const beforeLoginNavigations = navigations
    if (mode === 'register') {
      await click("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='注册新账号')")
      await waitFor("document.querySelectorAll('.auth-pane input[autocomplete=\"new-password\"]').length===2")
      await fill('.auth-pane input[autocomplete="username"]', interrupted ? 'ui_signup02' : 'ui_signup01')
      await fill('.auth-pane input[autocomplete="new-password"]', password, 0)
      await fill('.auth-pane input[autocomplete="new-password"]', password, 1)
    } else if (mode === 'email') {
      await click("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim()==='验证码登录')")
      await waitFor("!!document.querySelector('.auth-pane input[autocomplete=\"email\"]')")
      await fill('.auth-pane input[autocomplete="email"]', 'fixture@example.invalid')
      await click("document.querySelector('.auth-pane button[type=\"submit\"]')")
      await waitFor("!!document.querySelector('.auth-pane input[autocomplete=\"one-time-code\"]')")
      await fill('.auth-pane input[autocomplete="one-time-code"]', '123456')
    } else {
      await fill('.auth-pane input[autocomplete="username"]', 'ui_empty')
      await fill('.auth-pane input[autocomplete="current-password"]', password)
    }
    await click("document.querySelector('.auth-pane button[type=\"submit\"]')")
    if (interrupted) {
      await waitFor(`!document.querySelector('.auth-pane') || (!!document.querySelector('.auth-pane .form-note.err') && !document.querySelector('.auth-pane button[type="submit"]').disabled)`)
      const recovery = await read("({ dialogOpen:!!document.querySelector('.auth-pane'), action:Array.from(document.querySelectorAll('.auth-pane button')).some(b => b.textContent.trim()==='继续登录'), intentPresent:sessionStorage.getItem('mt-watch-after-login')!==null })")
      assert(recovery.dialogOpen && recovery.action && recovery.intentPresent, 'WATCH_LOGIN_RECOVERY_LOST: ' + mode + ' ' + JSON.stringify(recovery))
      assert.equal(interruptedReads, 1)
      assert.equal(credentialPosts, 1)
      if (outcome === 'cancelled') {
        await click("document.querySelector('.auth-dlg .dlg-close')")
        await waitFor("!document.querySelector('.auth-pane')")
        assert(await read("sessionStorage.getItem('mt-watch-after-login')===null"), 'cancel must clear the watch intent')
        assert.equal(credentialPosts, 1)
        console.log('PASS watch login cancellation after interruption: no later watch replay')
        completedCases++
        window.destroy()
        continue
      }
      if (outcome === 'expired') await window.webContents.session.clearStorageData({ storages: ['cookies'] })
      if (outcome === 'interrupted' && mode === 'password') {
        interruptMe = true
        await click("Array.from(document.querySelectorAll('.auth-pane button')).find(b => b.textContent.trim()==='继续登录')")
        await waitFor("!!document.querySelector('.auth-pane .form-note.err') && !document.querySelector('.auth-pane button[type=\"submit\"]').disabled")
        assert.equal(interruptedReads, 2)
        assert.equal(credentialPosts, 1)
        assert(await read("sessionStorage.getItem('mt-watch-after-login')!==null"))
      }
      await click("Array.from(document.querySelectorAll('.auth-pane button')).find(b => b.textContent.trim()==='继续登录')")
      if (outcome === 'expired') {
        await waitFor("!!document.querySelector('.auth-pane input[autocomplete=\"one-time-code\"]')")
        const expired = await read("({error:document.querySelector('.auth-pane .form-note.err')?.textContent, action:Array.from(document.querySelectorAll('.auth-pane button')).some(b => b.textContent.trim()==='继续登录'), intentPresent:sessionStorage.getItem('mt-watch-after-login')!==null})")
        assert.equal(expired.error, '登录已失效，请重新登录')
        assert.equal(expired.action, false, 'confirmed 401 must leave the identity-only retry state')
        assert.equal(expired.intentPresent, true)
        assert.equal(credentialPosts, 1)
        await click("document.querySelector('.auth-dlg .dlg-close')")
        await waitFor("!document.querySelector('.auth-pane')")
        assert(await read("sessionStorage.getItem('mt-watch-after-login')===null"))
        console.log('PASS watch login confirmed 401: return to credential entry, no repeated code consumption')
        completedCases++
        window.destroy()
        continue
      }
    }
    await waitFor("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim()==='退出登录') && !document.querySelector('.auth-pane')")
    await waitFor("!!document.querySelector('[role=\"dialog\"][aria-label=\"挑个播放源\"]') || sessionStorage.getItem('mt-watch-after-login')===null")
    const result = await read("({ selected:document.querySelector('[role=\"dialog\"][aria-label=\"挑个播放源\"]')?.textContent ?? '', intentPresent:sessionStorage.getItem('mt-watch-after-login')!==null })")
    assert(result.selected.includes('葬送的芙莉莲') && /第\s*1\s*话/.test(result.selected), 'WATCH_LOGIN_SELECTION_LOST: ' + mode + ' ' + JSON.stringify(result))
    assert.equal(navigations, beforeLoginNavigations, 'test must use in-page auth, not OAuth/reload')
    assert.equal(credentialPosts, 1, 'recovery must not submit credentials or consume the code again')
    console.log('PASS watch login ' + mode + (interrupted ? ' after identity-read interruption' : '') + ': same anime and EP1 survive, 1 credential POST')
    completedCases++
    window.destroy()
  }
  console.log('WATCH_LOGIN_CASES=' + completedCases)
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })

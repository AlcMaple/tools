/**
 * Hidden Electron BrowserWindow for aowu.tv FantasyKon SPA.
 *
 * Aowu's 2026-05 redesign moved all detail/watch data behind a JS-rendered SPA
 * that fetches a private encrypted endpoint (`POST /api/site/secure`). Replicating
 * the request signing + response decryption from the obfuscated bundle is a large
 * fragile project. Instead we let Chromium do the work: load the page in a hidden
 * window, wait for the relevant DOM to populate, extract the data we need.
 *
 * One window is reused across calls — keeps the ~3s init cost amortized for
 * multi-episode downloads.
 */
import { app, BrowserWindow } from 'electron'

let _win: BrowserWindow | null = null
let _initPromise: Promise<BrowserWindow> | null = null

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function ensureWindow(): Promise<BrowserWindow> {
  if (_win && !_win.isDestroyed()) return _win
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    await app.whenReady()
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        // Hidden windows are background-throttled by default — Chromium would
        // pause the SPA's timers and the secure endpoint would never fire.
        backgroundThrottling: false,
      },
    })
    win.webContents.setUserAgent(DESKTOP_UA)
    win.on('closed', () => {
      _win = null
      _initPromise = null
    })
    _win = win
    return win
  })()
  return _initPromise
}

/** Tear down the shared window — used on app shutdown. */
export function closeAowuHeadless(): void {
  if (_win && !_win.isDestroyed()) _win.destroy()
  _win = null
  _initPromise = null
}

/** Load a URL into the shared window. Always triggers a full reload. */
export async function navigate(url: string): Promise<void> {
  const win = await ensureWindow()
  await win.loadURL(url)
}

/** Execute `fn` inside the page context; auto-awaits returned Promises. */
export async function evalInPage<T>(fn: () => T | Promise<T>): Promise<T> {
  const win = await ensureWindow()
  return win.webContents.executeJavaScript(`(${fn.toString()})()`, true)
}

/** Click the Nth match of a CSS selector inside the page. */
export async function clickInPage(selector: string, index = 0): Promise<void> {
  const win = await ensureWindow()
  const expr = `(()=>{const els=document.querySelectorAll(${JSON.stringify(selector)});const el=els[${index}];if(el)el.click()})()`
  await win.webContents.executeJavaScript(expr, true)
}

/** Set a global on the page's window. Useful for parameterizing predicates. */
export async function setPageGlobal(name: string, value: unknown): Promise<void> {
  const win = await ensureWindow()
  await win.webContents.executeJavaScript(
    `window[${JSON.stringify(name)}] = ${JSON.stringify(value)}`,
    true
  )
}

/** Poll `predicate` (run in page) until truthy or timeout. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
  pollMs = 150,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await evalInPage(predicate).catch(() => false)
    if (ok) return
    await new Promise(r => setTimeout(r, pollMs))
  }
  throw new Error(`AOWU_HEADLESS_TIMEOUT: waitFor timed out after ${timeoutMs}ms`)
}

interface LoadOpts<T> {
  url: string
  predicate: () => boolean | Promise<boolean>
  extractor: () => T | Promise<T>
  timeoutMs?: number
  pollMs?: number
}

/** Convenience: navigate → waitFor predicate → evalInPage extractor. */
export async function loadAndExtract<T>(opts: LoadOpts<T>): Promise<T> {
  await navigate(opts.url)
  await waitFor(opts.predicate, opts.timeoutMs ?? 25000, opts.pollMs ?? 200)
  return evalInPage(opts.extractor)
}

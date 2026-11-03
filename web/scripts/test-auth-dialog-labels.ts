import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AuthMode } from '../src/AuthModal'

const originalFetch = globalThis.fetch
let networkRequests = 0
globalThis.fetch = async () => {
  networkRequests++
  throw new Error('AUTH_DIALOG_TEST_UNEXPECTED_NETWORK')
}

try {
  const { AuthModal } = await import('../src/AuthModal')
  const labels: Record<AuthMode, string> = {
    login: '登录番外小站',
    register: '注册番外小站',
    email: '邮箱验证码登录番外小站',
    forgot: '找回番外小站密码',
  }
  for (const mode of Object.keys(labels) as AuthMode[]) {
    const output = renderToStaticMarkup(createElement(AuthModal, { open: true, mode, onMode: () => {}, onClose: () => {} }))
    const dialog = output.match(/<[^>]+role="dialog"[^>]*>/)?.[0] ?? ''
    assert(dialog.includes(`aria-label="${labels[mode]}"`), `${mode}: expected ${labels[mode]}, actual ${dialog}`)
    assert(dialog.includes('aria-modal="true"'))
    console.log(`PASS auth dialog ${mode}: ${labels[mode]}`)
  }
  assert.equal(renderToStaticMarkup(createElement(AuthModal, { open: false, mode: 'login', onMode: () => {}, onClose: () => {} })), '')
  assert.equal(networkRequests, 0)
  console.log('PASS auth dialog: 4 modes, closed state, 0 network requests')
} finally {
  globalThis.fetch = originalFetch
}

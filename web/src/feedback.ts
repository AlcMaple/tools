import type { FeedbackContext } from '../shared/feedback'

export function feedbackContext(errorCode = ''): FeedbackContext {
  const hash = window.location.hash.split('?')[0]
  const page = window.location.hash === '#/feedback?from=player' || window.location.pathname.startsWith('/api/player/') ? '/api/player/page'
    : /^#\/[a-z/-]*$/.test(hash) ? `/${hash}` : '/'
  const agent = navigator.userAgent
  const platform = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Windows/.test(agent) ? 'Windows' : /Mac/.test(agent) ? 'macOS' : 'Other'
  return { page, platform, version: `web-${__AGENT_CLIENT_RELEASE__.slice(0,12)}`, errorCode: /^[A-Z0-9_]{1,60}$/.test(errorCode) ? errorCode : '' }
}
export function openFeedback(errorCode = ''): void {
  window.dispatchEvent(new CustomEvent('maple:feedback', { detail: feedbackContext(errorCode) }))
}
export async function feedbackApi<T>(path: string, body?: unknown): Promise<T> {
  const endpoint = path === '/' ? '' : path.startsWith('/?') ? path.slice(1) : path
  const response = await fetch(`/api/feedback${endpoint}`, body === undefined ? undefined : { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) })
  const result = await response.json() as T & {error?:string}
  if (!response.ok) throw new Error(result.error || `反馈请求失败（${response.status}）`)
  return result
}

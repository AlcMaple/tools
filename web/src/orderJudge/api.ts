import { fetchApi, readApi } from '../request'
import type { JudgeEvent, JudgeImage, JudgeState, JudgeSyncEvent, Project } from '../../shared/order-judge-api'
import { judgeLineReader } from '../../shared/order-judge-lines'

export class JudgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null) as (T & { code?: string; error?: string }) | null
  if (!res.ok) throw new JudgeError(data?.code ?? `HTTP_${res.status}`, data?.error ?? `服务器返回 HTTP ${res.status}`)
  if (!data) throw new JudgeError('BAD_RESPONSE', '服务器的回复读不出来')
  return data
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  credentials: 'same-origin',
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const loadState = async (): Promise<JudgeState> => json(await fetchApi('/api/order-judge', { credentials: 'same-origin' }))

export const deleteProject = async (id: string): Promise<void> => {
  await json(await fetchApi(`/api/order-judge/projects/${id}`, send('DELETE')))
}

export const imageUrl = (version: string, file: string): string => `/api/order-judge/versions/${version}/${file}`
export const attachUrl = (version: string, file: string, download = false): string => `/api/order-judge/versions/${version}/files/${file}${download ? '?download=1' : ''}`

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function logClient(tag: string, error: unknown): void {
  const detail = error instanceof Error
    ? [error.stack || `${error.name}: ${error.message}`, error.cause instanceof Error ? error.cause.stack : error.cause].filter(Boolean).join('\nCaused by: ')
    : String(error)
  try {
    void fetch('/api/order-judge/log', { ...send('POST', { tag, detail }), keepalive: true })
  } catch { /* 上报失败不影响整理 */ }
}

// NDJSON：一行一个事件；HTTP 非 200 的是发请求前就拒了（限流、没连 AI、项目不存在）。
// projectId 为 null 是新项目，否则给这个项目追加一个版本
export async function organize(
  projectId: string | null, text: string, images: JudgeImage[], files: File[],
  onStage: (e: Extract<JudgeEvent, { type: 'stage' }>) => void,
  signal: AbortSignal,
): Promise<Project> {
  const attached = await Promise.all(files.map(async (f) => ({ name: f.name, data: await fileBase64(f) })))
  const url = projectId ? `/api/order-judge/projects/${projectId}/versions` : '/api/order-judge/projects'
  return readApi(url, { ...send('POST', { text, images, files: attached }), signal }, async (res) => {
    if (!res.ok || !res.body) await json(res)
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let result: Project | null = null, failure: JudgeError | null = null
    const parse = judgeLineReader(value => {
      const e = value as JudgeEvent
      if (e.type === 'stage') onStage(e)
      else if (e.type === 'done') result = e.project
      else failure = new JudgeError(e.code, e.error)
    })
    for (;;) {
      const { value, done } = await reader.read()
      if (value) parse(value)
      if (done) { parse('', true); break }
    }
    if (failure) throw failure
    if (!result) throw new JudgeError('STREAM_CLOSED', '连接中途断开了，没有拿到需求清单，请手动重试')
    return result
  }, 300_000)
}

export interface ProviderStatus {
  enabled: boolean
  ready: boolean
  source: 'server' | 'byok'
  model: string
  profiles?: { endpoint: string; model: string }[]
}

export const providerStatus = async (): Promise<ProviderStatus> => json(await fetchApi('/api/agent/provider', { credentials: 'same-origin' }))

export const connectProvider = async (endpoint: string, model: string, key: string): Promise<ProviderStatus> =>
  json(await fetchApi('/api/agent/provider/connect', send('POST', { source: 'byok', endpoint, model, key }), 40_000))

export function followJudgeChanges(onChange: () => void, onError: (error: unknown) => void, onConnected: () => void = () => {}): () => void {
  let stopped = false, attempts = 0, controller: AbortController | null = null, timer: number | undefined
  const start = async (): Promise<void> => {
    if (stopped || document.visibilityState === 'hidden' || !navigator.onLine || controller) return
    const current = new AbortController(); controller = current
    try {
      const res = await fetch('/api/order-judge/sync/events', { credentials: 'same-origin', signal: current.signal, cache: 'no-store' })
      if (!res.ok) await json(res)
      if (!res.body) throw new JudgeError('SYNC_DISCONNECTED', '同步连接已断开')
      const parse = judgeLineReader(value => {
        const event = value as JudgeSyncEvent
        if (event.type === 'ready') onConnected()
        if (event.type === 'ready' || event.type === 'changed') onChange()
      })
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (value) parse(value)
          if (done) { parse('', true); throw new JudgeError('SYNC_DISCONNECTED', '同步连接已断开') }
        }
      } finally { reader.releaseLock() }
    } catch (error) {
      if (stopped || current.signal.aborted) return
      onError(error)
      if ((error instanceof TypeError || error instanceof JudgeError && error.code === 'SYNC_DISCONNECTED') && attempts++ < 2) {
        timer = window.setTimeout(() => { timer = undefined; void start() }, 700 * attempts + Math.random() * 500)
      }
    } finally { if (controller === current) controller = null }
  }
  const resume = (): void => {
    if (document.visibilityState === 'hidden' || !navigator.onLine) { controller?.abort(); controller = null; return }
    window.clearTimeout(timer); attempts = 0; onChange(); void start()
  }
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('online', resume)
  void start()
  return () => {
    stopped = true; controller?.abort(); window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume)
  }
}

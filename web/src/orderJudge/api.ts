import { fetchApi, readApi } from '../request'
import type { DocKind, DocMeta, HistoryEntry, JudgeEvent, JudgeImage, JudgeState, JudgePath, JudgePaths, JudgeSyncEvent } from '../../shared/order-judge-api'
import { judgeLineReader } from '../../shared/order-judge-lines'
import type { EstimateEvent, EstimateResult } from '../../shared/order-judge-estimate'

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

type SavedDoc = { docs: Record<DocKind, DocMeta | null>; paths: JudgePaths }
export const saveDoc = async (kind: DocKind, name: string, content: string): Promise<SavedDoc> =>
  json(await fetchApi(`/api/order-judge/docs/${kind}`, send('PUT', { name, content })))

export const savePaths = async (kind: DocKind, paths: JudgePath[]): Promise<JudgePaths> =>
  (await json<{ paths: JudgePaths }>(await fetchApi(`/api/order-judge/paths/${kind}`, send('PUT', { paths })))).paths

export const deleteEntry = async (id: string): Promise<void> => {
  await json(await fetchApi(`/api/order-judge/history/${id}`, send('DELETE')))
}

export const imageUrl = (id: string, file: string): string => `/api/order-judge/history/${id}/${file}`
export const attachUrl = (id: string, file: string, download = false): string => `/api/order-judge/history/${id}/files/${file}${download ? '?download=1' : ''}`

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
  } catch { /* 上报失败不影响评估 */ }
}

// NDJSON：一行一个事件；HTTP 非 200 的是发请求前就拒了（限流、没档案、没连 AI）。
// 带估价时结论先到就先返回，流继续读到估价结束；估价事件交给 onEstimate
export async function judge(
  text: string, images: JudgeImage[], files: File[], requestId: string,
  onStage: (e: Extract<JudgeEvent, { type: 'stage' }>) => void,
  onEstimate: ((e: EstimateEvent) => void) | null,
  signal: AbortSignal,
): Promise<HistoryEntry> {
  const attached = await Promise.all(files.map(async (f) => ({ name: f.name, data: await fileBase64(f) })))
  return readApi('/api/order-judge/judge', { ...send('POST', { text, images, files: attached, requestId, estimate: !!onEstimate }), signal }, async (res) => {
    if (!res.ok || !res.body) await json(res)
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let settle: { ok: (e: HistoryEntry) => void; fail: (e: unknown) => void } | null = null
    const result = new Promise<HistoryEntry>((ok, fail) => { settle = { ok, fail } })
    let judged = false, estimated = !onEstimate
    // 结论返回后 readApi 已不再转发取消，后面读估价的这段自己响应取消
    signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}) }, { once: true })
    void (async () => {
      let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (value) buf += value
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) continue
            const e = JSON.parse(line) as JudgeEvent
            if (e.type === 'stage') onStage(e)
            else if (e.type === 'estimate') {
              if (e.event.type === 'done' || e.event.type === 'error') estimated = true
              onEstimate?.(e.event)
            } else if (e.type === 'done') { judged = true; settle!.ok(e.entry) }
            else { judged = true; settle!.fail(new JudgeError(e.code, e.error)) }
          }
          if (done) break
        }
      } catch (e) {
        if (!judged) { judged = true; settle!.fail(e) }
      }
      if (!judged) settle!.fail(new JudgeError('STREAM_CLOSED', '连接中途断开了，没有拿到结论，请手动重试'))
      if (!estimated && !signal.aborted) onEstimate?.({ type: 'error', code: 'STREAM_CLOSED', error: '连接中途断开了，没有拿到估价，请手动重试' })
    })()
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
      if (!res.body) throw new JudgeError('SYNC_DISCONNECTED', '同步连接已断开。')
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
          if (done) { parse('', true); throw new JudgeError('SYNC_DISCONNECTED', '同步连接已断开。') }
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

// 与评估同一次点击发出、带同一个 requestId，服务端把结果写进那条历史
export async function estimate(text: string, images: JudgeImage[], requestId: string, onProgress: (e: Exclude<EstimateEvent, { type: 'done' | 'error' }>) => void, signal: AbortSignal): Promise<EstimateResult> {
  return readApi('/api/order-judge/estimate', { ...send('POST', { text, images, requestId }), signal }, async (res) => {
    if (!res.ok || !res.body) await json(res)
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (value) buf += value
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const e = JSON.parse(line) as EstimateEvent
        if (e.type === 'done') return e.result
        if (e.type === 'error') throw new JudgeError(e.code, e.error)
        onProgress(e)
      }
      if (done) throw new JudgeError('STREAM_CLOSED', '连接中途断开了，没有拿到估价，请手动重试')
    }
  }, 180_000)
}

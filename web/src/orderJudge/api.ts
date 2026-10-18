import { fetchApi, readApi } from '../request'
import type { DocKind, DocMeta, HistoryEntry, JudgeEvent, JudgeImage, JudgeState } from '../../shared/order-judge-api'

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

export const saveDoc = async (kind: DocKind, name: string, content: string): Promise<Record<DocKind, DocMeta | null>> =>
  json(await fetchApi(`/api/order-judge/docs/${kind}`, send('PUT', { name, content })))

export const deleteEntry = async (id: string): Promise<void> => {
  await json(await fetchApi(`/api/order-judge/history/${id}`, send('DELETE')))
}

export const imageUrl = (id: string, file: string): string => `/api/order-judge/history/${id}/${file}`

export function logClient(tag: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error)
  try {
    void fetch('/api/order-judge/log', { ...send('POST', { tag, detail }), keepalive: true })
  } catch { /* 上报失败不影响评估 */ }
}

// NDJSON：一行一个事件；HTTP 非 200 的是发请求前就拒了（限流、没档案、没连 AI）
export async function judge(text: string, images: JudgeImage[], onStage: (e: Extract<JudgeEvent, { type: 'stage' }>) => void, signal: AbortSignal): Promise<HistoryEntry> {
  return readApi('/api/order-judge/judge', { ...send('POST', { text, images }), signal }, async (res) => {
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
        const e = JSON.parse(line) as JudgeEvent
        if (e.type === 'stage') onStage(e)
        else if (e.type === 'done') return e.entry
        else throw new JudgeError(e.code, e.error)
      }
      if (done) throw new JudgeError('STREAM_CLOSED', '连接中途断开了，没有拿到结论，请手动重试')
    }
  }, 300_000)
}

// 与助手共用同一条「自配 API」连接：在这里连上，助手那边也就连上了
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

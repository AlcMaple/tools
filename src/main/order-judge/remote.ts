import { randomUUID } from 'crypto'
import { authedRequest, onWebAccountChange, readWebAccount, rememberVerifiedAccount, webAccountLines } from '../ipc/webAccount'
import { WebRequestError } from '../shared/net-lines'
import type { DocKind, DocReceipt, DocWrite, HistoryEntry, JudgeEvent, JudgeState, JudgeSyncState } from '../../../web/shared/order-judge-api'
import type { EstimateEvent } from '../../../web/shared/order-judge-estimate'

const activeJudges = new Set<AbortController>()
export function stopSharedJudgeRequests(): void { for (const controller of activeJudges) controller.abort(); activeJudges.clear() }
onWebAccountChange(stopSharedJudgeRequests)

export async function judgeRemote<T>(path: string, method = 'GET', input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await authedRequest('/api/order-judge' + path, { method, body: input === undefined ? undefined : JSON.stringify(input), signal })
  let value: T & { code?: string; error?: string }
  try { value = JSON.parse(response.body.toString('utf8')) as typeof value }
  catch { throw new WebRequestError('BAD_RESPONSE', '网站接单评估接口尚未就绪，请更新服务。', response.status) }
  if (response.status < 200 || response.status >= 300) throw new WebRequestError(value.code ?? `HTTP_${response.status}`, value.error ?? `网站返回 HTTP ${response.status}`, response.status)
  return value
}

export async function remoteSnapshot(signal?: AbortSignal): Promise<JudgeSyncState> {
  const snapshot = await judgeRemote<JudgeSyncState>('/sync', 'GET', undefined, signal)
  if (snapshot.protocol !== 1) throw new Error('接单评估同步协议不匹配。')
  await rememberVerifiedAccount(snapshot.username, snapshot.accountId)
  return snapshot
}

export async function remoteWrite(kind: DocKind, input: DocWrite, signal?: AbortSignal): Promise<DocReceipt> {
  return (await judgeRemote<{ receipt: DocReceipt }>(`/docs/${kind}`, 'PUT', input, signal)).receipt
}

export const remoteState = (): Promise<JudgeState> => judgeRemote('')

export async function sharedJudgeImage(uid: string, id: string, file: string): Promise<Buffer> {
  if (!/^[0-9]+$/.test(uid) || !/^[0-9a-f-]{36}$/.test(id) || !/^\d{2}\.jpg$/.test(file) || Number(uid) !== (await readWebAccount()).accountId) throw new Error('INVALID_SHARED_IMAGE')
  const response = await authedRequest(`/api/order-judge/history/${id}/${file}`)
  if (response.status !== 200) throw new Error(`历史图片读取失败（HTTP ${response.status}）。`)
  return response.body
}

// 带估价时结论先经 onVerdict 交出去，流继续读到估价结束才返回
export async function remoteJudge(input: { text: string; images: { name: string; dataUrl: string }[] }, progress: (stage: Extract<JudgeEvent, { type: 'stage' }>) => void, signal: AbortSignal, onVerdict?: (entry: HistoryEntry) => void, onEstimate?: (e: EstimateEvent) => void): Promise<HistoryEntry> {
  let entry: HistoryEntry | undefined, estimated = false
  const controller = new AbortController(), abort = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  signal.addEventListener('abort', abort, { once: true }); activeJudges.add(controller)
  try { await webAccountLines('/api/order-judge/judge', JSON.stringify({ ...input, requestId: randomUUID(), estimate: !!onEstimate }), controller.signal, raw => {
    const event = raw as JudgeEvent
    if (event.type === 'stage') progress(event)
    else if (event.type === 'done') { entry = event.entry; onVerdict?.(event.entry) }
    else if (event.type === 'estimate') { if (event.event.type === 'done' || event.event.type === 'error') estimated = true; onEstimate?.(event.event) }
    else throw new WebRequestError(event.code, event.error)
  }, 250_000) } finally { activeJudges.delete(controller); signal.removeEventListener('abort', abort) }
  if (!entry) throw new WebRequestError('STREAM_CLOSED', '连接中断，没有取得结论；请先查看共享历史。')
  // 旧版网站不认 estimate 参数，流里不会有估价事件；不交代一声，桌面的估价卡片会一直停在进行中
  if (onEstimate && !estimated) onEstimate({ type: 'error', code: 'NO_ESTIMATE', error: '这次没有拿到估价：网站可能还没更新到带估价的版本。' })
  return entry
}

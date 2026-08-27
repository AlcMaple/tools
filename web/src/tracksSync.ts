// 追番数据的「秒开缓存 + 后台校验」—— 缓存只负责首屏立即可见，账号服务器才是跨设备的
// 唯一事实源。真实请求回来后整份覆盖缓存，不能拿 localStorage 的 updatedAt 反过来压服务器：
// 旧部署、设备时钟或中途关闭页面留下的未来时间戳，会让一台设备永久停在旧状态。
import {
  fetchTracks,
  fetchTracksRevision,
  sourceById,
  type SourceBinding,
  type SourceId,
  type Track,
  type TracksSnapshot,
} from './api'
import { cachePeek, cacheSet } from './dataCache'

const tracksKey = (username: string): string => `tracks:${username}`
const tracksServerKey = (username: string): string => `tracksServer:${username}`
// 缓存 key 保持不变：`xifanBindings:` / `girigiriBindings:`
const bindingsKey = (source: SourceId, username: string): string => `${source}Bindings:${username}`
const TRACKS_STORAGE_PREFIX = 'mt_cache:'
const REVISION_INTERVAL_MS = 15_000
const LIFECYCLE_COALESCE_MS = 500

function tracksSignature(tracks: Track[]): string {
  return JSON.stringify(tracks)
}

interface TracksListener {
  onData: (tracks: Track[]) => void
  onError?: (message: string | null) => void
}

interface TracksAccountState {
  username: string
  listeners: Set<TracksListener>
  /** 已排队或正在执行的写入总数。 */
  pendingWrites: number
  /** 同一账号严格按用户操作顺序发 PUT / DELETE，避免旧操作后落库。 */
  writeTail: Promise<void>
  /** 写入或跨标签变更会递增；全量 GET 只有版本仍相等才有资格落地。 */
  validationVersion: number
  nextRequestId: number
  latestRequestId: number
  fullRequest: Promise<void> | null
  fullQueued: boolean
  revisionRequest: Promise<void> | null
  /** 有乐观写入尚未被权威全量结果收口。 */
  needsAuthoritativeRead: boolean
  lastRevision: number | null
  lastServerData: Track[] | null
  lastServerSignature: string | null
  monitorCleanup: (() => void) | null
  lifecycleTimer: number | null
  lastFullStartedAt: number
}

const accountStates = new Map<string, TracksAccountState>()

function stateFor(username: string): TracksAccountState {
  const existing = accountStates.get(username)
  if (existing) return existing
  const cachedServer = cachePeek<TracksSnapshot>(tracksServerKey(username))
  const hasValidServerCache = !!cachedServer
    && Number.isSafeInteger(cachedServer.rev)
    && cachedServer.rev >= 0
    && Array.isArray(cachedServer.data)
  const state: TracksAccountState = {
    username,
    listeners: new Set(),
    pendingWrites: 0,
    writeTail: Promise.resolve(),
    validationVersion: 0,
    nextRequestId: 0,
    latestRequestId: 0,
    fullRequest: null,
    fullQueued: false,
    revisionRequest: null,
    needsAuthoritativeRead: false,
    lastRevision: hasValidServerCache ? cachedServer.rev : null,
    lastServerData: hasValidServerCache ? cachedServer.data : null,
    lastServerSignature: hasValidServerCache ? tracksSignature(cachedServer.data) : null,
    monitorCleanup: null,
    lifecycleTimer: null,
    lastFullStartedAt: 0,
  }
  accountStates.set(username, state)
  return state
}

function notifyData(state: TracksAccountState, tracks: Track[]): void {
  for (const listener of state.listeners) listener.onData(tracks)
}

function notifyError(state: TracksAccountState, message: string | null): void {
  for (const listener of state.listeners) listener.onError?.(message)
}

function applyServerSnapshot(state: TracksAccountState, snapshot: TracksSnapshot): void {
  state.lastRevision = snapshot.rev
  state.lastServerData = snapshot.data
  state.lastServerSignature = tracksSignature(snapshot.data)
  state.needsAuthoritativeRead = false
  const cachedServer = cachePeek<TracksSnapshot>(tracksServerKey(state.username))
  if (
    !cachedServer ||
    cachedServer.rev !== snapshot.rev ||
    !Array.isArray(cachedServer.data) ||
    tracksSignature(cachedServer.data) !== state.lastServerSignature
  ) {
    cacheSet(tracksServerKey(state.username), snapshot)
  }
  saveTracksCache(state.username, snapshot.data)
  notifyData(state, snapshot.data)
  notifyError(state, null)
}

function startFullRequest(state: TracksAccountState): void {
  if (state.fullRequest || state.pendingWrites > 0) {
    state.fullQueued = true
    return
  }

  state.fullQueued = false
  const requestId = ++state.nextRequestId
  state.latestRequestId = requestId
  // 开始一份全量快照时，同时淘汰更早发出的 revision 响应；否则旧 revision 可能在
  // 新快照落地后误报「版本变化」，白白再拉一次全量数据。
  const validationVersion = ++state.validationVersion
  state.lastFullStartedAt = Date.now()

  const request = fetchTracks()
    .then((snapshot) => {
      // 写入开始、跨标签缓存变化或 revision 变化都会让这次读取失效。即使请求较早发出、
      // 较晚返回，也没有资格覆盖当前乐观 UI；失效方已经排好下一次权威读取。
      if (
        requestId !== state.latestRequestId ||
        validationVersion !== state.validationVersion ||
        state.pendingWrites > 0
      ) return
      applyServerSnapshot(state, snapshot)
    })
    .catch((error: unknown) => {
      if (validationVersion !== state.validationVersion || state.pendingWrites > 0) return
      notifyError(state, error instanceof Error ? error.message : '追番数据读取失败')
    })
    .finally(() => {
      if (state.fullRequest === request) state.fullRequest = null
      if (state.fullQueued && state.pendingWrites === 0) startFullRequest(state)
    })

  state.fullRequest = request
}

/** 普通挂载 / 聚焦只需要保证有一次全量读取；已有请求就是这次校验，不再叠加。 */
function ensureFullRequest(state: TracksAccountState): void {
  if (state.fullRequest) return
  startFullRequest(state)
}

/** 写入或明确的新版本会使在途 GET 失效，并保证其后再发一次全量读取。 */
function invalidateAndRequestFull(state: TracksAccountState): void {
  state.validationVersion++
  state.fullQueued = true
  if (state.pendingWrites === 0 && !state.fullRequest) startFullRequest(state)
}

function restoreKnownServerData(state: TracksAccountState): void {
  if (!state.lastServerData) return
  state.needsAuthoritativeRead = false
  saveTracksCache(state.username, state.lastServerData)
  notifyData(state, state.lastServerData)
  notifyError(state, null)
}

function checkRevision(state: TracksAccountState): void {
  if (state.revisionRequest || state.fullRequest || state.pendingWrites > 0) return

  const validationVersion = state.validationVersion
  const request = fetchTracksRevision()
    .then((revision) => {
      if (validationVersion !== state.validationVersion || state.pendingWrites > 0) return
      if (state.lastRevision !== revision) {
        invalidateAndRequestFull(state)
        return
      }
      // 最后一个写入后的全量读取若恰好断网失败，15 秒轮询仍只发轻量 revision。
      // revision 没变说明服务器没有接纳那份乐观写入，可安全恢复上次权威快照；若变了，
      // 上面的分支会拉全量数据，覆盖「响应丢了但服务器其实写成功」的情况。
      if (state.needsAuthoritativeRead) {
        if (state.lastServerData) restoreKnownServerData(state)
        else invalidateAndRequestFull(state)
        return
      }
      notifyError(state, null)
    })
    .catch((error: unknown) => {
      if (validationVersion !== state.validationVersion || state.pendingWrites > 0) return
      notifyError(state, error instanceof Error ? error.message : '追番数据校验失败')
    })
    .finally(() => {
      if (state.revisionRequest === request) state.revisionRequest = null
    })

  state.revisionRequest = request
}

function parseStorageTracks(raw: string | null): Track[] | null {
  if (!raw) return null
  try {
    const entry = JSON.parse(raw) as { data?: unknown }
    return Array.isArray(entry.data) ? (entry.data as Track[]) : null
  } catch {
    return null
  }
}

function scheduleLifecycleRefresh(state: TracksAccountState): void {
  if (state.lifecycleTimer != null) return
  if (state.fullRequest) {
    // 刚发出的 full 足以覆盖同一批 focus / visible / pageshow；已运行较久的请求可能
    // 在本次聚焦前就取得了旧快照，必须废弃并在它结束后补一份 post-focus GET。
    if (
      Date.now() - state.lastFullStartedAt >= LIFECYCLE_COALESCE_MS &&
      !state.fullQueued
    ) invalidateAndRequestFull(state)
    return
  }
  if (Date.now() - state.lastFullStartedAt < LIFECYCLE_COALESCE_MS) return
  state.lifecycleTimer = window.setTimeout(() => {
    state.lifecycleTimer = null
    if (state.listeners.size) ensureFullRequest(state)
  }, 0)
}

function startMonitor(state: TracksAccountState): void {
  if (state.monitorCleanup || typeof window === 'undefined' || typeof document === 'undefined') return

  const onFocus = (): void => scheduleLifecycleRefresh(state)
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') scheduleLifecycleRefresh(state)
  }
  const onPageShow = (): void => scheduleLifecycleRefresh(state)
  const storageKey = `${TRACKS_STORAGE_PREFIX}${tracksKey(state.username)}`
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== storageKey) return
    const incoming = parseStorageTracks(event.newValue)
    // 权威 GET 在另一个标签写入同一快照时无需互相反复校验；真正不同的缓存（包括
    // 另一个标签的乐观更新）才会使当前读取失效并回服务器确认。
    if (incoming && tracksSignature(incoming) === state.lastServerSignature) return
    invalidateAndRequestFull(state)
  }
  const interval = window.setInterval(() => {
    if (document.visibilityState === 'visible') checkRevision(state)
  }, REVISION_INTERVAL_MS)

  window.addEventListener('focus', onFocus)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('storage', onStorage)
  document.addEventListener('visibilitychange', onVisible)
  state.monitorCleanup = () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('storage', onStorage)
    document.removeEventListener('visibilitychange', onVisible)
    window.clearInterval(interval)
    if (state.lifecycleTimer != null) window.clearTimeout(state.lifecycleTimer)
    state.lifecycleTimer = null
    state.monitorCleanup = null
  }
}

function stopMonitorIfIdle(state: TracksAccountState): void {
  if (state.listeners.size === 0) state.monitorCleanup?.()
}

/**
 * 把一次 PUT / DELETE 纳入账号级写入生命周期。最后一个连续写无论成功失败都会触发
 * 一次权威全量 GET；调用方不要再把单条写响应直接套回页面，避免旧响应覆盖后续操作。
 */
export async function runTracksMutation<T>(username: string, mutate: () => Promise<T>): Promise<T> {
  const state = stateFor(username)
  state.pendingWrites++
  state.needsAuthoritativeRead = true
  state.validationVersion++
  state.fullQueued = true
  // 不能只数「还有几个请求」：HTTP 请求并发时，后点的操作可能先落库、先点的操作反而
  // 最后覆盖服务器。队列继续执行失败后的下一项，但每个调用仍拿到自己的成功 / 失败。
  const result = state.writeTail.then(mutate)
  state.writeTail = result.then(
    () => undefined,
    () => undefined,
  )
  try {
    return await result
  } finally {
    state.pendingWrites--
    if (state.pendingWrites === 0) {
      state.fullQueued = true
      if (!state.fullRequest) startFullRequest(state)
    }
  }
}

/** 立刻用缓存喂一次 onData（如果有），随后后台拉最新数据并整份覆盖缓存与页面。
 * 页面挂载期间监听恢复前台、15 秒 revision 和其他标签缓存变化。返回取消订阅函数。 */
export function loadTracks(
  username: string,
  onData: (ts: Track[]) => void,
  onError?: (message: string | null) => void,
): () => void {
  const key = tracksKey(username)
  const state = stateFor(username)
  const listener = { onData, onError }
  state.listeners.add(listener)
  const cached = cachePeek<Track[]>(key)
  if (cached) onData(cached)
  startMonitor(state)
  ensureFullRequest(state)
  return () => {
    state.listeners.delete(listener)
    stopMonitorIfIdle(state)
  }
}

/**
 * 某个在线源的绑定：秒开缓存 + 后台整份覆盖。绑定是一次性动作、没有跨端冲突，
 * 直接覆盖即可。缓存 key 按源分开（`xifanBindings:` / `girigiriBindings:`）。
 */
export function loadBindings(
  source: SourceId,
  username: string,
  onData: (b: Record<number, SourceBinding>) => void,
): () => void {
  const key = bindingsKey(source, username)
  const cached = cachePeek<Record<number, SourceBinding>>(key)
  if (cached) onData(cached)

  let cancelled = false
  sourceById(source).fetchBindings()
    .then((b) => {
      if (cancelled) return
      cacheSet(key, b)
      onData(b)
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
  }
}

/** 乐观更新落地后，把最新状态直接写回缓存——不用等下次后台校验才追上。 */
export function saveTracksCache(username: string, ts: Track[]): void {
  const signature = tracksSignature(ts)
  const state = accountStates.get(username)
  // 权威 GET 已经收口后，React 上一帧迟到的乐观 effect 不能再把旧状态写回缓存。
  if (
    state &&
    !state.needsAuthoritativeRead &&
    state.lastServerSignature &&
    signature !== state.lastServerSignature
  ) return
  const cached = cachePeek<Track[]>(tracksKey(username))
  if (cached && tracksSignature(cached) === signature) return
  cacheSet(tracksKey(username), ts)
}
export function saveBindingsCache(source: SourceId, username: string, b: Record<number, SourceBinding>): void {
  cacheSet(bindingsKey(source, username), b)
}

// 追番数据的「秒开缓存 + 后台校验」—— 缓存只负责首屏立即可见，账号服务器才是跨设备的
// 唯一事实源。真实请求回来后整份覆盖缓存，不能拿 localStorage 的 updatedAt 反过来压服务器：
// 旧部署、设备时钟或中途关闭页面留下的未来时间戳，会让一台设备永久停在旧状态。
import {
  addSearchTrack,
  fetchTracks,
  fetchTracksRevision,
  SearchTrackAddHttpError,
  sourceById,
  type AnimeHit,
  type CalendarResult,
  type SourceBinding,
  type SourceId,
  type Track,
  type TracksSnapshot,
  type TracksLoadProgress,
} from './api'
import { auth, type AuthUser } from './auth'
import { cacheGet, cachePeek, cacheSet } from './dataCache'
import { toast } from './Toast'

const tracksKey = (username: string): string => `tracks:${username}`
const tracksServerKey = (username: string): string => `tracksServer:${username}`
// 缓存 key 保持不变：`xifanBindings:` / `girigiriBindings:`
const bindingsKey = (source: SourceId, username: string): string => `${source}Bindings:${username}`
const TRACKS_STORAGE_PREFIX = 'mt_cache:'
const REVISION_INTERVAL_MS = 3_000
const LIFECYCLE_COALESCE_MS = 500
const ADD_CHECK_WINDOW_MS = 120_000
const addCheckKey = (ownerId: number): string => `mapletools-add-check:${ownerId}`

function tracksSignature(tracks: Track[]): string {
  return JSON.stringify(tracks)
}

interface TracksListener {
  onData: (tracks: Track[]) => void
  onError?: (message: string | null) => void
  onProgress?: (progress: TracksLoadProgress | null) => void
  onTrackAdded?: (track: Track) => void
}

type TrackAccount = Pick<AuthUser, 'id' | 'username'>
export type SearchTrackAddStatus = 'sending' | 'checking' | 'confirmed'
type AddListener = (status: ReadonlyMap<number, SearchTrackAddStatus>) => void

interface AddRecovery {
  ownerId: number
  outstanding: Map<number, number>
  checking: Set<number>
}

interface TracksAccountState {
  username: string
  listeners: Set<TracksListener>
  /** 已排队或正在执行的写入总数。 */
  pendingWrites: number
  // 既有编辑仍保序；只新增的搜索请求只等同一部和整批操作。
  writeTail: Promise<void>
  trackWriteTails: Map<number, Promise<void>>
  bulkWriteTail: Promise<void> | null
  searchWrites: Map<number, Promise<void>>
  addRecovery: AddRecovery | null
  addListeners: Set<AddListener>
  addedWithoutSnapshot: Map<number, Track>
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
  lastViewRevision: number
  lastServerData: Track[] | null
  committedData: Track[] | null
  lastServerSignature: string | null
  monitorCleanup: (() => void) | null
  lifecycleTimer: number | null
  lastFullStartedAt: number
  readFailed: boolean
  progress: TracksLoadProgress | null
  partialData: Track[] | null
  fullController: AbortController | null
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
    trackWriteTails: new Map(),
    bulkWriteTail: null,
    searchWrites: new Map(),
    addRecovery: null,
    addListeners: new Set(),
    addedWithoutSnapshot: new Map(),
    validationVersion: 0,
    nextRequestId: 0,
    latestRequestId: 0,
    fullRequest: null,
    fullQueued: false,
    revisionRequest: null,
    needsAuthoritativeRead: false,
    lastRevision: hasValidServerCache ? cachedServer.rev : null,
    lastViewRevision: hasValidServerCache ? cachedServer.viewRev ?? 0 : 0,
    lastServerData: hasValidServerCache ? cachedServer.data : null,
    committedData: null,
    lastServerSignature: hasValidServerCache ? tracksSignature(cachedServer.data) : null,
    monitorCleanup: null,
    lifecycleTimer: null,
    lastFullStartedAt: 0,
    readFailed: false,
    progress: null,
    partialData: null,
    fullController: null,
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

function addRecoveryFor(state: TracksAccountState, ownerId: number): AddRecovery {
  if (state.addRecovery?.ownerId === ownerId) return state.addRecovery
  const outstanding = new Map<number, number>()
  try {
    const rows: [number, number][] = JSON.parse(sessionStorage.getItem(addCheckKey(ownerId)) ?? '[]')
    for (const [id, until] of rows) {
      if (Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(until) && until > Date.now()) {
        outstanding.set(id, until)
      }
    }
  } catch { /* 浏览器存储关闭或记录已损坏时，仍以正常的服务端列表为准 */ }
  return state.addRecovery = { ownerId, outstanding, checking: new Set(outstanding.keys()) }
}

function persistAddChecks(recovery: AddRecovery): void {
  const key = addCheckKey(recovery.ownerId)
  const live = [...recovery.outstanding].filter(([, until]) => until > Date.now())
  try {
    if (live.length) sessionStorage.setItem(key, JSON.stringify(live))
    else sessionStorage.removeItem(key)
  } catch { /* 回查记录不阻断用户的加番请求 */ }
}

function notifyAdds(state: TracksAccountState): void {
  const status = new Map<number, SearchTrackAddStatus>()
  for (const id of state.addedWithoutSnapshot.keys()) status.set(id, 'confirmed')
  const recovery = state.addRecovery
  if (recovery) {
    for (const id of recovery.checking) if ((recovery.outstanding.get(id) ?? 0) > Date.now()) status.set(id, 'checking')
  }
  for (const id of state.searchWrites.keys()) status.set(id, 'sending')
  for (const listener of state.addListeners) listener(status)
}

function finishAddCheck(state: TracksAccountState, snapshot?: TracksSnapshot): void {
  const recovery = state.addRecovery
  if (!recovery?.outstanding.size) return
  // 第一次读回可能抢在旧页写入前；未命中就交给正常的版本同步，不重发写入。
  recovery.checking.clear()
  const saved = snapshot && new Set(snapshot.data.map(track => track.bgmId))
  for (const [id, until] of recovery.outstanding) {
    if (saved?.has(id) || until <= Date.now()) recovery.outstanding.delete(id)
  }
  persistAddChecks(recovery)
  notifyAdds(state)
}

function applyServerSnapshot(state: TracksAccountState, snapshot: TracksSnapshot): void {
  state.committedData = null
  const hadUnmergedAdds = state.addedWithoutSnapshot.size > 0
  state.addedWithoutSnapshot.clear()
  state.progress = null
  state.partialData = null
  for (const listener of state.listeners) listener.onProgress?.(null)
  state.lastRevision = snapshot.rev
  state.lastViewRevision = snapshot.viewRev ?? 0
  state.readFailed = false
  state.lastServerData = snapshot.data
  state.lastServerSignature = tracksSignature(snapshot.data)
  state.needsAuthoritativeRead = false
  const cachedServer = cachePeek<TracksSnapshot>(tracksServerKey(state.username))
  if (
    !cachedServer ||
    cachedServer.rev !== snapshot.rev ||
    (cachedServer.viewRev ?? 0) !== (snapshot.viewRev ?? 0) ||
    !Array.isArray(cachedServer.data) ||
    tracksSignature(cachedServer.data) !== state.lastServerSignature
  ) {
    cacheSet(tracksServerKey(state.username), snapshot)
  }
  saveTracksCache(state.username, snapshot.data)
  notifyData(state, snapshot.data)
  finishAddCheck(state, snapshot)
  if (hadUnmergedAdds) notifyAdds(state)
  notifyError(state, null)
}

function startFullRequest(state: TracksAccountState): void {
  if (state.fullRequest || state.pendingWrites > 0) {
    state.fullQueued = true
    return
  }

  state.fullQueued = false
  notifyError(state, null)
  if (state.progress) {
    state.progress = { ...state.progress, loading: true }
    for (const listener of state.listeners) listener.onProgress?.(state.progress)
  }
  const requestId = ++state.nextRequestId
  state.latestRequestId = requestId
  // 开始一份全量快照时，同时淘汰更早发出的 revision 响应；否则旧 revision 可能在
  // 新快照落地后误报「版本变化」，白白再拉一次全量数据。
  const validationVersion = ++state.validationVersion
  state.lastFullStartedAt = Date.now()
  const controller = new AbortController()
  state.fullController = controller
  const onPartial = !state.lastServerData && !cachePeek<Track[]>(tracksKey(state.username)) ? (snapshot: TracksSnapshot, progress: TracksLoadProgress): void => {
    if (requestId !== state.latestRequestId || validationVersion !== state.validationVersion || state.pendingWrites > 0) return
    state.partialData = snapshot.data
    state.progress = progress
    for (const listener of state.listeners) {
      // 周历等只认完整集合；只有明确接收加载进度的页面才展示部分条目。
      if (!listener.onProgress) continue
      listener.onProgress(progress)
      listener.onData(snapshot.data)
    }
  } : undefined

  const owner = state.addRecovery?.ownerId
  const request = fetchTracks(onPartial, controller.signal, owner)
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
      state.readFailed = true
      finishAddCheck(state)
      if (state.progress) {
        state.progress = { ...state.progress, loading: false }
        for (const listener of state.listeners) listener.onProgress?.(state.progress)
      }
      notifyError(state, error instanceof Error ? error.message : '追番数据读取失败')
    })
    .finally(() => {
      if (state.fullRequest === request) state.fullRequest = null
      if (state.fullController === controller) state.fullController = null
      if (state.fullQueued && state.pendingWrites === 0) startFullRequest(state)
    })

  state.fullRequest = request
}

/** 普通挂载 / 聚焦只需要保证有一次全量读取；已有请求就是这次校验，不再叠加。 */
function ensureFullRequest(state: TracksAccountState): void {
  if (state.fullRequest) {
    if (state.fullController?.signal.aborted) state.fullQueued = true
    return
  }
  startFullRequest(state)
}

/** 写入或明确的新版本会使在途 GET 失效，并保证其后再发一次全量读取。 */
function invalidateAndRequestFull(state: TracksAccountState): void {
  state.validationVersion++
  state.fullQueued = true
  state.fullController?.abort()
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
  if (state.readFailed || state.revisionRequest || state.fullRequest || state.pendingWrites > 0) return

  const validationVersion = state.validationVersion
  const request = fetchTracksRevision()
    .then((revision) => {
      if (validationVersion !== state.validationVersion || state.pendingWrites > 0) return
      if (state.lastRevision !== revision.rev || state.lastViewRevision !== revision.viewRev) {
        invalidateAndRequestFull(state)
        return
      }
      // 尚未确认的乐观修改不能长期充当事实；版本未变时恢复权威快照，
      // 版本变化则由上面的分支重新读取，覆盖“写成功但响应丢失”的情况。
      if (state.needsAuthoritativeRead) {
        if (state.lastServerData) restoreKnownServerData(state)
        else invalidateAndRequestFull(state)
        return
      }
      notifyError(state, null)
    })
    .catch((error: unknown) => {
      if (validationVersion !== state.validationVersion || state.pendingWrites > 0) return
      state.readFailed = true
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
  if (state.fullRequest) return
  if (Date.now() - state.lastFullStartedAt < LIFECYCLE_COALESCE_MS) return
  state.lifecycleTimer = window.setTimeout(() => {
    state.lifecycleTimer = null
    if (state.listeners.size) {
      state.readFailed = false
      if (state.lastServerData && !state.needsAuthoritativeRead) checkRevision(state)
      else ensureFullRequest(state)
    }
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
  window.addEventListener('online', onFocus)
  window.addEventListener('storage', onStorage)
  document.addEventListener('visibilitychange', onVisible)
  state.monitorCleanup = () => {
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('online', onFocus)
    window.removeEventListener('storage', onStorage)
    document.removeEventListener('visibilitychange', onVisible)
    window.clearInterval(interval)
    if (state.lifecycleTimer != null) window.clearTimeout(state.lifecycleTimer)
    state.lifecycleTimer = null
    state.monitorCleanup = null
  }
}

function stopMonitorIfIdle(state: TracksAccountState): void {
  if (state.listeners.size !== 0) return
  state.monitorCleanup?.()
  if (state.fullRequest && state.pendingWrites === 0) {
    state.validationVersion++
    state.fullQueued = false
    state.fullController?.abort()
    if (state.progress) state.progress = { ...state.progress, loading: false }
  }
}

function beginWrite(state: TracksAccountState): void {
  state.pendingWrites++
  state.needsAuthoritativeRead = true
  state.validationVersion++
  state.fullController?.abort()
  state.fullQueued = true
}

function finishWrite(state: TracksAccountState): void {
  state.pendingWrites--
  if (state.pendingWrites !== 0) return
  if (state.committedData) {
    saveTracksCache(state.username, state.committedData)
    notifyData(state, state.committedData)
  }
  state.fullQueued = true
  if (!state.fullRequest) startFullRequest(state)
}

function queueTracksMutation<T>(
  state: TracksAccountState,
  bgmId: number | null,
  mutate: () => Promise<T>,
  update?: (tracks: Track[], result: T) => Track[],
): Promise<T> {
  const adds = bgmId === null ? [...state.searchWrites.values()] : [state.searchWrites.get(bgmId)]
  beginWrite(state)
  const result = Promise.all([state.writeTail, ...adds]).then(async () => {
    const value = await mutate()
    const base = state.committedData ?? state.lastServerData
    // 只有完整快照才能合并单条成功响应，首批流式数据不能冒充完整列表。
    if (update && base) state.committedData = update(base, value)
    return value
  }).finally(() => {
    if (bgmId === null) {
      if (state.bulkWriteTail === tail) state.bulkWriteTail = null
    } else if (state.trackWriteTails.get(bgmId) === tail) state.trackWriteTails.delete(bgmId)
    finishWrite(state)
  })
  const tail = result.then(() => undefined, () => undefined)
  state.writeTail = tail
  if (bgmId === null) state.bulkWriteTail = tail
  else state.trackWriteTails.set(bgmId, tail)
  return result
}

export function runTracksMutation<T>(username: string, mutate: () => Promise<T>): Promise<T> {
  return queueTracksMutation(stateFor(username), null, mutate)
}

export function mergeTrack(tracks: Track[], saved: Track): Track[] {
  return tracks.some(track => track.bgmId === saved.bgmId)
    ? tracks.map(track => track.bgmId === saved.bgmId ? saved : track)
    : [saved, ...tracks]
}

export function runTrackMutation(
  username: string,
  bgmId: number,
  mutate: () => Promise<Track | void>,
): Promise<Track | void> {
  const state = stateFor(username)
  return queueTracksMutation(state, bgmId, async () => {
    const saved = await mutate()
    if (state.addedWithoutSnapshot.delete(bgmId)) notifyAdds(state)
    return saved
  }, (tracks, saved) => {
    return saved ? mergeTrack(tracks, saved) : tracks.filter(track => track.bgmId !== bgmId)
  })
}

export function watchSearchTrackAdds(account: TrackAccount, onChange: AddListener): () => void {
  const state = stateFor(account.username)
  addRecoveryFor(state, account.id)
  state.addListeners.add(onChange)
  notifyAdds(state)
  return () => { state.addListeners.delete(onChange) }
}

export function runSearchTrackAdd(account: TrackAccount, hit: AnimeHit): void {
  const state = stateFor(account.username)
  const id = hit.bgmId
  if (state.searchWrites.has(id) || auth.user?.id !== account.id) return
  const name = `『${hit.nameCn || hit.name}』`
  const offline = (): boolean => {
    if (navigator.onLine !== false) return false
    toast(`${name}加入失败：网络已断开`, { err: true })
    return true
  }
  if (offline()) return

  const recovery = addRecoveryFor(state, account.id)
  const clearCheck = (): void => {
    recovery.outstanding.delete(id)
    recovery.checking.delete(id)
    persistAddChecks(recovery)
  }
  const send = async (): Promise<void> => {
    if (auth.user?.id !== account.id || offline()) return
    recovery.outstanding.set(id, Date.now() + ADD_CHECK_WINDOW_MS)
    persistAddChecks(recovery)
    let saved: Track
    try {
      const calendar = cacheGet<CalendarResult>('calendar', 14 * 24 * 60 * 60_000)
      const day = calendar?.data.find(entry => entry.items.some(item => item.id === id))
      const cover = day?.items.find(item => item.id === id)?.cover
      saved = await addSearchTrack(account.id, hit, {
        ...(cover ? { cover } : {}), ...(day ? { airWeekday: day.id } : {}),
      })
    } catch (error) {
      const http = error instanceof SearchTrackAddHttpError ? error : null
      if (http?.rejected) clearCheck()
      else if (navigator.onLine !== false) recovery.checking.add(id)
      if (auth.user?.id === account.id) {
        const detail = http?.message ?? (navigator.onLine === false ? '网络已断开' : '没收到保存回执')
        toast(`${name}${http?.rejected ? '加入失败' : '暂未确认加入'}：${detail}`, { err: true })
      }
      return
    }

    clearCheck()
    const base = state.committedData ?? state.lastServerData
    if (base) state.committedData = mergeTrack(base, saved)
    // 同一部已经排了修改或删除时，旧回执只更新确认底稿，不盖掉后一个操作的界面。
    if (state.trackWriteTails.has(id)) return
    if (!base) state.addedWithoutSnapshot.set(id, saved)
    for (const listener of state.listeners) listener.onTrackAdded?.(saved)
  }

  const previous = [state.trackWriteTails.get(id), state.bulkWriteTail].filter(Boolean)
  beginWrite(state)
  const result = (previous.length ? Promise.all(previous).then(send) : send()).finally(() => {
    state.searchWrites.delete(id)
    notifyAdds(state)
    finishWrite(state)
  })
  state.searchWrites.set(id, result)
  notifyAdds(state)
}

// 有权威缓存时先检查 revision，只有版本变化才拉全量；读取失败后停止定时检查，
// 由重新进入页面、恢复前台或 online 事件触发下一次校验。
export function loadTracks(
  username: string,
  onData: (ts: Track[]) => void,
  onError?: (message: string | null) => void,
  onProgress?: (progress: TracksLoadProgress | null) => void,
  onTrackAdded?: (track: Track) => void,
): () => void {
  const key = tracksKey(username)
  const state = stateFor(username)
  const account = auth.user
  if (account?.username === username) addRecoveryFor(state, account.id)
  const listener = { onData, onError, onProgress, onTrackAdded }
  state.listeners.add(listener)
  // 重启前未完成的乐观写入可能留在普通缓存里；有权威快照时优先展示它。
  const cached = state.committedData ?? (!state.needsAuthoritativeRead ? state.lastServerData : null) ?? cachePeek<Track[]>(key)
  if (cached) onData(cached)
  else if (onProgress && state.partialData) onData(state.partialData)
  if (!state.committedData && !state.lastServerData) {
    for (const track of state.addedWithoutSnapshot.values()) onTrackAdded?.(track)
  }
  onProgress?.(state.progress)
  startMonitor(state)
  state.readFailed = false
  if (cached && state.lastServerData && !state.needsAuthoritativeRead && !state.addRecovery?.checking.size) checkRevision(state)
  else ensureFullRequest(state)
  return () => {
    state.listeners.delete(listener)
    stopMonitorIfIdle(state)
  }
}

export function reloadTracks(username: string): void {
  const state = stateFor(username)
  state.readFailed = false
  invalidateAndRequestFull(state)
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
  if (state?.partialData) return
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

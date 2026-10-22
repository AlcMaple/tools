import { app, BrowserWindow, powerMonitor } from 'electron'
import { existsSync, watch, type FSWatcher } from 'fs'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { onWebAccountChange, readWebAccount, webAccountLines } from '../ipc/webAccount'
import { logError, logInfo } from '../shared/logger'
import { WebRequestError } from '../shared/net-lines'
import { JudgeFileSync } from './sync-core'
import { judgeRemote, remoteSnapshot, remoteWrite } from './remote'
import type { JudgePaths, JudgeSyncEvent, JudgeSyncState } from '../../../web/shared/order-judge-api'

interface JudgeSyncDisk { deviceId: string }
export interface JudgeSyncOptions { shared: boolean }
export interface JudgeSyncStatus { state: 'disabled' | 'starting' | 'synced' | 'error'; message: string; at: number | null }
let options: JudgeSyncOptions = { shared: false }
let status: JudgeSyncStatus = { state: 'disabled', message: '', at: null }
let generation = 0, owner: AbortController | null = null, core: JudgeFileSync | null = null
let watchers: FSWatcher[] = [], debounce: ReturnType<typeof setTimeout> | undefined, reconnect: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | undefined, checking: Promise<JudgeSyncState> | null = null, paused: Error | null = null
let diskWrite: Promise<void> = Promise.resolve()
let requested = false
let latest: JudgeSyncState | null = null, watchedKey = ''

export const getJudgeSyncStatus = (): JudgeSyncStatus => ({ ...status })
export const latestJudgeState = (): JudgeSyncState | null => latest
export function notifyJudgeChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('order-judge:changed')
}

function update(next: JudgeSyncStatus): void {
  if (next.state !== status.state || next.message !== status.message) logInfo('order-judge:sync', `${next.state} ${next.message}`)
  status = next; notifyJudgeChanged()
}

export async function syncJudgeNow(): Promise<JudgeSyncState> {
  if (paused) throw paused
  if (!core) return remoteSnapshot(owner?.signal)
  requested = true
  if (checking) return checking
  const current = generation, target = core
  const task = (async () => {
    let snapshot: JudgeSyncState
    do {
      requested = false
      snapshot = await target.sync()
      if (current !== generation) throw new Error('SYNC_CANCELLED')
    } while (requested)
    latest = snapshot; rewatch(snapshot.paths)
    update({ state: 'synced', message: '已同步', at: Date.now() })
    return snapshot
  })().catch((error: unknown) => {
    if (current === generation) {
      requested = false; paused = error instanceof Error ? error : new Error(String(error))
      logError('order-judge:sync', error)
      update({ state: 'error', message: paused.message, at: status.at })
    }
    throw error
  }).finally(() => { if (checking === task) checking = null })
  checking = task
  return task
}

function stopOwner(): void {
  generation++; owner?.abort(); owner = null; core?.stop(); core = null; checking = null
  clearTimeout(debounce); clearTimeout(reconnect)
  for (const watcher of watchers) watcher.close()
  watchers = []; watchedKey = ''; paused = null; requested = false
}

export async function configureJudgeSync(next: JudgeSyncOptions): Promise<void> {
  options = { ...next }; stopOwner()
  if (!unsubscribe) {
    unsubscribe = onWebAccountChange(() => { void configureJudgeSync(options).catch(error => logError('order-judge:sync-account', error)) })
    powerMonitor.on('resume', resume)
  }
  if (!options.shared) { latest = null; update({ state: 'disabled', message: '', at: null }); return }
  const current = generation, account = await readWebAccount()
  if (current !== generation) return
  if (!account.token) { update({ state: 'error', message: '请先在设置中登录网页版账号。', at: null }); return }
  const controller = new AbortController(); owner = controller
  update({ state: 'starting', message: '正在核对资料…', at: status.at })
  try {
    await diskWrite.catch(() => {})
    if (current !== generation) return
    // 只存本机设备 ID（评估前点名要认出是哪台电脑）；旧版留下的 bindings 字段直接忽略。
    const file = join(app.getPath('userData'), 'order-judge-sync.json')
    let disk: JudgeSyncDisk | null = null
    try { disk = JSON.parse(await readFile(file, 'utf8')) as JudgeSyncDisk }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') logError('order-judge:device-id', error)
    }
    if (typeof disk?.deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(disk.deviceId)) {
      const fresh: JudgeSyncDisk = { deviceId: randomUUID() }, data = JSON.stringify(fresh)
      diskWrite = diskWrite.catch(() => {}).then(async () => {
        await mkdir(dirname(file), { recursive: true }); await writeFile(file + '.tmp', data); await rename(file + '.tmp', file)
      })
      await diskWrite
      disk = fresh
    }
    const deviceId = disk.deviceId
    if (current !== generation) return
    core = new JudgeFileSync({
      label: process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : '电脑',
      transport: { snapshot: () => remoteSnapshot(controller.signal), write: (kind, input) => remoteWrite(kind, input, controller.signal) },
    })
    try { await syncJudgeNow() } catch { /* 错误已记录；保持连接，以便评估屏障收到明确失败。 */ }
    if (current !== generation) return
    let attempt = 0
    const connect = async (): Promise<void> => {
      if (current !== generation) return
      try {
        await webAccountLines('/api/order-judge/sync/events?deviceId=' + deviceId, undefined, controller.signal, raw => {
          const event = raw as JudgeSyncEvent
          if (event.type === 'check') {
            void (async () => {
              let error: string | undefined
              try { await syncJudgeNow() } catch (e) { error = e instanceof Error ? e.message : String(e) }
              if (current !== generation) return
              await judgeRemote(`/sync/check/${event.id}`, 'POST', { deviceId, error }, controller.signal)
            })().catch(error => { if (current === generation) logError('order-judge:check', error) })
          } else if (event.type === 'ready' || event.type === 'changed') {
            notifyJudgeChanged()
            if (event.type === 'ready' && paused instanceof WebRequestError && paused.code === 'NETWORK') paused = null
            if (!paused) void syncJudgeNow().catch(() => {})
          }
        })
        if (current === generation) throw new WebRequestError('NETWORK', '同步连接已断开。')
      } catch (error) {
        if (current !== generation || controller.signal.aborted) return
        logError('order-judge:events', error)
        update({ state: 'error', message: error instanceof Error ? error.message : String(error), at: status.at })
        if (error instanceof WebRequestError && error.code === 'NETWORK' && attempt++ < 2) reconnect = setTimeout(() => void connect(), 700 * attempt + Math.random() * 500)
      }
    }
    void connect()
  } catch (error) {
    if (current !== generation) return
    paused = error instanceof Error ? error : new Error(String(error)); logError('order-judge:sync-start', error)
    update({ state: 'error', message: paused.message, at: status.at })
  }
}

// 路径列表由网站下发，变了才重建监听；另一台电脑的路径在本机不存在是常态，跳过即可。
function rewatch(paths: JudgePaths): void {
  const list = [...paths.profile, ...paths.log].map(p => p.path), key = JSON.stringify(list)
  if (key === watchedKey) return
  for (const watcher of watchers) watcher.close()
  watchers = []; watchedKey = key
  const current = generation, groups = new Map<string, Set<string>>()
  for (const path of list) {
    const names = groups.get(dirname(path)) ?? new Set<string>(); names.add(basename(path)); groups.set(dirname(path), names)
  }
  for (const [folder, names] of groups) {
    if (!existsSync(folder)) continue
    const watcher = watch(folder, (_event, name) => {
      if (name && !names.has(name.toString())) return
      if (paused && 'sourceRead' in paused && paused.sourceRead === true) paused = null
      clearTimeout(debounce)
      debounce = setTimeout(() => { if (!paused && current === generation) void syncJudgeNow().catch(() => {}) }, 300)
    })
    watcher.on('error', error => { paused = error; logError('order-judge:watch', error); update({ state: 'error', message: '源文件目录监听失败，请重新选择文件。', at: status.at }) })
    watchers.push(watcher)
  }
}

function resume(): void {
  if (paused && !(paused instanceof WebRequestError && paused.code === 'NETWORK') && !('sourceRead' in paused && paused.sourceRead === true)) return
  void configureJudgeSync(options).catch(error => logError('order-judge:sync-resume', error))
}

export function stopJudgeSync(): void {
  stopOwner(); unsubscribe?.(); unsubscribe = undefined; powerMonitor.removeListener('resume', resume)
}

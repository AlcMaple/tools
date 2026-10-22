// 评估一律走网站：AI 跟随网页账号设置（默认服务器 AI，网页里改成自己的 key 就用用户的），
// 资料与历史也只在网站上存一份。桌面只负责按路径列表读本机文件并上传；未开启共用时只能查看旧的本机历史。
// 材料预处理（截图缩放、长图切块、视频取帧、PDF / Word 取字）在渲染进程里做完，这里只收文字和 JPEG。

import { app } from 'electron'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { JsonStore } from '../shared/json-store'
import { logError, logInfo } from '../shared/logger'
import { readWebAccount, WEB_BASE } from '../ipc/webAccount'
import { configureJudgeSync, getJudgeSyncStatus, latestJudgeState, syncJudgeNow, type JudgeSyncStatus } from './sync-manager'
import { judgeRemote, remoteJudge, remoteSnapshot, remoteState } from './remote'
import { MAX_IMAGES, type JudgeReport } from '../../../web/shared/order-judge'
import { MAX_JUDGE_PATHS, type JudgePath, type JudgePaths } from '../../../web/shared/order-judge-api'

// ── 设置 ──

type DocWhich = 'profile' | 'log'
// paths 只在未开启共用时使用；开启共用那一刻并进账号，之后以网站上的列表为准。
interface Settings {
  shared: boolean
  paths: Record<DocWhich, string[]>
  historyImported: boolean
}

export const DEVICE_LABEL = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : '电脑'

const settingsStore = new JsonStore<Settings>('order-judge-settings.json', (raw) => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const old = (r.paths && typeof r.paths === 'object' ? r.paths : {}) as Record<string, unknown>
  const list = (...candidates: unknown[]): string[] => {
    const items = candidates.flatMap(value => Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [])
    return [...new Set(items.filter((x): x is string => typeof x === 'string' && x.length > 0))].slice(0, MAX_JUDGE_PATHS)
  }
  return {
    shared: r.shared === true,
    paths: { profile: list(old.profile, r.profilePaths, r.profilePath), log: list(old.log, r.logPaths, r.logPath) },
    historyImported: r.historyImported === true,
  }
})

export interface PathView { path: string; device: string; exists: boolean; active: boolean; updatedAt: number | null }

export interface SettingsView {
  shared: boolean
  hasWebAccount: boolean
  webUsername: string
  sync: JudgeSyncStatus
  paths: Record<DocWhich, PathView[]>
}

async function currentPaths(s: Settings): Promise<JudgePaths> {
  if (s.shared && (await readWebAccount()).token) {
    const latest = latestJudgeState() ?? await remoteSnapshot().catch(() => null)
    if (latest) return latest.paths
  }
  return { profile: s.paths.profile.map(path => ({ path, device: DEVICE_LABEL })), log: s.paths.log.map(path => ({ path, device: DEVICE_LABEL })) }
}

export async function getSettings(): Promise<SettingsView> {
  const s = await settingsStore.read()
  const paths = await currentPaths(s)
  const view = async (list: JudgePath[]): Promise<PathView[]> => {
    const rows = await Promise.all(list.map(async ({ path, device, upload }) => {
      if (upload) return { path, device, exists: true, active: false, updatedAt: upload.updatedAt }
      try { const info = await stat(path); return { path, device, exists: info.isFile(), active: false, updatedAt: info.mtimeMs } }
      catch { return { path, device, exists: false, active: false, updatedAt: null } }
    }))
    const first = rows.find(row => row.exists)
    if (first) first.active = true
    return rows
  }
  const account = await readWebAccount()
  return { shared: s.shared, hasWebAccount: !!account.token, webUsername: account.username, sync: getJudgeSyncStatus(), paths: { profile: await view(paths.profile), log: await view(paths.log) } }
}

export async function initializeJudgeSync(): Promise<void> { await configureJudgeSync({ shared: (await settingsStore.read()).shared }) }

// 开启共用：本机路径并进账号（追加，不覆盖别的电脑加的），旧的本机历史自动上传一次。
export async function setSharedMode(shared: boolean): Promise<SettingsView> {
  const settings = await settingsStore.read()
  if (shared) {
    if (!(await readWebAccount()).token) throw new Error('请先在应用设置中登录网页版账号。')
    await remoteSnapshot()
    const mine = (kind: DocWhich): JudgePath[] => settings.paths[kind].map(path => ({ path, device: DEVICE_LABEL }))
    await judgeRemote('/paths/merge', 'POST', { profile: mine('profile'), log: mine('log') })
  }
  settingsStore.update(s => { s.shared = shared })
  await initializeJudgeSync()
  if (shared && !settings.historyImported) await uploadLocalHistory()
  return getSettings()
}

async function uploadLocalHistory(): Promise<void> {
  if (!(await historyStore.read()).length) { settingsStore.update(s => { s.historyImported = true }); return }
  try {
    const result = await importLocalJudgeHistory()
    settingsStore.update(s => { s.historyImported = true })
    logInfo('order-judge:import', `本机历史自动上传：导入 ${result.imported} 条，跳过 ${result.skipped} 条`)
  } catch (error) {
    // 共用已开启，上传失败不回退开关；原记录和备份都保留，下次开启或重启时再试。
    logError('order-judge:import', error)
    throw new Error(`已开启共用，但本机历史没有全部上传：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function historyBase(): Promise<string> {
  if (!(await settingsStore.read()).shared) return historyRoot()
  return `archivist://judge/${(await readWebAccount()).accountId}`
}
export const judgeWebsite = (): string => WEB_BASE + '/#/judge'

async function editPaths(which: DocWhich, change: (list: JudgePath[]) => JudgePath[]): Promise<void> {
  const s = await settingsStore.read()
  if (s.shared && (await readWebAccount()).token) {
    const paths = await currentPaths(s)
    await judgeRemote(`/paths/${which}`, 'PUT', { paths: change(paths[which]) })
    await syncJudgeNow().catch(error => logError('order-judge:paths', error))
    return
  }
  const next = change(s.paths[which].map(path => ({ path, device: DEVICE_LABEL }))).map(p => p.path)
  settingsStore.update(x => { x.paths[which] = next })
}

export async function addPath(which: DocWhich, path: string): Promise<void> {
  await editPaths(which, list => {
    if (list.some(p => p.path === path)) return list
    if (list.length >= MAX_JUDGE_PATHS) throw new Error(`每类资料最多 ${MAX_JUDGE_PATHS} 个路径。`)
    return [...list, { path, device: DEVICE_LABEL }]
  })
}

export async function removePath(which: DocWhich, index: number): Promise<void> {
  await editPaths(which, list => list.filter((_, i) => i !== index))
}

export async function movePath(which: DocWhich, index: number, offset: -1 | 1): Promise<void> {
  await editPaths(which, list => {
    const next = [...list], target = index + offset
    if (index < 0 || index >= next.length || target < 0 || target >= next.length) return list
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  })
}

// ── 历史 ──

export interface HistoryEntry {
  id: string
  at: number
  report: JudgeReport
  order: string
  images: { file: string; name: string }[]
}

const historyStore = new JsonStore<HistoryEntry[]>('order-judge-history.json', (raw) =>
  Array.isArray(raw) ? (raw as HistoryEntry[]).filter((x) => x && typeof x.id === 'string') : [])

const ID_RE = /^[0-9a-f-]{36}$/

function historyRoot(): string {
  return join(app.getPath('userData'), 'order-judge')
}

export async function listHistory(): Promise<HistoryEntry[]> {
  if ((await settingsStore.read()).shared) {
    if (!(await readWebAccount()).accountId) await remoteSnapshot()
    return (await remoteState()).history
  }
  return historyStore.read()
}

export function historyDir(): string {
  return historyRoot()
}

export async function importLocalJudgeHistory(): Promise<{ imported: number; skipped: number; backupPath: string }> {
  if (!(await settingsStore.read()).shared) throw new Error('请先启用共享评估，再明确导入本机历史。')
  const entries = await historyStore.read(), backupPath = join(app.getPath('userData'), 'order-judge-migration', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
  await mkdir(backupPath, { recursive: true })
  const original = join(app.getPath('userData'), 'order-judge-history.json')
  const raw = await readFile(original).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return Buffer.from(JSON.stringify(entries)); throw error })
  await writeFile(join(backupPath, 'order-judge-history.json'), raw)
  try { await cp(historyRoot(), join(backupPath, 'order-judge'), { recursive: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  if (hash(raw) !== hash(await readFile(join(backupPath, 'order-judge-history.json')))) throw new Error('本机历史备份校验失败，尚未导入。')
  for (const entry of entries) {
    if (!ID_RE.test(entry.id)) throw new Error('本机历史标识无效，原记录保留。')
    for (const image of entry.images) {
      if (!/^\d{2}\.jpg$/.test(image.file)) throw new Error('本机历史图片名无效。')
      if (hash(await readFile(join(historyRoot(), entry.id, image.file))) !== hash(await readFile(join(backupPath, 'order-judge', entry.id, image.file)))) throw new Error('本机图片备份校验失败，尚未开始导入。')
    }
  }
  let imported = 0, skipped = 0
  for (const entry of entries) {
    if (!ID_RE.test(entry.id)) throw new Error('本机历史标识无效，原记录与备份均保留。')
    const images: { name: string; dataUrl: string }[] = []
    for (const image of entry.images) {
      if (!/^\d{2}\.jpg$/.test(image.file)) throw new Error('本机历史图片名无效，尚未导入这条记录。')
      const bytes = await readFile(join(backupPath, 'order-judge', entry.id, image.file))
      images.push({ name: image.name, dataUrl: 'data:image/jpeg;base64,' + bytes.toString('base64') })
    }
    const input = { sourceId: entry.id, at: entry.at, report: entry.report, text: entry.order, images }
    if (Buffer.byteLength(JSON.stringify(input)) > 20 * 1024 * 1024) throw new Error(`单条历史超过 20 MB；已导入 ${imported} 条，其余原记录和备份保留。`)
    try {
      const result = await judgeRemote<{ imported: boolean }>('/history/import', 'POST', input)
      if (result.imported) imported++; else skipped++
    } catch (cause) { throw Object.assign(new Error(`已导入 ${imported} 条、跳过 ${skipped} 条；原记录和备份保留。${cause instanceof Error ? cause.message : String(cause)}`), { cause }) }
  }
  logInfo('order-judge:import', `导入 ${imported} 条，跳过 ${skipped} 条；备份 ${backupPath}`)
  return { imported, skipped, backupPath }
}

export async function deleteHistory(id: string): Promise<void> {
  if (!ID_RE.test(id)) return
  if ((await settingsStore.read()).shared) { await judgeRemote(`/history/${id}`, 'DELETE'); return }
  const list = await historyStore.read()
  historyStore.set(list.filter((x) => x.id !== id))
  await rm(join(historyRoot(), id), { recursive: true, force: true })
}

// ── 评估 ──

export type JudgeErrorCode = 'NEED_WEB' | 'BAD_INPUT' | 'SHARED_ERROR'

export type JudgeResult =
  | { ok: true; entry: HistoryEntry; warnings: string[] }
  | { ok: false; code: JudgeErrorCode; detail?: string }

export interface JudgeInput {
  text: string
  images: { name: string; dataUrl: string }[]
}

export type JudgeProgress = { stage: 'links'; count: number } | { stage: 'ai' }

const DATA_URL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/

export async function judge(input: JudgeInput, onProgress: (p: JudgeProgress) => void): Promise<JudgeResult> {
  const text = typeof input?.text === 'string' ? input.text : ''
  const images = Array.isArray(input?.images) ? input.images : []
  if (images.length > MAX_IMAGES || images.some((x) => typeof x?.name !== 'string' || typeof x?.dataUrl !== 'string' || !DATA_URL_RE.test(x.dataUrl))) {
    return { ok: false, code: 'BAD_INPUT' }
  }
  if (!(await settingsStore.read()).shared || !(await readWebAccount()).token) return { ok: false, code: 'NEED_WEB' }
  try {
    await syncJudgeNow()
    const entry = await remoteJudge({ text, images }, onProgress, new AbortController().signal)
    return { ok: true, entry, warnings: [] }
  } catch (e) {
    logError('order-judge:shared', e)
    return { ok: false, code: 'SHARED_ERROR', detail: e instanceof Error ? e.message : String(e) }
  }
}

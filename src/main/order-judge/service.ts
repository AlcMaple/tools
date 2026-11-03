// 接单评估一律走网站：项目和版本只在网页账号里存一份，AI 跟随网页账号设置。
// 材料预处理（截图缩放、长图切块、视频取帧、PDF / Word 取字）在渲染进程里做完，这里只转发文字、JPEG 和附件。

import { app } from 'electron'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { authedRequest, onWebAccountChange, readWebAccount, webAccountLines, WEB_BASE } from '../ipc/webAccount'
import { WebRequestError } from '../shared/net-lines'
import { logError, logInfo } from '../shared/logger'
import { MAX_IMAGES } from '../../../web/shared/order-judge'
import { normalizeQuote } from '../../../web/shared/order-judge-sheet'
import { ATTACH_MAX_FILES, type JudgeEvent, type JudgeState, type Project } from '../../../web/shared/order-judge-api'

const ID_RE = /^[0-9a-f-]{36}$/
const DATA_URL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/
const BASE64_RE = /^[A-Za-z0-9+/=]*$/

const active = new Set<AbortController>()
export function stopJudgeRequests(): void { for (const controller of active) controller.abort(); active.clear() }
onWebAccountChange(stopJudgeRequests)

export const judgeWebsite = (): string => WEB_BASE + '/#/judge'

// 2026-11 重做前桌面在本机留的设置、历史、截图、迁移备份和同步状态；用户决定旧数据全部删除
export async function removeRetiredJudgeData(): Promise<void> {
  const dir = app.getPath('userData')
  const names = ['order-judge-settings.json', 'order-judge-history.json', 'order-judge-sync.json', 'order-judge', 'order-judge-migration']
  const found = names.map(name => join(dir, name)).filter(path => existsSync(path))
  if (!found.length) return
  await Promise.all(found.map(path => rm(path, { recursive: true, force: true })))
  logInfo('order-judge', `已删除重做前的本机接单评估数据：${found.join(', ')}`)
}

async function remote<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await authedRequest('/api/order-judge' + path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
  let value: T & { code?: string; error?: string }
  try { value = JSON.parse(response.body.toString('utf8')) as typeof value }
  catch { throw new WebRequestError('BAD_RESPONSE', '网站接单评估接口还没更新', response.status) }
  if (response.status < 200 || response.status >= 300) throw new WebRequestError(value.code ?? `HTTP_${response.status}`, value.error ?? `网站返回 HTTP ${response.status}`, response.status)
  return value
}

export interface JudgeView { loggedIn: boolean; username: string; accountId: number; projects: Project[] }

export async function loadProjects(): Promise<JudgeView> {
  const account = await readWebAccount()
  if (!account.token) return { loggedIn: false, username: '', accountId: 0, projects: [] }
  const state = await remote<JudgeState>('')
  return { loggedIn: true, username: account.username, accountId: account.accountId, projects: state.projects }
}

export async function deleteProject(id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error('项目标识无效')
  await remote(`/projects/${id}`, 'DELETE')
}

export async function saveQuote(versionId: string, quote: unknown): Promise<Project> {
  if (!ID_RE.test(versionId)) throw new Error('版本标识无效')
  return (await remote<{ project: Project }>(`/versions/${versionId}/quote`, 'PUT', normalizeQuote(quote))).project
}

export async function versionImage(uid: string, id: string, file: string): Promise<Buffer> {
  if (!/^[0-9]+$/.test(uid) || !ID_RE.test(id) || !/^\d{2}\.jpg$/.test(file) || Number(uid) !== (await readWebAccount()).accountId) throw new Error('INVALID_JUDGE_IMAGE')
  const response = await authedRequest(`/api/order-judge/versions/${id}/${file}`)
  if (response.status !== 200) throw new Error(`截图读取失败（HTTP ${response.status}）`)
  return response.body
}

export interface OrganizeInput {
  projectId: string | null
  text: string
  images: { name: string; dataUrl: string }[]
  files: { name: string; data: string }[]
}

export type OrganizeStage = Extract<JudgeEvent, { type: 'stage' }>

export type OrganizeResult =
  | { ok: true; project: Project }
  | { ok: false; code: string; error: string }

// projectId 为 null 是新项目，否则给这个项目追加一个版本
export async function organize(input: OrganizeInput, onStage: (stage: OrganizeStage) => void): Promise<OrganizeResult> {
  const text = typeof input?.text === 'string' ? input.text : ''
  const images = Array.isArray(input?.images) ? input.images : []
  const files = Array.isArray(input?.files) ? input.files : []
  const projectId = input?.projectId ?? null
  if ((projectId !== null && (typeof projectId !== 'string' || !ID_RE.test(projectId)))
    || images.length > MAX_IMAGES || images.some(x => typeof x?.name !== 'string' || typeof x?.dataUrl !== 'string' || !DATA_URL_RE.test(x.dataUrl))
    || files.length > ATTACH_MAX_FILES || files.some(x => typeof x?.name !== 'string' || typeof x?.data !== 'string' || !BASE64_RE.test(x.data))) {
    return { ok: false, code: 'BAD_INPUT', error: '材料没有通过检查，清空后重新放一次' }
  }
  if (!(await readWebAccount()).token) return { ok: false, code: 'AUTH_REQUIRED', error: '请先在应用设置里登录网页版账号' }
  const controller = new AbortController()
  active.add(controller)
  let project: Project | null = null
  try {
    const path = projectId ? `/api/order-judge/projects/${projectId}/versions` : '/api/order-judge/projects'
    await webAccountLines(path, JSON.stringify({ text, images, files }), controller.signal, raw => {
      const event = raw as JudgeEvent
      if (event.type === 'stage') onStage(event)
      else if (event.type === 'done') project = event.project
      else throw new WebRequestError(event.code, event.error)
    }, 250_000)
    if (!project) return { ok: false, code: 'STREAM_CLOSED', error: '连接中途断开了，没有拿到需求清单，请手动重试' }
    return { ok: true, project }
  } catch (e) {
    logError('order-judge:organize', e)
    return { ok: false, code: e instanceof WebRequestError ? e.code : 'FAILED', error: e instanceof Error ? e.message : String(e) }
  } finally { active.delete(controller) }
}

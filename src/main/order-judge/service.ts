// 接单评估：读能力档案和项目日志、打开派单里的网址、调 DeepSeek、存历史。
// 材料预处理（截图缩放、长图切块、视频取帧、PDF / Word 取字）在渲染进程里做完，这里只收文字和 JPEG。

import { app, safeStorage } from 'electron'
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { JsonStore } from '../shared/json-store'
import { netRequest } from '../shared/net-request'
import { sleep } from '../shared/http-client'
import { logError, logInfo } from '../shared/logger'
import {
  MAX_IMAGES, SAME_SITE_GAP_MS, buildSystemPrompt, buildUserText, extractUrls, groupByHost,
  normalizeReport, pageDigest, type JudgeReport,
} from '../../../web/shared/order-judge'

const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash'
const HISTORY_LIMIT = 50 // 每条带着当时发出去的图（最多 40 张），留太多会占几百 MB
const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── 设置 ──

interface Settings {
  keyEnc: string
  profilePath: string
  logPath: string
}

const settingsStore = new JsonStore<Settings>('order-judge-settings.json', (raw) => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
  return {
    keyEnc: typeof r.keyEnc === 'string' ? r.keyEnc : '',
    profilePath: typeof r.profilePath === 'string' ? r.profilePath : '',
    logPath: typeof r.logPath === 'string' ? r.logPath : '',
  }
})

export interface SettingsView {
  hasKey: boolean
  profilePath: string
  logPath: string
  logUpdatedAt: number | null
}

export async function getSettings(): Promise<SettingsView> {
  const s = await settingsStore.read()
  let logUpdatedAt: number | null = null
  if (s.logPath) {
    try { logUpdatedAt = (await stat(s.logPath)).mtimeMs } catch { /* 文件不在了，界面显示路径即可 */ }
  }
  return { hasKey: !!s.keyEnc, profilePath: s.profilePath, logPath: s.logPath, logUpdatedAt }
}

export async function setKey(key: string): Promise<void> {
  await settingsStore.read()
  const trimmed = key.trim()
  if (!trimmed) {
    settingsStore.update((s) => { s.keyEnc = '' })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据存储暂不可用，Key 没有保存')
  const enc = safeStorage.encryptString(trimmed).toString('base64')
  settingsStore.update((s) => { s.keyEnc = enc })
}

export async function setPath(which: 'profile' | 'log', path: string): Promise<void> {
  await settingsStore.read()
  settingsStore.update((s) => {
    if (which === 'profile') s.profilePath = path
    else s.logPath = path
  })
}

function readKey(s: Settings): string {
  if (!s.keyEnc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(s.keyEnc, 'base64'))
  } catch (e) {
    // 换机 / 重装系统后钥匙串对不上，当作没填过，让用户重填
    logError('order-judge:key', e)
    return ''
  }
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
  return historyStore.read()
}

export function historyDir(): string {
  return historyRoot()
}

export async function deleteHistory(id: string): Promise<void> {
  if (!ID_RE.test(id)) return
  const list = await historyStore.read()
  historyStore.set(list.filter((x) => x.id !== id))
  await rm(join(historyRoot(), id), { recursive: true, force: true })
}

async function saveHistory(entry: Omit<HistoryEntry, 'images'>, images: { name: string; bytes: Buffer }[]): Promise<HistoryEntry> {
  const dir = join(historyRoot(), entry.id)
  await mkdir(dir, { recursive: true })
  const saved = await Promise.all(images.map(async (img, i) => {
    const file = `${String(i + 1).padStart(2, '0')}.jpg`
    await writeFile(join(dir, file), img.bytes)
    return { file, name: img.name }
  }))
  const full: HistoryEntry = { ...entry, images: saved }
  const list = await historyStore.read()
  const next = [full, ...list]
  historyStore.set(next.slice(0, HISTORY_LIMIT))
  for (const old of next.slice(HISTORY_LIMIT)) {
    await rm(join(historyRoot(), old.id), { recursive: true, force: true })
  }
  return full
}

// ── 打开派单里的网址 ──

function charsetOf(headers: Record<string, string | string[] | undefined>): string {
  const ct = headers['content-type']
  const v = Array.isArray(ct) ? ct[0] : ct
  return /charset=([\w-]+)/i.exec(v ?? '')?.[1] ?? 'utf-8'
}

async function fetchOne(url: string): Promise<string> {
  try {
    const res = await netRequest(url, { headers: { 'User-Agent': FETCH_UA }, timeoutMs: 10000, maxBytes: 5_000_000 })
    if (res.status >= 400) return `[${url}] 抓取失败：HTTP ${res.status}`
    let raw: string
    try {
      raw = new TextDecoder(charsetOf(res.headers)).decode(res.body)
    } catch {
      raw = res.body.toString('utf-8')
    }
    return pageDigest(url, raw)
  } catch (e) {
    return `[${url}] 抓取失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function fetchLinks(urls: string[]): Promise<string> {
  const results = new Map<string, string>()
  await Promise.all(groupByHost(urls).map(async (group) => {
    for (let i = 0; i < group.length; i++) {
      if (i) {
        const [lo, hi] = SAME_SITE_GAP_MS
        await sleep(lo + Math.random() * (hi - lo))
      }
      results.set(group[i], await fetchOne(group[i]))
    }
  }))
  return urls.map((u) => results.get(u) ?? '').join('\n\n')
}

// ── 调 DeepSeek ──

export type JudgeErrorCode =
  | 'NO_KEY' | 'NO_PROFILE' | 'PROFILE_UNREADABLE'
  | 'KEY_INVALID' | 'BALANCE' | 'RATE_LIMITED' | 'PROVIDER_ERROR'
  | 'NETWORK' | 'EMPTY_RESPONSE' | 'BAD_RESPONSE' | 'BAD_INPUT'

export type JudgeResult =
  | { ok: true; entry: HistoryEntry; warnings: string[] }
  | { ok: false; code: JudgeErrorCode; detail?: string; status?: number }

export interface JudgeInput {
  text: string
  images: { name: string; dataUrl: string }[]
}

export type JudgeProgress = { stage: 'links'; count: number } | { stage: 'ai' }

const DATA_URL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/

function providerMessage(body: Buffer): string {
  const text = body.toString('utf-8')
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } }
    if (typeof j.error?.message === 'string') return j.error.message
  } catch { /* 不是 JSON，用原文 */ }
  return text.slice(0, 300)
}

function statusCode(status: number): JudgeErrorCode {
  if (status === 401) return 'KEY_INVALID'
  if (status === 402) return 'BALANCE'
  if (status === 429) return 'RATE_LIMITED'
  return 'PROVIDER_ERROR'
}

export async function judge(input: JudgeInput, onProgress: (p: JudgeProgress) => void): Promise<JudgeResult> {
  const text = typeof input?.text === 'string' ? input.text : ''
  const images = Array.isArray(input?.images) ? input.images : []
  if (images.length > MAX_IMAGES || images.some((x) => typeof x?.name !== 'string' || typeof x?.dataUrl !== 'string' || !DATA_URL_RE.test(x.dataUrl))) {
    return { ok: false, code: 'BAD_INPUT' }
  }

  const settings = await settingsStore.read()
  const key = readKey(settings)
  if (!key) return { ok: false, code: 'NO_KEY' }
  if (!settings.profilePath) return { ok: false, code: 'NO_PROFILE' }
  let profile: string
  try {
    profile = await readFile(settings.profilePath, 'utf-8')
  } catch (e) {
    logError('order-judge:profile', e)
    return { ok: false, code: 'PROFILE_UNREADABLE', detail: settings.profilePath }
  }
  const warnings: string[] = []
  let projectLog: string | null = null
  if (settings.logPath) {
    try {
      projectLog = await readFile(settings.logPath, 'utf-8')
    } catch (e) {
      logError('order-judge:log', e)
      warnings.push('项目日志读不到，这次只按能力档案判断')
    }
  }

  const urls = extractUrls(text)
  let links = ''
  if (urls.length) {
    onProgress({ stage: 'links', count: urls.length })
    links = await fetchLinks(urls)
  }
  onProgress({ stage: 'ai' })

  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt(profile, projectLog) },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildUserText(text, links, images.map((x) => x.name)) },
          ...images.map((x) => ({ type: 'image_url', image_url: { url: x.dataUrl } })),
        ],
      },
    ],
  })
  logInfo('order-judge', `→ DeepSeek  文字 ${text.length} 字  网址 ${urls.length} 个  图片 ${images.length} 张  请求体 ${(body.length / 1024).toFixed(0)}KB`)

  let report: JudgeReport | null = null
  // JSON 模式偶尔返回空内容，最多试 3 次；HTTP 错误不重试，原样交给界面
  for (let attempt = 0; attempt < 3 && !report; attempt++) {
    let res
    try {
      res = await netRequest(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
        timeoutMs: 180_000,
      })
    } catch (e) {
      logError('order-judge:request', e)
      return { ok: false, code: 'NETWORK', detail: e instanceof Error ? e.message : String(e) }
    }
    if (res.status !== 200) {
      const detail = providerMessage(res.body)
      logError('order-judge:request', `HTTP ${res.status} ${detail}`)
      return { ok: false, code: statusCode(res.status), status: res.status, detail }
    }
    let content: unknown
    try {
      content = (JSON.parse(res.body.toString('utf-8')) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
    } catch (e) {
      logError('order-judge:response', e)
      return { ok: false, code: 'BAD_RESPONSE', detail: res.body.toString('utf-8').slice(0, 300) }
    }
    if (typeof content !== 'string' || !content.trim()) {
      logInfo('order-judge', `第 ${attempt + 1} 次返回空内容`)
      continue
    }
    try {
      report = normalizeReport(JSON.parse(content))
    } catch (e) {
      logError('order-judge:response', e)
      return { ok: false, code: 'BAD_RESPONSE', detail: content.slice(0, 300) }
    }
  }
  if (!report) return { ok: false, code: 'EMPTY_RESPONSE' }

  const entry = await saveHistory(
    { id: randomUUID(), at: Date.now(), report, order: text },
    images.map((x) => ({ name: x.name, bytes: Buffer.from(x.dataUrl.slice(x.dataUrl.indexOf(',') + 1), 'base64') })),
  )
  logInfo('order-judge', `← ${report.verdict}  ${report.title}`)
  return { ok: true, entry, warnings }
}

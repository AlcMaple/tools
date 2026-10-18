// 助手附图是「消息行 images_json + 磁盘 JPEG」两半：文件落 dataDir/agent-images/<uid>/<sessionId>/<imageId>.jpg。
// 写入先落文件（上传接口），发送那一轮再把编号写进用户消息行；没被任何消息引用、超过宽限期的文件由 sweep 删。
// 删除先删行再删文件：删会话 → 事务删行后整目录删；清空 → 删行后整目录删；截断 → 删行后被截掉的图
// 刷新 mtime 给一段宽限期（编辑重发要原样带回这些图），之后由 sweep 当孤儿删掉。
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { dataDir } from '../data-dir'
import { AgentRunError } from '../../shared/agent-run'
import { AGENT_IMAGE_LIMITS } from '../../shared/agent-history'
import { logAgentIssue } from './diagnostics'

const rootDir = join(dataDir, 'agent-images')
const ID = /^[a-f0-9-]{36}$/
const sessionDir = (uid: number, sessionId: string) => join(rootDir, String(uid), sessionId)
const fileOf = (uid: number, sessionId: string, id: string) => join(sessionDir(uid, sessionId), `${id}.jpg`)

// 只认浏览器缩好的 JPEG：SOI 开头、EOI 结尾，SOF 里的宽高不超过长边上限。
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1], length = bytes.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
    i += 2 + length
  }
  return null
}

async function usedBytes(uid: number): Promise<number> {
  let total = 0
  const userDir = join(rootDir, String(uid))
  for (const session of await readdir(userDir).catch(() => [] as string[])) {
    for (const name of await readdir(join(userDir, session)).catch(() => [] as string[])) total += (await stat(join(userDir, session, name)).catch(() => ({ size: 0 }))).size
  }
  return total
}

export class AgentImageStore {
  constructor(readonly db: Database.Database) {}

  private referenced(uid: number, sessionId: string): Set<string> {
    const rows = this.db.prepare("SELECT images_json FROM agent_messages WHERE user_id = ? AND session_id = ? AND images_json != '[]'").all(uid, sessionId) as { images_json: string }[]
    return new Set(rows.flatMap(r => JSON.parse(r.images_json) as string[]))
  }

  private requireSession(uid: number, sessionId: string) {
    const row = this.db.prepare('SELECT archived_at FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, sessionId) as { archived_at: number | null } | undefined
    if (!row) throw new AgentRunError('NOT_FOUND', 404)
    return row
  }

  async save(uid: number, sessionId: string, bytes: Buffer): Promise<{ id: string; width: number; height: number }> {
    if (this.requireSession(uid, sessionId).archived_at !== null) throw new AgentRunError('SESSION_ARCHIVED')
    const size = jpegSize(bytes)
    if (!size || bytes.length > AGENT_IMAGE_LIMITS.bytes) throw new AgentRunError('IMAGE_INVALID', 400)
    if (Math.max(size.width, size.height) > AGENT_IMAGE_LIMITS.edge) throw new AgentRunError('IMAGE_INVALID', 400)
    await this.sweep(uid, sessionId)
    if (await usedBytes(uid) + bytes.length > AGENT_IMAGE_LIMITS.bytesPerUser) throw new AgentRunError('IMAGE_STORAGE_LIMIT', 413)
    const id = randomUUID()
    await mkdir(sessionDir(uid, sessionId), { recursive: true })
    await writeFile(fileOf(uid, sessionId, id), bytes)
    return { id, ...size }
  }

  // 只在 begin 事务里调用：编号必须是这个会话目录下已落盘、还没被别的消息引用的文件。
  checkUnbound(uid: number, sessionId: string, ids: string[], exists: (path: string) => boolean) {
    if (new Set(ids).size !== ids.length || ids.length > AGENT_IMAGE_LIMITS.perMessage) throw new AgentRunError('INVALID_ARGUMENT', 400)
    const used = this.referenced(uid, sessionId)
    for (const id of ids) if (!ID.test(id) || used.has(id) || !exists(fileOf(uid, sessionId, id))) throw new AgentRunError('IMAGE_MISSING', 409)
  }

  async read(uid: number, sessionId: string, id: string): Promise<Buffer> {
    if (!ID.test(id)) throw new AgentRunError('NOT_FOUND', 404)
    this.requireSession(uid, sessionId)
    try { return await readFile(fileOf(uid, sessionId, id)) } catch { throw new AgentRunError('NOT_FOUND', 404) }
  }

  async dataUrls(uid: number, sessionId: string, ids: string[]): Promise<string[]> {
    const urls: string[] = []
    for (const id of ids) {
      try { urls.push('data:image/jpeg;base64,' + (await readFile(fileOf(uid, sessionId, id))).toString('base64')) }
      catch (error) { logAgentIssue('agent-image', { uid, sessionId, id }, error); throw new AgentRunError('IMAGE_MISSING', 409) }
    }
    return urls
  }

  // 截断后被丢掉的那几张：编辑重发会原样带回，给一段宽限期再当孤儿回收。
  async graceRemoved(uid: number, sessionId: string, ids: string[]) {
    const now = new Date()
    for (const id of ids) await utimes(fileOf(uid, sessionId, id), now, now).catch(() => undefined)
  }

  async removeSession(uid: number, sessionId: string) {
    await rm(sessionDir(uid, sessionId), { recursive: true, force: true }).catch(error => logAgentIssue('agent-image', { uid, sessionId, op: 'remove' }, error))
  }

  async sweep(uid: number, sessionId: string) {
    const dir = sessionDir(uid, sessionId)
    const names = await readdir(dir).catch(() => [] as string[])
    if (!names.length) return
    const alive = this.db.prepare('SELECT 1 FROM agent_sessions WHERE user_id = ? AND id = ?').get(uid, sessionId)
    if (!alive) { await this.removeSession(uid, sessionId); return }
    const used = this.referenced(uid, sessionId), cutoff = Date.now() - AGENT_IMAGE_LIMITS.orphanGraceMs
    for (const name of names) {
      const id = name.replace(/\.jpg$/, '')
      if (used.has(id)) continue
      const info = await stat(join(dir, name)).catch(() => null)
      if (info && info.mtimeMs < cutoff) await rm(join(dir, name), { force: true })
    }
  }

  // 没发出去的上传、截断后没被带回的图，只有该会话再有动作时才会扫到；这里兜底把全部会话扫一遍。
  async sweepAll() {
    for (const user of await readdir(rootDir).catch(() => [] as string[])) {
      const uid = Number(user)
      if (!Number.isSafeInteger(uid)) continue
      for (const sessionId of await readdir(join(rootDir, user)).catch(() => [] as string[])) await this.sweep(uid, sessionId)
    }
  }
}

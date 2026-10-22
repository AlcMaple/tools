import { readFile, stat } from 'fs/promises'
import type { BigIntStats } from 'fs'
import { basename } from 'path'
import { createHash } from 'crypto'
import { DOC_MAX_BYTES, type DocKind, type DocWrite, type DocReceipt, type JudgeSyncState } from '../../../web/shared/order-judge-api'
import { judgeDocText } from '../../../web/shared/order-judge-text'

export interface JudgeSyncTransport {
  snapshot(): Promise<JudgeSyncState>
  write(kind: DocKind, input: DocWrite): Promise<DocReceipt>
}
export const localDocHash = (text: string): string => createHash('sha256').update(text).digest('hex')
const LABEL: Record<DocKind, string> = { profile: '能力档案', log: '项目日志' }

export type SourceDoc = { path: string; content: string }

// 按优先级找第一个存在的文件；一个都没有返回 null，由调用方改用服务器上的正文。
// 找到了却读不稳（正在保存、空文件、超限）要报错，而不是悄悄跳到下一个路径——那会把旧稿当成新稿传上去。
export async function firstSourceDoc(kind: DocKind, paths: string[]): Promise<SourceDoc | null> {
  for (const path of paths) {
    let before: BigIntStats
    try { before = await stat(path, { bigint: true }) }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT' || (cause as NodeJS.ErrnoException).code === 'ENOTDIR') continue
      throw Object.assign(new Error(`${LABEL[kind]}读不到（${(cause as NodeJS.ErrnoException).code ?? 'READ_ERROR'}）：${path}`), { cause, sourceRead: true })
    }
    if (!before.isFile() || before.size > DOC_MAX_BYTES) throw new Error(`${LABEL[kind]}需要是 1 MB 以内的文本文件：${path}`)
    const content = judgeDocText(await readFile(path, 'utf-8'))
    const after = await stat(path, { bigint: true })
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino) throw Object.assign(new Error('资料正在保存，请完成保存后再同步。'), { sourceRead: true })
    if (!content.trim()) throw Object.assign(new Error(`${LABEL[kind]}是空的，本次没有覆盖云端正文：${path}`), { sourceRead: true })
    return { path, content }
  }
  return null
}

export class JudgeFileSync {
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false

  // 路径列表不在本机：每次都从网站的最新快照里取，网页上改了顺序下次同步立即生效。
  constructor(private options: {
    label: string
    transport: JudgeSyncTransport
  }) {}

  stop(): void { this.stopped = true }
  private live(): void { if (this.stopped) throw new Error('SYNC_CANCELLED') }

  sync(): Promise<JudgeSyncState> {
    const task = this.tail.catch(() => {}).then(() => this.perform())
    this.tail = task
    return task
  }

  // 本机文件是唯一来源：内容和云端不同就整份覆盖，不合并、不比新旧。
  private async perform(): Promise<JudgeSyncState> {
    this.live()
    const { transport } = this.options
    let remote = await transport.snapshot()
    if (remote.protocol !== 1 || !Number.isSafeInteger(remote.accountId) || remote.accountId < 1) throw new Error('网页版尚未提供接单评估同步协议，请更新服务。')
    for (const kind of ['profile', 'log'] as const) {
      this.live()
      // 网页上传的条目排在前面时，以它为准，本机文件不覆盖。
      const list = remote.paths[kind], firstUpload = list.findIndex(p => p.upload)
      const found = await firstSourceDoc(kind, (firstUpload < 0 ? list : list.slice(0, firstUpload)).map(p => p.path))
      this.live()
      if (!found || remote.docs[kind]?.hash === localDocHash(found.content)) continue
      await transport.write(kind, { name: basename(found.path), content: found.content, source: this.options.label, path: found.path })
      this.live()
      const accountId = remote.accountId
      remote = await transport.snapshot()
      if (remote.accountId !== accountId) throw new Error('同步账号已经改变，旧操作已停止。')
    }
    return remote
  }
}

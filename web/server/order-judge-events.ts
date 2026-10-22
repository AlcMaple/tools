import { randomUUID } from 'node:crypto'
import { JudgeDataError } from './order-judge-data'
import type { JudgeSyncEvent } from '../shared/order-judge-api'

interface Peer { key: string; device: string | null; send: (event: JudgeSyncEvent) => void; close: () => void }
interface Check { uid: number; pending: Set<string>; finish: (error?: Error) => void }

export class JudgeEvents {
  private listeners = new Map<number, Set<Peer>>()
  private checks = new Map<string, Check>()
  private barriers = new Map<number, Promise<void>>()

  validate(uid: number, device: string | null): void {
    const peers = [...(this.listeners.get(uid) ?? [])]
    if (peers.filter(peer => !device || peer.device !== device).length >= 12) throw new JudgeDataError('TOO_MANY_CONNECTIONS', '同步连接过多，请关闭重复窗口。')
  }

  subscribe(uid: number, device: string | null, send: Peer['send'], close: () => void): () => void {
    const peers = this.listeners.get(uid) ?? new Set<Peer>()
    this.validate(uid, device)
    for (const peer of peers) if (device && peer.device === device) peer.close()
    const peer: Peer = { key: randomUUID(), device, send, close }
    peers.add(peer); this.listeners.set(uid, peers)
    return () => {
      peers.delete(peer)
      if (!peers.size) this.listeners.delete(uid)
      for (const check of this.checks.values()) if (check.uid === uid && check.pending.has(peer.key)) check.finish(new JudgeDataError('SYNC_OFFLINE', '资料来源在核对中断开，请重新同步后评估。'))
    }
  }

  changed(uid: number, seq: number): void {
    for (const peer of this.listeners.get(uid) ?? []) peer.send({ type: 'changed', seq })
  }

  acknowledge(uid: number, device: string, id: string, error?: string): void {
    const check = this.checks.get(id)
    const peer = [...(this.listeners.get(uid) ?? [])].find(p => p.device === device)
    if (!check || check.uid !== uid || !peer || !check.pending.has(peer.key)) throw new JudgeDataError('CHECK_EXPIRED', '这次资料核对已结束。')
    if (error) { check.finish(new JudgeDataError('SYNC_FAILED', error.slice(0, 600))); return }
    check.pending.delete(peer.key)
    if (!check.pending.size) check.finish()
  }

  check(uid: number, timeoutMs = 12_000): Promise<void> {
    const current = this.barriers.get(uid)
    if (current) return current
    const peers = [...(this.listeners.get(uid) ?? [])].filter(p => p.device)
    if (!peers.length) return Promise.resolve()
    const id = randomUUID()
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new JudgeDataError('SYNC_TIMEOUT', '资料核对超时，本次尚未调用 AI。')), timeoutMs)
      const finish = (error?: Error): void => {
        clearTimeout(timer); this.checks.delete(id)
        if (error) reject(error); else resolve()
      }
      this.checks.set(id, { uid, pending: new Set(peers.map(p => p.key)), finish })
      for (const peer of peers) peer.send({ type: 'check', id })
    })
    this.barriers.set(uid, result)
    void result.finally(() => { if (this.barriers.get(uid) === result) this.barriers.delete(uid) }).catch(() => {})
    return result
  }
}

export const judgeEvents = new JudgeEvents()

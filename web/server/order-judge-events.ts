import { randomUUID } from 'node:crypto'
import { JudgeDataError } from './order-judge-data'
import type { JudgeSyncEvent } from '../shared/order-judge-api'

interface Peer { key: string; send: (event: JudgeSyncEvent) => void; close: () => void }

// 同一账号开着的网页和桌面，在别处新建 / 追加 / 删除项目后收到 changed，各自重新拉列表
export class JudgeEvents {
  private listeners = new Map<number, Set<Peer>>()

  subscribe(uid: number, send: Peer['send'], close: () => void): () => void {
    const peers = this.listeners.get(uid) ?? new Set<Peer>()
    if (peers.size >= 12) throw new JudgeDataError('TOO_MANY_CONNECTIONS', '同步连接过多，请关闭重复窗口')
    const peer: Peer = { key: randomUUID(), send, close }
    peers.add(peer); this.listeners.set(uid, peers)
    return () => {
      peers.delete(peer)
      if (!peers.size) this.listeners.delete(uid)
    }
  }

  changed(uid: number, seq: number): void {
    for (const peer of this.listeners.get(uid) ?? []) peer.send({ type: 'changed', seq })
  }
}

export const judgeEvents = new JudgeEvents()

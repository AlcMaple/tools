// 媒体库增量同步的 worker_threads 入口。在独立线程（独立事件循环 + 独立 libuv
// 线程池）里跑，主进程线程全程不被占 —— 扫描 / 同步期间 UI 不卡。
//
// 协议：主进程 postMessage({ paths, prevEntries, prevDirMtimes })
//   → 回 postMessage({ ok:true, entries, dirMtimes }) 或 { ok:false, error }。
// 一次性：同步完即由主进程 terminate。

import { parentPort } from 'worker_threads'
import { syncLibrary, type LibraryEntry, type LibraryPath, type DirMtimes } from './scan-core'

interface SyncRequest {
  paths: LibraryPath[]
  prevEntries: LibraryEntry[]
  prevDirMtimes: DirMtimes
}

parentPort?.on('message', async (msg: SyncRequest) => {
  try {
    const { entries, dirMtimes } = await syncLibrary(
      msg.paths ?? [],
      msg.prevEntries ?? [],
      msg.prevDirMtimes ?? {},
    )
    parentPort?.postMessage({ ok: true, entries, dirMtimes })
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

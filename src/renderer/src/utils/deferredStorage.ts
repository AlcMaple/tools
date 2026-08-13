// 把 localStorage 的同步序列化 + 写入从渲染热路径上挪走。
//
// 那两个 plain store 每次 mutate 都要把整张表序列化再写盘,追番上百条时单次能到几百 KB ——
// 这一步同步跑在渲染线程上,叠加订阅者的一次性重渲染,就是切页面时那几百毫秒到 1 秒的卡顿。
//
// 策略:调用方先**同步**通知订阅者(UI 立刻响应),把真正的写盘闭包丢给这里,在空闲帧合并执行。
// 同一个 key 多次注册只保留最后一个闭包 —— 闭包在 flush 时才去读 store,拿到的永远是最新状态
// 所以合并不会丢更新。
//
// 页面隐藏 / 卸载(关窗到托盘、退出)时强制 flush,避免还没落地的写入丢掉。

type WriteFn = () => void

// 待写入的闭包表,按 storage key 去重合并。
const pending = new Map<string, WriteFn>()
let idleHandle: number | null = null

const scheduleIdle: (cb: () => void) => number =
  typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(cb, { timeout: 1000 })
    : (cb) => window.setTimeout(cb, 0) as unknown as number

const cancelIdle: (h: number) => void =
  typeof cancelIdleCallback === 'function' ? cancelIdleCallback : (h) => clearTimeout(h)

/** 立即把所有挂起的写入落盘(空闲帧或页面隐藏时调用)。 */
function flushAll(): void {
  if (idleHandle !== null) {
    cancelIdle(idleHandle)
    idleHandle = null
  }
  for (const write of pending.values()) {
    try {
      write()
    } catch {
      /* 忽略 quota / 序列化异常，跟原来的 try/catch 语义一致 */
    }
  }
  pending.clear()
}

/**
 * 注册一次延迟写入。`write` 在空闲帧执行时才真正 stringify + setItem，
 * 所以传进来的闭包应当**在调用时读取最新 store 状态**，而不是提前算好字符串。
 */
export function scheduleStorageWrite(key: string, write: WriteFn): void {
  pending.set(key, write)
  if (idleHandle === null) {
    idleHandle = scheduleIdle(() => {
      idleHandle = null
      flushAll()
    })
  }
}

// 页面隐藏 / 卸载时兜底刷盘。Electron 关窗到托盘走 visibilitychange=hidden，
// 真正退出走 pagehide —— 两条都挂上，确保没有窗口在挂起写入未落地时消失。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushAll)
  window.addEventListener('beforeunload', flushAll)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll()
  })
}

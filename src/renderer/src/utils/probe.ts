// 针对性的性能探子 —— 哪个操作觉得慢就在哪埋一个,各自清楚自己测的是什么,归因天然精确。
// 全部写进主进程的 main.log(tag = perf),一个地方看。
//
//   异步操作:const end = probe('webdav:pull'); await ...; end()
//   切页面这种要等画面出来的:probeToPaint('nav:/my-anime')
//
// 开销可忽略:只记几个时间戳、只在被埋的操作上记,写日志还是异步的。

function emit(message: string): void {
  // 控制台留一份(dev 直接看),同时转发给主进程落盘。
  console.log(`[perf] ${message}`)
  try {
    void window.systemApi?.logPerf?.(message)
  } catch {
    /* preload 不可用时不二次抛 */
  }
}

/** 异步操作计时,返回的 end() 在调用时记下耗时,可附一句备注(条数 / 分段名)。 */
export function probe(label: string): (note?: string) => void {
  const t0 = performance.now()
  return (note?: string) => {
    const ms = performance.now() - t0
    emit(`${label} ${ms.toFixed(0)}ms${note ? ` ${note}` : ''}`)
  }
}

/**
 * 量「此刻 → 下一帧真正绘制完成」的耗时,用于切页这类要等用户看见画面的场景。
 * 用 double-rAF:第二个 rAF 回调发生在合成器出帧之后
 */
export function probeToPaint(label: string): void {
  const t0 = performance.now()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const ms = performance.now() - t0
      emit(`${label} ${ms.toFixed(0)}ms (to-paint)`)
    })
  })
}

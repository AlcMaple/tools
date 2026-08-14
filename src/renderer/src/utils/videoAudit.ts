// 在线播放的 <video> 生命周期审计（排查「暂停/退出后仍有声音」用，Windows 复现、mac 不复现）。
//
// 要回答的就一个问题:出声的时候,页面上到底还有几个媒体元素、它们是不是真的停了。
// 之前靠读代码推断根因、结论是错的,所以这里不做任何判断,只把运行时事实打出来:
// 每个元素的 attached / paused / muted / readyState / currentTime,外加 document 里
// <video> 与 <webview> 的实际数量(声音也可能根本不来自我们 ref 到的那个元素)。
//
// 日志走 systemApi.logPerf → main.log（tag=perf），Windows 上不用开 DevTools 就能取。

interface Tracked {
  id: number
  el: HTMLVideoElement
  bornAt: number
}

let seq = 0
const tracked: Tracked[] = []
let lastLine = ''
let timer: number | null = null

/** 每个元素一行状态。`attached` = 还在 DOM 上;false 且 paused=false 就是「游离还在播」。 */
function describe(t: Tracked): string {
  const el = t.el
  const src = el.currentSrc || el.getAttribute('src') || ''
  // mtmedia://media/?u=<很长的编码地址> —— 只留能区分是哪一集的尾部特征
  const srcTag = src ? `${src.slice(0, 22)}…${src.slice(-12)}` : '(空)'
  return [
    `#${t.id}`,
    `attached=${document.contains(el)}`,
    `paused=${el.paused}`,
    `muted=${el.muted}`,
    `vol=${el.volume.toFixed(2)}`,
    `ready=${el.readyState}`,
    `net=${el.networkState}`,
    `t=${el.currentTime.toFixed(1)}`,
    `src=${srcTag}`,
  ].join(' ')
}

/**
 * 打一行当前快照。`tag` 标出是哪个时机触发的（mount/detach/unmount/心跳…）。
 * `force=false` 时与上一行完全相同则不打，避免心跳刷屏——变化才有信息量。
 */
export function auditVideos(tag: string, force = true): void {
  const domVideos = document.querySelectorAll('video').length
  const domWebviews = document.querySelectorAll('webview').length
  const body =
    tracked.length === 0
      ? '(无 tracked 元素)'
      : tracked.map((t) => `\n    ${describe(t)}`).join('')
  const line = `tracked=${tracked.length} dom<video>=${domVideos} dom<webview>=${domWebviews}${body}`
  if (!force && line === lastLine) return
  lastLine = line
  void window.systemApi.logPerf(`[video-audit ${tag}] ${line}`)
}

/** 交给 <video> ref 的元素登记进来。同一个元素重复登记忽略。 */
export function trackVideo(el: HTMLVideoElement): void {
  if (tracked.some((t) => t.el === el)) return
  tracked.push({ id: ++seq, el, bornAt: Date.now() })
  auditVideos('track')
}

/** 元素确实收干净后再摘掉登记——收不干净的要留在列表里，否则审计就看不见它了。 */
export function untrackVideo(el: HTMLVideoElement): void {
  const i = tracked.findIndex((t) => t.el === el)
  if (i >= 0) tracked.splice(i, 1)
}

/** 当前所有登记在册的元素（含已从 DOM 摘下但没收干净的）。离开播放页时要逐个收。 */
export function trackedVideos(): HTMLVideoElement[] {
  return tracked.map((t) => t.el)
}

/**
 * 心跳:每秒扫一次,状态有变化才打。播放页挂载时开、卸载时关。
 * 卸载后**故意再多跑几秒**,专门抓「已经退出播放页但声音还在」那一段。
 */
export function startVideoAudit(): () => void {
  if (timer !== null) window.clearInterval(timer)
  auditVideos('mount')
  timer = window.setInterval(() => auditVideos('tick', false), 1000)
  return () => {
    if (timer !== null) window.clearInterval(timer)
    auditVideos('unmount')
    // 离开播放页后继续观察 10 秒:若这期间还有 paused=false,就证明声音来自游离元素。
    let left = 10
    timer = window.setInterval(() => {
      auditVideos('after-leave', false)
      if (--left <= 0 && timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }, 1000)
  }
}

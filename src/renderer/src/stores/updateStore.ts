/**
 * 应用更新状态机。
 *
 * 状态语义：
 *   - `idle`        从未检查 / 已检查无更新（自动检查的默认状态）
 *   - `checking`    正在检查
 *   - `available`   Windows 下载中（autoDownload，含 progress%）
 *   - `downloaded`  Windows 已下载完，等待用户点「重启安装」
 *   - `available-mac` macOS 发现新版本，无下载，仅展示「前往下载」
 *   - `not-available` 已是最新（手动检查后才进入此状态）
 *   - `error`       检查 / 下载出错（手动检查时才显示给用户）
 *
 * 跟其他 store 一样：纯 observable + 监听列表，不依赖 React Context。
 * 没有持久化——banner 关闭状态只在 session 内有效（关闭后下次启动还会弹）。
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloaded'
  | 'available-mac'
  | 'not-available'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  newVersion?: string
  /** 0..100，仅 Windows 下载阶段有值。 */
  progressPercent?: number
  /** Bytes/s，仅 Windows 下载阶段有值。 */
  bps?: number
  /** macOS 用：GitHub release HTML 页面 URL。 */
  releaseUrl?: string
  /** error 状态下显示给用户。 */
  errorMessage?: string
  /** banner 是否被用户手动关闭（仅当前 session 有效）。 */
  bannerDismissed: boolean
}

type Listener = () => void

let state: UpdateState = {
  status: 'idle',
  bannerDismissed: false,
}

const listeners = new Set<Listener>()

function notify(): void {
  listeners.forEach((l) => l())
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  notify()
}

/**
 * 决定 banner 是否应该展示给用户。
 * - `downloaded` / `available-mac` 是用户可操作的终态，显示
 * - `available` / `checking` / `idle` / `not-available` / `error` 不显示 banner
 *   （checking / not-available / error 是设置页按钮的反馈，不打扰其他页面）
 */
export function shouldShowBanner(s: UpdateState): boolean {
  if (s.bannerDismissed) return false
  return s.status === 'downloaded' || s.status === 'available-mac'
}

let wired = false

export const updateStore = {
  /** 注册主进程事件监听。App 启动时调一次。 */
  init(): void {
    if (wired) return
    wired = true

    window.updaterApi.onChecking(() => {
      setState({ status: 'checking' })
    })

    window.updaterApi.onAvailable((info) => {
      // Windows: 进入下载流程
      setState({
        status: 'available',
        newVersion: info.version,
        progressPercent: 0,
      })
    })

    window.updaterApi.onAvailableMac((info) => {
      setState({
        status: 'available-mac',
        newVersion: info.version,
        releaseUrl: info.releaseUrl,
        bannerDismissed: false, // 新版本到来时复位
      })
    })

    window.updaterApi.onDownloadProgress((p) => {
      setState({
        progressPercent: Math.max(0, Math.min(100, Math.round(p.percent))),
        bps: p.bytesPerSecond,
      })
    })

    window.updaterApi.onDownloaded((info) => {
      setState({
        status: 'downloaded',
        newVersion: info.version,
        progressPercent: 100,
        bannerDismissed: false,
      })
    })

    window.updaterApi.onNotAvailable(() => {
      setState({ status: 'not-available' })
    })

    window.updaterApi.onError((info) => {
      setState({ status: 'error', errorMessage: info.message })
    })
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  getState(): UpdateState {
    return state
  },

  /** 用户手动触发检查（设置页按钮）。 */
  async check(): Promise<void> {
    await window.updaterApi.check()
  },

  /** Windows: 重启并安装；macOS: 打开 release 页。 */
  async install(): Promise<void> {
    await window.updaterApi.install()
  },

  /** 用户关闭 banner（只在当前 session 有效）。 */
  dismissBanner(): void {
    setState({ bannerDismissed: true })
  },
}

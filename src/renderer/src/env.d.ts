// 静态资源（*.png 等）的模块声明已移至非模块的 assets.d.ts —— 本文件含顶层
// import/export 属于模块，通配声明放这里不会生效（见 assets.d.ts 注释）。

declare global {
  const __APP_VERSION__: string
}

import type { BgmSearchResult, BgmDetail, BgmCalendarResult, BgmAuthStatus, BgmCredentials } from './types/bgm'
import type { XifanSearchResult, XifanWatchInfo, XifanSource } from './types/xifan'
import type { GirigiriSearchResult, GirigiriEpisode, GirigiriWatchInfo } from './types/girigiri'
import type { AowuSearchResult, AowuEpisode, AowuWatchInfo } from './types/aowu'
import type { BiliVideoInfo, BiliDash } from './types/bili'

export interface LibraryPath {
  path: string;
  label: string;
}

export interface LibraryEntry {
  id: string;
  title: string;
  nativeTitle: string;
  tags: string;
  episodes: number;
  specs: string;
  image: string;
  folderPath: string;
  addedAt: number;
  totalSize: number;
}

export interface LibraryFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'folder'
  size?: number
  mtime?: string
  ext?: string
  kind?: 'video' | 'image' | 'archive' | 'text'
}

declare global {
  // Electron 的 <webview> 标签。React 的内建 JSX 类型不认识它,这里补上最小属性集。
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
        },
        HTMLElement
      >
    }
  }

  interface Window {
    fileExplorerApi: {
      getHomeInfo: () => Promise<{ homeDir: string; platform: string }>
      listDir: (dirPath: string) => Promise<{ entries: FsEntry[]; isVirtualRoot: boolean }>
      open: (targetPath: string) => Promise<void>
      reveal: (targetPath: string) => Promise<void>
      /**
       * 「移到回收站」Stage 1(5s 整体送回收站窗口)。返回 `stage1-failed` 表示整体送入失败且
       * **没有**尝试 Stage 2 —— 渲染层据此弹确认弹窗,用户点继续才调 trashFragmented。
       * 抛错 = 出现致命错误(spawn 失败 / helper 找不到)。
       */
      trash: (
        targetPath: string,
      ) => Promise<{ status: 'success' | 'stage1-failed' | 'already-absent' }>
      /**
       * 「移到回收站」Stage 2(用户确认后调),跑完整两阶段。返回 `fragmented` 时渲染层**必须**
       * 强提示「回收站里是散件,可全选→还原重建结构」。抛错 = 两阶段都失败。
       */
      trashFragmented: (
        targetPath: string,
      ) => Promise<{ status: 'success' | 'fragmented' | 'already-absent' }>
      /** 永久删除(三级 fallback,每级自动重试),几乎一次必成。 */
      deletePermanent: (
        targetPath: string,
      ) => Promise<{ status: 'success' | 'already-absent' }>
      resolveSpecial: (input: string) => Promise<string | null>
      /**
       * 从 `targetPath` 往上找最近的、仍然存在的目录(自身还在就返回自身)。删除流程用它把 UI
       * 从已删除的 cwd 上撤走。
       */
      findExistingAncestor: (targetPath: string) => Promise<string | null>
      onDirChange: (cb: () => void) => () => void
    }
    girigiriApi: {
      getCaptcha: () => Promise<{ image_b64: string }>
      verifyCaptcha: (code: string) => Promise<{ success: boolean }>
      search: (keyword: string) => Promise<GirigiriSearchResult[] | { needs_captcha: true }>
      getWatch: (playUrl: string) => Promise<GirigiriWatchInfo>
      /** 某一集的播放页 → 真实 m3u8(隐藏窗口截流,秒级);抓不到时抛错。 */
      resolveEpUrl: (epPageUrl: string) => Promise<string>
      startDownload: (
        title: string,
        epList: GirigiriEpisode[],
        selectedIdxs: number[],
        savePath?: string
      ) => Promise<{ started: boolean; taskId: string }>
      cancelDownload: (taskId: string) => Promise<{ cancelled: boolean }>
      pauseDownload: (taskId: string) => Promise<{ paused: boolean }>
      resumeDownload: (taskId: string, title?: string, epList?: GirigiriEpisode[], pendingEps?: number[], savePath?: string) => Promise<{ resumed: boolean }>
      requeueEpisodes: (
        taskId: string,
        title: string,
        epList: GirigiriEpisode[],
        eps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
      retryDownload: (
        taskId: string,
        title: string,
        epList: GirigiriEpisode[],
        failedEps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
    }
    /** 下载进度的唯一订阅点 —— 三个源都发到同一个频道,渲染层只需要一个监听器。 */
    downloadApi: {
      onProgress: (cb: (taskId: string, event: unknown) => void) => () => void
    }
    systemApi: {
      /** 渲染就绪后调一次，主进程据此一次性显示窗口（消除启动闪烁）。 */
      signalReady: () => void
      getDiskFree: () => Promise<{ free: number; total: number }>
      /** 离开播放页时收掉在线播放的缓冲(mp4 后台流 + HLS 分片预取)。 */
      releaseMedia: () => void
      pickFolder: () => Promise<string | null>
      /** 系统默认下载目录:没配自定义保存路径时所有下载器都回退到它,设置页要显示实际生效的路径。 */
      getDefaultDownloadsPath: () => Promise<string>
      /** 是否 dev(非打包)运行。设置页据此决定要不要显示「打开开发者工具」按钮。 */
      isDev: () => Promise<boolean>
      /** 开关 DevTools(F12 那样的控制台)。仅 dev 生效,打包版返回 false。 */
      toggleDevTools: () => Promise<boolean>
      checkConnectivity: () => Promise<boolean>
      loadSettingsHistory: () => Promise<Array<{ text: string; time: number }>>
      saveSettingsHistory: (entries: Array<{ text: string; time: number }>) => Promise<boolean>
      onSpeedUpdate: (cb: (bps: number) => void) => () => void
      cacheGet: (key: string) => Promise<Record<string, unknown> | null>
      cacheSet: (key: string, valueOrSubkey: unknown, maybeValue?: unknown) => Promise<void>
      getSetting: (key: string) => Promise<any>
      setSetting: (key: string, value: any) => Promise<void>
      /** 右键菜单编辑命令,作用在主进程 webContents 的当前聚焦元素/选区上。 */
      editCommand: (action: 'cut' | 'copy' | 'paste' | 'selectAll') => void
      loadDownloadState: () => Promise<any[]>
      saveDownloadState: (tasks: any[]) => Promise<void>
      /** 渲染进程错误转发到主进程统一落盘(同 main.log)。 */
      logError: (scope: string, message: string) => Promise<void>
      /** 性能探子数据,落到同一个 main.log(tag=perf)。 */
      logPerf: (message: string) => Promise<void>
      /** 打开日志目录(设置→关于)。 */
      openLogDir: () => Promise<void>
    }
    versions: {
      node: () => string
      chrome: () => string
      electron: () => string
    }
    miaoyuApi: {
      /** 妙语库图片目录的 archivist base URL。渲染端用 `${base}/${hash}.${ext}` 拼具体图片 URL。 */
      imagesBase: () => Promise<string>
      /** 存一张图（data URL）；主进程超宽则缩 + 转 JPEG，按内容 sha1 去重落盘，返回 {hash, ext}。 */
      saveImage: (dataUrl: string) => Promise<{ hash: string; ext: string }>
      /** 坚果云同步：把一批图片（`hash.ext`）读成 base64，缺图跳过。 */
      exportImages: (names: string[]) => Promise<Record<string, string>>
      /** 坚果云同步：把 base64 图片写回本地（按文件名跳过已存在），返回写入张数。 */
      importImages: (map: Record<string, string>) => Promise<number>
    }
    bgmApi: {
      /**
       * `update=true` 同时绕过渲染层和主进程的缓存,每一页都重新抓 —— 只给手动刷新按钮用
       * 别拿它做后台同步。`cat` 是 BGM 类目(2=动画 / 1=书籍),缺省 2。
       */
      search: (keyword: string, update?: boolean, cat?: 1 | 2) => Promise<BgmSearchResult[]>
      detail: (subjectId: number) => Promise<BgmDetail>
      /** 订阅分页进度,每完成一页触发 `(current, total)`;返回取消订阅函数。 */
      onSearchProgress: (cb: (current: number, total: number) => void) => () => void
      /** 本季新番周历。`update=true` 绕过 24h 缓存。 */
      calendar: (update?: boolean) => Promise<BgmCalendarResult>
      /** 封面本地化：下载 url 到本地，返回 archivist:// 路径（失败 null）。 */
      cacheCover: (key: string, url: string, maxWidth?: number) => Promise<string | null>
      /** BGM 鉴权状态（只含布尔，不含 token/cookie 明文）。 */
      authStatus: () => Promise<BgmAuthStatus>
      /** 设置个人访问令牌（粘贴即用，传空串=清除）。返回最新状态。 */
      setToken: (token: string) => Promise<BgmAuthStatus>
      /** 弹内嵌 BGM 登录窗口，登录成功后捕获 cookie。返回最新状态。 */
      login: () => Promise<BgmAuthStatus>
      /** 退出网页登录（清 cookie，令牌保留）。返回最新状态。 */
      logout: () => Promise<BgmAuthStatus>
      /** 主动校验网页登录是否过期（失效会自动清 cookie）。返回最新状态。 */
      verifyLogin: () => Promise<BgmAuthStatus>
      /** 读已保存的登录邮箱/密码（供设置回显 + 登录窗自动填充）。 */
      getCredentials: () => Promise<BgmCredentials>
      /** 保存登录邮箱/密码（纯本地，供登录窗自动填充）。返回最新值。 */
      setCredentials: (email: string, password: string) => Promise<BgmCredentials>
    }
    xifanApi: {
      getCaptcha: () => Promise<{ image_b64: string }>
      verifyCaptcha: (code: string) => Promise<{ success: boolean }>
      /** 稀饭账号登录态(cookie 是否落地),不涉及令牌/密码明文。 */
      authStatus: () => Promise<{ loggedIn: boolean }>
      login: (username: string, password: string, verify: string) => Promise<{ success: boolean; message: string }>
      logout: () => Promise<{ loggedIn: boolean }>
      search: (keyword: string) => Promise<XifanSearchResult[] | { needs_captcha: true }>
      getWatch: (watchUrl: string, preferCache?: boolean) => Promise<XifanWatchInfo>
      /** 在线播放:模板直链 404 时回源播放页解析真实地址(找不到返回 null)。 */
      resolveEpUrl: (epPage: string, ep: number) => Promise<string | null>
      /** 逐集 MP4 地址缓存 24h；video 已报错时 forceRefresh=true 回源更新一次。 */
      resolvePlayUrl: (template: string | null, epPage: string, ep: number, forceRefresh?: boolean) => Promise<string | null>
      /** 下载配置面板专用:watch() 只解析当前激活源,这里主动并发补全其余线路。 */
      resolveAllSources: (animeId: string, sources: XifanSource[]) => Promise<XifanSource[]>
      startDownload: (
        title: string,
        templates: string[],
        startEp: number,
        endEp: number,
        savePath?: string,
        excludeEps?: number[],
        epPages?: string[]
      ) => Promise<{ started: boolean; taskId: string }>
      cancelDownload: (taskId: string) => Promise<{ cancelled: boolean }>
      pauseDownload: (taskId: string) => Promise<{ paused: boolean }>
      resumeDownload: (taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number, epPages?: string[]) => Promise<{ resumed: boolean }>
      requeueEpisodes: (
        taskId: string,
        title: string,
        templates: string[],
        eps: number[],
        savePath?: string,
        sourceIdx?: number,
        epPages?: string[]
      ) => Promise<{ started: boolean }>
      retryDownload: (
        taskId: string,
        title: string,
        templates: string[],
        failedEps: number[],
        savePath?: string,
        sourceIdx?: number,
        epPages?: string[]
      ) => Promise<{ started: boolean }>
      switchSource: (
        taskId: string,
        title: string,
        templates: string[],
        failedEps: number[],
        newSourceIdx: number,
        savePath?: string,
        epPages?: string[]
      ) => Promise<{ switched: boolean }>
    }
    biliApi: {
      /** B 站登录态(persist:bili 分区里有没有有效 SESSDATA)。 */
      status: () => Promise<{ loggedIn: boolean }>
      /** 申请 TV 端登录二维码。qrDataUrl 是白边烤进 PNG 的 data URL,直接 <img>。 */
      createQr: () => Promise<{ authCode: string; qrDataUrl: string }>
      /** 查一次扫码结果。'ok' 时 cookie 已写进 persist:bili 分区。 */
      pollQr: (authCode: string) => Promise<{
        state: 'pending' | 'scanned' | 'expired' | 'ok'
        loggedIn: boolean
      }>
      /** 完成极验并发送短信验证码；用户关闭极验窗时返回 cancelled。 */
      sendSms: (phone: string) => Promise<
        { cancelled: true } | { cancelled: false; flowId: string }
      >
      /** 用 sendSms 返回的一次性 flowId + 6 位短信码完成登录。 */
      loginSms: (flowId: string, code: string) => Promise<{ loggedIn: true }>
      /** 清空 persist:bili 分区 cookie(退出登录)。 */
      logout: () => Promise<{ loggedIn: boolean }>
      /** BV 号 → 稿件信息。pages 就是合集的集数列表(&p=N 里的 N = page)。 */
      videoInfo: (bvid: string) => Promise<BiliVideoInfo>
      /** 某一分 P 的 DASH 音视频分轨。可选画质由登录态/会员权益决定。 */
      dash: (aid: number, cid: number) => Promise<BiliDash>
    }
    aowuApi: {
      search: (keyword: string) => Promise<{
        requestId: string
        results: AowuSearchResult[]
        total: number
        /** 为 true 表示还有后续页会通过 onSearchPage 送来。 */
        more: boolean
      }>
      onSearchPage: (
        cb: (requestId: string, results: AowuSearchResult[], done: boolean) => void
      ) => () => void
      getWatch: (watchUrl: string) => Promise<AowuWatchInfo>
      /** 搜索期的 /v/{id} URL → 用户可用的 /w/{token} URL。 */
      resolveShareUrl: (input: string) => Promise<string>
      resolveMp4Url: (animeId: string, sourceIdx: number, ep: number) => Promise<string>
      startDownload: (
        title: string,
        animeId: string,
        sourceIdx: number,
        epList: AowuEpisode[],
        selectedIdxs: number[],
        savePath?: string
      ) => Promise<{ started: boolean; taskId: string }>
      cancelDownload: (taskId: string) => Promise<{ cancelled: boolean }>
      pauseDownload: (taskId: string) => Promise<{ paused: boolean }>
      resumeDownload: (
        taskId: string,
        title?: string,
        animeId?: string,
        sourceIdx?: number,
        epList?: AowuEpisode[],
        pendingEps?: number[],
        savePath?: string
      ) => Promise<{ resumed: boolean }>
      requeueEpisodes: (
        taskId: string,
        title: string,
        animeId: string,
        sourceIdx: number,
        epList: AowuEpisode[],
        eps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
      retryDownload: (
        taskId: string,
        title: string,
        animeId: string,
        sourceIdx: number,
        epList: AowuEpisode[],
        failedEps: number[],
        savePath?: string
      ) => Promise<{ started: boolean }>
      switchSource: (
        taskId: string,
        title: string,
        animeId: string,
        newSourceIdx: number,
        epList: AowuEpisode[],
        failedEps: number[],
        savePath?: string
      ) => Promise<{ switched: boolean }>
    }
    mailApi: {
      /** 读当前邮件配置。出于安全,授权码不原样回传,只给一个「磁盘上有没有」的布尔位。 */
      getConfig: () => Promise<{ enabled: boolean; qqEmail: string; hasAuthCode: boolean }>
      /** 保存邮件配置。授权码留空表示沿用磁盘旧值 —— 改开关或邮箱时不必每次重输。 */
      setConfig: (config: { enabled: boolean; qqEmail: string; authCode: string }) => Promise<boolean>
      /** 触发一次周历邮件发送(截图 + SMTP)。`sent` 表示是否真的发出,reason 留作排错线索。 */
      sendCalendar: () => Promise<{ sent: boolean; reason?: string }>
      /** 发一封追番报告邮件。`html` 是渲染层已经拼好的完整正文(带内联样式)。 */
      sendAnimeReport: (html: string) => Promise<{ sent: boolean; reason?: string }>
      /** 发一封不带截图的测试邮件，失败会抛错。 */
      testSend: () => Promise<boolean>
    }
    /** screenshot 模式渲染器专用，普通页面不应使用。 */
    screenshotApi: {
      reportCalendarReady: (height: number) => Promise<boolean>
    }
    updaterApi: {
      /** 主动触发检查更新。dev 模式下返回 { skipped: true }。 */
      check: () => Promise<{ skipped?: boolean; reason?: string; ok?: boolean }>
      /** Windows: 重启并安装；macOS: shell.openExternal release 页。 */
      install: () => Promise<{ ok: boolean; error?: string }>
      openReleasePage: () => Promise<{ ok: boolean }>
      onChecking: (cb: () => void) => () => void
      onAvailable: (cb: (info: { version: string }) => void) => () => void
      onAvailableMac: (cb: (info: { version: string; releaseUrl?: string }) => void) => () => void
      onDownloadProgress: (
        cb: (p: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void,
      ) => () => void
      onDownloaded: (cb: (info: { version: string }) => void) => () => void
      onNotAvailable: (cb: (info: { version: string }) => void) => () => void
      onError: (cb: (info: { message: string }) => void) => () => void
    }
    webdavApi: {
      getConfig: () => Promise<{ account: string; appPassword: string; remotePath: string } | null>
      saveConfig: (config: { account: string; appPassword: string; remotePath: string }) => Promise<boolean>
      test: () => Promise<boolean>
      /** 把一份 JSON 推到该类别对应的远端文件,`kind` 决定写基准目录下的哪一个。 */
      push: (kind: 'homework' | 'anime' | 'miaoyu', jsonStr: string) => Promise<boolean>
      pull: (kind: 'homework' | 'anime' | 'miaoyu') => Promise<string>
    }
    webAccountApi: {
      status: () => Promise<{ loggedIn: boolean; username: string }>
      login: (input: { username: string; password: string }) => Promise<{ loggedIn: true; username: string }>
      logout: () => Promise<{ loggedIn: false; username: string }>
      pullTracks: () => Promise<{ rev: number; data: unknown[] }>
      pushTracks: (input: {
        baseRev: number
        force?: boolean
        data: unknown[]
      }) => Promise<
        | { ok: true; conflict: false; rev: number; count: number }
        | { ok: false; conflict: true; rev: number; serverCount: number; error: string }
      >
    }
    libraryApi: {
      getPaths: () => Promise<LibraryPath[]>
      addPath: (folderPath: string, label: string) => Promise<LibraryPath[]>
      removePath: (folderPath: string) => Promise<LibraryPath[]>
      getEntries: () => Promise<LibraryEntry[]>
      getFiles: (folderPath: string) => Promise<LibraryFile[]>
      openFolder: (folderPath: string) => Promise<void>
      playVideo: (filePath: string) => Promise<void>
      playFolder: (folderPath: string) => Promise<void>
      scan: () => Promise<LibraryEntry[]>
      onScanStatus: (cb: (status: { status: string, currentVal: number, totalVal: number }) => void) => () => void
      onLibraryUpdated: (callback: (entries: LibraryEntry[]) => void) => void
    }
  }
}

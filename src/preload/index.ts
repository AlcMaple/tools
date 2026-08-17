import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron,
})

contextBridge.exposeInMainWorld('bgmApi', {
  // 默认通道：只搜本地动画索引，不会向 BGM 发请求。书籍库暂不支持，
  // 返回值的 supported=false 由 UI 明确引导用户点「在线搜索」。
  searchOffline: (keyword: string, cat?: 1 | 2) =>
    ipcRenderer.invoke('bgm:search-offline', keyword, cat),
  // 显式在线通道；`update` 仍只表示绕过原有在线缓存，不和离线/在线语义混用。
  searchOnline: (keyword: string, update?: boolean, cat?: 1 | 2) =>
    ipcRenderer.invoke('bgm:search', keyword, update, cat),
  detail: (subjectId: number) => ipcRenderer.invoke('bgm:detail', subjectId),
  // 多页搜索的分页进度,主进程每抓完一页发一次 (current, total)。返回取消订阅函数。
  onSearchProgress: (cb: (current: number, total: number) => void) => {
    const handler = (_: Electron.IpcRendererEvent, current: number, total: number): void =>
      cb(current, total)
    ipcRenderer.on('bgm:search-progress', handler)
    return () => ipcRenderer.removeListener('bgm:search-progress', handler)
  },
  /** 本季新番周历。`update=true` 绕过 24h 缓存。 */
  calendar: (update?: boolean) => ipcRenderer.invoke('bgm:calendar', update),
  /** 封面本地化:下载到本地并返回 archivist:// 路径(失败返回 null)。key 一般传 String(bgmId)。 */
  cacheCover: (key: string, url: string, maxWidth?: number): Promise<string | null> =>
    ipcRenderer.invoke('bgm:cache-cover', key, url, maxWidth),
  // 鉴权:状态(只含布尔)/ 设置令牌 / 弹登录窗 / 退出登录。token、cookie 明文
  // 不出主进程。
  authStatus: () => ipcRenderer.invoke('bgm:auth-status'),
  setToken: (token: string) => ipcRenderer.invoke('bgm:set-token', token),
  login: () => ipcRenderer.invoke('bgm:login'),
  logout: () => ipcRenderer.invoke('bgm:logout'),
  // 主动校验网页登录是否过期(失效会自动清 cookie),返回最新状态。
  verifyLogin: () => ipcRenderer.invoke('bgm:verify-login'),
  // 登录邮箱/密码(供登录窗自动填充)。纯本地存储,明文回传仅用于设置回显。
  getCredentials: () => ipcRenderer.invoke('bgm:get-credentials'),
  setCredentials: (email: string, password: string) =>
    ipcRenderer.invoke('bgm:set-credentials', email, password),
})

// 下载进度的唯一订阅点 —— 三个源都发到统一的 'download:progress' 频道
// 渲染层只需要一个监听器。
contextBridge.exposeInMainWorld('downloadApi', {
  onProgress: (cb: (taskId: string, event: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, taskId: string, ev: unknown): void => cb(taskId, ev)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  },
})

contextBridge.exposeInMainWorld('systemApi', {
  /**
   * 渲染进程完全就绪(React 挂载完 + 字体加载完)后调一次,主进程据此一次性显示窗口
   * 避免首帧 show 之后字体/图标陆续跳出来的闪烁。
   */
  signalReady: () => ipcRenderer.send('app:renderer-ready'),
  getDiskFree: () => ipcRenderer.invoke('system:disk-free'),
  // 离开播放页时收掉在线播放的缓冲(mp4 后台顺序流 + HLS 分片预取)。一次性通知,用 send。
  releaseMedia: () => ipcRenderer.send('media:release'),
  pickFolder: () => ipcRenderer.invoke('system:pick-folder'),
  /** 系统默认下载目录 —— 用户没配保存路径时所有下载器都静默落到这里,设置页要显示实际生效的路径。 */
  getDefaultDownloadsPath: () => ipcRenderer.invoke('system:default-downloads'),
  // 是否 dev(非打包)运行 —— 设置页据此决定是否显示「打开开发者工具」按钮。
  isDev: () => ipcRenderer.invoke('system:is-dev'),
  // 开关 DevTools(F12 那样的控制台)。仅 dev 生效,打包版返回 false。
  toggleDevTools: () => ipcRenderer.invoke('system:toggle-devtools'),
  checkConnectivity: () => ipcRenderer.invoke('system:connectivity'),
  loadSettingsHistory: () => ipcRenderer.invoke('system:history-read'),
  saveSettingsHistory: (entries: unknown) => ipcRenderer.invoke('system:history-write', entries),
  cacheGet: (key: string) => ipcRenderer.invoke('cache:get', key),
  cacheSet: (key: string, valueOrSubkey: unknown, maybeValue?: unknown) => ipcRenderer.invoke('cache:set', key, valueOrSubkey, maybeValue),
  getSetting: (key: string) => ipcRenderer.invoke('system:get-setting', key),
  setSetting: (key: string, value: any) => ipcRenderer.invoke('system:set-setting', key, value),
  // 右键菜单编辑命令:作用在主进程 webContents 当前聚焦元素/选区上(单向通知)。
  editCommand: (action: 'cut' | 'copy' | 'paste' | 'selectAll') =>
    ipcRenderer.send('system:edit-command', action),
  loadDownloadState: () => ipcRenderer.invoke('download:load-state'),
  saveDownloadState: (tasks: unknown) => ipcRenderer.invoke('download:save-state', tasks),
  onSpeedUpdate: (cb: (bps: number) => void) => {
    const handler = (_: Electron.IpcRendererEvent, bps: number) => cb(bps)
    ipcRenderer.on('system:speed', handler)
    return () => ipcRenderer.removeListener('system:speed', handler)
  },
  // 渲染进程错误转发到主进程统一落盘(同 main.log)。
  logError: (scope: string, message: string) => ipcRenderer.invoke('log:error', scope, message),
  // 性能探子数据,落到同一个 main.log(tag=perf)。
  logPerf: (message: string) => ipcRenderer.invoke('log:perf', message),
  // 打开日志目录(设置→关于)。
  openLogDir: () => ipcRenderer.invoke('log:open-dir'),
})

contextBridge.exposeInMainWorld('girigiriApi', {
  getCaptcha: () => ipcRenderer.invoke('girigiri:captcha'),
  verifyCaptcha: (code: string) => ipcRenderer.invoke('girigiri:verify', code),
  search: (keyword: string) => ipcRenderer.invoke('girigiri:search', keyword),
  getWatch: (playUrl: string, preferCache?: boolean) =>
    ipcRenderer.invoke('girigiri:watch', playUrl, preferCache),
  // 在线播放:逐集播放地址缓存 24h(与稀饭同一套做法);video 已报错时传 true 强制回源刷新一次。
  resolveEpUrl: (epPageUrl: string, forceRefresh?: boolean) =>
    ipcRenderer.invoke('girigiri:resolve-ep-url', epPageUrl, forceRefresh),
  startDownload: (
    title: string,
    epList: { idx: number; name: string; url: string }[],
    selectedIdxs: number[],
    savePath?: string
  ) => ipcRenderer.invoke('girigiri:download', title, epList, selectedIdxs, savePath),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('girigiri:download-cancel', taskId),
  pauseDownload: (taskId: string) => ipcRenderer.invoke('girigiri:download-pause', taskId),
  resumeDownload: (taskId: string, title?: string, epList?: { idx: number; name: string; url: string }[], pendingEps?: number[], savePath?: string) =>
    ipcRenderer.invoke('girigiri:download-resume', taskId, title, epList, pendingEps, savePath),
  requeueEpisodes: (
    taskId: string,
    title: string,
    epList: { idx: number; name: string; url: string }[],
    eps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('girigiri:download-requeue', taskId, title, epList, eps, savePath),
  retryDownload: (
    taskId: string,
    title: string,
    epList: { idx: number; name: string; url: string }[],
    failedEps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('girigiri:download-retry', taskId, title, epList, failedEps, savePath),
})

contextBridge.exposeInMainWorld('xifanApi', {
  getCaptcha: () => ipcRenderer.invoke('xifan:captcha'),
  verifyCaptcha: (code: string) => ipcRenderer.invoke('xifan:verify', code),
  // 账号登录:登录态(cookie)存主进程 xifanSession,UI 只拿一个布尔。
  authStatus: () => ipcRenderer.invoke('xifan:auth-status'),
  login: (username: string, password: string, verify: string) =>
    ipcRenderer.invoke('xifan:login', username, password, verify),
  logout: () => ipcRenderer.invoke('xifan:logout'),
  search: (keyword: string) => ipcRenderer.invoke('xifan:search', keyword),
  getWatch: (watchUrl: string, preferCache?: boolean) =>
    ipcRenderer.invoke('xifan:watch', watchUrl, preferCache),
  // 在线播放:模板直链 404 时回源播放页解析真实地址(找不到返回 null)。
  resolveEpUrl: (epPage: string, ep: number) => ipcRenderer.invoke('xifan:resolve-ep-url', epPage, ep),
  // 在线播放:逐集 MP4 地址缓存 24h；video 已报错时传 true 强制回源刷新一次。
  resolvePlayUrl: (template: string | null, epPage: string, ep: number, forceRefresh?: boolean) =>
    ipcRenderer.invoke('xifan:resolve-play-url', template, epPage, ep, forceRefresh),
  // 下载配置面板专用:watch() 只解析当前激活源,这里主动并发补全其余线路。
  resolveAllSources: (animeId: string, sources: unknown[]) =>
    ipcRenderer.invoke('xifan:resolve-all-sources', animeId, sources),
  startDownload: (title: string, templates: string[], startEp: number, endEp: number, savePath?: string, excludeEps?: number[], epPages?: string[]) =>
    ipcRenderer.invoke('xifan:download', title, templates, startEp, endEp, savePath, excludeEps, epPages),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('xifan:download-cancel', taskId),
  pauseDownload: (taskId: string) => ipcRenderer.invoke('xifan:download-pause', taskId),
  resumeDownload: (taskId: string, title?: string, templates?: string[], pendingEps?: number[], savePath?: string, sourceIdx?: number, epPages?: string[]) =>
    ipcRenderer.invoke('xifan:download-resume', taskId, title, templates, pendingEps, savePath, sourceIdx, epPages),
  requeueEpisodes: (taskId: string, title: string, templates: string[], eps: number[], savePath?: string, sourceIdx?: number, epPages?: string[]) =>
    ipcRenderer.invoke('xifan:download-requeue', taskId, title, templates, eps, savePath, sourceIdx, epPages),
  retryDownload: (taskId: string, title: string, templates: string[], failedEps: number[], savePath?: string, sourceIdx?: number, epPages?: string[]) =>
    ipcRenderer.invoke('xifan:download-retry', taskId, title, templates, failedEps, savePath, sourceIdx, epPages),
  switchSource: (taskId: string, title: string, templates: string[], failedEps: number[], newSourceIdx: number, savePath?: string, epPages?: string[]) =>
    ipcRenderer.invoke('xifan:download-switch-source', taskId, title, templates, failedEps, newSourceIdx, savePath, epPages),
})

contextBridge.exposeInMainWorld('biliApi', {
  // B 站登录态(011 在线观看):TV 端扫码 + persist:bili 分区。web 端扫码接口被 B 站
  // 风控挡着(手机确认那步弹「API校验密匙错误」),换 TV 端,见 main/ipc/bili.ts。
  status: () => ipcRenderer.invoke('bili:status'),
  createQr: () => ipcRenderer.invoke('bili:qr-create'),
  pollQr: (authCode: string) => ipcRenderer.invoke('bili:qr-poll', authCode),
  // Biu 同款短信链路:先完成极验并发送验证码,再用一次性 flowId 提交短信码。
  sendSms: (phone: string) => ipcRenderer.invoke('bili:sms-send', phone),
  loginSms: (flowId: string, code: string) => ipcRenderer.invoke('bili:sms-login', flowId, code),
  logout: () => ipcRenderer.invoke('bili:logout'),
  // BV 号 → 稿件信息(合集的分 P 就是集数列表);cid → DASH 音视频分轨
  videoInfo: (bvid: string) => ipcRenderer.invoke('bili:video-info', bvid),
  dash: (aid: number, cid: number) => ipcRenderer.invoke('bili:dash', aid, cid),
})

contextBridge.exposeInMainWorld('aowuApi', {
  // 流式搜索:立刻返回第一页,后续页通过 onSearchPage 事件推送。
  search: (keyword: string) => ipcRenderer.invoke('aowu:search', keyword),
  onSearchPage: (cb: (requestId: string, results: unknown[], done: boolean) => void) => {
    const handler = (_: Electron.IpcRendererEvent, requestId: string, results: unknown[], done: boolean): void =>
      cb(requestId, results, done)
    ipcRenderer.on('aowu:search-page', handler)
    return () => ipcRenderer.removeListener('aowu:search-page', handler)
  },
  getWatch: (watchUrl: string) => ipcRenderer.invoke('aowu:watch', watchUrl),
  /** 搜索期的 /v/{id} URL → 用户可分享的 /w/{token} URL。 */
  resolveShareUrl: (input: string) =>
    ipcRenderer.invoke('aowu:resolve-share-url', input) as Promise<string>,
  resolveMp4Url: (animeId: string, sourceIdx: number, ep: number) =>
    ipcRenderer.invoke('aowu:resolve-mp4-url', animeId, sourceIdx, ep) as Promise<string>,
  startDownload: (
    title: string,
    animeId: string,
    sourceIdx: number,
    epList: { idx: number; name?: string; label: string }[],
    selectedIdxs: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download', title, animeId, sourceIdx, epList, selectedIdxs, savePath),
  cancelDownload: (taskId: string) => ipcRenderer.invoke('aowu:download-cancel', taskId),
  pauseDownload: (taskId: string) => ipcRenderer.invoke('aowu:download-pause', taskId),
  resumeDownload: (
    taskId: string,
    title?: string,
    animeId?: string,
    sourceIdx?: number,
    epList?: { idx: number; label: string }[],
    pendingEps?: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-resume', taskId, title, animeId, sourceIdx, epList, pendingEps, savePath),
  requeueEpisodes: (
    taskId: string,
    title: string,
    animeId: string,
    sourceIdx: number,
    epList: { idx: number; label: string }[],
    eps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-requeue', taskId, title, animeId, sourceIdx, epList, eps, savePath),
  retryDownload: (
    taskId: string,
    title: string,
    animeId: string,
    sourceIdx: number,
    epList: { idx: number; label: string }[],
    failedEps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-retry', taskId, title, animeId, sourceIdx, epList, failedEps, savePath),
  switchSource: (
    taskId: string,
    title: string,
    animeId: string,
    newSourceIdx: number,
    epList: { idx: number; label: string }[],
    failedEps: number[],
    savePath?: string
  ) => ipcRenderer.invoke('aowu:download-switch-source', taskId, title, animeId, newSourceIdx, epList, failedEps, savePath),
})

contextBridge.exposeInMainWorld('fileExplorerApi', {
  getHomeInfo: () => ipcRenderer.invoke('fs:home-info'),
  listDir: (dirPath: string) => ipcRenderer.invoke('fs:list-dir', dirPath),
  open: (targetPath: string) => ipcRenderer.invoke('fs:open', targetPath),
  reveal: (targetPath: string) => ipcRenderer.invoke('fs:reveal', targetPath),
  /**
   * 「移到回收站」Stage 1(5s 整体送回收站窗口)。失败时返回 `stage1-failed`,由渲染层弹确认
   * 用户点继续才调 `trashFragmented` —— 本接口**不**自动进 Stage 2。
   */
  trash: (targetPath: string) => ipcRenderer.invoke('fs:trash', targetPath),
  /**
   * 「移到回收站」Stage 2(用户确认后跑完整两阶段)。返回 `fragmented` 表示分片成功
   * 渲染层必须强提示「回收站里是散件,可全选→还原重建结构」。
   */
  trashFragmented: (targetPath: string) => ipcRenderer.invoke('fs:trash-fragmented', targetPath),
  /** 永久删除（recycle-helper --purge 模式，三级 fallback 几乎一次必成）。 */
  deletePermanent: (targetPath: string) => ipcRenderer.invoke('fs:delete-permanent', targetPath),
  resolveSpecial: (input: string) => ipcRenderer.invoke('fs:resolve-special', input),
  /**
   * 从 `targetPath` 往上找最近的、仍然存在的目录(自身还在就返回自身)。
   * 删除流程用它把 UI 从已删除的 cwd 上撤走,不至于卡在打不开的路径。
   */
  findExistingAncestor: (targetPath: string): Promise<string | null> =>
    ipcRenderer.invoke('fs:find-existing-ancestor', targetPath),
  onDirChange: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('fs:dir-changed', handler)
    return () => ipcRenderer.removeListener('fs:dir-changed', handler)
  },
})

contextBridge.exposeInMainWorld('libraryApi', {
  getPaths: () => ipcRenderer.invoke('library:get-paths'),
  addPath: (folderPath: string, label: string) => ipcRenderer.invoke('library:add-path', folderPath, label),
  removePath: (folderPath: string) => ipcRenderer.invoke('library:remove-path', folderPath),
  getEntries: () => ipcRenderer.invoke('library:get-entries'),
  getFiles: (folderPath: string) => ipcRenderer.invoke('library:get-files', folderPath),
  openFolder: (folderPath: string) => ipcRenderer.invoke('library:open-folder', folderPath),
  playVideo: (filePath: string) => ipcRenderer.invoke('library:play-video', filePath),
  playFolder: (folderPath: string) => ipcRenderer.invoke('library:play-folder', folderPath),
  scan: () => ipcRenderer.invoke('library:scan'),
  onScanStatus: (cb: (status: { status: string, currentVal: number, totalVal: number }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, status: any) => cb(status)
    ipcRenderer.on('library:scan-status', handler)
    return () => ipcRenderer.removeListener('library:scan-status', handler)
  },
  onLibraryUpdated: (callback: (entries: any[]) => void) => {
    ipcRenderer.removeAllListeners('library:updated') // 防止热更新导致重复绑定
    ipcRenderer.on('library:updated', (_event, entries) => callback(entries))
  }
})

contextBridge.exposeInMainWorld('mailApi', {
  /** 获取邮件配置（authCode 不会原样返回，只回布尔 hasAuthCode）。 */
  getConfig: () => ipcRenderer.invoke('mail:get-config'),
  /**
   * 保存邮件配置。authCode 留空表示沿用磁盘上已有的加密值（编辑场景里
   * 用户不重新输入授权码也能改 enabled / qqEmail）。
   */
  setConfig: (config: { enabled: boolean; qqEmail: string; authCode: string }) =>
    ipcRenderer.invoke('mail:set-config', config),
  /** 手动触发周历邮件发送（用于内部自动触发逻辑，UI 一般不直接调）。 */
  sendCalendar: () => ipcRenderer.invoke('mail:send-calendar'),
  /**
   * MyAnime「发送极简报告」按钮调这个。html 参数是 renderer 拼好的完整
   * 邮件正文（含内联样式），主进程只负责套上 from/to/subject 通过 SMTP 发送。
   */
  sendAnimeReport: (html: string) => ipcRenderer.invoke('mail:send-anime-report', html),
  /** Settings 页「发送测试邮件」按钮调这个，失败会抛错让用户看到原因。 */
  testSend: () => ipcRenderer.invoke('mail:test-send'),
})

// 仅供 screenshot 模式的渲染器使用：渲染好后上报 scrollHeight 让主进程
// resize 隐藏窗口然后 capturePage。普通页面不应该用这个接口。
// IPC payload 用对象包一层 —— 主进程那边解构 .height 才能拿到，直接传数字会让
// 主进程拿到 undefined（destructure on number → undefined），导致 setBounds
// 传入 NaN，截图整个崩在 resize 这一步。
contextBridge.exposeInMainWorld('screenshotApi', {
  reportCalendarReady: (height: number) =>
    ipcRenderer.invoke('screenshot:calendar-ready', { height }),
})

/**
 * 应用内自动更新。事件流：
 * - `checking`: 检查中
 * - `available`: 发现新版本（Windows，autoUpdater 会自动开始后台下载）
 * - `available-mac`: 发现新版本（macOS，无下载，仅供跳转）
 * - `download-progress`: Windows 下载中（百分比）
 * - `downloaded`: Windows 下载完成，等待用户重启安装
 * - `not-available`: 已是最新（仅手动检查时炸）
 * - `error`: 检查 / 下载出错（手动检查时才显示）
 */
contextBridge.exposeInMainWorld('updaterApi', {
  /** 主动触发检查更新。返回 { skipped: true } 表示 dev 模式跳过。 */
  check: () => ipcRenderer.invoke('updater:check'),
  /** Windows: 重启并安装已下载的更新；macOS: 在浏览器打开 release 页。 */
  install: () => ipcRenderer.invoke('updater:install'),
  /** 备用入口：直接在浏览器打开 latest release 页。 */
  openReleasePage: () => ipcRenderer.invoke('updater:open-release-page'),
  onChecking: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('updater:checking', handler)
    return () => ipcRenderer.removeListener('updater:checking', handler)
  },
  onAvailable: (cb: (info: { version: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { version: string }): void => cb(info)
    ipcRenderer.on('updater:available', handler)
    return () => ipcRenderer.removeListener('updater:available', handler)
  },
  onAvailableMac: (cb: (info: { version: string; releaseUrl?: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { version: string; releaseUrl?: string }): void => cb(info)
    ipcRenderer.on('updater:available-mac', handler)
    return () => ipcRenderer.removeListener('updater:available-mac', handler)
  },
  onDownloadProgress: (cb: (p: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, p: any): void => cb(p)
    ipcRenderer.on('updater:download-progress', handler)
    return () => ipcRenderer.removeListener('updater:download-progress', handler)
  },
  onDownloaded: (cb: (info: { version: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { version: string }): void => cb(info)
    ipcRenderer.on('updater:downloaded', handler)
    return () => ipcRenderer.removeListener('updater:downloaded', handler)
  },
  onNotAvailable: (cb: (info: { version: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { version: string }): void => cb(info)
    ipcRenderer.on('updater:not-available', handler)
    return () => ipcRenderer.removeListener('updater:not-available', handler)
  },
  onError: (cb: (info: { message: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { message: string }): void => cb(info)
    ipcRenderer.on('updater:error', handler)
    return () => ipcRenderer.removeListener('updater:error', handler)
  },
})

contextBridge.exposeInMainWorld('webdavApi', {
  getConfig: () => ipcRenderer.invoke('webdav:get-config'),
  saveConfig: (config: { account: string; appPassword: string; remotePath: string }) =>
    ipcRenderer.invoke('webdav:save-config', config),
  test: () => ipcRenderer.invoke('webdav:test'),
  /**
   * 把一份 JSON 推到该类别对应的远端文件。每一类各有自己的 rev 和冲突检测,
   * 各个页面只推自己那一类。
   */
  push: (kind: 'homework' | 'anime' | 'miaoyu', jsonStr: string) => ipcRenderer.invoke('webdav:push', kind, jsonStr),
  pull: (kind: 'homework' | 'anime' | 'miaoyu') => ipcRenderer.invoke('webdav:pull', kind),
})

contextBridge.exposeInMainWorld('webAccountApi', {
  status: () => ipcRenderer.invoke('web-account:status'),
  login: (input: { username: string; password: string }) => ipcRenderer.invoke('web-account:login', input),
  logout: () => ipcRenderer.invoke('web-account:logout'),
  pullTracks: () => ipcRenderer.invoke('web-account:pull-tracks'),
  pushTracks: (input: { baseRev: number; force?: boolean; data: unknown[] }) =>
    ipcRenderer.invoke('web-account:push-tracks', input),
})

contextBridge.exposeInMainWorld('miaoyuApi', {
  /** 妙语库图片目录的 archivist base URL；渲染端用 `${base}/${hash}.${ext}` 拼图片 URL。 */
  imagesBase: () => ipcRenderer.invoke('miaoyu:images-base'),
  /** 存一张图（data URL），主进程按内容 sha1 去重落盘，返回 {hash, ext}。 */
  saveImage: (dataUrl: string) =>
    ipcRenderer.invoke('miaoyu:save-image', dataUrl) as Promise<{ hash: string; ext: string }>,
  /** 坚果云同步：把一批图片（`hash.ext`）读成 base64，塞进同步 blob。 */
  exportImages: (names: string[]) =>
    ipcRenderer.invoke('miaoyu:export-images', names) as Promise<Record<string, string>>,
  /** 坚果云同步：把 blob 里的 base64 图片写回本地（按文件名跳过已存在），返回写入张数。 */
  importImages: (map: Record<string, string>) =>
    ipcRenderer.invoke('miaoyu:import-images', map) as Promise<number>,
})

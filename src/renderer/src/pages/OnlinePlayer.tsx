// 在线观看播放页 —— 追番卡片「播放」按钮进入(/play?bgm=<bgmId>)。沉浸式,无侧边栏。
//
// 设计从简,四要素:动漫标题 / 多站切换 / 站内线路 / 集数网格(011 阶段决策)。
// 交互定稿见 docs/design-mockups/在线观看-源切换交互.html。
//
// 源切换与绑定的关系(011 定调,别回退成「切换器=bindings」):
//   - 稀饭/Girigiri/嗷呜三个 chips **常驻**,与有没有绑定无关;自定义链接追加在后。
//   - 未绑定的站是虚线 chip,点开才**懒式搜索这一个站**(绝不并发搜三站——
//     xifan/girigiri 有验证码);挑中候选**自动写回 binding**,下次直接播。
//   - 跨站不做自动推断:每个站的关联都是用户第一次点它时亲手挑的。
//
// 播放形态按源分三种:
//   - Xifan / Aowu:解析 mp4 直链,<video> 播放(Chromium 原生控件)。直链**不**
//     直接喂 <video>,而是包成同源的 mtmedia:// 走主进程流代理(见 toMediaProxy /
//     main/shared/media-proxy.ts):dev 的 http://localhost origin 会拒绝带
//     content-disposition 的跨源媒体(pan.wo.cn 联通网盘直链就是)→ code 4,
//     经主进程取流剥头后 dev/正式都不受 origin 限制。解析类请求仍全在主进程 IPC。
//   - Bilibili(普通视频 BV):**自研播放** —— 主进程按 TV appkey 签名问 playurl 要
//     DASH 音视频分轨,合成 MPD 交给 shaka-player 走 MSE。**别退回官方外链播放器**
//     (player.bilibili.com/player.html):它把画质锁在 360P(菜单里列 1080P 但选了
//     没用)、暂停弹推荐位、盖「进入哔哩哔哩观看更高清」引流层,而且合集拿不到分 P
//     列表 —— 这四条都是它写死的,登录也解不开。分 P(&p=N)就是集数网格。
//   - 番剧 ep 链接 / 其他自定义源:仍用 <webview> 嵌站点播放器(persist:bili 分区,
//     登录后第一方 cookie 生效)。番剧走的是另一套 pgc playurl,暂未自研。
//   - Girigiri:地址从播放页 HTML 的 player_aaaa 直接解析(一次 GET,与稀饭同源)。
//     多数线路是 m3u8(HLS)—— Chromium 不原生支持,由 hls.js 接管 <video> 走 MSE
//     逐段喂,播放列表和分片同样过 mtmedia 代理(主进程把列表里的地址重写成
//     mtmedia://,否则 hls.js 在渲染进程直取 CDN 会被跨源策略拦);**少数老番线路
//     给的是 .mp4 直链**,那就走和稀饭一样的直喂路径。按后缀分流,别假设 girigiri
//     一定是 HLS。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Hls from 'hls.js'
import shaka from 'shaka-player'
import BiliLoginModal from '../components/BiliLoginModal'
import ErrorPanel from '../components/ErrorPanel'
import type { AnimeBinding } from '../stores/animeTrackStore'
import { animeTrackStore, useAnimeTrack } from '../stores/animeTrackStore'
import { useSourceSearch } from '../hooks/useSourceSearch'
import { biliMpdUri, pickVideoTracks } from '../utils/biliMpd'
import type { SearchCard, Source } from '../types/search'
import type { BiliDash, BiliVideoInfo } from '../types/bili'
import type { XifanWatchInfo } from '../types/xifan'
import type { AowuWatchInfo } from '../types/aowu'
import type { GirigiriWatchInfo } from '../types/girigiri'

// shaka 只认自己注册过的 scheme:B 站的分片地址已被主进程包成 mtmedia://(带防盗链
// Referer),不注册的话 shaka 直接报 UNSUPPORTED_SCHEME。用它自带的 fetch 插件即可
// —— mtmedia 声明了 supportFetchAPI,实测 fetch/XHR 都直通(见 011 纪要)。
shaka.polyfill.installAll()
shaka.net.NetworkingEngine.registerScheme(
  'mtmedia',
  shaka.net.HttpFetchPlugin.parse,
  shaka.net.NetworkingEngine.PluginPriority.PREFERRED,
  true, // progressSupport
)

const BUILTINS: Source[] = ['Xifan', 'Girigiri', 'Aowu']

interface PlayEp {
  idx: number
  label: string
}

interface PlayLine {
  name: string
  eps: PlayEp[]
}

/** 站点数据:线路 + 各线路集列表,连同解析播放地址所需的原始 watch 信息。 */
type SiteData =
  | { kind: 'xifan'; info: XifanWatchInfo; lines: PlayLine[] }
  | { kind: 'aowu'; info: AowuWatchInfo; lines: PlayLine[] }
  | { kind: 'girigiri'; info: GirigiriWatchInfo; lines: PlayLine[] }
  | { kind: 'bili'; info: BiliVideoInfo; lines: PlayLine[] }

type PlayerView =
  | { mode: 'none' }
  | { mode: 'loading' }
  | { mode: 'search' }
  | { mode: 'video'; url: string; isHls: boolean }
  | { mode: 'dash'; dash: BiliDash }
  | { mode: 'embed'; url: string; isBili: boolean }
  | { mode: 'error'; err: unknown }

/** 源切换器的一项:三个内置源常驻(binding 可空),自定义 binding 追加。 */
interface SourceEntry {
  key: string
  label: string
  builtin?: Source
  binding?: AnimeBinding
}

function bindingUrl(b: AnimeBinding): string {
  return b.sourceUrl || b.sourceKey
}

/** B 站**普通视频**链接里的 BV 号。番剧(/bangumi/play/ep…)没有 BV,返回 null。 */
function biliBvid(raw: string): string | null {
  if (!/bilibili\.com/i.test(raw)) return null
  return /BV[0-9A-Za-z]{10}/.exec(raw)?.[0] ?? null
}

/** B 站**番剧**链接 → 官方外链播放器 URL。番剧走另一套 pgc playurl,暂未自研,
 *  仍嵌外链播放器(它的画质锁死/引流层等毛病一并继承,普通视频已不走这里)。 */
function biliBangumiEmbedUrl(raw: string): string | null {
  const ep = /bilibili\.com\/bangumi\/play\/ep(\d+)/.exec(raw)
  return ep ? `https://player.bilibili.com/player.html?ep_id=${ep[1]}&autoplay=0` : null
}

/** 占位符按携带的位宽补零 —— 必须与主进程 formatEpUrl / siteApi.resolveEpUrl 一致
 *  (见 docs/regression/xifan-下载链接-集数补零-回归用例.md),兼容旧 {:02d} 模板。 */
function xifanUrlFromTemplate(template: string, ep: number): string {
  return template.replace(/\{:0?(\d*)d\}/, (_, w: string) =>
    String(ep).padStart(w ? parseInt(w, 10) : 0, '0'))
}

// mp4 直链包成同源流代理 URL 再喂 <video>(scheme 与 main/shared/media-proxy.ts
// 的 MEDIA_PROXY_SCHEME 保持一致)。绕开渲染进程 origin 对跨源媒体的拦截,
// dev/正式都能播;非 http(s) 原样返回。
function toMediaProxy(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url
  return `mtmedia://media/?u=${encodeURIComponent(url)}`
}

/** 集数格子的短显示:「第01集/话」类标签抽出数字,OVA/BD 等特殊标签原样展示。 */
function epShort(e: PlayEp): string {
  const m = /^第\s*0*(\d+)\s*[话集]$/.exec(e.label)
  if (m) return m[1].padStart(2, '0')
  return e.label || String(e.idx).padStart(2, '0')
}

async function loadSiteData(binding: AnimeBinding): Promise<SiteData> {
  const url = bindingUrl(binding)
  const bvid = biliBvid(url)
  if (bvid) {
    // 合集/多 P 稿件的 pages 就是集数列表(page = 链接上的 &p=N)。单 P 稿件 pages
    // 长度为 1,网格只有一格,与其他源形态一致。B 站只有一条「线路」。
    const info = await window.biliApi.videoInfo(bvid)
    if (info.pages.length === 0) throw new Error('这个稿件没有可播放的分 P')
    const lines = [{ name: 'B 站', eps: info.pages.map((p) => ({ idx: p.page, label: p.part })) }]
    return { kind: 'bili', info, lines }
  }
  if (binding.source === 'Xifan') {
    const info = await window.xifanApi.getWatch(url)
    if (info.error) throw new Error(info.error)
    const lines = info.sources.map((s) => ({
      name: s.name,
      eps: s.epLabels.length > 0
        ? s.epLabels.map((label, i) => ({ idx: i + 1, label }))
        : Array.from({ length: info.total }, (_, i) => ({ idx: i + 1, label: `第${String(i + 1).padStart(2, '0')}集` })),
    }))
    return { kind: 'xifan', info, lines }
  }
  if (binding.source === 'Girigiri') {
    const info = await window.girigiriApi.getWatch(url)
    if (info.error) throw new Error(info.error)
    const lines = info.sources.map((s) => ({
      name: s.name,
      eps: s.episodes.map((e) => ({ idx: e.idx, label: e.name })),
    }))
    if (lines.length === 0) throw new Error('没有解析到可播放的线路,换个源试试')
    return { kind: 'girigiri', info, lines }
  }
  const info = await window.aowuApi.getWatch(url)
  if (info.error) throw new Error(info.error)
  const lines = info.sources.map((s) => ({
    name: s.name,
    eps: s.episodes.map((e) => ({ idx: e.idx, label: e.label })),
  }))
  return { kind: 'aowu', info, lines }
}

/** 一集解析出来的播放形态:B 站是 DASH 分轨,其余是一条 url(mp4 或 m3u8)。 */
type Stream =
  | { kind: 'url'; url: string; isHls: boolean }
  | { kind: 'dash'; dash: BiliDash }

/** 解析某条线路某一集的播放地址:B 站给 DASH,girigiri 给 m3u8(HLS),其余给 mp4 直链。 */
async function resolveStream(data: SiteData, lineIdx: number, ep: number): Promise<Stream> {
  if (data.kind === 'bili') {
    const page = data.info.pages.find((p) => p.page === ep)
    if (!page) throw new Error('这个稿件没有这一集')
    return { kind: 'dash', dash: await window.biliApi.dash(data.info.aid, page.cid) }
  }
  if (data.kind === 'girigiri') {
    const line = data.info.sources[lineIdx]
    if (!line) throw new Error('线路不存在,换一条线路试试')
    const epInfo = line.episodes.find((e) => e.idx === ep)
    if (!epInfo) throw new Error('这条线路没有这一集,换一条线路试试')
    const url = await window.girigiriApi.resolveEpUrl(epInfo.url)
    if (!url) throw new Error('未能取到这一集的播放地址')
    // girigiri **不都是 HLS**:部分老番线路给的是 .mp4 直链,按后缀决定播放方式
    return { kind: 'url', url, isHls: /\.m3u8(\?|$)/i.test(url) }
  }
  if (data.kind === 'aowu') {
    const line = data.info.sources[lineIdx]
    if (!line) throw new Error('线路不存在,换一条线路试试')
    const url = await window.aowuApi.resolveMp4Url(data.info.id, line.idx, ep)
    return { kind: 'url', url, isHls: false }
  }
  const line = data.info.sources[lineIdx]
  if (!line) throw new Error('线路不存在,换一条线路试试')
  if (line.template) return { kind: 'url', url: xifanUrlFromTemplate(line.template, ep), isHls: false }
  // 这条线路连第 1 集地址都没解析出来(template null)→ 直接回源播放页解析
  if (!line.epPage) throw new Error('这条线路没有可用的播放地址,换一条线路试试')
  const real = await window.xifanApi.resolveEpUrl(line.epPage, ep)
  if (!real) throw new Error('未能解析到这一集的播放地址')
  return { kind: 'url', url: real, isHls: false }
}

/** 把选中的 qn 落到 shaka 上。B 站同档画质有多种编码,MPD 里只放了 avc1,按高度匹配。 */
function applyQuality(player: shaka.Player, dash: BiliDash, qn: number): void {
  const want = pickVideoTracks(dash).find((v) => v.id === qn)
  const tracks = player.getVariantTracks()
  const track = (want && tracks.find((t) => t.height === want.height)) ?? tracks[0]
  if (track) player.selectVariantTrack(track, true)
}

export default function OnlinePlayer(): JSX.Element {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const bgmId = Number(params.get('bgm') ?? 0)
  const track = useAnimeTrack(bgmId)

  // ── 源切换器条目:三个内置源常驻 + 自定义 binding 追加 ──────────────────────
  const entries = useMemo<SourceEntry[]>(() => {
    const bindings = track?.bindings ?? []
    const builtinEntries = BUILTINS.map((s) => ({
      key: `b:${s}`,
      label: s === 'Xifan' ? '稀饭' : s === 'Aowu' ? '嗷呜' : s,
      builtin: s,
      binding: bindings.find((b) => b.source === s),
    }))
    const customEntries = bindings
      .filter((b) => b.source === 'Bilibili' || b.source === 'Custom')
      .map((b, i) => ({
        key: `c:${i}:${b.sourceKey}`,
        label: b.source === 'Bilibili' ? (b.sourceTitle || 'B 站') : (b.sourceTitle || '自定义'),
        binding: b,
      }))
    return [...builtinEntries, ...customEntries]
  }, [track])

  // 默认选中:优先任一**已绑定的内置源**(三源现在都能应用内播了),其次自定义源,
  // 兜底第一个(稀饭,进去就是搜索面板)。只在初次进入时定一次。
  const [selKey, setSelKey] = useState<string | null>(null)
  useEffect(() => {
    if (selKey !== null || entries.length === 0) return
    const pick =
      entries.find((e) => e.builtin && e.binding) ??
      entries.find((e) => !e.builtin) ??
      entries[0]
    setSelKey(pick.key)
  }, [entries, selKey])
  const entry = entries.find((e) => e.key === selKey) ?? entries[0]

  const [data, setData] = useState<SiteData | null>(null)
  const [lineIdx, setLineIdx] = useState(0)
  const [ep, setEp] = useState<number | null>(null)
  const [view, setView] = useState<PlayerView>({ mode: 'none' })
  const [reloadTick, setReloadTick] = useState(0)
  const [resolveTick, setResolveTick] = useState(0)
  // 竞态防护:站点数据加载 / 地址解析都是异步,切站切集后旧结果作废
  const seqRef = useRef(0)
  // xifan 模板直链 404 时回源解析,同一集只回源一次,防 onError 死循环
  const fallbackTriedRef = useRef(false)
  // 播放失败自动兜底:记这条线路已试过,换下一条**还没试过**、含本集的线路
  // (同一集、只换线路,不跳集);三条都试完才停下报错。记忆在整部番的一次观看里
  // 持续累积:换站/换番(data 重载)才清零,换集**保留**;手动切线路把切走的旧线路
  // 计入已试;Try again 清零重来一轮(见下方 effect 与 selectLine / retry)。
  const triedLinesRef = useRef<Set<number>>(new Set())

  // B 站登录态(null = 还没查);webviewKey 用于登录后强制重载 webview
  const [biliLoggedIn, setBiliLoggedIn] = useState<boolean | null>(null)
  const [biliQrOpen, setBiliQrOpen] = useState(false)
  const [webviewKey, setWebviewKey] = useState(0)
  // 自定义源(webview 嵌真实播放页)进入「站点播放器自己的全屏」时,把 webview 容器
  // 铺满整个窗口 —— 这样站点在 webview 内部对 <video> 请求的 HTML5 全屏(只剩视频画面)
  // 才能覆盖整扇窗,和稀饭/Girigiri/B 站原生 <video> 全屏观感一致;否则 webview 只在
  // 「标题/切换器下方的箱子」里全屏,顶部那排 app chrome 还露着(用户实拍反馈)。
  //   - 由站点自己的全屏按钮驱动:webview 的 guest 请求 requestFullscreen 时,DOM 元素
  //     派发 enter-html-full-screen / leave-html-full-screen(Electron webview 事件)。
  //   - 只切容器 class(relative 盒子 ↔ fixed inset-0),webview 元素不换位置不重载,
  //     不打断播放;Esc / 站点退出全屏都会派发 leave 事件收起,无需自己接键盘。
  const [embedFs, setEmbedFs] = useState(false)
  const [embedWebviewEl, setEmbedWebviewEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const el = embedWebviewEl
    if (!el) return
    setEmbedFs(false) // 新挂载的 webview 一定不在全屏态,避免切源后残留铺满
    const onEnter = (): void => setEmbedFs(true)
    const onLeave = (): void => setEmbedFs(false)
    el.addEventListener('enter-html-full-screen', onEnter)
    el.addEventListener('leave-html-full-screen', onLeave)
    return () => {
      el.removeEventListener('enter-html-full-screen', onEnter)
      el.removeEventListener('leave-html-full-screen', onLeave)
    }
  }, [embedWebviewEl])
  // 离开 embed(切到内置源)时兜底收起,免得残留的全屏态盖住别的源
  useEffect(() => { if (view.mode !== 'embed') setEmbedFs(false) }, [view.mode])
  // 选中的画质(B 站 DASH)。null = 还没选,加载完取该稿件最高的一档。
  // 换集**保留**用户选的档:切到没有该档的稿件时,load 完自动回落到最高档。
  const [qn, setQn] = useState<number | null>(null)

  // 挑中候选自动关联后的轻提示
  const [toastText, setToastText] = useState<string | null>(null)
  useEffect(() => {
    if (!toastText) return
    const t = setTimeout(() => setToastText(null), 3600)
    return () => clearTimeout(t)
  }, [toastText])

  // ── 切换源(或绑定落地 / 手动重试)时决定播放器形态 ───────────────────────────
  const entryKey = entry?.key
  const entrySourceKey = entry?.binding?.sourceKey
  useEffect(() => {
    setData(null)
    setLineIdx(0)
    setEp(null)
    if (!entry) return
    if (!entry.builtin && !biliBvid(bindingUrl(entry.binding!))) {
      // 自定义源(番剧 ep / 非 B 站站点):webview 嵌站点自己的播放器。
      // B 站**普通视频**不走这里 —— 它有 BV 号,下面按内置源一样解析 DASH 自研播放。
      const raw = bindingUrl(entry.binding!)
      const embed = biliBangumiEmbedUrl(raw)
      setView({ mode: 'embed', url: embed ?? raw, isBili: /bilibili\.com/i.test(raw) })
      return
    }
    if (entry.builtin && !entry.binding) {
      // 未绑定的内置源:懒式单站搜索(面板挂在播放器区,挑中自动关联)
      setView({ mode: 'search' })
      return
    }
    setView({ mode: 'loading' })
    const seq = ++seqRef.current
    loadSiteData(entry.binding!)
      .then((d) => {
        if (seqRef.current !== seq) return
        setData(d)
        setView({ mode: 'none' })
      })
      .catch((err) => {
        if (seqRef.current !== seq) return
        setView({ mode: 'error', err })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, entrySourceKey, reloadTick])

  // ── B 站登录态:选中的是 B 站源时查一次 ────────────────────────────────────
  // 画质由登录态决定(匿名最高 480P,登录后才有 1080P),所以自研播放的 B 站源也要查。
  const needBiliAuth = !!entry && !entry.builtin && /bilibili\.com/i.test(bindingUrl(entry.binding!))
  useEffect(() => {
    if (!needBiliAuth) return
    let alive = true
    void window.biliApi.status().then((s) => { if (alive) setBiliLoggedIn(s.loggedIn) })
    return () => { alive = false }
  }, [needBiliAuth])

  // 登录态一变,画质档位跟着变 —— 重新解析这一集(自研播放),webview 那条则整个重载。
  const handleBiliAuthChanged = (loggedIn: boolean): void => {
    setBiliLoggedIn(loggedIn)
    setQn(null)
    setResolveTick((t) => t + 1)
    setWebviewKey((k) => k + 1)
  }
  const handleBiliLogout = (): void => {
    void window.biliApi.logout().then((s) => handleBiliAuthChanged(s.loggedIn))
  }

  // ── 集列表就绪后默认选「追番卡片上显示的那一集」 ────────────────────────────
  // 用户定调:卡片写着 1/12 就从第 1 集开始播,写 2 就从第 2 集开始 —— 所见即所播。
  // （旧逻辑选 N+1「下一集」,卡片显示 1 却从第 2 集开播,与用户心智不符。）
  // episode=0(还没看)→ 第一集;N 超出这条线路的集数(如 BD 线只有特典)→ 最后一集。
  useEffect(() => {
    if (!data || ep !== null) return
    const eps = data.lines[lineIdx]?.eps ?? []
    if (eps.length === 0) return
    const wanted = track?.episode ?? 0
    const last = eps[eps.length - 1]
    const target =
      eps.find((e) => e.idx === wanted) ??
      (wanted > last.idx ? last : eps[0])
    setEp(target.idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lineIdx, ep])

  // ── 选集 / 换线路(或重试)时解析播放地址 ────────────────────────────────────
  useEffect(() => {
    if (!data || ep === null) return
    const seq = ++seqRef.current
    fallbackTriedRef.current = false
    setView({ mode: 'loading' })
    resolveStream(data, lineIdx, ep)
      .then((s) => {
        if (seqRef.current !== seq) return
        setView(s.kind === 'dash' ? { mode: 'dash', dash: s.dash } : { mode: 'video', url: s.url, isHls: s.isHls })
      })
      .catch((err) => {
        if (seqRef.current !== seq) return
        setView({ mode: 'error', err })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lineIdx, ep, resolveTick])

  // 「已试线路」记录只在换站/换番(data 重新加载成新对象)时清零 —— 换集**不**清,
  // 同一部番里一条线路整体不行就跨集一直绕开它。triedLines 存的是当前 data 的
  // 线路下标,换站后下标语义全变、必须清;换集 data 引用不变,不触发本 effect,
  // 保留累积。手动选线路 / 自动兜底 / Try again 各自维护(见 selectLine /
  // tryNextLine / retry)。
  useEffect(() => {
    triedLinesRef.current = new Set()
  }, [data])

  // 播放失败自动兜底:换下一条**还没试过**、且含本集的线路(只换线路不跳集);
  // 三条都试完才停下报错。
  const tryNextLine = (): void => {
    if (!data || ep === null) return
    triedLinesRef.current.add(lineIdx)
    const nextIdx = data.lines.findIndex(
      (ln, i) => !triedLinesRef.current.has(i) && ln.eps.some((e) => e.idx === ep),
    )
    if (nextIdx >= 0) {
      const from = data.lines[lineIdx]?.name || `线路 ${lineIdx + 1}`
      const to = data.lines[nextIdx]?.name || `线路 ${nextIdx + 1}`
      setToastText(`${from} 播放失败,已自动切到 ${to}`)
      setLineIdx(nextIdx) // 触发解析 effect 换线路重播(triedLines 不清,防死循环)
    } else {
      setView({ mode: 'error', err: new Error('所有线路都播放失败了,可切换上方网站或稍后重试') })
    }
  }

  // xifan 模板拼接的直链对 OVA 等特殊集会 404 —— <video> 报错时先在**本线路**
  // 回源播放页解析真实地址重试一次(与下载器内部回源同源);本线路仍不行,
  // 就自动换下一条线路,直到三条都试完。
  const handleVideoError = (): void => {
    if (view.mode !== 'video' || !data || ep === null) return
    if (data.kind === 'xifan' && !fallbackTriedRef.current) {
      const line = data.info.sources[lineIdx]
      if (line?.epPage) {
        fallbackTriedRef.current = true
        const seq = ++seqRef.current
        setView({ mode: 'loading' })
        window.xifanApi.resolveEpUrl(line.epPage, ep)
          .then((real) => {
            if (seqRef.current !== seq) return
            if (real) setView({ mode: 'video', url: real, isHls: false })
            else tryNextLine()
          })
          .catch(() => {
            if (seqRef.current !== seq) return
            tryNextLine()
          })
        return
      }
    }
    tryNextLine()
  }

  // ── HLS(Girigiri):hls.js 接管 <video> ─────────────────────────────────────
  // Chromium 不原生支持 m3u8,靠 hls.js 走 MSE 逐段喂。列表/分片/AES 密钥全部
  // 经 mtmedia 代理(主进程已把列表里的地址重写成 mtmedia://),同源不受跨源策略限制。
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // 兜底回调用 ref 取最新的 —— 直接进 effect 依赖数组会让每次渲染都重建 hls 实例、打断播放。
  const onFatalRef = useRef<() => void>(() => {})
  useEffect(() => { onFatalRef.current = handleVideoError })

  useEffect(() => {
    if (view.mode !== 'video' || !view.isHls) return
    const video = videoRef.current
    if (!video) return
    if (!Hls.isSupported()) {
      setView({ mode: 'error', err: new Error('当前环境不支持 HLS 播放') })
      return
    }
    // 用 hls.js 默认 loader(XhrLoader)。实测 mtmedia:// 上 XHR 与 fetch 都直通
    // (该 scheme 没开 corsEnabled,不进 CORS 检查),两种 loader 都能正常播,
    // 所以不覆盖默认值 —— 别为"自定义协议可能不支持 XHR"这种没验证的担心加配置。
    const hls = new Hls()
    hls.on(Hls.Events.ERROR, (_e, data) => {
      // 只有 fatal 才走换线路兜底;非 fatal(单个分片超时等)hls.js 自己会重试。
      if (data.fatal) onFatalRef.current()
    })
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      void video.play().catch(() => { /* 自动播放被拦就等用户点一下 */ })
    })
    hls.loadSource(toMediaProxy(view.url))
    hls.attachMedia(video)
    return () => hls.destroy()
  }, [view])

  // ── DASH(B 站):shaka-player 接管 <video> ──────────────────────────────────
  // B 站 1080P 只存在于 DASH 音视频分轨里(mp4 直链容器封顶 720P,实测 accept_quality
  // 只有 [64,16])。分片地址已被主进程包成 mtmedia://(带防盗链 Referer),shaka 在
  // 渲染进程里逐段发 Range 取,同源不受跨源策略限制。
  const playerRef = useRef<shaka.Player | null>(null)
  // 换集时沿用上次选的画质档,不用把 qn 塞进 effect 依赖(那会重建 player 打断播放)
  const qnRef = useRef<number | null>(null)
  useEffect(() => { qnRef.current = qn })

  useEffect(() => {
    if (view.mode !== 'dash') return
    const video = videoRef.current
    if (!video) return
    const dash = view.dash
    let cancelled = false
    const player = new shaka.Player()
    playerRef.current = player

    // ABR 关掉:用户在画质条上选了 1080P 就该一直是 1080P(外链播放器「选了没反应」
    // 正是用户投诉的点),不要让自适应在背后偷偷降档。
    player.configure({ abr: { enabled: false } })
    player.addEventListener('error', (e) => {
      if (cancelled) return
      const detail = (e as unknown as { detail?: { code?: number; message?: string } }).detail
      setView({ mode: 'error', err: new Error(`B 站播放失败(shaka ${detail?.code ?? '?'})`) })
    })

    void (async () => {
      try {
        await player.attach(video)
        // MPD 是我们拼的、没有远端地址,包成 data: URI;shaka 无从推断类型,显式给 MIME。
        await player.load(biliMpdUri(dash), undefined, 'application/dash+xml')
        if (cancelled) return
        const tracks = pickVideoTracks(dash)
        // 沿用上次的档;这个稿件没有那一档(或首次进入)就取最高的
        const target = tracks.find((t) => t.id === qnRef.current)?.id ?? tracks[0]?.id ?? 0
        applyQuality(player, dash, target)
        setQn(target)
        await video.play().catch(() => { /* 自动播放被拦就等用户点一下 */ })
      } catch (err) {
        if (!cancelled) setView({ mode: 'error', err })
      }
    })()

    return () => {
      cancelled = true
      playerRef.current = null
      void player.destroy()
    }
  }, [view])

  // 用户点画质档:直接切 variant,不重新 load(shaka 会清缓冲从当前时间续播)
  const selectQuality = (next: number): void => {
    if (next === qn || view.mode !== 'dash') return
    setQn(next)
    const player = playerRef.current
    if (player) applyQuality(player, view.dash, next)
  }

  const retry = (): void => {
    triedLinesRef.current = new Set() // 手动重试:重新给所有线路一次机会
    if (!data) setReloadTick((t) => t + 1)
    else setResolveTick((t) => t + 1)
  }

  const selectLine = (i: number): void => {
    if (i === lineIdx) return
    // 手动切走当前线路 = 用户放弃它,标记为已试,之后自动兜底不再回退到它;
    // 手动想再切回来仍允许(下面直接 setLineIdx,不看标记)。不清空整份记忆。
    triedLinesRef.current.add(lineIdx)
    setLineIdx(i)
    // 新线路没有当前集(如 BD 线只有特典)时清掉选集,交给默认选集逻辑重挑
    const eps = data?.lines[i]?.eps ?? []
    if (ep !== null && !eps.some((e) => e.idx === ep)) setEp(null)
  }

  const title = track ? (track.titleCn || track.title) : ''
  const eps = data?.lines[lineIdx]?.eps ?? []

  // ── 两种布局共用的片段(单一来源,内置源 / 嵌入页两处不各写一份) ─────────────────
  // 返回 + 标题
  const header = (
    <div className="flex items-center gap-3 min-w-0">
      <button
        type="button"
        onClick={() => navigate(-1)}
        title="返回"
        className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors shrink-0"
      >
        <span className="material-symbols-outlined leading-none" style={{ fontSize: 20 }}>arrow_back</span>
      </button>
      <h1 className="text-lg md:text-2xl font-bold font-headline text-on-surface truncate">
        {title || '在线观看'}
      </h1>
    </div>
  )

  // 多站切换:实线 = 已关联,虚线 + 放大镜 = 未关联(点开才搜)
  const sourceSwitcher = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mr-1">播放源</span>
      {entries.map((e) => {
        const sel = e.key === entry?.key
        const bound = !!e.binding
        return (
          <button
            key={e.key}
            type="button"
            onClick={() => setSelKey(e.key)}
            title={bound ? (e.binding?.sourceTitle || e.label) : `${e.label} · 未关联,点击后在该站搜索并关联`}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border font-label text-[11px] font-bold tracking-wider transition-colors ${
              sel
                ? 'border-primary/40 bg-primary/15 text-primary'
                : bound
                  ? 'border-transparent bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                  : 'border-dashed border-outline-variant/40 bg-transparent text-on-surface-variant/50 hover:border-primary/40 hover:text-primary'
            }`}
          >
            {!bound && <span className="material-symbols-outlined leading-none" style={{ fontSize: 12 }}>search</span>}
            <span>{e.label}</span>
          </button>
        )
      })}
    </div>
  )

  // B 站登录态提示条 —— 画质档位由登录态决定,自研播放 / 番剧 webview 都要提示
  const biliAuthBar = needBiliAuth ? (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-container px-3 py-2 text-on-surface-variant/70">
      <span className="material-symbols-outlined leading-none shrink-0" style={{ fontSize: 14 }}>info</span>
      <span className="font-label text-[11px] tracking-wider">
        {biliLoggedIn ? 'B 站 · 已登录' : 'B 站 · 未登录最高只有 480P,登录后可选 1080P'}
      </span>
      {biliLoggedIn === false && (
        // 下划线只加在文字上:整个按钮加 underline 的话,图标是字体字形,它的基线与
        // 文字不同,下划线会画成高低两截(用户实拍)。
        <button
          type="button"
          onClick={() => setBiliQrOpen(true)}
          className="group ml-auto inline-flex items-center gap-1 text-primary font-label text-[11px] font-bold tracking-wider"
        >
          <span className="material-symbols-outlined leading-none" style={{ fontSize: 13 }}>qr_code_2</span>
          <span className="group-hover:underline underline-offset-4">登录 B 站</span>
        </button>
      )}
      {biliLoggedIn === true && (
        <button
          type="button"
          onClick={handleBiliLogout}
          className="ml-auto text-on-surface-variant/50 hover:text-on-surface font-label text-[11px] tracking-wider transition-colors"
        >
          退出
        </button>
      )}
    </div>
  ) : null

  // 弹窗 + 自动关联轻提示
  const overlays = (
    <>
      {biliQrOpen && (
        <BiliLoginModal onClose={() => setBiliQrOpen(false)} onLoggedIn={() => handleBiliAuthChanged(true)} />
      )}
      {toastText && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-surface-container-high border border-outline-variant/20 px-4 py-3 shadow-2xl">
          <span className="material-symbols-outlined text-primary leading-none" style={{ fontSize: 18 }}>link</span>
          <span className="font-label text-xs text-on-surface">{toastText}</span>
        </div>
      )}
    </>
  )

  // ── 自定义源(webview 嵌真实播放页):整页固定高度、页面自身不滚动 ──────────────
  // webview 占满标题/切换器下方的全部剩余高度 —— 页面本身不再产生第二条滚动条,
  // 只留站点自己的滚动条,彻底消除「应用滚动条 vs 网页滚动条」互相打架的违和感
  // (原先 16:9 矮盒子里塞整张网页,两条滚动条并存,鼠标压在 webview 上滚的永远是
  // 网页那条)。全屏交给站点播放器自己的全屏按钮(真·全屏),不再提供应用内「铺满」。
  if (view.mode === 'embed') {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="shrink-0 px-4 md:px-8 pt-4 pb-3 space-y-3">
          {header}
          {sourceSwitcher}
          {biliAuthBar}
          {!view.isBili && (
            <p className="flex items-center gap-1.5 text-on-surface-variant/45">
              <span className="material-symbols-outlined leading-none shrink-0" style={{ fontSize: 13 }}>public</span>
              <span className="font-label text-[11px] tracking-wider">
                网页版播放 · 剧集、画质都在站点页里;点播放器自带的全屏按钮即可全屏观看
              </span>
            </p>
          )}
        </div>
        {/* B 站走 persist:bili 分区(与登录窗同分区同 UA,第一方 cookie);其他自定义站
            用独立的 persist:webplay 分区,把不受信站点的 cookie/storage 与应用默认会话
            隔开。webview 里站点页是顶层文档,不受 X-Frame-Options / 第三方 cookie 限制;
            弹窗广告在主进程被拦死。平时占满剩余高度的盒子;站点触发全屏时整块铺满窗口
            (embedFs),让内部 <video> 的全屏覆盖整扇窗,只剩视频画面。 */}
        <div
          className={embedFs
            ? 'fixed inset-0 z-[80] bg-black'
            : 'relative flex-1 min-h-0 mx-4 md:mx-8 mb-4 overflow-hidden rounded-xl bg-black border border-outline-variant/10'}
        >
          <webview
            ref={setEmbedWebviewEl}
            key={`${view.url}#${webviewKey}`}
            src={view.url}
            partition={view.isBili ? 'persist:bili' : 'persist:webplay'}
            className="h-full w-full"
          />
        </div>
        {overlays}
      </div>
    )
  }

  // ── 内置源(稀饭/Girigiri/嗷呜/B 站自研):16:9 播放区 + 下方集数网格,页面正常滚动 ──
  return (
    <div className="relative min-h-full bg-background">
      <div className="max-w-[1400px] mx-auto px-4 md:px-8 py-6 space-y-5">
        {header}

        {!track ? (
          <div className="flex flex-col items-center gap-3 py-24 text-on-surface-variant/60">
            <span className="material-symbols-outlined" style={{ fontSize: 40 }}>link_off</span>
            <p className="font-label text-sm">没找到这条追番</p>
          </div>
        ) : (
          <>
            {/* 播放器 —— 16:9 播放区(video / dash / 内联搜索 / 各占位态)。
                自定义源(webview 嵌真实页)走上面的固定高度早期 return,不到这里。 */}
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
              {view.mode === 'video' && (
                <video
                  key={view.url}
                  ref={videoRef}
                  // HLS 由 hls.js 经 MSE 喂,不设 src;mp4 直链走同源流代理直接喂。
                  src={view.isHls ? undefined : toMediaProxy(view.url)}
                  controls
                  autoPlay
                  className="h-full w-full"
                  // HLS 的失败统一由 hls.js 的 fatal 事件兜底,别在这儿再触发一次换线路。
                  onError={view.isHls ? undefined : handleVideoError}
                />
              )}
              {view.mode === 'dash' && (
                // DASH 由 shaka 经 MSE 喂,不设 src、不挂 onError(失败走 shaka 的 error 事件)
                <video ref={videoRef} controls autoPlay className="h-full w-full" />
              )}
              {view.mode === 'search' && entry?.builtin && track && (
                <div className="flex h-full items-center justify-center overflow-y-auto p-4 md:p-6">
                  <InlineSourceSearch
                    key={entry.builtin}
                    source={entry.builtin}
                    bgmId={track.bgmId}
                    initialKeyword={track.titleCn || track.title}
                    aliases={track.aliases}
                    onBound={(card) => setToastText(`已自动关联 ${entry.label} ·「${card.title}」,下次直接播放`)}
                  />
                </div>
              )}
              {view.mode === 'loading' && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-on-surface-variant/70">
                  <span className="material-symbols-outlined animate-spin" style={{ fontSize: 32 }}>progress_activity</span>
                  <span className="font-label text-xs tracking-widest">解析播放地址中…</span>
                </div>
              )}
              {view.mode === 'none' && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-on-surface-variant/50">
                  <span className="material-symbols-outlined" style={{ fontSize: 40 }}>smart_display</span>
                  <span className="font-label text-xs tracking-widest">选一集开始播放</span>
                </div>
              )}
              {view.mode === 'error' && (
                <div className="flex h-full items-center justify-center overflow-y-auto p-6">
                  <ErrorPanel error={view.err} onRetry={retry} />
                </div>
              )}
            </div>

            {biliAuthBar}

            {sourceSwitcher}

            {/* 画质(仅 B 站 DASH)。只列该稿件**真有**的档 —— 外链播放器那种「菜单里
                摆着 1080P、点了没反应」的坑,这里靠 dash.video 与 accept_quality 求交避免。 */}
            {view.mode === 'dash' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mr-1">画质</span>
                {pickVideoTracks(view.dash).map((t) => {
                  const label = view.dash.qualities.find((q) => q.qn === t.id)?.label ?? `${t.height}P`
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => selectQuality(t.id)}
                      className={`px-2.5 py-1 rounded-md border font-label text-[10px] font-bold tracking-wider transition-colors ${
                        t.id === qn
                          ? 'border-primary/40 bg-primary/15 text-primary'
                          : 'border-transparent bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}

            {/* 站内线路(仅多线路时显示) */}
            {data && data.lines.length > 1 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mr-1">线路</span>
                {data.lines.map((l, i) => (
                  <button
                    key={`${l.name}-${i}`}
                    type="button"
                    onClick={() => selectLine(i)}
                    className={`px-2.5 py-1 rounded-md border font-label text-[10px] font-bold tracking-wider transition-colors ${
                      i === lineIdx
                        ? 'border-primary/40 bg-primary/15 text-primary'
                        : 'border-transparent bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                    }`}
                  >
                    {l.name || `线路 ${i + 1}`}
                  </button>
                ))}
              </div>
            )}

            {/* 集数网格 */}
            {data && eps.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-baseline gap-2 border-b border-outline-variant/20 pb-2">
                  <h2 className="font-label text-xs font-bold uppercase tracking-widest text-on-surface-variant">选集</h2>
                  <span className="font-label text-[10px] text-on-surface-variant/40">{eps.length} 集</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-2">
                  {eps.map((e) => (
                    <button
                      key={e.idx}
                      type="button"
                      onClick={() => setEp(e.idx)}
                      title={e.label}
                      className={`aspect-square rounded-lg px-1 flex items-center justify-center font-label text-xs font-medium transition-colors overflow-hidden ${
                        e.idx === ep
                          ? 'bg-primary text-on-primary'
                          : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                      }`}
                    >
                      <span className="truncate">{epShort(e)}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {overlays}
    </div>
  )
}

// ── 未绑定内置源的内联搜索面板(挂在播放器区中央) ────────────────────────────
//
// 业务逻辑(搜索/缓存/验证码/Aowu 流式/竞速)全在 useSourceSearch,与
// SearchDownload / SearchSourceModal 共用同一套实现;这里只是播放页形态的 UI。
// 挑中候选 → 写回 binding(自动关联,与「搜 Xifan」补绑流程同效)→ 父组件
// 的 entry 因 track 更新而带上 binding,自动进入加载播放流程。
function InlineSourceSearch({
  source, bgmId, initialKeyword, aliases, onBound,
}: {
  source: Source
  bgmId: number
  initialKeyword: string
  aliases: string[]
  onBound: (card: SearchCard) => void
}): JSX.Element {
  const [keyword, setKeyword] = useState(initialKeyword)
  const [captchaInput, setCaptchaInput] = useState('')
  const [binding, setBinding] = useState(false)
  const { state, search, refreshCaptcha, verifyCaptcha } = useSourceSearch(source, { initialKeyword })

  const pick = async (card: SearchCard): Promise<void> => {
    setBinding(true)
    try {
      // Aowu 的 card.key 是 /v/{id} 合成 URL,写 binding 前先换成用户可分享的
      // /w/{token}(与 MyAnime 补绑流程一致);失败不阻塞,sourceKey 仍可用。
      let sourceUrl: string | undefined
      if (card.source === 'Aowu') {
        try {
          sourceUrl = await window.aowuApi.resolveShareUrl(card.key)
        } catch (err) {
          console.warn('[OnlinePlayer] aowu resolveShareUrl failed:', err)
        }
      }
      animeTrackStore.bind(
        { bgmId },
        { source: card.source, sourceTitle: card.title, sourceKey: card.key, sourceUrl },
      )
      onBound(card)
    } finally {
      setBinding(false)
    }
  }

  const busy = state.status === 'searching' || state.status === 'verifying' || binding

  // 换关键词的小工具行:输入框 + 重搜 + 别名快捷 chips(BGM 别名,点了直接搜)
  const searchRow = (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) void search(keyword) }}
          spellCheck={false}
          className="flex-1 min-w-0 bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2 text-xs font-label text-on-surface outline-none focus:border-primary/60 transition-colors"
        />
        <button
          type="button"
          onClick={() => void search(keyword)}
          disabled={!keyword.trim() || busy}
          className="px-3 py-2 rounded-lg bg-surface-container-highest text-on-surface-variant font-label text-[11px] tracking-wider hover:text-on-surface transition-colors disabled:opacity-40"
        >
          重搜
        </button>
      </div>
      {aliases.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-label text-[10px] text-on-surface-variant/35">别名</span>
          {aliases.slice(0, 4).map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => { setKeyword(a); void search(a) }}
              disabled={busy}
              className="px-2 py-0.5 rounded-md bg-surface-container text-on-surface-variant/60 hover:text-primary font-label text-[10px] tracking-wider transition-colors disabled:opacity-40"
            >
              {a}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="w-[440px] max-w-full rounded-2xl bg-surface-container-high border border-outline-variant/20 p-5 text-left">
      {(state.status === 'idle' || state.status === 'searching' || state.status === 'verifying' || binding) && (
        <div className="flex flex-col items-center justify-center py-8 gap-3 text-on-surface-variant/60">
          <span className="material-symbols-outlined animate-spin text-primary/60" style={{ fontSize: 28 }}>progress_activity</span>
          <span className="font-label text-[11px] tracking-widest">
            {binding ? '正在关联…' : state.status === 'verifying' ? '正在验证…' : `正在 ${source} 搜索「${keyword}」…`}
          </span>
        </div>
      )}

      {state.status === 'captcha' && !binding && (
        <div>
          <div className="flex items-center gap-2 mb-3 text-on-surface">
            <span className="material-symbols-outlined text-primary leading-none" style={{ fontSize: 18 }}>password</span>
            <span className="font-label text-sm font-bold">{source} 需要验证码</span>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <img
              src={`data:image/gif;base64,${state.imageB64}`}
              alt="captcha"
              className="h-11 rounded-lg border border-outline-variant/20 cursor-pointer"
              title="点击换一张"
              onClick={() => { setCaptchaInput(''); void refreshCaptcha() }}
            />
            <input
              value={captchaInput}
              onChange={(e) => setCaptchaInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && captchaInput.trim()) { const c = captchaInput.trim(); setCaptchaInput(''); void verifyCaptcha(c) } }}
              placeholder="输入验证码"
              autoFocus
              className="flex-1 min-w-0 bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-2.5 text-sm font-label tracking-[0.2em] outline-none focus:border-primary/60 transition-colors"
            />
          </div>
          {state.error && <p className="font-label text-xs text-error mb-2">{state.error}</p>}
          <button
            type="button"
            onClick={() => { const c = captchaInput.trim(); if (!c) return; setCaptchaInput(''); void verifyCaptcha(c) }}
            disabled={!captchaInput.trim()}
            className="w-full py-2.5 rounded-lg bg-primary text-on-primary font-label text-xs font-bold tracking-wider hover:bg-primary/90 transition-colors disabled:opacity-40"
          >
            确认并搜索
          </button>
          <p className="mt-2 text-[10px] font-label text-on-surface-variant/40">与搜索下载页同一套验证码流程,只在点开该站时才会出现</p>
        </div>
      )}

      {state.status === 'results' && !binding && (
        <div>
          <div className="flex items-center gap-2 mb-1 text-on-surface">
            <span className="material-symbols-outlined text-primary leading-none" style={{ fontSize: 18 }}>travel_explore</span>
            <span className="font-label text-sm font-bold">在 {source} 找到 {state.cards.length} 个结果</span>
          </div>
          <p className="text-[10px] font-label text-on-surface-variant/40 mb-3">挑一个开始播放 —— 选中会自动关联,下次直接播</p>
          <ul className="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1 custom-scrollbar">
            {state.cards.map((card) => (
              <li key={card.key}>
                <button
                  type="button"
                  onClick={() => void pick(card)}
                  className="group w-full flex items-center gap-3 px-3 py-2 rounded-xl bg-surface-container hover:bg-primary/10 border border-transparent hover:border-primary/30 transition-colors text-left"
                >
                  {card.cover ? (
                    <img src={card.cover} alt="" loading="lazy" className="w-9 h-12 object-cover rounded shrink-0 bg-surface-container-highest" />
                  ) : (
                    <div className="w-9 h-12 rounded bg-surface-container-highest shrink-0 flex items-center justify-center">
                      <span className="material-symbols-outlined text-on-surface-variant/30" style={{ fontSize: 16 }}>image</span>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-on-surface truncate">{card.title}</div>
                    <div className="text-[10px] font-label text-on-surface-variant/50 mt-0.5">
                      {[card.year, card.tag, card.count].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-primary opacity-0 group-hover:opacity-100 transition-opacity leading-none" style={{ fontSize: 18 }}>play_arrow</span>
                </button>
              </li>
            ))}
          </ul>
          {searchRow}
        </div>
      )}

      {state.status === 'empty' && !binding && (
        <div>
          <div className="flex items-center gap-2 mb-1 text-on-surface">
            <span className="material-symbols-outlined text-on-surface-variant leading-none" style={{ fontSize: 18 }}>search_off</span>
            <span className="font-label text-sm font-bold">{source} 没搜到「{keyword}」</span>
          </div>
          <p className="text-[10px] font-label text-on-surface-variant/40 leading-relaxed">
            该站可能没有这部番。可以换个关键词重搜,或切换其他播放源。
          </p>
          {searchRow}
        </div>
      )}

      {state.status === 'error' && !binding && (
        <div>
          <ErrorPanel error={state.message} compact onRetry={() => void search(keyword)} />
          {searchRow}
        </div>
      )}
    </div>
  )
}

// B 站站点接口 —— 登录(TV 端扫码)、稿件信息(分 P 列表)、播放地址。
//
// **为什么走 TV 端 appkey 签名,不走 web 端**:
//   1. 登录:B 站 2026-06 起收紧 **web 扫码**接口(/x/passport-login/web/qrcode/*)风控,
//      手机确认那步直接弹「API校验密匙错误」(同期 downkyi 等一起中招)。TV 端
//      (/x/passport-tv-login/qrcode/*)是 appkey+appsec 的 md5 签名,不吃这套风控,
//      而且登录成功后 **cookie 直接在响应体里**返回(不靠 Set-Cookie)。
//   2. 播放地址:web 端 playurl 要 WBI 签名 —— 那套盐值藏在页面 JS 里、隔三差五就换,
//      是 011 当初否掉「自研播放器」的主要理由。TV appkey 的 appsec 是固定常量、
//      多年未动,签名只是「参数排序拼接 + md5」,不需要运行时反推。
//
// UA 沿用 BGM 的教训:登录态绑 UA,分区 / 请求统一 DESKTOP_USER_AGENT。
import { session } from 'electron'
import { createHash } from 'node:crypto'
import { netRequest } from '../shared/net-request'
import { toMediaProxyUrl } from '../shared/media-proxy'
import { DESKTOP_USER_AGENT } from '../shared/download-types'

export const BILI_PARTITION = 'persist:bili'

// TV 端(bilibili 智能电视版)固定 appkey/appsec。
const TV_APPKEY = '4409e2ce8ffd12b8'
const TV_APPSEC = '59b43e04ad6965f34319062b478f83dd'

const PASSPORT = 'https://passport.bilibili.com'
const API = 'https://api.bilibili.com'

/** B 站 CDN 对 upos/bilivideo 直链校验防盗链:不带这个 Referer 一律 403(实测)。 */
export const BILI_REFERER = 'https://www.bilibili.com'

// session 只能在 app ready 后创建(registerAllIpc 在模块加载期就跑)→ 惰性初始化;
// 首次拿到分区时顺手固定 UA。
let cachedSession: Electron.Session | null = null
export function biliSession(): Electron.Session {
  if (!cachedSession) {
    cachedSession = session.fromPartition(BILI_PARTITION)
    cachedSession.setUserAgent(DESKTOP_USER_AGENT)
  }
  return cachedSession
}

/** APP 签名:公共参数并入后按 key 排序 urlencode 拼接,尾部追加 md5(query + appsec)。 */
function signParams(params: Record<string, string> = {}): string {
  const all: Record<string, string> = {
    ...params,
    appkey: TV_APPKEY,
    ts: String(Math.floor(Date.now() / 1000)),
  }
  const query = Object.keys(all)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(all[k])}`)
    .join('&')
  const sign = createHash('md5').update(query + TV_APPSEC).digest('hex')
  return `${query}&sign=${sign}`
}

interface BiliEnvelope<T> {
  code: number
  message: string
  data: T | null
}

/** 拆 B 站统一响应信封:非 0 一律 throw 到 UI(红线:不静默吞错、不自动重试)。 */
function unwrap<T>(raw: Buffer, what: string): T {
  const env = JSON.parse(raw.toString('utf-8')) as BiliEnvelope<T>
  if (env.code !== 0 || !env.data) throw new Error(`${what}失败:${env.message || env.code}`)
  return env.data
}

// ── 登录(TV 扫码) ───────────────────────────────────────────────────────────

export type QrState = 'pending' | 'scanned' | 'expired' | 'ok'

interface TvPollData {
  mid: number
  access_token: string
  cookie_info?: {
    cookies: { name: string; value: string; http_only: number; expires: number; secure: number }[]
  }
}

async function postForm<T>(path: string, params: Record<string, string> = {}): Promise<BiliEnvelope<T>> {
  const res = await netRequest(`${PASSPORT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DESKTOP_USER_AGENT,
    },
    body: signParams({ ...params, local_id: '0' }),
  })
  return JSON.parse(res.body.toString('utf-8')) as BiliEnvelope<T>
}

export async function tvAuthCode(): Promise<{ url: string; auth_code: string }> {
  const env = await postForm<{ url: string; auth_code: string }>('/x/passport-tv-login/qrcode/auth_code')
  if (env.code !== 0 || !env.data) throw new Error(`B 站二维码申请失败:${env.message || env.code}`)
  return env.data
}

/**
 * 查一次扫码结果。**不是「失败后自动重试/周期性探测」**(AI_GUIDELINES 网络红线)——
 * 扫码本就是 B 站定义的轮询协议,UI 在二维码亮着时每 2s 问一次、关窗即停;
 * 请求真出错就 throw,由用户决定重来。
 */
export async function tvPoll(authCode: string): Promise<QrState> {
  const env = await postForm<TvPollData>('/x/passport-tv-login/qrcode/poll', { auth_code: authCode })
  if (env.code === 86038) return 'expired'
  if (env.code === 86090) return 'scanned'
  if (env.code === 86039) return 'pending'
  if (env.code !== 0 || !env.data) throw new Error(`B 站扫码失败:${env.message || env.code}`)

  // TV 端登录**不走 Set-Cookie**,凭证在响应体里,逐条写进分区。
  const ses = biliSession()
  for (const c of env.data.cookie_info?.cookies ?? []) {
    await ses.cookies.set({
      url: 'https://bilibili.com/',
      domain: '.bilibili.com',
      path: '/',
      name: c.name,
      value: c.value,
      secure: c.secure === 1,
      httpOnly: c.http_only === 1,
      sameSite: 'no_restriction',
      expirationDate: c.expires,
    })
  }
  await ses.cookies.flushStore()
  return 'ok'
}

/** SESSDATA 是 B 站的关键登录态 cookie(等价 BGM 的 chii_auth)。 */
export async function isLoggedIn(): Promise<boolean> {
  const cookies = await biliSession().cookies.get({ name: 'SESSDATA' })
  return cookies.some((c) => c.domain?.includes('bilibili.com') && c.value)
}

export async function logout(): Promise<void> {
  await biliSession().clearStorageData({ storages: ['cookies'] })
}

// ── 稿件信息(分 P) ──────────────────────────────────────────────────────────

export interface BiliPage {
  /** 分 P 序号,就是视频链接里的 &p=N。 */
  page: number
  cid: number
  /** 分 P 标题,合集里通常是「01」「02」或单集名。 */
  part: string
  duration: number
}

export interface BiliVideoInfo {
  bvid: string
  aid: number
  title: string
  pages: BiliPage[]
}

/** BV 号 → 稿件信息。合集/多 P 稿件的 pages 就是集数列表(匿名可取)。 */
export async function getVideoInfo(bvid: string): Promise<BiliVideoInfo> {
  const res = await netRequest(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: { 'User-Agent': DESKTOP_USER_AGENT, Referer: BILI_REFERER },
  })
  const d = unwrap<{
    bvid: string
    aid: number
    title: string
    pages: BiliPage[]
  }>(res.body, '取 B 站稿件信息')
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    pages: (d.pages ?? []).map((p) => ({ page: p.page, cid: p.cid, part: p.part, duration: p.duration })),
  }
}

// ── 播放地址 ────────────────────────────────────────────────────────────────

/** DASH 里一路音轨或视轨。B 站给的是单文件 fMP4 + SegmentBase 字节范围。 */
export interface BiliTrack {
  id: number
  /** **已经**包成 mtmedia:// 代理 URL(带 Referer),渲染层拿不到裸签名链。 */
  baseUrl: string
  bandwidth: number
  codecs: string
  mimeType: string
  /** 起始/索引段的字节范围,合成 MPD 时要原样填进 SegmentBase。 */
  initRange: string
  indexRange: string
  /** 音轨为 0。 */
  width: number
  height: number
}

export interface BiliDash {
  /** 秒。合成 MPD 的 mediaPresentationDuration 用。 */
  duration: number
  video: BiliTrack[]
  audio: BiliTrack[]
  /** qn → 画质名,如 80 → 「1080P 高清」。给画质切换器显示用。 */
  qualities: { qn: number; label: string }[]
}

interface RawTrack {
  id: number
  baseUrl: string
  bandwidth: number
  codecs: string
  mimeType: string
  width: number
  height: number
  segment_base?: { initialization: string; index_range: string }
}

/**
 * 取某一分 P 的 DASH 音视频分轨。
 *
 * 画质由登录态决定,不是参数说了算:匿名只给到 360P/480P,登录后才有 1080P(qn=80),
 * 1080P 高码率(112)还要大会员。所以这里必须带 `persist:bili` 分区的 cookie。
 * `fnval=4048` = DASH + 8K/HDR/杜比等全开(取到什么由账号权益定),`fourk=1` 同理。
 */
export async function getDash(aid: number, cid: number): Promise<BiliDash> {
  const query = signParams({
    avid: String(aid),
    cid: String(cid),
    qn: '127',
    fnver: '0',
    fnval: '4048',
    fourk: '1',
  })
  const res = await netRequest(`${API}/x/player/playurl?${query}`, {
    headers: { 'User-Agent': DESKTOP_USER_AGENT, Referer: BILI_REFERER },
    session: biliSession(),
  })
  const d = unwrap<{
    accept_quality: number[]
    accept_description: string[]
    dash: { duration: number; video: RawTrack[]; audio: RawTrack[] } | null
  }>(res.body, '取 B 站播放地址')
  if (!d.dash) throw new Error('这个稿件没有 DASH 播放源,换个源试试')

  // baseUrl 在这里就包成 mtmedia:// 并钉上 Referer:B 站 CDN 校验防盗链,而 shaka 是在
  // 渲染进程里逐段发 Range 请求的,直取必然 403(且跨源)。渲染层只见代理 URL。
  const toTrack = (t: RawTrack): BiliTrack => ({
    id: t.id,
    baseUrl: toMediaProxyUrl(t.baseUrl, BILI_REFERER),
    bandwidth: t.bandwidth,
    codecs: t.codecs,
    mimeType: t.mimeType,
    initRange: t.segment_base?.initialization ?? '',
    indexRange: t.segment_base?.index_range ?? '',
    width: t.width ?? 0,
    height: t.height ?? 0,
  })

  // accept_quality 是账号「能选」的档,dash.video 里实际存在的才是「真有」的档 ——
  // 只列真有的,免得画质切换器摆一个点了没反应的 1080P(外链播放器就是这么坑人的)。
  const present = new Set(d.dash.video.map((v) => v.id))
  const qualities = d.accept_quality
    .map((qn, i) => ({ qn, label: d.accept_description[i] ?? String(qn) }))
    .filter((q) => present.has(q.qn))

  return {
    duration: d.dash.duration,
    video: d.dash.video.map(toTrack),
    audio: (d.dash.audio ?? []).map(toTrack),
    qualities,
  }
}

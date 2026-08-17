// B 站站点接口 —— 登录(TV 端扫码 / web 短信)、稿件信息(分 P 列表)、播放地址。
//
// **为什么走 TV 端 appkey 签名而不是 web 端**:
//   1. 登录:web 扫码接口风控收紧,手机确认那一步直接弹「API校验密匙错误」。TV 端走
//      appkey+appsec 的 md5 签名,不吃这套风控,而且登录成功后 **cookie 直接在响应体里**返回
//      不靠 Set-Cookie。
//   2. 播放地址:web 端 playurl 要 WBI 签名,盐值藏在页面 JS 里、隔三差五就换 —— 这正是当初
//      否掉自研播放器的主要理由。TV 的 appsec 是固定常量,签名只是「参数排序拼接 + md5」。
//
// UA 沿用 BGM 的教训:登录态绑 UA,分区和请求统一用同一个 UA。
import { session } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { netRequest } from '../shared/net-request'
import { toMediaProxyUrl } from '../shared/media-proxy'
import { DESKTOP_USER_AGENT } from '../shared/download-types'

export const BILI_PARTITION = 'persist:bili'

// TV 端(bilibili 智能电视版)固定 appkey/appsec。
const TV_APPKEY = '4409e2ce8ffd12b8'
const TV_APPSEC = '59b43e04ad6965f34319062b478f83dd'

const PASSPORT = 'https://passport.bilibili.com'
const API = 'https://api.bilibili.com'

/** B 站 CDN 对 upos/bilivideo 直链校验防盗链,不带这个 Referer 一律 403。 */
export const BILI_REFERER = 'https://www.bilibili.com'

// session 只能在 app ready 之后创建(而 IPC 注册在模块加载期就跑),所以惰性初始化;
// 首次拿到分区时顺手把 UA 固定下来。
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

/** 拆 B 站的统一响应信封:非 0 一律 throw 到 UI(红线:不静默吞错、不自动重试)。 */
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
 * 查一次扫码结果。**这不是「失败后自动重试」**:扫码本来就是 B 站定义的轮询协议,UI 在二维码
 * 亮着时每 2s 问一次、关窗即停;请求真出错就 throw,由用户决定重来。
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

/** SESSDATA 是 B 站的关键登录态 cookie。 */
export async function isLoggedIn(): Promise<boolean> {
  const cookies = await biliSession().cookies.get({ name: 'SESSDATA' })
  return cookies.some((c) => c.domain?.includes('bilibili.com') && c.value)
}

export async function logout(): Promise<void> {
  await biliSession().clearStorageData({ storages: ['cookies'] })
}

// ── 登录(短信验证码) ────────────────────────────────────────────────────────
// 流程:captcha → 极验 → sms/send → login/sms。请求必须由**主进程**发,并走 persist:bili 分区
// 保证 UA 和 cookie 罐与后续播放请求一致。

const WEB_LOGIN_SOURCE = 'main_web'
const WEB_LOGIN_REFERER = 'https://passport.bilibili.com/login'

export interface BiliGeetestChallenge {
  token: string
  gt: string
  challenge: string
}

export interface BiliGeetestResult {
  validate: string
  seccode: string
  challenge: string
  token: string
}

function webLoginHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: PASSPORT,
    Referer: WEB_LOGIN_REFERER,
    'User-Agent': DESKTOP_USER_AGENT,
    ...extra,
  }
}

function multipartForm(fields: Record<string, string>): { contentType: string; body: Buffer } {
  const boundary = `----MapleTools${randomBytes(12).toString('hex')}`
  const lines = Object.entries(fields).flatMap(([name, value]) => [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="${name}"\r\n\r\n`,
    `${value}\r\n`,
  ])
  lines.push(`--${boundary}--\r\n`)
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(lines.join(''), 'utf-8'),
  }
}

async function postWebLogin<T>(path: string, fields: Record<string, string>, what: string): Promise<T> {
  const form = multipartForm(fields)
  const res = await netRequest(`${PASSPORT}${path}`, {
    method: 'POST',
    headers: webLoginHeaders({ 'Content-Type': form.contentType }),
    body: form.body,
    session: biliSession(),
  })
  return unwrap<T>(res.body, what)
}

/** Biu `getPassportLoginCaptcha()` 同款参数，返回启动极验 v3 所需的数据。 */
export async function getWebLoginCaptcha(): Promise<BiliGeetestChallenge> {
  const query = new URLSearchParams({ source: WEB_LOGIN_SOURCE })
  const res = await netRequest(`${PASSPORT}/x/passport-login/captcha?${query}`, {
    headers: webLoginHeaders(),
    session: biliSession(),
  })
  const data = unwrap<{
    token: string
    geetest: { gt: string; challenge: string }
  }>(res.body, '获取 B 站安全验证')
  if (!data.token || !data.geetest?.gt || !data.geetest.challenge) {
    throw new Error('获取 B 站安全验证失败:返回数据不完整')
  }
  return { token: data.token, gt: data.geetest.gt, challenge: data.geetest.challenge }
}

/** 极验完成后发送短信;返回的 captcha_key 只供下一步 login/sms 使用。 */
export async function sendWebSmsCode(phone: string, result: BiliGeetestResult): Promise<string> {
  const data = await postWebLogin<{ captcha_key: string }>('/x/passport-login/web/sms/send', {
    cid: '86',
    tel: phone,
    source: WEB_LOGIN_SOURCE,
    token: result.token,
    challenge: result.challenge,
    validate: result.validate,
    seccode: result.seccode,
  }, '发送 B 站短信验证码')
  if (!data.captcha_key) throw new Error('发送 B 站短信验证码失败:未返回登录凭证')
  return data.captcha_key
}

/** 用短信验证码登录;必须真的在共享分区里写下 SESSDATA 才算成功。 */
export async function loginWithWebSms(phone: string, code: string, captchaKey: string): Promise<void> {
  await postWebLogin<{
    refresh_token?: string
  }>('/x/passport-login/web/login/sms', {
    cid: '86',
    tel: phone,
    code,
    source: WEB_LOGIN_SOURCE,
    captcha_key: captchaKey,
    keep: 'true',
    go_url: 'https://www.bilibili.com',
  }, 'B 站短信登录')

  const ses = biliSession()
  await ses.cookies.flushStore()
  if (!(await isLoggedIn())) {
    throw new Error('B 站短信登录未写入登录态,请重新获取验证码')
  }
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
// ── 搜索(关键词 → 视频候选) ────────────────────────────────────────────────
// web 端搜索接口要 WBI 签名(和登录/播放走的 TV appkey 签名是两套完全不同的机制)。
// 盐值本身不公开,但取法公开且稳定:img_key/sub_key 从 /x/web-interface/nav 的
// wbi_img 里现取,按固定表打乱拼接成 mixin_key,再对参数排序后 md5(query+mixin_key)。
// 参照 biu 项目 electron/ipc/api/wbi.ts 的同一套算法。

const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

interface WbiKeys { imgKey: string; subKey: string }

// 密钥按天轮换,进程内缓存一份;真被拒了(风控/密钥过期)才强制重取一次,不是每次搜索都打 nav。
let cachedWbiKeys: WbiKeys | null = null

function wbiKeyFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('.'))
}

async function fetchWbiKeys(): Promise<WbiKeys> {
  // nav 匿名也能拿到 wbi_img(未登录时 code=-101,但 data 仍在),不能用 unwrap() 的
  // 「非 0 即抛」逻辑,得原样解出 data。
  const res = await netRequest(`${API}/x/web-interface/nav`, {
    headers: { 'User-Agent': DESKTOP_USER_AGENT, Referer: BILI_REFERER },
    session: biliSession(),
  })
  const env = JSON.parse(res.body.toString('utf-8')) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const imgUrl = env.data?.wbi_img?.img_url ?? ''
  const subUrl = env.data?.wbi_img?.sub_url ?? ''
  const keys = { imgKey: wbiKeyFromUrl(imgUrl), subKey: wbiKeyFromUrl(subUrl) }
  if (!keys.imgKey || !keys.subKey) throw new Error('取 B 站搜索签名密钥失败')
  return keys
}

async function getWbiKeys(forceRefresh = false): Promise<WbiKeys> {
  if (forceRefresh) cachedWbiKeys = null
  if (!cachedWbiKeys) cachedWbiKeys = await fetchWbiKeys()
  return cachedWbiKeys
}

function mixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey
  return WBI_MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

/** WBI 签名:参数按 key 排序、过滤 `!'()*`、拼上 wts,md5(query + mixin_key) 得到 w_rid。 */
async function signWbi(params: Record<string, string>, forceRefresh = false): Promise<string> {
  const { imgKey, subKey } = await getWbiKeys(forceRefresh)
  const mixin = mixinKey(imgKey, subKey)
  const all: Record<string, string> = { ...params, wts: String(Math.floor(Date.now() / 1000)) }
  const stripped = /[!'()*]/g
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k].replace(stripped, ''))}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixin).digest('hex')
  return `${query}&w_rid=${wRid}`
}

export interface BiliSearchResult {
  bvid: string
  title: string
  cover: string
  author: string
  /** 「12:34」这种时长文本,原样透传。 */
  duration: string
}

interface RawSearchItem {
  bvid?: string
  title?: string
  pic?: string
  author?: string
  duration?: string | number
}

function stripHighlightTags(title: string): string {
  // 搜索结果标题里命中的关键词包着 <em class="keyword">…</em>,界面只要纯文本。
  return title.replace(/<[^>]+>/g, '')
}

function normalizeCover(pic: string): string {
  if (!pic) return ''
  // 协议相对地址(//i0.hdslb.com/…)先补全。渲染进程直接裸连 hdslb.com 拿不到图——
  // 走的是应用自己的 origin,没有 B 站要的 Referer,一律 403。和视频直链同一个毛病,
  // 同一个解法:包成 mtmedia:// 代理,由主进程带着 Referer 转发(见 media-proxy.ts)。
  const full = pic.startsWith('//') ? `https:${pic}` : pic
  return toMediaProxyUrl(full, BILI_REFERER)
}

/** 账号已注销/找不到时,B 站把作者名兜底成「BILI_<uid数字>」——这类稿件的上传者已经
 *  没有主页、投稿数是 0,通常是账号被封后遗留的搬运/失效内容,直接从搜索结果里滤掉。 */
function isGhostAuthor(author: string): boolean {
  return /^BILI_\d+$/i.test(author.trim())
}

async function requestSearchPage(keyword: string, page: number, forceRefresh: boolean): Promise<{
  code: number
  message: string
  result: RawSearchItem[]
}> {
  const query = await signWbi({ search_type: 'video', keyword, page: String(page) }, forceRefresh)
  const res = await netRequest(`${API}/x/web-interface/wbi/search/type?${query}`, {
    headers: { 'User-Agent': DESKTOP_USER_AGENT, Referer: BILI_REFERER },
    session: biliSession(),
  })
  const env = JSON.parse(res.body.toString('utf-8')) as {
    code: number
    message: string
    data?: { result?: RawSearchItem[] }
  }
  return { code: env.code, message: env.message, result: env.data?.result ?? [] }
}

/**
 * 关键词搜视频(search_type=video)。只搜普通投稿,合集(多个独立 BV 号归到同一
 * season)不做特殊识别——命中合集里的某一集时,用户挑的就是那一条 BV,和分 P 稿件
 * 一样处理;要是选错了,走「重新搜索」覆盖即可,不在这一层猜。
 */
export async function search(keyword: string, page = 1): Promise<BiliSearchResult[]> {
  let res = await requestSearchPage(keyword, page, false)
  // -403/-352 是签名被拒(密钥过期或风控),强刷一次密钥重试;别的错误直接抛给 UI。
  if (res.code === -403 || res.code === -352) {
    res = await requestSearchPage(keyword, page, true)
  }
  if (res.code !== 0) throw new Error(`B 站搜索失败:${res.message || res.code}`)
  return res.result
    .filter((it) => it.bvid && it.title && !isGhostAuthor(it.author ?? ''))
    .map((it) => ({
      bvid: it.bvid!,
      title: stripHighlightTags(it.title!),
      cover: normalizeCover(it.pic ?? ''),
      author: it.author ?? '',
      duration: String(it.duration ?? ''),
    }))
}

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

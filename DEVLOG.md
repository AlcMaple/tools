# 开发日志（DEVLOG）

## 2026-07-01 docs: 新增 AI_GUIDELINES.md + DEVLOG.md

**效果**：
1. 项目根目录新增两份持续维护的文档——`AI_GUIDELINES.md`（AI 生成规范）和本文件 `DEVLOG.md`（开发日志）
2. 之后 AI 生成代码有规范要求与避坑指南，并且每次提交前都需要在 DEVELOG.md 对改动进行白盒记录

**流程**：
- Git 提交规范对齐仓库里实际的提交历史（`type(scope): 中文描述`，无 AI 署名——用 `git log` 核对过近期提交）

## 2026-06-29 feat: BGM 登录状态UI(设置账号区 + 查询页登录提示)

**效果**：
1. 动漫查询页顶部新增登录状态：未登录/过期显示「点此登录提速」按钮，已登录显示「BGM 已登录」（可点重新校验）
2. 之前登录状态只能在设置页看，容易忘记去看；将自动检查改为进入动漫查询 tab 时自动检查一次

**状态流转**（`BgmLoginChip` 组件）：

![BgmLoginChip 状态流转](docs/devlog-assets/bgm-login-chip-states.svg)

节流判断是这个组件的核心——不是"每 24 小时查一次"，是按自然天的 8 点分界（早于 8 点算前一天）：

```ts
// utils/bgmAuth.ts
// 同一个"逻辑日"（8点到次日8点算一天）只自动查一次，避免每次切 tab 都打一次 BGM 的验证接口
function windowStart(ts: number): number {
  const d = new Date(ts)
  if (d.getHours() < 8) d.setDate(d.getDate() - 1) // 8点前算"昨天"的窗口
  d.setHours(8, 0, 0, 0)
  return d.getTime()
}
export function needsAutoVerify(): boolean {
  if (!cachedStatus) return true            // 从没查过，必须查一次
  return cachedAt < windowStart(Date.now())  // 上次查的时间早于本次窗口起点 → 已跨天，要重查
}
```

## 2026-06-29 feat: BGM 搜索带登录cookie提速 + 修正限流/CF报错分类

**效果**：
1. 之前：匿名搜索被 BGM 故意拖慢到 ~16s，10s 超时直接报错；现在：带登录 cookie 后 ~0.6s 秒回，未登录也放宽到 25s 等真实响应，不再误报「请求超时」
2. 之前：诊断信息里出现裸 `cloudflare` 字样就判定被拦截（BGM 诊断串本身恒带 `server=cloudflare`，会把正常 5xx 也误判成拦截）；现在：只认强特征

**数据流向**（一次搜索请求会怎么被分类）：

![BGM 搜索请求结果分类](docs/devlog-assets/bgm-search-classify.svg)


**"只认强特征"——失败时 UI「Show details」里真实会看到的内容**

场景 A：BGM 后端偶发 502，CF 只是照常转发，没拦任何东西：

```bash
[bgm-search-diag] HTTP 502 on https://bgm.tv/subject_search/xxx
  status=502 server=cloudflare cf-ray=8a1e2f9d3b1c-SJC cf-mitigated=- cf-cache-status=- via=- content-type=text/html retry-after=- | body[0:300]=<html><title>502 Bad Gateway</title><body>upstream connect error or disconnect/reset before headers...
```

场景 B：CF 真的弹出人机验证拦了这次请求：

```bash
[bgm-search-diag] HTTP 403 on https://bgm.tv/subject_search/xxx
  status=403 server=cloudflare cf-ray=9c2f3a8e4d5b-SJC cf-mitigated=challenge cf-cache-status=- via=- content-type=text/html retry-after=- | body[0:300]=<html><title>Just a moment...</title><body class="no-js">...
```

两条都有 `server=cloudflare 。区别在 `cf-mitigated`：场景 A 是 `-`（没值 = 没动作），场景 B 是 `challenge`（有值 = CF 真的拦了）；场景 B 的 body 里还有 "Just a moment" 原文，场景 A 没有。

判断代码只认这两个信号：

```ts
// utils/errorMessage.ts
const cfBlocked =
  /cf-mitigated=\s*(challenge|block|managed)/i.test(msg) || // 场景B命中，场景A不命中(值是"-")
  lower.includes('just a moment') ||                        // 场景B的body命中，场景A不命中
  lower.includes('cf-chl') ||
  lower.includes('attention required')
```

**两个 cookie 到底怎么用——流程**

![BGM 两个 cookie 的说明](docs/devlog-assets/bgm-cookie-flow.svg)

- 匿名 cookie jar（`BrowserSession`）是反爬虫伪装的一部分，跟登录无关
- 固定 UA/请求头 + 把服务器发的 `Set-Cookie` 存下来下次带上，
- 让请求看起来像"同一个人在持续访问"，而不是每次都是零 cookie 的全新访客。
- 登录后两个 cookie 一起带——这就是真实浏览器本来的行为。
- 浏览器的 Cookie 机制不区分"登录 cookie"和"其他 cookie"，
- 同一域名下所有没过期的 cookie 都在同一个罐子里，每次请求原样一起发出去；
- 登录不会清掉你登录前就有的 cookie，只是往罐子里加新的。
- 反过来登录后特意把匿名 cookie 摘掉、只发登录 cookie，才是不像真实浏览器的可疑做法。

## 2026-06-29 feat: BGM 令牌 + 内嵌登录窗自动填充鉴权

**效果**：
1. 设置页填「BGM 访问令牌」后，`api.bgm.tv` 请求（详情/别名搜索）带登录态，限额更宽松
2. 新增「登录 BGM」按钮：弹内嵌真实登录页，登录成功自动关窗，不用手动复制 cookie

**登录流程**（点击"登录 BGM"之后，数据怎么流动）：

![BGM 内嵌登录数据流程](docs/devlog-assets/bgm-login-flow.svg)

「怎么判断登录成功了」——监听 cookie 变化，只认 `chii_auth` 这个 BGM 的关键登录态 cookie：

```ts
// bgm/credentials.ts
const captureIfLoggedIn = async () => {
  const cookies = await part.cookies.get({ domain: 'bgm.tv' })
  const hasAuth = cookies.some((c) => c.name === 'chii_auth' && c.value) // 这个cookie出现=登录成功
  if (!hasAuth) return
  setBgmCookie(cookies.map((c) => `${c.name}=${c.value}`).join('; ')) // 存下全部cookie，供后续搜索请求用
  win.close() // 自动关掉登录窗，用户不用手动关
}
part.cookies.on('changed', (_e, c, _cause, removed) => {
  if (!removed && c.domain?.includes('bgm.tv') && c.name === 'chii_auth') captureIfLoggedIn()
})
```

「怎么判断登录过期了」——不是猜 cookie 有效期，是主动拉一次首页看有没有退出链接：

```ts
// bgm/credentials.ts
const html = res.body.toString('utf-8')
if (!html.includes('/logout')) setBgmCookie('') // 页面上没有"退出"入口 = 其实没登录了，清掉本地cookie
// 这行在try块里，请求本身失败（网络问题）会走catch、不清cookie —— 避免把"网络抖了一下"误判成"登录过期"
```

有 token 时给 API 请求加认证头，跟上面的 cookie 是两套独立的凭证（token 管 API，cookie 管网页搜索）：

```ts
// bgm/api-client.ts
const token = getBgmToken()
if (token) headers['Authorization'] = `Bearer ${token}`
```

# noreply 发信与第三方登录接入指南

> 目标读者：本站维护者自己。分两部分——① 用自有域名 `alcmaple.cn` 以 `noreply@alcmaple.cn` 发验证码；② Google / Microsoft / Apple / QQ 第三方登录的平台注册与后续接入。身份联邦的安全边界分析见 [013-邮箱快捷注册与登录](./013-邮箱快捷注册与登录.md)。

## 一、noreply@alcmaple.cn 发信

### 原理

收件方（QQ/163/Gmail 等）用 DNS 里的 SPF / DKIM / DMARC 记录判断「这封自称 noreply@alcmaple.cn 的信，是不是经 alcmaple.cn 主人授权的服务器发出的」。所以 noreply 地址不需要真实收件箱，但**必须**在域名 DNS 里授权一个发信服务。个人邮箱（如 QQ 邮箱）直接冒充 noreply@alcmaple.cn 发信会被判伪造进垃圾箱——现有实现只把 `SMTP_FROM` 当发件地址，切到正规发信服务后代码零改动。

### 选发信服务

| 服务 | 免费额度 | 前提 | 适用 |
| --- | --- | --- | --- |
| Brevo | 约 300 封 / 天，每天刷新 | 域名 DNS 验证即可，无备案要求 | **本站选定**：验证码量级下长期免费 |
| 阿里云邮件推送 DirectMail | 一次性 2000 封（每天上限 200），用完按量付费（资源包约 90 元 / 5 万封） | 阿里云账号实名；发信域名要求完成 ICP 备案 | 备选：哪天想全走阿里体系再切 |
| 腾讯云邮件推送 SES | 有免费体验额度（以官网为准） | 实名；域名备案要求同上 | 同上 |
| Resend | 约 3000 封 / 月 | 域名 DNS 验证 | Brevo 替代项 |

**本站现状与结论**：服务器在唐人云香港机房（海外，访问 Brevo / Google 无障碍），域名在阿里云注册且已完成 ICP 备案。选 **Brevo**——免费额度每天刷新，验证码一天几十封的量级等于永久免费；阿里云虽因域名已备案也能用，但免费额度是一次性的，用完就付费。备案这件事对 Brevo 毫无影响，反而给 QQ 互联留了路（见下文）。

### Brevo 接入步骤

1. [brevo.com](https://www.brevo.com/) 注册免费套餐（手机号验证激活，不用绑卡）。注册引导依次问：组织信息（「组织名称」必填但**不核验**，个人项目填站名 `MapleTools`，「我的业务是」选与软件 / IT 最接近的一项）→ 地址（地址 / 邮编 / 城市 / 国家，全必填，填自己的真实大致地址即可，国家选中国，个人账号不核验）→ 方案选择（选 **Free 免费套餐**）。网站字段可填 `https://anime.alcmaple.cn` 也可选「我没有网站」。
   - **「地址」框是 Google 地址联想组件**：手打是填不进去的，输入几个字后要点选下拉建议（或按 ↓ 选中再回车）才算填上；若点选没反应，换无痕窗口或让代理走全局再打开这一页（联想脚本加载不全会点不动）。地址不核验，选哪条建议都不影响发信。
2. 右上角头像 →「SMTP & API」→「SMTP」标签 → 生成 SMTP 密钥（**2026 年实测为 `xsmtpsib-` 开头**，旧教程写的 `xkeysib-` 已过时；只显示一次，立即保存）。连接必须用这个 **SMTP 密钥**，不是 API v3 密钥；**SMTP 登录名是页面上显示的自动生成地址**（形如 `smtp-user@example.com`），不是注册邮箱。主机 `smtp-relay.brevo.com`，端口 587。页面上「Activate for SMTP keys / 授权 IP」的加固提示**不要开**——开了之后未列入白名单的服务器 IP 会被拒发，保持默认「不限制」即可。
   - 注意：SMTP 密钥**90 天不用会自动过期**（与设置的 1 年有效期无关）。站点长期没人登录发验证码的话密钥会静默失效，表现为邮箱入口重新报「暂不可用」——去同页面重新生成一个换 env 即可。
3. 「Senders & IP」→「Domains」→ 添加 `alcmaple.cn`，按控制台给出的记录到阿里云「云解析 DNS」逐条添加并回 Brevo 验证（DNS 生效几分钟到几小时）。2026-08 实际要加 4 条：`@` TXT（brevo-code）、`brevo1._domainkey` / `brevo2._domainkey` 两条 CNAME、`_dmarc` TXT；解析请求来源选「默认」，TTL 默认。**这一步是 outlook/hotmail 能收到信的前提**——163 等宽松服务在未认证时也会收，微软直接拒收（Brevo 日志表现为 Sent 后跟 Error 事件）；认证完成后日志出现 Delivered 事件即通：
   - SPF：`@` TXT `v=spf1 include:spf.brevo.com ~all`
   - DKIM：`brevo._domainkey` 等记录，类型与值以控制台为准
   - 建议补 DMARC：`_dmarc` TXT `v=DMARC1; p=none`
4. 服务器上配置环境变量（**放部署目录外**，`rm -rf` 重新部署不能带走密钥）：

   ```text
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587
   SMTP_SECURE=false      # 换 465 端口时改 true
   SMTP_USER=<SMTP & API 页显示的登录名>
   SMTP_PASS=<xkeysib- 开头的 SMTP 密钥>
   SMTP_FROM=noreply@alcmaple.cn
   SMTP_FROM_NAME=MapleTools
   ```

5. 重启 node 服务，在登录页走一次完整验证码流程实测；QQ / 163 收件箱里确认发件人显示为 `MapleTools <noreply@alcmaple.cn>` 且未进垃圾箱。`noreply` 不需要真实收件箱，是纯发信地址。

其他家接入同理：控制台添加发信域名 → 拿 DNS 记录 → 解析生效后验证 → 生成 SMTP 凭证，差异只在控制台入口和记录值，**一律以控制台给的记录为准**，不要照抄本文的示例值。

## 二、第三方登录（OIDC / OAuth）

### 回调地址约定

本站统一用 `https://anime.alcmaple.cn/api/auth/oauth/<provider>/callback`（provider 取 `google` / `microsoft` / `apple` / `qq`）。**注册平台应用时就填这个精确地址**，少斜杠、多参数都会被拒；后续实现路由按此落码，两边不会对不上。

### Google（免费，审核最轻，建议第一个做）

控制台首页（就是你截图那个「欢迎」页）顶栏已经选中项目 `gen-lang-client-0478473635`——这是之前建 Gemini API 密钥时自动生成的项目，OAuth 客户端直接放它下面就行，**不用新建项目**；想分开管理也可以：点顶栏项目名下拉 → 右上「新建项目」→ 名称 `mapletools` → 创建。顶部「免费开始使用吧」是 $300 赠金绑卡，OAuth 用不到，不要点。

1. 左上角 ☰ 菜单 →「API 和服务」→「OAuth 同意屏」（新界面可能叫 Google Auth 平台 / 品牌）→ 开始配置：User Type 选**外部**，应用名 `MapleTools`，用户支持邮箱选自己的 Gmail。Scopes 只加 `openid` / `email` / `profile`——非敏感 scope，发布时**不需要** Google 安全评估。
2. 「API 和服务」→「凭据」→ 顶部「+ 创建凭据」→「OAuth 客户端 ID」→ 应用类型选 **Web 应用** →「已获授权的重定向 URI」填 `https://anime.alcmaple.cn/api/auth/oauth/google/callback` → 创建，弹窗里**当场复制客户端 ID 和客户端密钥**（Google 的密钥关掉弹窗就再也看不到，丢了只能重置）。
3. 同意屏的「受众」页把发布状态从「测试」推到「正式」——发布时可能要求补应用主页（`https://anime.alcmaple.cn`）和隐私政策链接，先放一个简单页面即可。**注意：处于「测试」状态时只有加进测试用户列表的 Google 账号能登录**，联调阶段先把自己的 Gmail 加为测试用户。

### Microsoft（Outlook / Hotmail / Live 账号）—— 个人账号已无法直接注册，建议暂缓

**2026-08-16 实测**（浏览器直进 Entra 管理中心验证）：微软已**弃用「无目录个人账号直接创建应用注册」**——个人账号在 [entra.microsoft.com](https://entra.microsoft.com) → 应用注册 → 新注册时，弹窗明确提示「在目录外创建应用的能力已被弃用」，只剩两条官方出路：

1. **加入 M365 开发者计划**（[aka.ms/joinM365DeveloperProgram](https://aka.ms/joinM365DeveloperProgram)，免费）：送一个开发者租户，应用注册住在里面。**风险：沙盒租户 90 天不活跃可能被回收**，届时应用注册随之失效，线上微软登录按钮会突然断掉——对生产登录入口是实际运维负担。
2. **注册 Azure 账号**（[aka.ms/signUpForAzure](https://aka.ms/signUpForAzure)）：需要一张国际信用卡做身份验证。

**结论：暂缓接入微软登录。** outlook / hotmail / live 用户已被「邮箱验证码」入口完整覆盖（Brevo 发信实测可达，快捷后缀与收件箱直达齐备），少一个按钮不影响这些用户登录。将来确有需要再走 M365 开发者计划，接入时复用 Google 的 OAuth 骨架（换 token/JWKS 端点，回调地址 `/api/auth/oauth/microsoft/callback`，帐户类型选「任何组织 + 个人 Microsoft 帐户」）。

> 踩坑记录：Azure 门户对无目录个人账号还会报 `AADSTS16000`（账号不存在于「Microsoft Services」租户），门户内反复重新登录无法解决；**Entra 管理中心（entra.microsoft.com）能正常进入**并给出上述弃用提示，排查时走这个入口。

### Apple（需 Apple Developer Program，约 99 美元 / 年）

唯一一家收费的：网页版登录要登开发者账号 → Certificates, IDs & Profiles → 建 **Services ID**（配主域 `anime.alcmaple.cn` + Return URL 填回调地址）→ 再建一把私钥 `.p8`（记下 Key ID）。实现侧也最麻烦：client_secret 是拿 .p8 用 ES256 现签的 JWT，不是静态字符串。**没有付费会员就先跳过**，Apple 用户走邮箱验证码（iCloud 邮箱收验证码）不受影响。

### QQ（OAuth2，非 OIDC；个人可申请，需备案）

[QQ 互联](https://connect.qq.com/) → 注册开发者（个人身份，提交基本资料）→ 创建「网站应用」→ 填已备案的网站域名和回调地址，审核约 3–7 天，通过后拿 App ID / App Key。注意 QQ 的 OAuth 只给 `openid`，**拿不到邮箱**，所以 QQ 登录的账号键只能是 `provider=qq + openid`，没法和现有邮箱账号自动合并；域名未备案则这条路走不通（本站域名已备案，条件具备）。

### 163 / 网易

无面向个人站点的公开第三方登录接口，跳过——163 邮箱用户用「邮箱验证码」入口覆盖（快捷后缀和收件箱直达都已就位）。

## 三、拿到凭据之后

Google 已于 2026-08-16 接入（见 [`docs/devlog/2026-网页版.md`](../devlog/2026-网页版.md) 的「新增 Google 账号登录」）：服务端 `/api/auth/oauth/google/start|callback`（授权码 + PKCE + JWKS 验签）、`oauth_identity` 表（`provider + subject` 唯一键）、登录弹窗品牌按钮都已就位。**部署时只需两步**：

1. 服务器（部署目录外的 env）配置 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`，重启 node，入口自动出现
2. 本地联调在 Google 客户端加一条重定向 URI `http://localhost:5173/api/auth/oauth/google/callback`

其余平台仍是待办（实现可复用 Google 的骨架）：

1. Microsoft：token 端点与 JWKS 地址不同，账号类型选「任何组织 + 个人」；client_secret 有有效期需轮换
2. Apple：需 Apple Developer Program（约 99 美元 / 年），client_secret 要用 `.p8` 私钥以 ES256 现签 JWT
3. QQ：OAuth2 拿不到邮箱与 OIDC 声明，账号键用 `provider + openid`，不参与邮箱并号
4. 设置页展示「已连接的第三方登录」及解绑入口；解绑后要求至少保留一种可登录方式

## 优先级建议

noreply / Brevo（半小时，直接提升所有验证码邮件观感）→ Google → Microsoft（都免费、当天可拿凭据）→ QQ（域名已备案，条件具备，审核约 3–7 天）→ Apple（99 美元 / 年，最后再说）。

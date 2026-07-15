# AI 生成规范

## 网络请求

- ❌ 新增抓取逻辑用 Node `https.get`/`https.request`
  后果：Node `https` 不读系统代理，Clash 等 fake-ip 代理下域名解析成 `198.18.x` 假地址，直连黑洞超时。
  ✅ 一律 `import { netRequest } from '../shared/net-request'`（Electron `net`，走系统代理/PAC）。

- ❌ 限流/5xx 失败后应用层自动重试、周期性探测「恢复了没」、或 catch 后静默 `return null`
  后果：惩罚窗口里加戳会加重限流；静默吞错让用户以为「没结果」而不停手动重试，等于放大伤害。
  ✅ 失败一律 `throw` 到 UI，由用户用倒计时按钮自己决定何时重试。唯一允许的代码层重试是传输层瞬时抖动（`withTransientRetry`，单次 ECONNRESET 级别）。

- ❌ 带 BGM 登录 cookie 的请求配随机/不一致的 User-Agent
  后果：真实事故——BGM 把登录会话绑定在登录时的 UA 上，UA 一换整套 cookie 被当匿名，「登录提速」上线近一周形同虚设且引发「启动掉登录」死循环。
  ✅ 登录窗分区、verifyBgmLogin、带登录 cookie 的搜索三处统一用 `DESKTOP_USER_AGENT`；只有未登录的匿名抓取才用 `BrowserSession` 随机伪装 UA。

- ❌ 上 Playwright 常驻浏览器去抓取
  后果：要的是浏览器的网络栈，不是它的 JS 渲染——BGM/萌娘都是服务端渲染 HTML、没有 JS 挑战，上真浏览器只会更慢、多吃几百 MB 内存，纯属浪费。
  ✅ 静态 HTML 解析用 cheerio 就够。

## 错误处理

- ❌ 统一兜底错误文案（比如所有失败都显示"网络请求失败"）
  后果：真实事故——用户被限流时以为自己断网了，一直手动重试，反而把限流打得更狠。
  ✅ 在 `utils/errorMessage.ts` 里按错误类型分类，每类给针对性文案 + 行动指引。

- ❌ 用裸 `cloudflare` 关键词判断是否被 CF 拦截
  后果：BGM 诊断串本来就恒带 `server=cloudflare`，裸关键词会把正常响应误判成拦截。
  ✅ 只认 `cf-mitigated=challenge/block/managed`、`Just a moment`、`cf-chl` 这类强特征。

## 数据持久化

- ❌ 把本机绝对路径（如 `archivist:///Users/xxx/.../cover.jpg`）写进要跨设备同步的数据
  后果：真事故——封面路径同步到另一台设备后路径不存在，封面全裂。
  ✅ 落盘只存可移植 URL/相对标识，本地化路径只在显示时按设备现算（参考 `hooks/useCover.ts`）。

## UI / 样式

- ❌ 选中态/hover 态切换时改变盒模型尺寸（只在选中态加 border、加粗字重、改 padding）
  后果：相邻元素被挤一下，出现布局抖动，chip/tab/pill/列表项高发。
  ✅ 两态之间 border 宽度、字重、padding、字号、宽高必须一致，只能变颜色/底色/阴影。

- ❌ 新加的可滚动区域（`overflow-*auto` 容器、`textarea` 等）用浏览器原生滚动条
  后果：原生滚动条又粗、又是系统配色，跟应用统一的 4px 细条不一致，一眼出戏（已踩：锦囊妙计记录备注）。
  ✅ 滚动条样式在 `index.css` 单一源：`textarea` 已在 `.custom-scrollbar` 选择器里全局并入（新的自动一致，不用逐个加类）；其余滚动容器（div/pre 等）加 `.custom-scrollbar` 类即可（参考 `#page-scroll`、结果列表、导入弹窗的 `<pre>`）。

## 工程习惯

- ❌ 识别出「唯一的工程风险是 XXX」后，只留一句注释「未来出问题再对齐/再修」就交付
  后果：真实案例——已登录搜索只顶掉 UA 没动 sec-ch-ua，留注记「未来 BGM 校验 sec-ch-ua 时再对齐」，被追问才承认这不是给未来的预留，而是**当下已存在**的指纹自相矛盾（UA 说 120、sec-ch-ua 说随机 119~123）；随后「版本号散落两处、改 UA 忘改提示头」的风险又想靠注释提醒了事。说得出口的已知风险就是已知 bug 的候补名单，留着必然兑现，且兑现时排查成本远高于当场修。
  ✅ 识别出的风险当场消除，优先用代码根除而不是注释提醒人：能派生就不写第二份（`DESKTOP_SEC_CH_UA` 版本号从 `DESKTOP_USER_AGENT` 串里解析生成，单一事实源，物理上无法改漏），能收敛到一处就不散落两处。
  与 YAGNI 的边界：YAGNI 拒绝的是「为不存在的需求预留扩展点」；修复当下已存在的不一致、堵死已识别的失误路径，是正确性工作，不属于过度设计，不能拿 YAGNI 当拖延的挡箭牌。

## 技术栈与架构边界

- 构建用 electron-vite，不换 webpack/rollup——一套配置管三端，没必要拆两套。
- TypeScript 5 `strict: true`，不关 strict、不甩 `any`——类型是唯一防线，关了等于裸奔。
- UI 用 React 18 + Tailwind 3 函数组件+hooks，不加新 UI 库/CSS-in-JS/class 组件——两套风格混用心智负担翻倍。
- 渲染进程状态管理用手写 `Map`+listener+`localStorage`（`stores/*.ts`），不上 Redux/Zustand/MobX/Context 全局态——现有模式够用，多一层状态库只是多一层要背的抽象。
- 抓取场景 HTTP 用 `netRequest()`，不用 axios/undici/node-fetch/裸 Node `https`——`https` 不走系统代理会黑洞超时（见「网络请求」错题本）。
- 抓取解析用 cheerio，不常驻 puppeteer/playwright——BGM/萌娘都是服务端渲染 HTML、没有 JS 挑战，上真浏览器只会更慢更吃内存。
- 文件监听用 chokidar，不自写轮询——系统本身都有"文件变了主动通知你"的机制。
- 邮件用 nodemailer，不接云邮件 SDK——本地 SMTP 够用，没必要多接一个账号依赖。
- 更新用 electron-updater，不自研协议——需要自己处理签名校验和增量包。
- 持久化用 JSON 文件（`shared/json-store.ts`），不上 SQLite/IndexedDB/ORM——数据量小，JSON 读写够用。
- 没有测试框架，也不需要——不要自作主张加 Jest/Vitest，加了没人维护。
- 渲染进程不碰网络/文件/Node API，一律走 IPC（新增 channel 四步流程见 `CLAUDE.md`「Adding a new IPC channel」）。渲染进程只能请求 IPC 写死的功能（搜索、下载等），无法请求"读任意文件""执行任意命令"这种，防止黑客和恶意代码
- 不为不存在的需求（多租户、插件系统、国际化）预留扩展点——YAGNI，三行能写完不要抽成一层。

## 提交规范

- commit message 用 **Conventional Commits + 中文描述**：`<type>(<scope>): <描述>`
  - 允许的 type：`feat` `fix` `docs` `refactor` `chore` `style` `perf` `test` `build` `ci`
  - scope 可选，用模块名（`bgm` `ipc` `library` 等）
- 标题写用户/开发者能看懂的**现象或结果**，不堆底层术语（术语放正文）。
  例：`fix(bgm): 修复搜索动漫时报 net::ERR_INVALID_ARGUMENT`，不是 `netRequest 跳过 Host 头`。
- 正文按需写：简单改动只要标题；复杂/踩过坑的改动才写正文，正文只写关键原因/决策，不堆废话。
- **不加 AI 署名 trailer**（如 `Co-Authored-By: Claude ...`）—— 提交历史统一以开发者身份呈现。
- 只在用户明确要求时才 commit/push。
- **提交前先按 [DEVLOG.md](./DEVLOG.md) 的格式补一条日志** —— 这是交付前的必经步骤，不是可选项。DEVLOG 是**快速查看 / 快速理解一次提交做了什么**的地方，别长篇大论（同一功能提交多，每条都堆字根本读不下去）：
  - **效果**（编号，面向用户的变化）是主体 —— 它本身就把「做了什么 / 为什么」讲清楚了。
  - **关键代码**只留「有代码片段 + 复杂 / 不显然」的点；**没有代码的「决策」段不写**（效果已说清），简单改动也不写。
  - **不写「已验」**；一个点要堆很多字才讲得清，就用图（SVG，放 `docs/devlog-assets/`）代替文字。

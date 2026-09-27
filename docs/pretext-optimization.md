# Pretext 接入范围与验证

当前依赖为 `@chenglou/pretext@0.0.9`。只修改 `web/`，不改变桌面端、工具权限、请求或数据库。

## 已接入

| 场景 | 入口 | 方式 |
| --- | --- | --- |
| 点评 / 推荐分享图正文 | `web/src/reviews/poster.ts` | 上一轮已接入，保留按需加载 |
| 作品公开点评、推荐列表正文 | `web/src/CommunityPage.tsx` | LongText 离屏排版 |
| 登录助手用户长消息 | `web/src/agent/AgentCards.tsx` | LongText 离屏排版 |
| 访客助手用户长消息 | `web/src/agent/GuestAgent.tsx` | LongText 离屏排版 |
| 两类助手已完成回复的纯文本段落 | `web/src/agent/AgentMarkdown.tsx` | LongText 离屏排版；保留 Markdown 渲染 |

`LongText` 只对 512～8,192 个 UTF-16 code units 的稳定纯文本段落启用；多段回复分别判断。
Pretext 提供 `contain-intrinsic-block-size` 预测高度，`content-visibility: auto` 由浏览器跳过离屏布局。
真实 DOM、字体样式、选区、按钮和链接保留；预测值不充当固定 height 或裁剪边界。
一个共享 ResizeObserver 取得宽度，宽度变化复用 prepared 数据，不在每条消息上读取几何尺寸。
准备队列每帧约 4 ms 后让出，单次 prepare 本身仍为同步操作，不代表硬性 4 ms 上限。
字体加载完成重建预测，卸载移除订阅，库缓存按累计字符量回收；首次使用长文本才加载分块。

## 主动保留原生处理的位置

| 位置 / 条件 | 原因 |
| --- | --- |
| 正在流式输出的回复、textarea 编辑器 | 文本持续变化会反复准备；保持输入法、光标与滚动行为 |
| 含强调、链接、行内代码的段落；表格、代码块 | 多字体或复杂块布局不满足单字体测量条件 |
| 短文、按钮、标签、卡片两行截断、海报均衡标题 | 原生布局 / 少量 Canvas 测宽已足够，避免新增准备成本及改动既有断行设计 |
| 超过 8,192 字符的单段 | 32,000 字符试验出现长任务，避免叠加同步分词准备 |
| 单个始终可见的点评阅读弹窗、短公告与偏好 | 没有可复用的离屏长列表收益 |
| 周历拖动、横向海报计数、播放进度位置、助手视口与贴底 | 测的是容器、图片或交互坐标，不是文字排版 |
| 竖排、多列、特殊断词/字体特性、大小写转换等 | 超出当前预测合同，保持原生段落 |
| 浏览器缺少相关 CSS / ResizeObserver 能力，或增强加载失败 | 保留原文正常阅读；错误走全局错误报告 |

未为接入库而重写整个网站布局，也未将复杂 Markdown 高度假装成纯文本高度。

## 本机结果（2026-09-26）

Chromium 120 / Electron 28.3.3，macOS；80 条消息，每条 1,944 字符，混合中文、英文、emoji。
相同 React 夹具在原生 p / LongText 之间切换，18 次交替将容器宽度改为 480 / 640 px，并读取滚动高度。
同步布局耗时中位数：**6.3 ms → 1.2 ms**。
这衡量“改变宽度后的同步布局”，不是整站性能、首屏、滚动帧率或网络耗时。
收益来自 Pretext 高度预测与浏览器离屏跳过的组合，不把全部收益归因于 Pretext。

总高度：640 px 宽时原生 50623 px / 优化 50632 px；
480 px 宽时原生 67143 px / 优化 67155 px。
可见段落仍用浏览器实际高度；贴底、中间阅读位置、选择复制、按钮焦点、字体变化、卸载和降级均通过。

- 浏览器布局与行为：25 项通过，浏览器错误 0。
- 既有 Agent UI：50 项通过，真实 AI 调用 0，外部请求 0。
- 海报：21 组换行验证通过，完整 PNG 生成。
- TypeScript / 生产构建通过；原主包大于 500 KB 的构建警告仍存在。
- 基准过程中仍记录到大于 50 ms 的任务，保留在原始结果中，不宣称零卡顿。
- 尚未完成 Safari、Firefox、移动真机及线上性能验证；没有部署。

## 重跑

在仓库根目录，清除 `ELECTRON_RUN_AS_NODE`，使用已有 Electron 运行：

```sh
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron web/scripts/test-pretext-ui.cjs
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron web/scripts/test-poster-pretext.cjs
cd web
./node_modules/.bin/tsx scripts/test-agent-ui.ts
./node_modules/.bin/tsc --noEmit
env -u SENTRY_AUTH_TOKEN npm run build
```

浏览器脚本屏蔽外部 HTTP/HTTPS，默认报告在 `/tmp/maple-pretext-wide`、`/tmp/maple-pretext-check`，
可用 `PRETEXT_CHECK_DIR` 指定输出目录。完整 diff、基线哈希、逐条输出与本轮回退脚本保存在 `/tmp/maple-pretext-wide`。

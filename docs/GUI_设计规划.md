# Anime Tool GUI 设计规划文档

## 一、现有脚本功能总览

### 1. tools.bat 主菜单（已集成 4 个功能）

#### 功能 1：一键搜索并下载动漫（稀饭线路）

三步流水线，对应三个 Python 脚本：

**步骤 1 — `fetch_page.py`（搜索页抓取）**
- 目标网站：`dm.xifanacg.com`
- 输入关键词，构建搜索 URL
- 检测到验证码时：自动下载图片并用系统查看器弹出，等待用户手动输入
- 验证通过后重新请求搜索结果
- 将结果 HTML 保存到 `html_cache/<keyword>.html`
- 支持缓存复用（询问是否更新）

**步骤 2 — `parse_anime_list.py`（选择动漫）**
- 读取 `html_cache/<keyword>.html`，解析搜索结果列表
- 提取每条结果：标题、集数/播放量、年份、地区、播放页链接、封面
- 打印列表供用户选择
- 抓取所选动漫的播放页，保存到 `html_cache/<title>_watch.html`
- 将选择结果写入 `.last_watch` 文件

**步骤 3 — `parse_watch_page.py` + `xifan_crawler.py`（下载）**
- 读取播放页 HTML，提取 JS 变量 `player_aaaa`（含视频 URL）
- 解析所有播放源（最多 N 个），每个源构建 `{:02d}` 集号模板
- 源 1 直接从本地 HTML 读取，源 2+ 自动发起网络请求获取
- 提示用户选择下载起止集数
- 调用 `xifan_crawler.download_mp4_series()` 批量下载

**`xifan_crawler.py` 核心下载器**
- `MultiThreadDownloader`：16 线程异步分片（Range 请求），每片 1MB
- 下载前 HEAD 请求验证文件大小（< 10MB 视为无效/防盗链）
- 预分配文件空间，各线程写入各自偏移量，最终校验文件大小
- `download_mp4_series()`：按集号循环，多源自动回退（源1 失败则试源2…），已存在文件自动跳过（断点续传效果）
- 使用 `tqdm` 显示单集下载进度条

---

#### 功能 2：动漫信息查询（bgm.tv）

**`search_anime.py`**
- 目标网站：`bgm.tv`，爬取动漫数据库信息（独立于下载流程）
- 输入关键词，多页爬取（自动检测总页数）
- 过滤：标题必须包含关键词
- 某页零匹配则停止翻页
- 结果按日期降序排列，去重
- 输出：标题、首播日期、bgm 评分、详情链接
- 支持缓存（`bgm_cache/<keyword>_<page>.html`），可选是否更新

---

#### 功能 3：拉取个人音乐数据（sync_biu.py）

- 平台：Windows 专用
- 在 E 盘递归搜索 `Web前端开发/electron/Biu` 目录作为数据源
- 将该目录完整复制覆盖到 `~/Documents/Biu`
- 使用 `shutil.copytree(dirs_exist_ok=True)` 覆盖合并

---

#### 功能 4：推送个人音乐数据（push_biu.py）

- 平台：Windows 专用
- 从 `~/Documents/Biu` 将文件推送回 E 盘 `electron/Biu`
- 同样使用 `shutil.copytree(dirs_exist_ok=True)` 覆盖合并

---

### 2. 尚未集成的 girigiri 线路（待接入）

#### `girigiri_search.py`（搜索）

- 目标网站：`bgm.girigirilove.com`
- 流程：首次请求 → **强制触发验证码**（每次必须）→ 验证通过 → 重新请求
- 验证码图片保存为 `captcha_girigiri.jpg`，弹出给用户输入
- 解析搜索结果：标题、播放量、年份、地区、播放页 URL（带去重）
- 将用户选择的播放页 URL 写入 `.last_watch`
- 额外抓取并保存播放页 HTML 到 `html_cache/<keyword>_girigiri_watch.html`

#### `girigiri_download.py`（下载）

与稀饭线路最大的差异：**视频格式是 HLS (m3u8 + TS 分片)，而非直链 MP4**

- 读取本地缓存的播放页 HTML，解析集数列表
- 每集用 **Playwright（无头浏览器）** 拦截网络请求捕获真实 m3u8 链接（绕过 JS 动态加密）
- 支持中转链接解析（`atom.php?key=url=...`）
- 解析 m3u8 文件，获取所有 TS 分片 URL 及加密信息：
  - 支持嵌套 m3u8（递归解析）
  - 支持 AES-128-CBC 加密分片（自动下载密钥，`pycryptodome` 解密）
- 使用 `aiohttp` 异步并发下载（最大 10 并发），失败分片最多重试 8 次
- 兜底策略：重试耗尽后切换同步请求 + 冷却等待（5/10/15秒）
- **严格完整性要求**：有任意分片失败则放弃合并（不产生损坏文件）
- 所有分片下载完毕 → `ffmpeg -f concat` 合并为 MP4（`-bsf:a aac_adtstoasc` 修复音频）
- 备用方案：主流程失败后切换 `ffmpeg` 直接下载 m3u8
- 已存在文件自动跳过

---

## 三、脚本尚未实现 / 待补充的功能

以下功能在 GUI 中应预留界面位置，脚本完善后接入：

| 功能 | 当前状态 | GUI 占位建议 |
|------|----------|--------------|
| girigiri 线路集成到主流程 | 独立脚本，未集成 | 搜索线路选择器中已有按钮，置灰显示"开发中" |
| girigiri TS 分片断点续传 | 无，重启需重下 | 暂停后提示"girigiri 任务恢复将重下当前集分片" |
| 批量搜索 / 批量加入队列 | 无 | 搜索结果页多选复选框 + 批量加入队列按钮 |
| 下载速度限制 | 无 | 设置页"最大下载速度"输入框（0 = 不限制） |
| 代理设置 | 无 | 设置页 HTTP/SOCKS5 代理输入 |
| 自动识别验证码 | 人工输入 | 验证码弹窗预留"自动识别"按钮（集成 OCR 后启用） |
| 下载完成通知 | 无 | 设置页"完成后系统通知"开关 |
| 番剧追更（定时检测新集） | 无 | 任务卡片"追更模式"开关 |

---

## 四、技术选型建议

| 方案 | 优点 | 缺点 |
|------|------|------|
| **PyQt6 / PySide6** | 原生控件、性能好、跨平台、与现有 Python 无缝集成 | 学习曲线稍陡 |
| Tkinter + CustomTkinter | Python 内置，依赖少 | 控件样式受限，进度条动画弱 |
| Electron（Node.js 前端 + Python 后端） | Web 技术栈，UI 自由度最高 | 打包体积大，跨进程通信复杂 |

**推荐：PyQt6 / PySide6**
- 后端直接 `import` 现有脚本函数，无需 IPC
- `QThread` / `asyncio` 集成处理下载并发
- `QProgressBar` + `QTimer` 实现实时进度更新
- `QProcess` 捕获子进程输出到日志面板

---

## 五、数据流示意

```
[GUI 输入关键词]
       │
       ▼
[fetch_page / girigiri_search]  →  html_cache/<keyword>.html
       │ 验证码弹窗（如需）
       ▼
[parse_anime_list / girigiri_search 解析]
       │ 结果列表 → GUI 展示
       ▼
[用户选择 + 配置集数范围]
       │
       ├── 稀饭线 ──▶ parse_watch_page → xifan_crawler.download_mp4_series
       │                                        │ Range 分片下载 MP4
       │                                        ▼
       │                               downloads/<title>/<title> - 01.mp4
       │
       └── girigiri 线 ──▶ girigiri_download
                                  │ Playwright 捕获 m3u8
                                  │ aiohttp 下载 TS 分片
                                  │ AES 解密 + ffmpeg 合并
                                  ▼
                         downloads/<title>/<episode>.mp4
```

# GitHub Release 发布模板

参考项目：[ScottSloan/Bili23-Downloader](https://github.com/ScottSloan/Bili23-Downloader/releases)（v1.66.0 ~ v2.00.1 区间，v1.70.3 及之前是反例）

---

## 一、核心概念：一个 Release 是什么

GitHub Release 本质上是三件套：

1. **一个 Git tag**（比如 `v1.0.0`）
2. **一组 Asset 文件**（安装包、便携版、源码包等）
3. **一段 Markdown 说明**（release notes）

tag 一旦打出、release 一旦发布，tag 名不应再改；但 asset 列表和 notes **随时可以编辑**。

---

## 二、版本号与标签规范

### 版本号（SemVer）

```
v{MAJOR}.{MINOR}.{PATCH}[-{PRERELEASE}.{N}]
```

示例：
- `v1.0.0` — 正式版（stable / GA）
- `v2.0.0-rc.1` — 第 1 轮候选发布版
- `v2.0.0-rc.2` — 第 2 轮候选发布版
- `v2.0.0-beta.3` — 第 3 轮公测版
- `v2.0.0-alpha.1` — 早期内测版

预发布后缀含义：

| 后缀 | 含义 | 适用场景 |
|---|---|---|
| `-alpha.N` | 早期内测 | 功能不完整，仅核心团队/极早期用户测试 |
| `-beta.N` | 公测 | 功能齐全但 bug 未穷尽 |
| `-rc.N` | Release Candidate 候选版 | 接近正式版，只做回归修复 |
| 无后缀 | 正式版 | 面向所有用户 |

### GitHub Release 徽章

这是**独立于版本号后缀**的属性，发布 release 时勾选：

- **Latest**（绿色徽章）— 一个仓库只有一个，代表当前主推版本
- **Pre-release**（黄色徽章）— 永远不会被标为 Latest
- **不标记**（Don't mark as latest）— 用于已废弃或历史回滚版

**最佳实践**：版本号后缀和徽章保持一致
- `v1.0.0` → Latest
- `v2.0.0-rc.1` → Pre-release
- 未经作者测试的多平台产物 → Pre-release

---

## 三、Asset 命名规范

统一模板：

```
{项目名}_{版本号}_{平台}_{架构}[_变体].{扩展名}
```

示例（假设项目名为 `MyApp` 版本 `1.0.0`）：

```
MyApp_1.0.0_windows_x64.exe
MyApp_1.0.0_windows_x64_portable.zip
MyApp_1.0.0_windows_x64_for_win7.exe
MyApp_1.0.0_macos_arm64.dmg
MyApp_1.0.0_macos_x86_64.dmg
MyApp_1.0.0_linux_amd64.deb
MyApp_1.0.0_linux_amd64.AppImage
MyApp_1.0.0_linux_amd64_portable.tar.gz
```

平台关键字：`windows` / `macos` / `linux`
架构关键字：`x64` / `x86_64` / `arm64` / `aarch64` / `amd64`（按工具链习惯选，保持全项目一致）

### 每平台建议至少两种形态

- **安装版**：`.exe` (NSIS) / `.dmg` / `.deb`
- **便携版**：`.zip` / `.tar.gz` / `.AppImage`

### 源码包

GitHub 会自动为每个 tag 生成 `Source code (zip)` 和 `Source code (tar.gz)`，无需手动上传。

### SHA-256 校验

GitHub 现在自动为每个 release asset 显示 sha256 digest，用户可校验完整性。无需自己维护 checksum 文件。

---

## 四、Release Notes 模板

### 标题格式

```
{版本号（不带 v）} ({YYYY-MM-DD})
```

例：`1.0.0 (2026-04-07)`

### 固定分节（按出场顺序）

```markdown
## 1.0.0 (2026-04-07)

### 新增
- 支持 XXX 功能
- 新增 YYY 配置项

### 优化
- 优化启动速度
- 改善 ZZZ 的显示效果

### 修复
- 修复部分情况下 AAA 失败的问题
- 修复 BBB 异常退出的问题

### 重要变更（仅在有 breaking change / 许可证变更等时出现）
- 许可证由 MIT 变更为 GPLv3，请在分发前阅读新条款

### 使用提示（仅在有特殊说明时出现）
- 遇到 412 错误请暂停使用一段时间
- Win7 用户请下载带 `for_win7` 字样的专用版
```

写作要点：
- 每条**动词开头、一句话**，描述**用户能感知**的变化
- 不要写"重构了 X 模块""更新了依赖到 Y 版本"这种开发者视角的内容
- 避免累加历史：**每版只写本版变更**，历史内容如需保留用 `<details>` 折叠

### GitHub Alert 语法（强烈推荐）

用于突出重点：

```markdown
> [!Caution]
> 请仅从官方 GitHub 链接下载本软件。第三方渠道的安装包可能被篡改。

> [!Tip]
> Windows 7 用户请下载 `for_win7` 专用版。

> [!Warning]
> 本版本的 Linux / Intel Mac 产物未经作者测试，欢迎反馈。

> [!Note]
> 需要预先安装 ffmpeg 并加入 PATH。
```

### 历史版本折叠（hotfix 场景）

```markdown
## 1.0.1 (2026-04-10)

### 修复
- 修复紧急安全问题

> [!Tip]
> 本次更新为热修复（hotfix），仅包含紧急问题修复。

<details>
<summary>点此展开 1.0.0 及更早版本的更新内容</summary>

## 1.0.0 (2026-04-07)
...
</details>
```

---

## 五、多平台构建：GitHub Actions Matrix

### 为什么要用 Actions

本地打包的致命问题：Mac 只能打 Mac，Windows 只能打 Windows，Linux 基本要虚拟机。换到 Actions 后**你本机是什么系统不再重要**——你只是 `git push` 触发，真正的构建在 GitHub 的云端 runner 上跑。

**这解决的是"能不能构建出来"，不解决"构建出来能不能用"**（见第六章）。

### 通用 workflow 骨架

在仓库根目录 `.github/workflows/release.yml`：

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            platform: windows
            arch: x64
          - os: macos-14         # Apple Silicon
            platform: macos
            arch: arm64
          - os: macos-13         # Intel
            platform: macos
            arch: x86_64
          - os: ubuntu-latest
            platform: linux
            arch: amd64

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install deps
        run: npm ci

      - name: Build
        run: npm run dist

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.platform }}-${{ matrix.arch }}
          path: dist/

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          files: '**/*.{exe,dmg,zip,deb,AppImage,tar.gz}'
          draft: true              # 先存草稿，人工确认后再发布
          generate_release_notes: false
```

### Runner 对应关系

| runner | 构建的产物 |
|---|---|
| `windows-latest` | Windows x64 |
| `macos-14` / `macos-latest` | macOS arm64（Apple Silicon） |
| `macos-13` | macOS x86_64（Intel） |
| `ubuntu-latest` | Linux amd64 |

### Tag 打法

```bash
# 确认本地干净，并 push 最新代码
git push

# 打 tag 并推送，触发 Actions
git tag v1.0.0
git push --tags
```

**关键纪律**：所有平台产物必须来自同一个 commit。走 Actions matrix 天然保证这一点；如果你手工多机打包，必须在每台机器 `git fetch --tags && git checkout v1.0.0` 后再构建。

---

## 六、验证策略：如何知道 Actions 产物真能用

Actions 吐出来的包不代表真的能跑。必须额外验证。从便宜到贵四个层次：

### 1. CI 里加 smoke test（解决 ~30%）

在 workflow 的构建步骤后追加"启动—等待—退出"脚本：

```yaml
- name: Smoke test (Windows)
  if: matrix.platform == 'windows'
  run: |
    Start-Process dist/MyApp-Setup.exe -ArgumentList '/S' -Wait
    Start-Process 'C:/Program Files/MyApp/MyApp.exe'
    Start-Sleep -Seconds 10
    Stop-Process -Name MyApp

- name: Smoke test (macOS)
  if: matrix.platform == 'macos'
  run: |
    hdiutil attach dist/MyApp.dmg
    /Volumes/MyApp/MyApp.app/Contents/MacOS/MyApp &
    sleep 10
    kill $!

- name: Smoke test (Linux)
  if: matrix.platform == 'linux'
  run: |
    chmod +x dist/MyApp.AppImage
    ./dist/MyApp.AppImage --no-sandbox &
    sleep 10
    kill $!
```

**Electron 项目更进一步**：用 Playwright 启动主窗口、点几个按钮、截图作为 artifact 上传。

局限：CI runner 自带许多依赖（ffmpeg 等），抓不到"用户缺依赖"类问题。

### 2. 本地虚拟机抽检（解决 ~50%）

在 M 系列 Mac 上免费可行的组合：

- **UTM + Windows 11 ARM ISO**（微软官方免费提供）— M 芯片上原生跑 Windows ARM，再靠 Windows 的 x64 翻译层测试你的 x64 包
- **UTM + Ubuntu ISO** — 原生 ARM Linux 流畅；x64 包需 QEMU 软件模拟
- **Parallels Desktop**（付费）— 体验比 UTM 好很多

**M 系列 Mac 无法测 Intel macOS**（Apple 硬件层面禁止）。要测 Intel Mac 只能借真机或用 MacinCloud 等付费服务。

### 3. Pre-release + 社区测试（GitHub 为此设计的机制）

这是最务实的答案。流程：

1. 自己能测的平台（例如 Windows x64、macOS arm64）→ 发 **Latest**
2. 没条件测的平台（例如 macOS x86_64、Linux）→ **同一个 release** 里一起上传，但在 notes 里 `> [!Warning]` 标注"未经作者测试"
3. 或者单独发 **Pre-release** 版本，征集该平台用户反馈
4. 收到 1~2 个正向反馈后，下一版就敢把这些产物也当正式版

**Pre-release 的真实作用就是"我知道这个构建可能有问题，别把它当最新稳定版"**，而不是"beta 功能"。

### 4. 付费跨平台测试云（商业项目才考虑）

BrowserStack / Sauce Labs / MacinCloud 等。个人项目不必。

---

## 七、发布流程清单

### 方案 A：手工多机打包（暂未上 Actions 时）

使用 GitHub 的 **Draft release** 功能避免"半成品上线"：

1. Mac 上打包 → GitHub 网页 `Draft a new release` → 写 tag、notes、上传 Mac 产物 → **Save draft**（不要 Publish）
2. 切到 Windows → 打包 → 编辑同一个 draft → 上传 Windows 产物
3. 所有平台齐了 → **Publish release**

**避免**：已发布的 release 事后追加 asset。GitHub 不会因为你加了新包再发一次通知，"watch releases" 的用户和第三方轮询会错过。

### 方案 B：GitHub Actions 自动化（推荐目标）

1. 在本地 `git tag v1.0.0 && git push --tags`
2. 等 Actions 跑完（一般 10~20 分钟）
3. 打开 GitHub Releases 页面，Actions 已创建一个 draft release，所有产物齐了
4. 检查 notes → 手工或按模板补写 → 点 **Publish release**

### Release 发布前最终 checklist

- [ ] tag 格式正确：`v` 开头 + SemVer（预发布带后缀）
- [ ] Latest / Pre-release 徽章选择正确
- [ ] asset 命名全部统一遵守模板
- [ ] 每平台至少一个安装版（视需要加便携版）
- [ ] Release notes 标题含版本号和日期
- [ ] 分节为"新增/优化/修复"，必要时加"重要变更/使用提示"
- [ ] 只写本版变更，不累加历史
- [ ] 破坏性变更用 `> [!Caution]` 或 `> [!Warning]` 突出
- [ ] 未测试平台用 `> [!Warning]` 明确标注
- [ ] 有特殊用户指引的（Win7 专用、依赖预装）用 `> [!Tip]`

---

## 八、针对 Electron 项目的特别建议

如果你的项目像 Bili23 一样是 Electron 应用，以下是额外要注意的事：

### 1. 先把外部依赖 bundle 进包里

最典型的是 ffmpeg。直接从 PATH 取（`const ffmpegPath = 'ffmpeg'`）意味着用户必须自行安装——这是整个分发链最脆弱的环节，**跨所有平台都会有人踩**。

两种修法任选：

```bash
# 方案一：npm 依赖
npm i ffmpeg-static
```

```js
const ffmpegPath = require('ffmpeg-static');
```

```json
// 方案二：electron-builder 配置里用 extraResources 手动打进
{
  "build": {
    "extraResources": [
      { "from": "./bin/ffmpeg", "to": "ffmpeg" }
    ]
  }
}
```

消除 PATH 依赖后，release notes 就不再需要"请用户预装 ffmpeg"，安装即用——对非技术用户是巨大的体验差别。

### 2. electron-builder 多平台 target 配置

```json
{
  "build": {
    "win": {
      "target": ["nsis", "zip"],
      "arch": ["x64"]
    },
    "mac": {
      "target": ["dmg", "zip"],
      "arch": ["arm64", "x64"]
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "arch": ["x64"]
    }
  }
}
```

### 3. macOS 代码签名与 Gatekeeper

未签名的 .app 用户首次运行会被 Gatekeeper 拦。两个选择：

- **不做签名**：release notes 里写明打开方式：
  ```
  > [!Tip]
  > macOS 首次运行提示"无法打开"时，请右键点击 App → 选择"打开"，
  > 或执行 `xattr -d com.apple.quarantine /Applications/MyApp.app`
  ```
- **做签名+公证**：加入 Apple Developer Program（$99/年），配置 `notarize` 插件

### 4. 平台支持范围诚实披露

Electron 28+ 的支持基线：

| 平台 | 最低支持 |
|---|---|
| Windows | 10 x64 / arm64 |
| macOS | 10.15 Catalina（Intel + Apple Silicon） |
| Linux | glibc 2.28+（Ubuntu 20.04+ / Debian 10+ / Fedora 30+） |

Windows 7/8 不再支持。在 README 和 release notes 里写清楚，避免用户徒劳下载。

---

## 九、首次落地建议顺序

不要一上来全搞。按这个顺序推进最省事：

1. **先处理 ffmpeg 等外部依赖**，bundle 进包里——这是发布前最该做的事，与平台无关
2. **补齐 electron-builder 的 mac/linux target 配置**
3. **写一个 Actions workflow**，matrix 包含 Windows + Mac arm64 两个 runner（先从你能测的平台开始）
4. **发第一版 Latest**，只挂 Windows x64 + macOS arm64 两个 asset，notes 里正式开始走本模板
5. **下一版扩展 matrix** 加入 macOS x86_64 和 Linux，先走 Pre-release 征集测试
6. **验证通过后**，这些平台也进 Latest 正式版

一句话总结：**Actions 让你能多平台发，Pre-release + 社区测试让你敢多平台发。两者配合才完整，少一个都不行。**
---
name: electron-release
description: "Use when setting up or maintaining GitHub Actions release automation for an Electron project. Covers first-time setup (workflow file, .npmrc mirror issues, tag management) and ongoing release maintenance (when to cut a release, editing draft releases, versioning). For projects with a self-rolled 国内加速 auto-updater, also covers the update-manifest.json / sync:manifest step and the version-alignment red lines. Examples: 'set up release workflow', 'publish a new version', 'Actions build failed', 'how do I release', '发版要改哪几个地方', 'update-manifest 怎么同步'."
---

# Electron 项目 GitHub Actions 发布流程

用 GitHub Actions + electron-builder 出包、`softprops/action-gh-release` 发 draft 的发布套路。

> **两类项目**：
> - **普通自动更新**：electron-updater 走默认 GitHub provider，客户端直接读 release 里的 `latest.yml`。
> - **国内加速自动更新**：updater 不走默认 provider，而是先读仓库 `main` 上一份 `update-manifest.json`
>   拿到最新版本号，再拼固定 tag 的 ghproxy 下载链。判断依据：仓库里有 `update-manifest.json`
>   + `npm run sync:manifest`。这类项目发版要**多同步一处版本号**，见 [§四](#四国内加速项目同步-update-manifestjson)。
>
> 两类都依赖 release 里的 `latest.yml`，[§一](#一首次搭建) 的 workflow 已把它打进产物。

---

## 一、首次搭建

### 1. `.github/workflows/release.yml`

push `v*` tag 时触发，Windows + macOS 并行构建，汇总成一个 draft release：

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            platform: windows
            arch: x64
          - os: macos-14
            platform: macos
            arch: arm64

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Clear .npmrc for CI
        shell: bash
        run: echo "" > .npmrc          # 关键：清除本地镜像配置（见 §二）

      - run: npm ci

      - name: Build & package
        run: npm run build && npx electron-builder --publish never
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: false   # 跳过 macOS 签名

      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.platform }}-${{ matrix.arch }}
          path: |
            dist/*.exe
            dist/*.dmg
            dist/*.zip
            dist/*.yml
            dist/*.blockmap
          if-no-files-found: error
          retention-days: 7

  release:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: artifacts

      - uses: softprops/action-gh-release@v2
        with:
          draft: true
          generate_release_notes: false
          token: ${{ secrets.GITHUB_TOKEN }}
          files: |
            artifacts/**/*.exe
            artifacts/**/*.dmg
            artifacts/**/*.zip
            artifacts/**/*.yml
            artifacts/**/*.blockmap
```

> **`*.yml` / `*.blockmap` 必须进 release，别只传 exe/dmg/zip。** electron-updater 靠 release 里的
> `latest.yml`(Windows) / `latest-mac.yml`(macOS) 找安装包并校验 sha512；`*.blockmap` 用于差量下载。
> 少了 `latest.yml`，无论哪种 provider 都更不了——这是最容易漏的一处。

### 2. electron-builder 产物命名

在 `package.json` 的 `build` 字段为每个平台加 `artifactName`，文件名带上 `${version}`：

```json
"win": {
  "target": "nsis",
  "artifactName": "${productName}_${version}_windows_${arch}.${ext}"
},
"mac": {
  "target": [
    { "target": "dmg", "arch": ["arm64"] },
    { "target": "zip", "arch": ["arm64"] }
  ],
  "artifactName": "${productName}_${version}_macos_${arch}.${ext}"
},
"dmg": {
  "artifactName": "${productName}_${version}_macos_${arch}.${ext}"
}
```

产物示例：`MapleTools_0.4.0_windows_x64.exe`、`MapleTools_0.4.0_macos_arm64.dmg`。
文件名里的 `${version}` 必须和 git tag、（国内加速项目还有）manifest 版本号一致——下载链就是按这个拼的。

---

## 二、`.npmrc` 镜像的坑（必读）

如果项目 `.npmrc` 里有国内镜像配置：

```
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

**这些镜像在 GitHub Actions（境外）上会导致 dmg-builder 等工具 404 下载失败。**

解法：在 CI 的 `npm ci` 之前用 `echo "" > .npmrc` 清空（workflow 里已包含）。本地开发不受影响，因为只在 CI 执行。

- 不要用 `npm config set` 覆盖——npm 不接受非标准 key。
- 不要用 `sed` 做多模式删除——macOS 的 BSD sed 不支持 `\|` 交替语法，`|| true` 会静默吃掉错误。
- 不要在 workflow `env:` 里设 `ELECTRON_MIRROR`——npm 跑脚本时会把 `.npmrc` 注入成 `npm_config_*` 变量，优先级更高，覆盖不了。
- `echo "" > .npmrc` 是唯一可靠的跨平台方案。

---

## 三、发布一个新版本

```bash
# 1. bump package.json 的 version（或 npm version --no-git-tag-version）
# 2. ★ 国内加速项目：同步 manifest（见 §四）；普通项目跳过
npm run sync:manifest

# 3. 提交并 push（package.json，以及 manifest 若有改动）—— manifest 必须落到 main
git add package.json update-manifest.json   # 普通项目只 add package.json
git commit -m "chore(release): v0.4.1"
git push

# 4. 打 tag 触发 Actions（Win + macOS 并行，约 10 分钟）。tag 必须是 v + 那个版本号
git tag v0.4.1
git push --tags
```

Actions 完成后，GitHub Releases 出现一个 **draft** release，产物已齐。手动编辑这个 draft：

- **Title**：`0.4.1 (YYYY-MM-DD)`（不带 v）
- **Body**：粘贴本版 release notes
- **勾选 Set as the latest release**
- 点 **Publish release**

---

## 四、国内加速项目：同步 `update-manifest.json`

> 仅适用于自研「国内加速」自动更新的项目。普通项目无此文件，跳过本节。

`update-manifest.json`（`{ version, proxies }`，放仓库 `main` 根目录）是客户端**「查最新版本」的唯一来源**
——因为 ghproxy 不认 GitHub 的 `/releases/latest/` 重定向（502），客户端只能先读这份清单拿版本号，
再拼固定 tag 的下载链。所以发版时版本号要**多同步一处**：

```bash
npm run sync:manifest    # 把 package.json 的 version 拷进 update-manifest.json
```

- 这一步并进 §三 的 release commit 一起 push 到 `main`（客户端读的是 `main` 分支这份文件）。
- `proxies` 字段**发版时不要动**。它是「下载用的代理节点列表」，可随时单独改、推 main 即对
  **所有已安装客户端**即时生效（换节点无需发版）。
- 别和 release 里的 `latest.yml` 搞混：`update-manifest.json`（main 上，**查版本**用）
  vs `latest.yml`（release 资产，**下载**用）——两个东西，都得在位。

---

## 五、发版红线（都踩过）

1. **版本号必须对齐**：普通项目 `package.json` === git tag（去 `v`）；国内加速项目再加
   `update-manifest.json`，三处一致。下载链是
   `releases/download/v${version}/${productName}_${version}_..._${arch}.${ext}`，
   任一处错位就 404 / 拉不到 → 客户端报「无法获取更新 / 所有更新源不可用」。
2. **release 必须 Publish，不能停在 draft**：draft 的资产不公开，ghproxy / 直连都拉不到。
3. **国内加速的时序**：CI 跑完尽快 publish，缩短「manifest 已指向新版、但二进制还没公开」的窗口；
   要零窗口就反过来——先发布 release 让二进制就位，再单独 commit 一次 `sync:manifest` 推 main。
4. **自测别装错版本**：确认装上的 exe 版本号正是这次打的。版本号更大 ≠ 更新——
   一个版本号更高但更早打的旧包里，可能根本没有当前的 updater 代码。
   （实战踩过：拿旧的高版本号包测「检查更新」怎么都失败，其实包里没有国内加速代码，
   而 curl / node 测通道全 200 —— 排查半天才发现是装错了包。）

---

## 六、打错 tag 或 Actions 失败后重跑

```bash
git tag -d v0.4.1                      # 删本地 tag
git push origin :refs/tags/v0.4.1      # 删远端 tag（同时取消旧的 Actions run）
git tag v0.4.1                         # 重新打
git push --tags                        # 触发新一轮构建
```

每次 push tag 只触发一次；删掉重打才能重跑。tag 一旦**发布**就别改名；产物和 notes 随时可在 GitHub 页面编辑。

---

## 七、版本号规则

| 变更类型 | 版本号 | 示例 |
|---|---|---|
| bug 修复 / 小改进 | PATCH +1 | `v0.1.0` → `v0.1.1` |
| 新功能 | MINOR +1 | `v0.1.x` → `v0.2.0` |
| 面向所有用户的稳定版 | MAJOR | `v0.x` → `v1.0.0` |

---
name: electron-release
description: "Use when setting up or maintaining GitHub Actions release automation for an Electron project. Covers first-time setup (workflow file, .npmrc mirror issues, tag management) and ongoing release maintenance (when to cut a release, editing draft releases, versioning). Examples: 'set up release workflow', 'publish a new version', 'Actions build failed', 'how do I release'."
---

# Electron 项目 GitHub Actions 发布流程

## 一、首次搭建

### 1. GitHub Actions workflow

在 `.github/workflows/release.yml` 中配置，push `v*` tag 时触发：

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
        run: echo "" > .npmrc          # 关键：清除本地镜像配置（见下方说明）

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
```

### 2. electron-builder 产物命名

在 `package.json` 的 `build` 字段里为每个平台加 `artifactName`，保证文件名规范：

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

产物示例：`MapleTools_0.1.0_windows_x64.exe`、`MapleTools_0.1.0_macos_arm64.dmg`

---

## 二、.npmrc 镜像的坑（必读）

如果项目 `.npmrc` 里有国内镜像配置：

```
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

**这些镜像在 GitHub Actions（境外）上会导致 dmg-builder 等工具 404 下载失败。**

解法：在 CI 的 `npm ci` 之前用 `echo "" > .npmrc` 清空（workflow 里已包含这一步）。本地开发不受影响，因为这只在 CI 环境执行。

注意：
- 不要用 `npm config set` 覆盖——npm 不接受非标准 key。
- 不要用 `sed` 做多模式删除——macOS 的 BSD sed 不支持 `\|` 交替语法，`|| true` 会静默吃掉错误。
- 不要在 workflow `env:` 里设 `ELECTRON_MIRROR`——npm 运行脚本时会将 `.npmrc` 注入为 `npm_config_*` 变量，优先级更高，覆盖不了。
- `echo "" > .npmrc` 是唯一可靠的跨平台方案。

---

## 三、发布一个新版本

```bash
# 1. 确认代码已 push
git push

# 2. 打 tag，触发 Actions（Windows + macOS 并行，约 10 分钟）
git tag v0.1.1
git push --tags
```

Actions 完成后，GitHub Releases 页面会出现一个 draft release，里面已有构建产物。

然后手动编辑这个 draft：
- **Title**：`0.1.1 (YYYY-MM-DD)`（不带 v）
- **Body**：粘贴本版 release notes
- **勾选 Set as the latest release**
- 点 **Publish release**

---

## 四、打错 tag 或 Actions 失败后重跑

```bash
git tag -d v0.1.1                      # 删本地 tag
git push origin :refs/tags/v0.1.1      # 删远端 tag（同时取消旧的 Actions run）
git tag v0.1.1                         # 重新打
git push --tags                        # 触发新一轮构建
```

每次 push tag 只触发一次；删掉重打才能重跑。

---

## 五、版本号规则

| 变更类型 | 版本号 | 示例 |
|---|---|---|
| bug 修复 / 小改进 | PATCH +1 | `v0.1.0` → `v0.1.1` |
| 新功能 | MINOR +1 | `v0.1.x` → `v0.2.0` |
| 面向所有用户的稳定版 | MAJOR | `v0.x` → `v1.0.0` |

tag 一旦发布不要改名；产物和 notes 随时可以在 GitHub 页面上编辑。

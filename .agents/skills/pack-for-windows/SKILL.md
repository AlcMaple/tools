# pack-for-windows

为前端项目生成一个跨平台打包脚本（`scripts/pack.mjs`），用于在 macOS 压缩项目、传输到 Windows 后解压安装依赖运行。

## 背景

macOS 生成的 `node_modules` 包含平台原生 binding，Windows 无法直接使用，因此压缩时应排除 `node_modules`（以及其他构建产物）。目标用户在 Windows 解压后执行 `npm install` 再运行项目。

## 你的任务

1. **读取项目根目录的 `package.json`**，获取 `name` 字段作为压缩包前缀（若无则用目录名）。

2. **检查项目根目录**，识别需要排除的目录：
   - 必排除：`node_modules`、`.git`
   - 若存在则排除：`out`、`dist`、`logs`、`build`、`.cache`、`archive`、`.turbo`、`.next`、`.nuxt`
   - 若已存在 `scripts/pack.mjs`，询问用户是否覆盖

3. **在 `scripts/pack.mjs` 生成打包脚本**，要求：
   - 纯 Node.js 内置模块（`child_process`、`fs`、`path`、`url`），无额外依赖
   - 用系统 `zip` 命令（macOS/Linux 自带）
   - **输出文件名格式：`{name}-YYYYMMDD-HHmm.zip`**（必须含本地时间的时分），放在项目根目录
   - 排除所有检测到的无关目录
   - 若输出文件已存在则先删除（同分钟重复打包才会触发）
   - 脚本末尾打印文件路径和大小

   > ⚠️ **不要只用 `YYYYMMDD`**。同一天打包两次会得到同名 zip；很多用户的工作流是「打包→上传云盘→删本地」，本地探测序号在 zip 已被删的情况下无法去重，结果云盘端覆盖。`HHmm` 只多 5 个字符，无状态文件，是最便宜的去重方案。
   >
   > 时分必须用**本地时间**（`now.getHours()`/`now.getMinutes()`），不是 `toISOString()`，否则用户看到的时间和文件名对不上。

4. **将 `{name}-*.zip` 加入 `.gitignore`**（若尚未存在该规则）。

5. 告知用户：
   - 运行方式：`node scripts/pack.mjs`
   - Windows 端操作：解压 → `npm install` → 按项目说明运行

## 脚本模板

生成的脚本结构如下（根据实际项目名和排除列表填充）：

```js
import { execSync } from 'child_process'
import { existsSync, unlinkSync, statSync } from 'fs'
import { resolve, basename } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

// 本地时间，不是 UTC —— 用户看到的时分要和文件名对得上
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const DATE = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
const TIME = `${pad(now.getHours())}${pad(now.getMinutes())}`
const OUTPUT = resolve(ROOT, `{name}-${DATE}-${TIME}.zip`)

const EXCLUDES = [
  // 根据项目实际情况列出
].map(p => `--exclude="${basename(ROOT)}/${p}/*"`)

if (existsSync(OUTPUT)) unlinkSync(OUTPUT) // 同一分钟内重复打包才会触发

const cmd = `cd "${resolve(ROOT, '..')}" && zip -r "${OUTPUT}" "${basename(ROOT)}" ${EXCLUDES.join(' ')}`

console.log(`Packing → ${OUTPUT}`)
execSync(cmd, { stdio: 'inherit' })

const size = (statSync(OUTPUT).size / 1024 / 1024).toFixed(1)
console.log(`Done. ${size} MB → ${OUTPUT}`)
```

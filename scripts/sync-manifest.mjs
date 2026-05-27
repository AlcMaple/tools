// 把 package.json 的 version 同步进 update-manifest.json。
//
// 为什么需要这个文件：自动更新走「国内加速」时，客户端无法用 GitHub 的
// /releases/latest/ 重定向（ghproxy 对它返回 502），只能先拿到「最新版本号」
// 再拼固定 tag 的下载链。update-manifest.json 就是那份「最新版本号 + 代理
// 列表」清单，发布时通过 ghproxy-raw / jsdelivr 被客户端读取。
//
// 用法：发版前 bump 完 package.json 版本号后，跑一次 `npm run sync:manifest`，
// 把改动和 release commit 一起提交。proxies 字段不动（那是可随时手改、无需
// 发版即可对所有已安装客户端生效的「代理列表」）。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const manifestPath = join(root, 'update-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

if (manifest.version === pkg.version) {
  console.log(`update-manifest.json 已是 ${pkg.version}，无需改动`)
  process.exit(0)
}

const prev = manifest.version
manifest.version = pkg.version
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`update-manifest.json: ${prev} → ${pkg.version}`)

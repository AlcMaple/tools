// DATA_DIR 解析 —— DB 和周历缓存都落这儿。
//
// **位置铁律**（原在 db.ts）：必须放在 `/opt/web`（部署目录）之外 —— 重新部署一条龙会
// `rm -rf /opt/web`，放里面每次部署就清空。生产用 env `DATA_DIR=/opt/mapletools-data`，
// dev 默认落 `web/data/`（已被 .gitignore 忽略）。
//
// 单独成文件、而不是从 db.ts 导出：calendar.ts 只要这个目录，若为此 import db.ts 会把
// better-sqlite3（原生模块，vite.config.ts 里标了 ssr.external）拖进周历的 import 图。
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const dataDir = process.env.DATA_DIR
  ? isAbsolute(process.env.DATA_DIR)
    ? process.env.DATA_DIR
    : join(process.cwd(), process.env.DATA_DIR)
  : join(process.cwd(), 'data')

mkdirSync(dataDir, { recursive: true })

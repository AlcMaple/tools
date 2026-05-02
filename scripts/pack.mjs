/**
 * pack.mjs — 打包项目为 zip，排除无关目录
 * 用法：node scripts/pack.mjs
 * 输出：项目根目录下 maple-tools-YYYYMMDD-HHmm.zip
 *   末尾的 HHmm 是本地时间的时分，用于区分同一天的多次打包。
 */

import { execSync } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { resolve, basename } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const DATE = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
const TIME = `${pad(now.getHours())}${pad(now.getMinutes())}`
const OUTPUT = resolve(ROOT, `maple-tools-${DATE}-${TIME}.zip`)

const EXCLUDES = [
  'node_modules',
  'out',
  'logs',
  'dist',
  '.git',
  'archive',
  'scripts/pack.mjs',  // 不打包自身也没问题，但打进去也无妨；按需注释掉
].map(p => `--exclude="${basename(ROOT)}/${p}/*"`)

if (existsSync(OUTPUT)) unlinkSync(OUTPUT) // 同一分钟内重复打包才会触发

const cmd = `cd "${resolve(ROOT, '..')}" && zip -r "${OUTPUT}" "${basename(ROOT)}" ${EXCLUDES.join(' ')}`

console.log(`Packing → ${OUTPUT}`)
execSync(cmd, { stdio: 'inherit' })
console.log('Done.')

/**
 * pack.mjs — 打包项目为 zip，排除无关目录
 * 用法：node scripts/pack.mjs
 * 输出：项目根目录下 maple-tools-YYYYMMDD.zip
 */

import { execSync } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { resolve, basename } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const DATE = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUTPUT = resolve(ROOT, `maple-tools-${DATE}.zip`)

const EXCLUDES = [
  'node_modules',
  'out',
  'logs',
  'dist',
  '.git',
  'archive',
  'scripts/pack.mjs',  // 不打包自身也没问题，但打进去也无妨；按需注释掉
].map(p => `--exclude="${basename(ROOT)}/${p}/*"`)

if (existsSync(OUTPUT)) unlinkSync(OUTPUT)

const cmd = `cd "${resolve(ROOT, '..')}" && zip -r "${OUTPUT}" "${basename(ROOT)}" ${EXCLUDES.join(' ')}`

console.log(`Packing → ${OUTPUT}`)
execSync(cmd, { stdio: 'inherit' })
console.log('Done.')

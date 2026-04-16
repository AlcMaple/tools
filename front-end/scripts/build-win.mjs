#!/usr/bin/env node
// Windows 打包脚本：结束残留进程 → 清理 dist/out → 检查依赖 → electron-builder
// 跨平台（Windows 流程专用，但在 macOS/Linux 上也能跑 build 流程）
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
process.chdir(projectRoot)

const isWin = process.platform === 'win32'
const npmCmd = isWin ? 'npm.cmd' : 'npm'

const step = (n, total, msg) => console.log(`\n[${n}/${total}] ${msg}`)
const info = (msg) => console.log(`  ${msg}`)
const err = (msg) => console.error(`  [ERROR] ${msg}`)

function killProcess(name) {
  if (!isWin) return
  spawnSync('taskkill', ['/F', '/IM', name], { stdio: 'ignore' })
}

function removeDir(dir, label) {
  const full = resolve(projectRoot, dir)
  if (!existsSync(full)) return true
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
      if (!existsSync(full)) return true
    } catch (e) {
      // fall through to retry
    }
    info(`${label} 被占用，2 秒后重试 ${attempt}/5 ...`)
    spawnSync(isWin ? 'timeout' : 'sleep', isWin ? ['/t', '2', '/nobreak'] : ['2'], { stdio: 'ignore' })
  }
  return !existsSync(full)
}

function run(cmd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: isWin })
    child.on('exit', (code) => resolvePromise(code ?? 1))
    child.on('error', () => resolvePromise(1))
  })
}

async function main() {
  console.log('========================================')
  console.log(' MapleTools Windows Build Script')
  console.log('========================================')

  step(1, 4, '结束残留的 MapleTools / electron 进程...')
  killProcess('MapleTools.exe')
  killProcess('electron.exe')
  info('done.')

  step(2, 4, '清理旧构建产物 (dist, out)...')
  if (!removeDir('dist', 'dist')) {
    err('无法删除 dist 目录，仍被进程占用。')
    err('请手动关闭资源管理器 / 终端中打开 dist 的窗口，')
    err('或临时关闭杀毒软件实时防护后重试。')
    process.exit(1)
  }
  removeDir('out', 'out')
  info('done.')

  step(3, 4, '检查依赖...')
  if (!existsSync(resolve(projectRoot, 'node_modules'))) {
    info('node_modules 不存在，执行 npm install ...')
    const code = await run(npmCmd, ['install'])
    if (code !== 0) {
      err('npm install 失败')
      process.exit(1)
    }
  } else {
    info('node_modules 已存在，跳过。')
  }

  step(4, 4, '打包 Windows 安装器...')
  const code = await run(npmCmd, ['run', 'dist'])
  if (code !== 0) {
    console.error('')
    err('打包失败，请查看上方日志。')
    process.exit(1)
  }

  console.log('')
  console.log('========================================')
  console.log(' 打包完成！输出目录: front-end\\dist\\')
  console.log('========================================')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

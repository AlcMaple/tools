// 渲染进程自己读不了的材料，交给本机工具兜底：Chromium 解不了的视频（wmv / avi / 部分 HEVC）走 ffmpeg 抽帧，
// HEIC / TIFF 走系统图片解码，mac 上的 doc / rtf / pages 走 textutil。
// 渲染进程只传字节进来，不传路径：主进程不替渲染进程读任意文件。

import { app, nativeImage } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { VIDEO_FRAMES } from '../../../web/shared/order-judge'

export type ConvertKind = 'image' | 'video' | 'doc'

export type ConvertResult =
  | { ok: true; images: Buffer[]; text: string; seconds?: number }
  | { ok: false; code: 'NO_FFMPEG' | 'UNSUPPORTED' | 'FAILED'; detail?: string }

const SAFE_EXT = /^[a-z0-9]{1,6}$/

// 从 Dock / 开始菜单启动时 PATH 里没有 Homebrew，补上常见安装位置
function which(name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const dirs = (process.env.PATH ?? '').split(delimiter)
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (d && existsSync(join(d, exe))) return join(d, exe)
  }
  return null
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } })
    const out: Buffer[] = []
    const err: Buffer[] = []
    p.stdout.on('data', (b: Buffer) => out.push(b))
    p.stderr.on('data', (b: Buffer) => err.push(b))
    p.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }))
    p.on('close', (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString('utf-8'),
      stderr: Buffer.concat(err).toString('utf-8').slice(-500),
    }))
  })
}

async function video(file: string, dir: string): Promise<ConvertResult> {
  const ffmpeg = which('ffmpeg')
  const ffprobe = which('ffprobe')
  if (!ffmpeg || !ffprobe) return { ok: false, code: 'NO_FFMPEG' }
  const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  const seconds = parseFloat(probe.stdout.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, code: 'FAILED', detail: probe.stderr }
  const r = await run(ffmpeg, ['-v', 'error', '-y', '-i', file,
    '-vf', `fps=${VIDEO_FRAMES}/${seconds},scale='min(960,iw)':-2`,
    '-frames:v', String(VIDEO_FRAMES), join(dir, 'f_%02d.jpg')])
  const names = (await readdir(dir)).filter((n) => n.startsWith('f_')).sort()
  if (!names.length) return { ok: false, code: 'FAILED', detail: r.stderr }
  return { ok: true, images: await Promise.all(names.map((n) => readFile(join(dir, n)))), text: '', seconds }
}

function image(file: string): ConvertResult {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return { ok: false, code: 'UNSUPPORTED' }
  return { ok: true, images: [img.toPNG()], text: '' }
}

async function doc(file: string): Promise<ConvertResult> {
  if (process.platform !== 'darwin') return { ok: false, code: 'UNSUPPORTED' }
  const r = await run('/usr/bin/textutil', ['-convert', 'txt', '-encoding', 'UTF-8', '-stdout', file])
  if (r.code !== 0) return { ok: false, code: 'FAILED', detail: r.stderr }
  return { ok: true, images: [], text: r.stdout }
}

export async function convertMaterial(kind: ConvertKind, bytes: Uint8Array, ext: string): Promise<ConvertResult> {
  if (!SAFE_EXT.test(ext)) return { ok: false, code: 'UNSUPPORTED' }
  const dir = await mkdtemp(join(tmpdir(), `${app.getName()}-order-judge-`))
  try {
    const file = join(dir, `input.${ext}`)
    await writeFile(file, bytes)
    if (kind === 'video') return await video(file, dir)
    if (kind === 'image') return image(file)
    return await doc(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// 接单评估的材料预处理：一律在渲染进程里用浏览器能力做完，只把文字和 JPEG 交给主进程。
// 这样网页版以后可以原样复用，视频也只需要传 12 张帧图，不用上传整段视频。
// Chromium 解不了的格式（wmv / avi、HEIC、mac 上的 doc / pages）才交给主进程用本机工具兜底。

import { reportError } from './reportError'
import { MAX_DOC_CHARS, MAX_IMAGES, VIDEO_FRAMES, unescapeHtml, htmlToText } from '../../../../web/shared/order-judge'

const VIDEO = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'flv'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif', 'tiff', 'tif', 'bmp'])
const IMAGE_EDGE = 1280 // 截图长边缩到这个尺寸，文字仍清晰
const FRAME_WIDTH = 960
const JPEG_QUALITY = 0.85

export type MaterialKind = 'image' | 'video' | 'pdf' | 'doc' | 'text' | 'other'

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

function stemOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? name : name.slice(0, i)
}

export function kindOf(file: File): MaterialKind {
  const ext = extOf(file.name)
  if (IMAGE.has(ext) || (!ext && file.type.startsWith('image/'))) return 'image'
  if (VIDEO.has(ext)) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (['docx', 'doc', 'rtf', 'odt', 'pages', 'html', 'htm'].includes(ext)) return 'doc'
  if (ext === 'txt' || ext === 'md') return 'text'
  return 'other'
}

// ── 图片 ──

type Drawable = ImageBitmap | HTMLVideoElement

function toJpeg(src: Drawable, sx: number, sy: number, sw: number, sh: number, scale: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  ctx.fillStyle = '#fff' // 透明 PNG 转 JPEG 时底色发黑
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

async function decodeImage(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file)
  } catch {
    // HEIC / TIFF 等 Chromium 解不了，交给系统图片解码
    const r = await window.orderJudgeApi.convert('image', new Uint8Array(await file.arrayBuffer()), extOf(file.name) || 'png')
    if (!r.ok || !r.images[0]) return null
    try {
      return await createImageBitmap(new Blob([r.images[0] as BlobPart], { type: 'image/png' }))
    } catch {
      return null
    }
  }
}

// 高超过宽 2.5 倍的长图按 2 倍宽切块，相邻重叠 100px，免得一行字被切成两半
function tileRanges(w: number, h: number): [number, number][] {
  if (h <= w * 2.5) return [[0, h]]
  const tile = w * 2
  const out: [number, number][] = []
  for (let y = 0; y < h; y += tile - 100) {
    out.push([y, Math.min(tile, h - y)])
    if (y + tile >= h) break
  }
  return out
}

export async function imageTileCount(file: File): Promise<number | null> {
  try {
    const bmp = await createImageBitmap(file)
    const n = tileRanges(bmp.width, bmp.height).length
    bmp.close()
    return n
  } catch {
    return null
  }
}

function imageToJpegs(bmp: ImageBitmap, stem: string): { name: string; dataUrl: string }[] {
  const { width: w, height: h } = bmp
  const ranges = tileRanges(w, h)
  if (ranges.length === 1) {
    return [{ name: stem, dataUrl: toJpeg(bmp, 0, 0, w, h, Math.min(1, IMAGE_EDGE / Math.max(w, h))) }]
  }
  const scale = Math.min(1, IMAGE_EDGE / w)
  return ranges.map(([y, th], i) => ({
    name: `${stem}_${String(i).padStart(2, '0')}`,
    dataUrl: toJpeg(bmp, 0, y, w, th, scale),
  }))
}

// ── 视频 ──

function waitEvent(el: HTMLMediaElement, ok: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      el.removeEventListener(ok, onOk)
      el.removeEventListener('error', onErr)
      fn()
    }
    const onOk = (): void => done(resolve)
    const onErr = (): void => done(() => reject(new Error(el.error?.message || '视频解码失败')))
    const timer = setTimeout(() => done(() => reject(new Error('视频读取超时'))), ms)
    el.addEventListener(ok, onOk)
    el.addEventListener('error', onErr)
  })
}

async function videoFramesInBrowser(file: File, stem: string): Promise<{ frames: { name: string; dataUrl: string }[]; seconds: number }> {
  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  try {
    v.src = url
    await waitEvent(v, 'loadedmetadata', 15000)
    const seconds = v.duration
    // 编码不支持时 Chromium 也可能给出时长，但画面宽度为 0
    if (!Number.isFinite(seconds) || seconds <= 0 || !v.videoWidth) throw new Error('浏览器解不了这个视频')
    const scale = Math.min(1, FRAME_WIDTH / v.videoWidth)
    const frames: { name: string; dataUrl: string }[] = []
    for (let i = 0; i < VIDEO_FRAMES; i++) {
      v.currentTime = (seconds * (i + 0.5)) / VIDEO_FRAMES
      await waitEvent(v, 'seeked', 10000)
      frames.push({
        name: `${stem}_${String(i + 1).padStart(2, '0')}`,
        dataUrl: toJpeg(v, 0, 0, v.videoWidth, v.videoHeight, scale),
      })
    }
    return { frames, seconds }
  } finally {
    v.removeAttribute('src')
    v.load()
    URL.revokeObjectURL(url)
  }
}

async function bytesToJpeg(bytes: Uint8Array, name: string): Promise<{ name: string; dataUrl: string }> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
  try {
    return { name, dataUrl: toJpeg(bmp, 0, 0, bmp.width, bmp.height, 1) }
  } finally {
    bmp.close()
  }
}

// ── 文档 ──

function decodeText(buf: ArrayBuffer): string {
  // txt 可能是 UTF-8，也可能是 Windows 记事本存的 GBK
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('gb18030').decode(buf)
  }
}

// docx / odt 是 zip：从中央目录找到指定条目，用浏览器自带的 deflate-raw 解压
async function readZipEntry(buf: ArrayBuffer, entry: string): Promise<string | null> {
  const dv = new DataView(buf)
  let eocd = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  for (let n = 0; n < count && p + 46 <= buf.byteLength; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null
    const method = dv.getUint16(p + 10, true)
    const size = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen))
    if (name === entry) {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
      const data = new Uint8Array(buf, start, size)
      if (method === 0) return dec.decode(data)
      if (method !== 8) return null
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      return new Response(stream).text()
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

function xmlText(xml: string, paraTag: string): string {
  return unescapeHtml(xml.replace(new RegExp(`</${paraTag}>`, 'g'), '\n').replace(/<[^>]+>/g, ''))
}

function rtfText(raw: string): string {
  let s = raw.replace(/\{\\(fonttbl|colortbl|stylesheet|\*)[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
  s = s.replace(/\\u(-?\d+) ?(\?|\\'[0-9a-f]{2})?/g, (_m, n: string) => String.fromCharCode(((parseInt(n, 10) % 65536) + 65536) % 65536))
  s = s.replace(/\\'[0-9a-f]{2}/g, '')
  return s.replace(/\\[a-z]+-?\d* ?|[{}]/g, '')
}

async function docText(file: File): Promise<string> {
  const ext = extOf(file.name)
  const buf = await file.arrayBuffer()
  if (ext === 'docx') {
    const xml = await readZipEntry(buf, 'word/document.xml')
    return xml ? xmlText(xml.replace(/<w:tab\/>/g, '\t'), 'w:p') : ''
  }
  if (ext === 'odt') {
    const xml = await readZipEntry(buf, 'content.xml')
    return xml ? xmlText(xml, 'text:p') : ''
  }
  if (ext === 'html' || ext === 'htm') return htmlToText(decodeText(buf))
  // doc / rtf / pages：mac 上 textutil 最准；其他平台的 rtf 粗略去掉控制字
  const r = await window.orderJudgeApi.convert('doc', new Uint8Array(buf), ext)
  if (r.ok) return r.text
  return ext === 'rtf' ? rtfText(decodeText(buf)) : ''
}

// ── 汇总 ──

export interface Prepared {
  text: string
  images: { name: string; dataUrl: string }[]
  /** 进度卡片上「整理材料」那一行的明细 */
  stats: string[]
  /** 读不出内容的文件名，界面上标出来 */
  unreadable: string[]
  /** 超过上限没发出去的图片张数 */
  dropped: number
}

export async function prepareMaterials(pasted: string, files: File[]): Promise<Prepared> {
  const parts: string[] = []
  const images: { name: string; dataUrl: string }[] = []
  const unreadable: string[] = []
  let shots = 0
  let tiles = 0
  let frames = 0
  let pdfPages = 0
  let docs = 0

  for (const file of files) {
    const stem = stemOf(file.name)
    const kind = kindOf(file)
    if (kind === 'image') {
      const bmp = await decodeImage(file)
      if (!bmp) {
        unreadable.push(file.name)
        parts.push(`[图片 ${file.name}：读不出来，请截图成 PNG 后再放入]\n`)
        continue
      }
      const out = imageToJpegs(bmp, stem)
      bmp.close()
      images.push(...out)
      if (out.length > 1) tiles += out.length
      else shots++
    } else if (kind === 'video') {
      try {
        const r = await videoFramesInBrowser(file, stem)
        images.push(...r.frames)
        frames += r.frames.length
        parts.push(`[视频 ${stem}：时长约 ${Math.floor(r.seconds)} 秒，按时间顺序均匀抽了 ${r.frames.length} 帧]\n`)
      } catch {
        const r = await window.orderJudgeApi.convert('video', new Uint8Array(await file.arrayBuffer()), extOf(file.name))
        if (r.ok) {
          for (let i = 0; i < r.images.length; i++) {
            images.push(await bytesToJpeg(r.images[i], `${stem}_${String(i + 1).padStart(2, '0')}`))
          }
          frames += r.images.length
          parts.push(`[视频 ${stem}：时长约 ${Math.floor(r.seconds ?? 0)} 秒，按时间顺序均匀抽了 ${r.images.length} 帧]\n`)
        } else {
          unreadable.push(file.name)
          parts.push(`[视频 ${file.name}：读不出画面，请截几张关键画面放进来]\n`)
        }
      }
    } else if (kind === 'pdf') {
      let text = ''
      try {
        const { pdfText } = await import('./orderJudgePdf')
        const r = await pdfText(file)
        text = r.text
        pdfPages += r.pages
      } catch (e) {
        reportError('order-judge:pdf', e)
      }
      if (text) {
        docs++
        parts.push(`[${file.name}]\n${text.slice(0, MAX_DOC_CHARS)}\n`)
      } else {
        unreadable.push(file.name)
        parts.push(`[附件：${file.name}（读不出文字，可能是扫描版，请截图后再放入）]\n`)
      }
    } else if (kind === 'doc') {
      const text = (await docText(file).catch(() => '')).trim()
      if (text) {
        docs++
        parts.push(`[${file.name}]\n${text.slice(0, MAX_DOC_CHARS)}\n`)
      } else {
        unreadable.push(file.name)
        parts.push(`[附件：${file.name}（读不出文字，请另存为 docx 或截图后再放入）]\n`)
      }
    } else if (kind === 'text') {
      parts.push(`[${file.name}]\n${decodeText(await file.arrayBuffer())}\n`)
    } else {
      unreadable.push(file.name)
      parts.push(`[附件：${file.name}（无法读取内容，请截图后再放入）]\n`)
    }
  }

  const stats: string[] = []
  if (shots) stats.push(`${shots} 张截图`)
  if (tiles) stats.push(`长图切成 ${tiles} 块`)
  if (frames) stats.push(`视频取 ${frames} 帧`)
  if (pdfPages) stats.push(`PDF ${pdfPages} 页`)
  else if (docs) stats.push(`${docs} 份文档`)
  if (!stats.length) stats.push('只有文字')
  const dropped = Math.max(0, images.length - MAX_IMAGES)
  if (dropped) stats.push(`图片超过 ${MAX_IMAGES} 张，只发前 ${MAX_IMAGES} 张`)

  const text = [pasted.trim(), parts.join('').trim()].filter(Boolean).join('\n\n')
  return { text, images: images.slice(0, MAX_IMAGES), stats, unreadable, dropped }
}

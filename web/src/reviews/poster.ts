// 点评 / 推荐分享海报 —— 纯浏览器 Canvas 生成，无服务器成本、可离线。
// 竖版长图（1080 宽，高度按正文撑开），手帐 / 剪贴簿风，配色取自 sketch-tokens.css。
//
// 一张图只对应「一篇」——点评或推荐，从哪篇生成就带哪篇的类型标，不合并。
// 边界（docs/ideas/017 第 8 节）：封面走 coverUrl() 代理，失败画占位块仍出图；
// 生成 / 下载不动草稿与发布状态。

import QRCode from 'qrcode'
import { coverUrl } from '../api'
import { calculatePosterScore, type PosterScoreSignals } from '../../shared/poster-score'
import type { ReviewMode, Spoiler } from './reviewsApi'

export { calculatePosterScore }
export type { PosterScoreSignals }

export interface PosterInput {
  cover: string
  titleCn: string
  /** 原名 / 日文名，和中文名不同才传 */
  titleAlt?: string
  mode: ReviewMode
  body: string
  spoiler: Spoiler
  /** 没有 scoreSignals 时保留的显式评分；追番卡海报优先使用 scoreSignals。 */
  userScore?: number
  scoreSignals?: PosterScoreSignals
  /** BGM 综合评分 0~10 */
  bgmScore?: number
  /** 播出日期，形如 2025-01-10；用来生成「2025 年 1 月」 */
  airDate?: string
  /** 用户标签 */
  tags?: string[]
  publishedAt?: number
  /** 手记编号，右上角图章下方那行 No. */
  serial?: number | string
  /** 二维码指向（一般是作者公开手帐页 https://host/u/<name>） */
  qrUrl: string
  username: string
}

// ── 画布尺寸与配色 ──────────────────────────────────────────────────────────
const W = 1080
const M = 68
const CW = W - M * 2

const C = {
  paper: '#fbf6ec',
  paper2: '#f4eddc',
  card: '#fffdf7',
  ink: '#3e4350',
  inkSub: 'rgba(62,67,80,.72)',
  inkFaint: 'rgba(62,67,80,.45)',
  teal: '#1f7680',
  tealMid: '#2e97a0',
  tealWash: '#e2eef0',
  sakura: '#d64f7a',
  sakuraMid: '#f095b4',
  sakuraWash: '#fbe6ec',
  gold: '#b8861d',
  goldHl: '#ffe894',
  line: 'rgba(62,67,80,.32)',
  sticky: '#fceea4',
  stickyFold: '#efdd83',
}
const HAND = "'Yusei Magic', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', system-ui, sans-serif"
const CJK = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', system-ui, sans-serif"

const MODE_TAG: Record<ReviewMode, string> = { review: '点评', recommend: '推荐' }
const MODE_KICKER: Record<ReviewMode, string> = { review: 'MY REVIEW', recommend: 'RECOMMEND' }
// 顶部标签两个模式都叫「手记」；差异只体现在配色 / kicker / 类型标
const MODE_HEAD: Record<ReviewMode, string> = { review: '手记', recommend: '手记' }
// 正文小旗标
const MODE_BODY_LABEL: Record<ReviewMode, string> = { review: '个人评价 · 我的碎碎念', recommend: '个人评价' }
// 剧透只两态，且不独占版面：小字挂在正文旗标旁
function spoilerTag(s: Spoiler): string {
  return s === 'none' ? '无剧透' : '含剧透'
}

// ── 基础工具 ────────────────────────────────────────────────────────────────
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) return resolve(null)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function loadQR(text: string): Promise<HTMLImageElement | null> {
  try {
    const url = await QRCode.toDataURL(text, {
      margin: 1,
      width: 320,
      color: { dark: C.ink, light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
    return await loadImage(url)
  } catch {
    return null
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 按像素宽度折行，CJK 逐字、拉丁按词。返回每行文本。 */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (!para) {
      out.push('')
      continue
    }
    let line = ''
    const tokens = para.match(/[A-Za-z0-9]+|\s+|[^A-Za-z0-9\s]/g) ?? []
    for (const tk of tokens) {
      const next = line + tk
      if (ctx.measureText(next).width > maxWidth && line) {
        out.push(line.trimEnd())
        line = tk.trimStart()
      } else {
        line = next
      }
    }
    if (line) out.push(line.trimEnd())
  }
  return out
}

/** 两行标题：在不超宽的前提下，找一个让两行长度尽量接近的断点。 */
function balanceTwoLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const chars = Array.from(text)
  let best: [string, string] | null = null
  let bestDiff = Infinity
  for (let i = 1; i < chars.length; i++) {
    const a = chars.slice(0, i).join('').trimEnd()
    const b = chars.slice(i).join('').trimStart()
    const wa = ctx.measureText(a).width
    const wb = ctx.measureText(b).width
    if (wa > maxWidth || wb > maxWidth) continue
    const diff = Math.abs(wa - wb)
    if (diff < bestDiff) {
      bestDiff = diff
      best = [a, b]
    }
  }
  return best ? [best[0], best[1]] : wrapLines(ctx, text, maxWidth)
}

function seasonText(airDate?: string): string | null {
  if (!airDate) return null
  const m = /^(\d{4})-(\d{1,2})/.exec(airDate)
  if (!m) return null
  return `${m[1]} 年 ${Number(m[2])} 月`
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2
    ctx.moveTo(cx, cy)
    ctx.quadraticCurveTo(cx + Math.cos(a - 0.25) * r * 0.4, cy + Math.sin(a - 0.25) * r * 0.4, cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    ctx.quadraticCurveTo(cx + Math.cos(a + 0.25) * r * 0.4, cy + Math.sin(a + 0.25) * r * 0.4, cx, cy)
  }
  ctx.fill()
  ctx.restore()
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
export async function renderPoster(input: PosterInput): Promise<Blob> {
  await Promise.all([
    document.fonts.load(`400 40px 'Yusei Magic'`).catch(() => undefined),
    document.fonts.ready,
  ])
  const [cover, qr] = await Promise.all([loadImage(coverUrl(input.cover)), loadQR(input.qrUrl)])
  const resolvedScore = input.scoreSignals
    ? calculatePosterScore(input.scoreSignals)
    : input.userScore
  const posterInput = resolvedScore === undefined ? input : { ...input, userScore: resolvedScore }

  const probe = document.createElement('canvas').getContext('2d')!
  const BODY_FONT = `400 30px ${CJK}`
  const BODY_LH = 47
  const STICKY_PAD_X = 46
  const STICKY_PAD_TOP = 52
  probe.font = BODY_FONT
  const bodyLines = wrapLines(probe, input.body.trim(), CW - STICKY_PAD_X * 2)
  const stickyH = bodyLines.length * BODY_LH + STICKY_PAD_TOP + 40

  // 标题自适应：52 → 44 → 38，尽量压到 2 行
  let titleSize = 52
  let titleLines: string[] = []
  for (const sz of [52, 44, 38]) {
    titleSize = sz
    probe.font = `700 ${sz}px ${CJK}`
    titleLines = wrapLines(probe, input.titleCn, CW - 8)
    if (titleLines.length <= 2) break
  }
  // 两行时把断点往中间挪，避免「末行只剩一两个字」
  if (titleLines.length === 2) {
    probe.font = `700 ${titleSize}px ${CJK}`
    titleLines = balanceTwoLines(probe, input.titleCn, CW - 8)
  }
  const titleLH = titleSize + 14
  const hasAlt = !!(input.titleAlt && input.titleAlt !== input.titleCn)

  // —— 垂直排布 ——
  const headerTop = 84
  const headerH = 108
  const dividerY = headerTop + headerH
  const titleTop = dividerY + 44
  // 末行基线（与 drawTitle 一致）
  let y = titleTop + titleSize + (titleLines.length - 1) * titleLH + 16
  if (hasAlt) y += 34
  y += 78 // 类型标 chip + 与封面留白
  const metaTop = y

  // 右栏：卡片比封面矮时，拉开卡间距把整列铺满封面高度，别在封面旁边留大片空白
  const coverW = 336
  const coverH = 470
  const rightW = CW - coverW - 44
  const cards = rightColumnCards(probe, posterInput, rightW)
  const cardsSum = cards.reduce((a, b) => a + b, 0)
  const BASE_GAP = 16
  const naturalH = cardsSum + Math.max(0, cards.length - 1) * BASE_GAP
  const metaH = Math.max(coverH, naturalH)
  // 卡间距：不足封面高就把富余高度分摊到各卡之间（最多撑到 64），单卡则整体居中
  let rightGap = BASE_GAP
  let rightTop = metaTop
  if (cards.length > 1 && naturalH < coverH) {
    rightGap = Math.min(64, BASE_GAP + (coverH - naturalH) / (cards.length - 1))
  } else if (naturalH < coverH) {
    rightTop = metaTop + (coverH - naturalH) / 2
  }
  const metaBottom = metaTop + metaH

  const bodyLabelTop = metaBottom + 44
  const stickyTop = bodyLabelTop + 46
  const footerTop = stickyTop + stickyH + 46
  const H = footerTop + 356

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = C.paper
  ctx.fillRect(0, 0, W, H)
  drawDotGrid(ctx, H)
  // 角落星芒
  star(ctx, W - 46, metaTop + 8, 13, C.sakuraMid)
  star(ctx, 40, footerTop - 24, 10, C.tealMid)

  drawHeader(ctx, posterInput, { top: headerTop, h: headerH, dividerY })
  drawTitle(ctx, posterInput, { titleTop, titleSize, titleLH, titleLines })
  drawMetaRow(ctx, posterInput, cover, { metaTop, rightTop, rightGap, coverW, coverH, rightW, season: seasonText(posterInput.airDate) })
  drawReviewBlock(ctx, posterInput, {
    bodyLabelTop,
    stickyTop,
    stickyH,
    bodyLines,
    bodyFont: BODY_FONT,
    bodyLH: BODY_LH,
    padX: STICKY_PAD_X,
    padTop: STICKY_PAD_TOP,
  })
  drawFooter(ctx, posterInput, qr, footerTop)

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('海报没生成出来……'))), 'image/png')
  })
}

// ── 测量右栏 ────────────────────────────────────────────────────────────────
/** 右栏各卡片高度（不含卡间距），按绘制顺序 */
function rightColumnCards(ctx: CanvasRenderingContext2D, input: PosterInput, w: number): number[] {
  const cards: number[] = []
  const hasScore =
    (typeof input.userScore === 'number' && input.userScore > 0) ||
    (typeof input.bgmScore === 'number' && input.bgmScore > 0)
  if (hasScore) cards.push(150)
  if (seasonText(input.airDate)) cards.push(96)
  const tags = (input.tags ?? []).filter(Boolean).slice(0, 6)
  if (tags.length) {
    ctx.font = `400 20px ${CJK}`
    cards.push(56 + chipRows(ctx, tags, w - 40).length * 42)
  }
  return cards
}

// ── 各段绘制 ────────────────────────────────────────────────────────────────
function drawDotGrid(ctx: CanvasRenderingContext2D, h: number): void {
  ctx.fillStyle = 'rgba(62,67,80,.05)'
  for (let y = 40; y < h; y += 40) {
    for (let x = 40; x < W; x += 40) {
      ctx.beginPath()
      ctx.arc(x, y, 1.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function drawTape(ctx: CanvasRenderingContext2D, w: number, cx: number, cy: number, color: string, deg: number): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((deg * Math.PI) / 180)
  ctx.globalAlpha = 0.7
  ctx.fillStyle = color
  ctx.fillRect(-w / 2, -22, w, 44)
  ctx.globalAlpha = 0.28
  ctx.fillStyle = '#fff'
  ctx.fillRect(-w / 2, -22, w, 10)
  ctx.restore()
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  input: PosterInput,
  o: { top: number; h: number; dividerY: number },
): void {
  const accent = input.mode === 'recommend' ? C.sakura : C.teal
  const wash = input.mode === 'recommend' ? C.sakuraWash : C.tealWash
  // 色带
  roundRect(ctx, M, o.top, CW, o.h, 12)
  ctx.fillStyle = wash
  ctx.fill()
  // 左竖条
  ctx.fillStyle = accent
  roundRect(ctx, M, o.top, 10, o.h, 5)
  ctx.fill()

  ctx.textAlign = 'left'
  ctx.fillStyle = accent
  ctx.font = `400 22px ${HAND}`
  ctx.fillText(spaced(MODE_KICKER[input.mode]), M + 34, o.top + 40)
  ctx.fillStyle = C.ink
  ctx.font = `700 36px ${CJK}`
  ctx.fillText(MODE_HEAD[input.mode], M + 34, o.top + 84)

  // 右上图章（双环）
  const cx = W - M - 66
  const cy = o.top + o.h / 2
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((-9 * Math.PI) / 180)
  ctx.strokeStyle = accent
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(0, 0, 54, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(0, 0, 46, 0, Math.PI * 2)
  ctx.stroke()
  // 上弧「追番」，下方一颗星
  ctx.fillStyle = accent
  ctx.font = `700 34px ${CJK}`
  ctx.textAlign = 'center'
  ctx.fillText('追番', 0, 4)
  star(ctx, 0, 30, 6, accent)
  ctx.restore()
  if (input.serial != null) {
    ctx.fillStyle = C.inkFaint
    ctx.font = `400 17px ${HAND}`
    ctx.textAlign = 'center'
    ctx.fillText(`No. ${input.serial}`, cx, cy + 78)
  }

  drawTape(ctx, 128, M + 26, o.top - 2, C.tealMid, -6)
  ctx.textAlign = 'left'
}

function drawTitle(
  ctx: CanvasRenderingContext2D,
  input: PosterInput,
  o: { titleTop: number; titleSize: number; titleLH: number; titleLines: string[] },
): void {
  ctx.textAlign = 'left'
  ctx.font = `700 ${o.titleSize}px ${CJK}`
  // 每行都扫一道荧光笔
  ctx.fillStyle = C.goldHl
  ctx.globalAlpha = 0.5
  {
    let hy = o.titleTop + o.titleSize
    for (const ln of o.titleLines) {
      const w = Math.min(ctx.measureText(ln).width + 14, CW)
      ctx.fillRect(M - 4, hy - o.titleSize * 0.68, w, o.titleSize * 0.72)
      hy += o.titleLH
    }
  }
  ctx.globalAlpha = 1

  ctx.fillStyle = C.ink
  {
    let ly = o.titleTop + o.titleSize
    for (const ln of o.titleLines) {
      ctx.font = `700 ${o.titleSize}px ${CJK}`
      ctx.fillText(ln, M, ly)
      ly += o.titleLH
    }
  }
  // 与 renderPoster 完全一致的落点
  let y = o.titleTop + o.titleSize + (o.titleLines.length - 1) * o.titleLH + 16
  if (input.titleAlt && input.titleAlt !== input.titleCn) {
    ctx.fillStyle = C.inkSub
    ctx.font = `400 23px ${HAND}`
    ctx.fillText(clip(ctx, input.titleAlt, CW), M, y + 24)
    y += 34
  }
  // 类型标 chip
  const label = MODE_TAG[input.mode]
  ctx.font = `700 26px ${CJK}`
  const cw = ctx.measureText(label).width + 46
  ctx.save()
  ctx.translate(M + cw / 2, y + 32)
  ctx.rotate((-1.5 * Math.PI) / 180)
  ctx.fillStyle = input.mode === 'recommend' ? C.sakura : C.teal
  roundRect(ctx, -cw / 2, -25, cw, 48, 11)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.fillText(label, 0, 9)
  ctx.restore()
  ctx.textAlign = 'left'
}

function drawMetaRow(
  ctx: CanvasRenderingContext2D,
  input: PosterInput,
  cover: HTMLImageElement | null,
  o: {
    metaTop: number
    rightTop: number
    rightGap: number
    coverW: number
    coverH: number
    rightW: number
    season: string | null
  },
): void {
  drawCoverSticker(ctx, cover, M, o.metaTop, o.coverW, o.coverH, input.mode)

  const rx = M + o.coverW + 44
  const rw = o.rightW
  const gap = o.rightGap
  let y = o.rightTop

  const hasUser = typeof input.userScore === 'number' && input.userScore > 0
  const hasBgm = typeof input.bgmScore === 'number' && input.bgmScore > 0
  if (hasUser || hasBgm) {
    const h = 150
    ctx.save()
    ctx.translate(rx + rw / 2, y + h / 2)
    ctx.rotate((1 * Math.PI) / 180)
    ctx.fillStyle = C.teal
    roundRect(ctx, -rw / 2, -h / 2, rw, h, 12)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,.8)'
    ctx.font = `400 16px ${HAND}`
    ctx.textAlign = 'left'
    ctx.fillText(spaced(hasUser ? 'MY SCORE / 我的评分' : 'BGM SCORE / 综合评分'), -rw / 2 + 22, -h / 2 + 34)
    ctx.fillStyle = '#fff'
    ctx.font = `400 62px ${HAND}`
    const big = (hasUser ? input.userScore! : input.bgmScore!).toFixed(1).replace(/\.0$/, '')
    ctx.fillText(big, -rw / 2 + 22, -h / 2 + 104)
    const bw = ctx.measureText(big).width
    ctx.fillStyle = 'rgba(255,255,255,.65)'
    ctx.font = `400 22px ${HAND}`
    ctx.fillText(' / 10', -rw / 2 + 26 + bw, -h / 2 + 104)
    if (hasUser && hasBgm) {
      ctx.fillStyle = 'rgba(255,255,255,.78)'
      ctx.font = `400 18px ${CJK}`
      ctx.fillText(`BGM 综合 ${input.bgmScore!.toFixed(1)}`, -rw / 2 + 22, -h / 2 + 134)
    }
    ctx.restore()
    y += h + gap
  }

  if (o.season) {
    const h = 96
    miniCard(ctx, rx, y, rw, h, C.card)
    ctx.textAlign = 'left'
    ctx.fillStyle = C.inkSub
    ctx.font = `400 16px ${HAND}`
    ctx.fillText(spaced('SEASON / 放送'), rx + 22, y + 34)
    ctx.fillStyle = C.ink
    ctx.font = `400 30px ${HAND}`
    ctx.fillText(o.season, rx + 22, y + 72)
    y += h + gap
  }

  const tags = (input.tags ?? []).filter(Boolean).slice(0, 6)
  if (tags.length) {
    ctx.font = `400 20px ${CJK}`
    const rows = chipRows(ctx, tags, rw - 44)
    const h = 56 + rows.length * 42
    miniCard(ctx, rx, y, rw, h, C.sakuraWash)
    ctx.fillStyle = C.sakura
    ctx.font = `400 16px ${HAND}`
    ctx.textAlign = 'left'
    ctx.fillText(spaced('TAGS / 标签'), rx + 22, y + 34)
    let cy = y + 54
    for (const row of rows) {
      let cx = rx + 22
      for (const t of row) {
        ctx.font = `400 20px ${CJK}`
        const w = ctx.measureText(t).width + 26
        ctx.fillStyle = '#fff'
        roundRect(ctx, cx, cy, w, 34, 9)
        ctx.fill()
        ctx.strokeStyle = C.sakuraMid
        ctx.lineWidth = 1.5
        roundRect(ctx, cx, cy, w, 34, 9)
        ctx.stroke()
        ctx.fillStyle = C.sakura
        ctx.fillText(t, cx + 13, cy + 23)
        cx += w + 10
      }
      cy += 42
    }
  }
}

function drawCoverSticker(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number,
  mode: ReviewMode,
): void {
  const accent = mode === 'recommend' ? C.sakuraMid : C.tealMid
  // 彩色衬底（错位贴纸）
  ctx.save()
  ctx.translate(x + w / 2 + 10, y + h / 2 + 12)
  ctx.rotate((3 * Math.PI) / 180)
  ctx.fillStyle = accent
  roundRect(ctx, -w / 2, -h / 2, w, h, 10)
  ctx.fill()
  ctx.restore()
  // 白贴纸
  ctx.save()
  ctx.translate(x + w / 2, y + h / 2)
  ctx.rotate((-2.2 * Math.PI) / 180)
  ctx.shadowColor = 'rgba(62,67,80,.22)'
  ctx.shadowBlur = 22
  ctx.shadowOffsetY = 10
  ctx.fillStyle = '#fff'
  roundRect(ctx, -w / 2, -h / 2, w, h, 8)
  ctx.fill()
  ctx.shadowColor = 'transparent'
  const pad = 12
  const iw = w - pad * 2
  const ih = h - pad * 2
  ctx.save()
  roundRect(ctx, -w / 2 + pad, -h / 2 + pad, iw, ih, 4)
  ctx.clip()
  if (img) {
    const ratio = Math.max(iw / img.width, ih / img.height)
    const dw = img.width * ratio
    const dh = img.height * ratio
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
  } else {
    ctx.fillStyle = C.paper2
    ctx.fillRect(-w / 2 + pad, -h / 2 + pad, iw, ih)
    ctx.fillStyle = C.inkFaint
    ctx.font = `400 58px ${HAND}`
    ctx.textAlign = 'center'
    ctx.fillText('☆', 0, -6)
    ctx.font = `400 18px ${CJK}`
    ctx.fillText('封面没加载出来', 0, 34)
  }
  ctx.restore()
  ctx.restore()
  drawTape(ctx, 120, x + 34, y + 10, C.tealMid, 44)
}

function drawReviewBlock(
  ctx: CanvasRenderingContext2D,
  input: PosterInput,
  o: {
    bodyLabelTop: number
    stickyTop: number
    stickyH: number
    bodyLines: string[]
    bodyFont: string
    bodyLH: number
    padX: number
    padTop: number
  },
): void {
  // 小旗标：个人评价 [· 我的碎碎念]
  ctx.textAlign = 'left'
  const accent = input.mode === 'recommend' ? C.sakura : C.teal
  ctx.font = `700 25px ${CJK}`
  const label = MODE_BODY_LABEL[input.mode]
  const lw = ctx.measureText(label).width + 40
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.moveTo(M, o.bodyLabelTop)
  ctx.lineTo(M + lw, o.bodyLabelTop)
  ctx.lineTo(M + lw - 14, o.bodyLabelTop + 21)
  ctx.lineTo(M + lw, o.bodyLabelTop + 42)
  ctx.lineTo(M, o.bodyLabelTop + 42)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.fillText(label, M + 18, o.bodyLabelTop + 29)
  // 剧透标记：小字挂在旗标右边，不独占版面
  const sp = spoilerTag(input.spoiler)
  ctx.font = `400 19px ${CJK}`
  ctx.fillStyle = input.spoiler === 'none' ? C.inkFaint : C.sakura
  ctx.fillText(input.spoiler === 'none' ? sp : `⚠ ${sp}`, M + lw + 16, o.bodyLabelTop + 28)

  // 便签
  ctx.save()
  ctx.translate(M + CW / 2, o.stickyTop + o.stickyH / 2)
  ctx.rotate((0.5 * Math.PI) / 180)
  ctx.shadowColor = 'rgba(62,67,80,.16)'
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 8
  ctx.fillStyle = C.sticky
  roundRect(ctx, -CW / 2, -o.stickyH / 2, CW, o.stickyH, 6)
  ctx.fill()
  ctx.shadowColor = 'transparent'
  const fold = 36
  ctx.fillStyle = C.stickyFold
  ctx.beginPath()
  ctx.moveTo(CW / 2 - fold, -o.stickyH / 2)
  ctx.lineTo(CW / 2, -o.stickyH / 2 + fold)
  ctx.lineTo(CW / 2, -o.stickyH / 2)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = C.ink
  ctx.font = o.bodyFont
  ctx.textAlign = 'left'
  let y = -o.stickyH / 2 + o.padTop
  for (const ln of o.bodyLines) {
    ctx.fillText(ln, -CW / 2 + o.padX, y)
    y += o.bodyLH
  }
  ctx.restore()
}

function drawFooter(
  ctx: CanvasRenderingContext2D,
  input: PosterInput,
  qr: HTMLImageElement | null,
  top: number,
): void {
  ctx.strokeStyle = C.line
  ctx.lineWidth = 2
  ctx.setLineDash([7, 7])
  ctx.beginPath()
  ctx.moveTo(M, top)
  ctx.lineTo(W - M, top)
  ctx.stroke()
  ctx.setLineDash([])

  const qrSize = 196
  const qx = W - M - qrSize
  if (qr) {
    ctx.fillStyle = '#fff'
    roundRect(ctx, qx - 12, top + 28, qrSize + 24, qrSize + 24, 12)
    ctx.fill()
    ctx.strokeStyle = C.line
    ctx.lineWidth = 1.5
    roundRect(ctx, qx - 12, top + 28, qrSize + 24, qrSize + 24, 12)
    ctx.stroke()
    ctx.drawImage(qr, qx, top + 40, qrSize, qrSize)
    ctx.fillStyle = C.inkFaint
    ctx.font = `400 18px ${CJK}`
    ctx.textAlign = 'center'
    ctx.fillText(`扫码看 ${clipPlain(input.username, 10)} 的追番手帐`, qx + qrSize / 2, top + 40 + qrSize + 30)
  }

  ctx.textAlign = 'left'
  ctx.fillStyle = C.sakura
  ctx.font = `400 22px ${HAND}`
  ctx.fillText(spaced('KEEP YOUR FAVORITES.'), M, top + 58)
  ctx.fillStyle = C.ink
  ctx.font = `700 30px ${CJK}`
  ctx.fillText('喜欢的番，一部都别落下。', M, top + 104)
  ctx.fillStyle = C.inkFaint
  ctx.font = `400 18px ${HAND}`
  let host = ''
  try {
    host = new URL(input.qrUrl).host
  } catch {
    host = ''
  }
  ctx.fillText(`MapleTools  ✦  ${host}`, M, top + 142)
  if (input.publishedAt) {
    ctx.font = `400 17px ${HAND}`
    ctx.fillText(fmtDate(input.publishedAt), M, top + 172)
  }

  ctx.strokeStyle = C.sakuraMid
  ctx.lineWidth = 3
  ctx.beginPath()
  const wy = top + 320
  for (let x = M; x < W - M; x += 22) {
    ctx.moveTo(x, wy)
    ctx.quadraticCurveTo(x + 5.5, wy - 7, x + 11, wy)
    ctx.quadraticCurveTo(x + 16.5, wy + 7, x + 22, wy)
  }
  ctx.stroke()
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
function miniCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string): void {
  ctx.fillStyle = fill
  ctx.strokeStyle = C.line
  ctx.lineWidth = 1.5
  roundRect(ctx, x, y, w, h, 10)
  ctx.fill()
  ctx.stroke()
}

function chipRows(ctx: CanvasRenderingContext2D, tags: string[], maxWidth: number): string[][] {
  const rows: string[][] = [[]]
  let w = 0
  for (const t of tags) {
    const cw = ctx.measureText(t).width + 36
    if (w + cw > maxWidth && rows[rows.length - 1].length) {
      rows.push([])
      w = 0
    }
    rows[rows.length - 1].push(t)
    w += cw
  }
  return rows
}

function spaced(s: string): string {
  return s.split('').join(' ')
}
function clip(ctx: CanvasRenderingContext2D, s: string, maxWidth: number): string {
  if (ctx.measureText(s).width <= maxWidth) return s
  let out = s
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1)
  return out + '…'
}
function clipPlain(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}  记`
}

/** 触发下载（sandbox 外的正常页面可用；移动端可能需要长按图片保存）。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

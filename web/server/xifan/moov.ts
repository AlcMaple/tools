// 只读 mp4 的 moov（索引），拿到整集时长和每个关键帧的时间——不下载一帧画面。
//
// 分区预转要从任意位置起转，起点必须落在**源关键帧**上：hd 档是 -c copy，只能从关键帧开始；
// sd 档虽然重编，但要和 hd 同一起点，两档的 playlist 才能按同一条时间线拼。
// 关键帧位置在 moov/trak/mdia/minf/stbl 的 stss（同步样本）+ stts（时长）+ ctts（pts 偏移）里，
// 再按 elst（编辑列表）平移，就是 ffmpeg 眼里各帧的 pts。moov 通常只有几百 KB~1MB，
// 在文件头或尾，两次 Range 请求就够（尾部小请求 stream.ts 直连透传，不建并发会话）。
//
// ffmpeg 的 `-ss X` 是相对 format.start_time（所有轨道最早 pts）的：seek 到绝对时刻 X + start_time，
// 输出时间戳再减掉这个绝对时刻归零。所以这里连 start_time 一起算出来，调用方按
// `-ss (K - start_time)` 就能精确落到关键帧 K。

export interface MoovInfo {
  /** format.start_time（秒），所有轨道最早的 pts */
  startTime: number
  /** 整集时长（秒） */
  duration: number
  /** 视频关键帧（秒，绝对，已按 elst 平移），按 dts 升序。ffmpeg 的 -ss 按 dts 找「≤ 目标」的关键帧，
   *  而它在时间线上的位置是 pts，两个都要。 */
  keyframes: { pts: number; dts: number }[]
}

interface Box { type: string; start: number; size: number; header: number }

function readBoxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = []
  let off = from
  while (off + 8 <= to) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    let header = 8
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); header = 16 }
    else if (size === 0) size = to - off
    if (size < header) break
    out.push({ type, start: off, size, header })
    off += size
  }
  return out
}

function child(buf: Buffer, parent: Box, type: string): Box | undefined {
  return readBoxes(buf, parent.start + parent.header, parent.start + parent.size).find((b) => b.type === type)
}

function parseTrack(buf: Buffer, trak: Box, movieTimescale: number): { kind: string; timescale: number; startTime: number; keyframes: { pts: number; dts: number }[] } | null {
  const mdia = child(buf, trak, 'mdia')
  if (!mdia) return null
  const mdhd = child(buf, mdia, 'mdhd'), hdlr = child(buf, mdia, 'hdlr'), minf = child(buf, mdia, 'minf')
  if (!mdhd || !hdlr || !minf) return null
  const mdhdVer = buf[mdhd.start + mdhd.header]!
  const timescale = buf.readUInt32BE(mdhd.start + mdhd.header + (mdhdVer === 1 ? 20 : 12))
  const kind = buf.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12)
  const stbl = child(buf, minf, 'stbl')
  if (!stbl) return null
  const stts = child(buf, stbl, 'stts'), ctts = child(buf, stbl, 'ctts'), stss = child(buf, stbl, 'stss')
  if (!stts) return null

  // 各样本 dts（stts 是游程编码）
  const dts: number[] = []
  {
    const n = buf.readUInt32BE(stts.start + stts.header + 4)
    let p = stts.start + stts.header + 8, t = 0
    for (let i = 0; i < n; i++) {
      const count = buf.readUInt32BE(p), delta = buf.readUInt32BE(p + 4)
      for (let k = 0; k < count; k++) { dts.push(t); t += delta }
      p += 8
    }
  }
  // pts = dts + ctts 偏移（version 1 是有符号）
  const pts = dts.slice()
  if (ctts) {
    const ver = buf[ctts.start + ctts.header]!
    const n = buf.readUInt32BE(ctts.start + ctts.header + 4)
    let p = ctts.start + ctts.header + 8, i = 0
    for (let e = 0; e < n && i < pts.length; e++) {
      const count = buf.readUInt32BE(p)
      const offset = ver === 1 ? buf.readInt32BE(p + 4) : buf.readUInt32BE(p + 4)
      for (let k = 0; k < count && i < pts.length; k++, i++) pts[i]! += offset
      p += 8
    }
  }
  // elst：空编辑（media_time = -1）推迟整轨；否则从 media_time 起播，等于所有 pts 减去它。
  let shift = 0
  const edts = child(buf, trak, 'edts')
  const elst = edts ? child(buf, edts, 'elst') : undefined
  if (elst) {
    const ver = buf[elst.start + elst.header]!
    const n = buf.readUInt32BE(elst.start + elst.header + 4)
    let p = elst.start + elst.header + 8
    let empty = 0, mediaTime = 0, seen = false
    for (let i = 0; i < n; i++) {
      const segDur = ver === 1 ? Number(buf.readBigUInt64BE(p)) : buf.readUInt32BE(p)
      const mt = ver === 1 ? Number(buf.readBigInt64BE(p + 8)) : buf.readInt32BE(p + 4)
      p += ver === 1 ? 20 : 12
      if (mt === -1) { empty += segDur; continue }
      if (!seen) { mediaTime = mt; seen = true }
    }
    shift = Math.round(empty * timescale / movieTimescale) - mediaTime
  }
  let keys: number[]
  if (stss) {
    const n = buf.readUInt32BE(stss.start + stss.header + 4)
    keys = []
    for (let i = 0; i < n; i++) {
      const sample = buf.readUInt32BE(stss.start + stss.header + 8 + i * 4) - 1
      if (sample >= 0 && sample < pts.length) keys.push(sample)
    }
  } else keys = pts.map((_v, i) => i) // 没有 stss = 全是关键帧
  let minPts = Number.POSITIVE_INFINITY
  for (const v of pts) if (v < minPts) minPts = v
  // 音频的 elst 常用来表示编码器预热样本（media_time > 0，pts 从 0 起）：ffmpeg 靠 skip_samples 处理，
  // 对外 start_time 仍是 0，这里同样不让它落成负数。
  return {
    kind, timescale,
    startTime: Math.max(0, (minPts + shift) / timescale),
    keyframes: keys
      .map((i) => ({ pts: Math.max(0, (pts[i]! + shift) / timescale), dts: Math.max(0, (dts[i]! + shift) / timescale) }))
      .sort((a, b) => a.dts - b.dts),
  }
}

export function parseMoov(buf: Buffer, moov: Box): MoovInfo | null {
  const mvhd = child(buf, moov, 'mvhd')
  if (!mvhd) return null
  const ver = buf[mvhd.start + mvhd.header]!
  const base = mvhd.start + mvhd.header + (ver === 1 ? 20 : 12)
  const movieTimescale = buf.readUInt32BE(base)
  const duration = (ver === 1 ? Number(buf.readBigUInt64BE(base + 4)) : buf.readUInt32BE(base + 4)) / movieTimescale
  let startTime = Number.POSITIVE_INFINITY
  let keyframes: MoovInfo['keyframes'] | null = null
  for (const trak of readBoxes(buf, moov.start + moov.header, moov.start + moov.size).filter((b) => b.type === 'trak')) {
    const t = parseTrack(buf, trak, movieTimescale)
    if (!t) continue
    if (t.startTime < startTime) startTime = t.startTime
    if (t.kind === 'vide' && !keyframes) keyframes = t.keyframes
  }
  if (!keyframes || !keyframes.length || !Number.isFinite(startTime)) return null
  return { startTime, duration, keyframes }
}

async function fetchRange(url: string, range: string): Promise<{ buf: Buffer; total: number }> {
  const res = await fetch(url, { headers: { Range: `bytes=${range}` } })
  if (res.status !== 206 && res.status !== 200) throw new Error(`读 moov 失败：HTTP ${res.status}`)
  const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? res.headers.get('content-length') ?? 0)
  return { buf: Buffer.from(await res.arrayBuffer()), total }
}

/** 从可 Range 的 mp4 地址读出 moov 并解析。文件头 64KB 先看一眼：moov 在头就按它的大小补齐，在尾就去尾部拿。 */
export async function probeMoov(url: string): Promise<MoovInfo> {
  const HEAD = 64 * 1024
  const head = await fetchRange(url, `0-${HEAD - 1}`)
  const top = readBoxes(head.buf, 0, head.buf.length)
  let moovStart = -1, moovSize = 0, cursor = 0
  for (const b of top) {
    if (b.type === 'moov') { moovStart = b.start; moovSize = b.size; break }
    cursor = b.start + b.size
  }
  if (moovStart < 0) {
    // 头 64KB 里没见到 moov：顺着已知盒子的尽头继续找（mdat 之后通常就是 moov）
    if (!cursor || !head.total) throw new Error('找不到 moov')
    const tail = await fetchRange(url, `${cursor}-`)
    const boxes = readBoxes(tail.buf, 0, tail.buf.length)
    const moov = boxes.find((b) => b.type === 'moov')
    if (!moov) throw new Error('文件尾没有 moov')
    const info = parseMoov(tail.buf, moov)
    if (!info) throw new Error('moov 解析失败')
    return info
  }
  let buf = head.buf, at = moovStart
  if (moovStart + moovSize > buf.length) { buf = (await fetchRange(url, `${moovStart}-${moovStart + moovSize - 1}`)).buf; at = 0 }
  const moov = readBoxes(buf, at, buf.length).find((b) => b.type === 'moov')
  if (!moov || moov.start + moov.size > buf.length) throw new Error('moov 不完整')
  const info = parseMoov(buf, moov)
  if (!info) throw new Error('moov 解析失败')
  return info
}

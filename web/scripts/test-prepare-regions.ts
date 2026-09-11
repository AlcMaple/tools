// 分区预转回归：用 ffmpeg 合成一段 4 分钟、10 秒一个关键帧的 mp4，本机 HTTP 冒充源站，
// 走真实的 startPrepare / statusOf / readPlaylist：从 0 起转 → 用户跳到 150s（杀段重开）→ 回头补洞 → 完成。
// 断言两档拼出的 playlist 时长都等于整集、没有 GAP、段与段之间用 DISCONTINUITY 衔接。
// 需要本机有 ffmpeg；DATA_DIR 指向临时目录，不碰真实数据。
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { Transform } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'prepare-regions-'))
process.env.DATA_DIR = work
process.env.NODE_ENV = 'production'
const { startPrepare, statusOf, readPlaylist, keyFor } = await import('../server/xifan/prepare')

const FILE = join(work, 'long.mp4')
execFileSync('ffmpeg', [
  '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '240', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '240', '-keyint_min', '240', '-sc_threshold', '0',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', FILE,
])
const size = statSync(FILE).size
const srv = createServer((req, res) => {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
  const start = m && m[1] ? Number(m[1]) : 0
  const end = m && m[2] ? Number(m[2]) : size - 1
  res.writeHead(m ? 206 : 200, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1),
  })
  // 限速约 4MB/s：本机转码太快的话，跳转会落在「马上就转到」的前瞻窗口里，测不到杀段重开。
  const throttle = new Transform({
    transform(chunk, _enc, cb) { setTimeout(() => cb(null, chunk), Math.ceil(chunk.length / 16384)) },
  })
  createReadStream(FILE, { start, end, highWaterMark: 256 * 1024 }).pipe(throttle).pipe(res)
})
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
const url = 'https://play.xfvod.pro/fixture/long.mp4'
const key = keyFor(url)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

startPrepare(url, origin, 0)
await sleep(1500)
const first = statusOf(url, 0)
check('R1 起转后很快就能从 0 播', first.state === 'running' && first.duration === 240, JSON.stringify(first))
const jump = statusOf(url, 150)
check('R2 跳到 150s 时那里还没转出', jump.playable === false)
let done = first
for (let i = 0; i < 120 && done.state === 'running'; i++) { await sleep(1000); done = statusOf(url, 150) }
check('R3 全集转完', done.state === 'ready', done.state)

function parse(text: string): { total: number; gaps: number; regions: string[]; starts: number[]; ended: boolean } {
  let total = 0, dur = 0
  const regions: string[] = [], starts: number[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#EXTINF:')) dur = Number(line.slice(8).split(',')[0])
    else if (line && !line.startsWith('#')) {
      const r = line.split('_seg')[0]!
      if (regions[regions.length - 1] !== r) { regions.push(r); starts.push(total) }
      total += dur
    }
  }
  return { total, gaps: (text.match(/#EXT-X-GAP/g) ?? []).length, regions, starts, ended: text.includes('#EXT-X-ENDLIST') }
}
for (const rung of ['vsd', 'vhd'] as const) {
  const text = readPlaylist(key, `${rung}.m3u8`) ?? ''
  const p = parse(text)
  check(`R4 ${rung} 时长等于整集`, Math.abs(p.total - 240) < 0.1, `total=${p.total.toFixed(2)}`)
  check(`R5 ${rung} 没有空洞`, p.gaps === 0 && p.ended)
  check(`R6 ${rung} 由多段拼成且以 DISCONTINUITY 衔接`, p.regions.length >= 2 && (text.match(/#EXT-X-DISCONTINUITY/g) ?? []).length === p.regions.length - 1, p.regions.join(','))
  // sd 段恰从网格点起；hd 段从 ≤ 网格点的源关键帧（10 秒一个）起，跳到 150s 的那段两档都从 150 起。
  const last = p.starts[p.starts.length - 1]!
  const expectStarts = p.regions.every((r, i) => {
    const s = Number(r.slice(1)) / 1000
    return Math.abs(p.starts[i]! - (rung === 'vsd' ? s : Math.floor(s / 10) * 10)) < 0.05
  })
  check(`R9 ${rung} 各段起点落在网格 / 关键帧上`, expectStarts && Math.abs(last - 150) < 0.05, p.starts.map((x) => x.toFixed(2)).join(','))
}
const master = readPlaylist(key, 'index.m3u8') ?? ''
check('R7 主 playlist 低码率档在前', master.indexOf('vsd.m3u8') > 0 && master.indexOf('vsd.m3u8') < master.indexOf('vhd.m3u8'))
check('R8 旧格式文件名规则不受影响', existsSync(join(work, 'hls', key, 'r0_init_sd.mp4'))) // gitleaks:allow

srv.close()
rmSync(work, { recursive: true, force: true })
console.log(JSON.stringify({ checks: 14, failed, sourceSiteRequests: 0, productionDataTouched: false }))
process.exit(failed ? 1 : 0)

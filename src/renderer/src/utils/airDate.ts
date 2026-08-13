// 放送日期 → 「未播出」判定,控制在线观看按钮的显隐。
//
//   undefined        字段引入前的老数据,按条目来源分流(见下方)
//   ''               确认未定档 → 未播出
//   可解析的日期      晚于今天 → 未播出
//   解析不了的非空串  宽容当已播出,不因格式问题误伤按钮
export function weekdayFromAirDate(airDate: string | undefined): number {
  const match = airDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return 0
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return day === 0 ? 7 : day
}

export function isUnaired(airDate: string | undefined, now: Date = new Date()): boolean {
  if (airDate === undefined) return false
  const s = airDate.trim()
  if (s === '') return true
  // 兼容标准的 2026-07-05 和手填的 2026年7月5日 / 2026/7 / 2026.7;只有年月时按当月 1 号算
  // (宁可早显示,不可迟)。
  const m = /(\d{4})\s*[-/年.]\s*(\d{1,2})(?:\s*[-/月.]\s*(\d{1,2}))?/.exec(s)
  if (!m) return false
  const d = new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1)
  return d.getTime() > now.getTime()
}

// 老数据(undefined)按条目来源分流:
//   - BGM 条目 → 宽容当已播出。老追番几乎都播过了,不能因为没回填过日期就集体丢掉播放按钮。
//   - 手动条目(负数 id)→ 当未定档。手动加的恰恰多是 BGM 还没收录的未播出作品,缺日期就该藏;
//     想显示的话去编辑弹窗填个已过去的日期即可。
export function trackUnaired(airDate: string | undefined, bgmId: number, now: Date = new Date()): boolean {
  if (airDate === undefined) return bgmId < 0
  return isUnaired(airDate, now)
}

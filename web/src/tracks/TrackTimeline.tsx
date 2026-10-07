import { useMemo } from 'react'
import type { Track } from '../api'

// ── 追番手帐·年表 ──────────────────────────────────────────────────────────────
// 按「贴进手帐的时间」归到 年份 → 季度（冬 1 月 / 春 4 月 / 夏 7 月 / 秋 10 月番）。
// 观望不算追番，不记进来。没看完的贴纸是虚线 + 粉色，看完的是实线 + 小对勾，
// 不只靠颜色区分。

export const SEASON_MONTHS = [1, 4, 7, 10] as const
const SEASON_KANJI = ['冬', '春', '夏', '秋'] as const
const SEASON_TAPE = ['lav', 'sakura', 'teal', 'gold'] as const

/** 老记录 / 本地旧缓存可能没有 createdAt，退回 updatedAt */
export const addedAtOf = (t: Pick<Track, 'createdAt' | 'updatedAt'>): number => t.createdAt || t.updatedAt

export const seasonOf = (ts: number): { year: number; q: number } => {
  const d = new Date(ts)
  return { year: d.getFullYear(), q: Math.floor(d.getMonth() / 3) }
}

/** 挪季度时落在该季度首月 1 号中午，避开时区边界 */
export const seasonStamp = (year: number, q: number): number => new Date(year, SEASON_MONTHS[q] - 1, 1, 12).getTime()

interface Season { q: number; items: Track[]; done: number }
interface Year { year: number; total: number; seasons: Season[] }

function group(tracks: Track[]): Year[] {
  const years = new Map<number, Map<number, Track[]>>()
  for (const t of tracks) {
    if (t.status === 'considering') continue
    const { year, q } = seasonOf(addedAtOf(t))
    const seasons = years.get(year) ?? new Map<number, Track[]>()
    seasons.set(q, [...(seasons.get(q) ?? []), t])
    years.set(year, seasons)
  }
  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, seasons]) => {
      const list = [...seasons.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([q, items]) => {
          const sorted = items.sort((a, b) => addedAtOf(a) - addedAtOf(b))
          return { q, items: sorted, done: sorted.filter((t) => t.status === 'done').length }
        })
      return { year, total: list.reduce((n, s) => n + s.items.length, 0), seasons: list }
    })
}

export function TrackTimeline({ tracks, onOpen }: { tracks: Track[]; onOpen: (bgmId: number) => void }): JSX.Element {
  const years = useMemo(() => group(tracks), [tracks])

  if (!years.length) {
    return (
      <div className="tl-empty">
        <img src="/assets/pop/empty.webp" alt="" />
        <p>……什么都没有。哥哥是不是点错筛选了？观望的番不算追番，我才不记。</p>
      </div>
    )
  }

  return (
    <div className="trk-timeline">
      <div className="tl-say">
        <img className="tl-say-face" src="/assets/sagiri-nudge.webp" alt="" />
        <p className="bubble">粉色虚线的，是还没看完的。哥哥可别装作没看见。</p>
      </div>

      {years.map((y) => (
        <section key={y.year} className="tl-year">
          <h2 className="tl-year-title">
            <span className="tl-year-num">{y.year}</span>
            <span className="tl-year-note">这一年追了 {y.total} 部</span>
          </h2>

          {y.seasons.map((s, i) => (
            <div key={s.q} className={`tl-season${i % 2 ? ' flip' : ''}`}>
              <span className={`tape tl ${SEASON_TAPE[s.q]}`} aria-hidden="true" />
              <div className="tl-season-head">
                <span className={`stamp st-${s.q === 1 ? 'sakura' : s.q === 2 ? 'teal' : s.q === 3 ? 'gold' : 'lav'}`} aria-hidden="true">
                  {SEASON_KANJI[s.q]}
                </span>
                <div>
                  <b>{SEASON_MONTHS[s.q]}月番</b>
                  <span>{s.items.length} 部，看完 {s.done}</span>
                </div>
              </div>
              <div className="tl-names">
                {s.items.map((t) => (
                  <button
                    key={t.bgmId}
                    type="button"
                    className={`tl-name${t.status === 'done' ? ' is-done' : ''}`}
                    onClick={() => onOpen(t.bgmId)}
                    title="点一下，挪到别的季度"
                  >
                    {t.titleCn || t.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

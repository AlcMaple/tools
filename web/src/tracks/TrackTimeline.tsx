import { useEffect, useMemo, useRef, useState } from 'react'
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
  const [selection, setSelection] = useState<number | null>(null)
  const year = years.find(item => item.year === selection) ?? years[0]
  const [quarter, setQuarter] = useState<number | null | undefined>(undefined)
  const q = quarter === undefined ? year?.seasons[0]?.q ?? 0 : quarter
  const [overview, setOverview] = useState(false)
  const yearsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = yearsRef.current
    if (!list) return
    const reveal = (): void => {
      const selected = list.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      if (!selected) return
      const item = selected.getBoundingClientRect()
      const viewport = list.getBoundingClientRect()
      list.scrollLeft += Math.min(0, item.left - viewport.left) + Math.max(0, item.right - viewport.right)
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    return () => observer.disconnect()
  }, [year?.year, overview])

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
      <div className="tl-picker">
        <div className="tl-years" ref={yearsRef} role="group" aria-label="选择年份">
          <button
            type="button"
            className={`tl-year-tab${overview ? ' on' : ''}`}
            aria-pressed={overview}
            onClick={() => { setOverview(true); setQuarter(q) }}
          >
            全览
          </button>
          {years.map(item => (
            <button
              key={item.year}
              type="button"
              className={`tl-year-tab${!overview && item.year === year.year ? ' on' : ''}`}
              aria-pressed={!overview && item.year === year.year}
              onClick={() => { setOverview(false); setSelection(item.year); setQuarter(q) }}
            >
              {item.year}
            </button>
          ))}
        </div>
        <div className="tl-quarters" role="group" aria-label="选择季度">
          <button
            type="button"
            className={`tl-quarter-tab${q === null ? ' on' : ''}`}
            aria-pressed={q === null}
            onClick={() => setQuarter(null)}
          >
            全部
          </button>
          {SEASON_MONTHS.map((month, index) => (
            <button
              key={month}
              type="button"
              className={`tl-quarter-tab${index === q ? ' on' : ''}`}
              aria-pressed={index === q}
              onClick={() => setQuarter(index)}
            >
              {month}月番
            </button>
          ))}
        </div>
      </div>

      {(overview ? years.filter(item => q === null || item.seasons.some(season => season.q === q)) : [year]).map(visibleYear => (
      <section key={visibleYear.year} className="tl-year" aria-label={`${visibleYear.year}年`}>
        <h2 className="tl-year-title">
          <span className="tl-year-num">{visibleYear.year}</span>
          <span className="tl-year-note">这一年追了 {visibleYear.total} 部</span>
        </h2>
        {(q === null ? visibleYear.seasons : [visibleYear.seasons.find(season => season.q === q) ?? { q, items: [], done: 0 }]).map(visibleSeason => (
        <div key={visibleSeason.q} className="tl-season">
          <span className={`tape tl ${SEASON_TAPE[visibleSeason.q]}`} aria-hidden="true" />
          <div className="tl-season-head">
            <span className={`stamp st-${visibleSeason.q === 1 ? 'sakura' : visibleSeason.q === 2 ? 'teal' : visibleSeason.q === 3 ? 'gold' : 'lav'}`} aria-hidden="true">
              {SEASON_KANJI[visibleSeason.q]}
            </span>
            <div>
              <b>{SEASON_MONTHS[visibleSeason.q]}月番</b>
              <span>{visibleSeason.items.length} 部，看完 {visibleSeason.done}</span>
            </div>
          </div>
          <div className="tl-names">
            {visibleSeason.items.map(track => (
              <button
                key={track.bgmId}
                type="button"
                className={`tl-name${track.status === 'done' ? ' is-done' : ''}`}
                onClick={() => onOpen(track.bgmId)}
                title="编辑追番"
              >
                {track.titleCn || track.title}
              </button>
            ))}
            {!visibleSeason.items.length && <p className="tl-season-empty">这一季没有匹配的追番</p>}
          </div>
        </div>
        ))}
      </section>
      ))}
      {overview && q !== null && !years.some(item => item.seasons.some(season => season.q === q)) && (
        <p className="tl-season-empty">这一季度没有匹配的追番</p>
      )}
    </div>
  )
}

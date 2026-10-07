import { useEffect, useMemo, useState } from 'react'
import { fetchSeason, fetchSeasons, type SeasonResult, type SeasonSummary } from './api'
import { DayFilm, FilmRow } from './CalendarPage'
import { navigate } from './router'
import { Ic, Spinner } from './SketchIcon'
import { useTrackToggle } from './useTrackToggle'

// 往期周历：一季一份（服务端 calendar-history.ts）。接入之后的季度是 BGM 周历快照，
// 更早的季度是点开时才去 BGM 按首播日翻出来补的，补一次就永久存下。
const SEASONS = [
  { q: 0, kanji: '冬', month: 1 },
  { q: 1, kanji: '春', month: 4 },
  { q: 2, kanji: '夏', month: 7 },
  { q: 3, kanji: '秋', month: 10 },
] as const

const stamp = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function CalendarHistoryPage(): JSX.Element {
  const [seasons, setSeasons] = useState<SeasonSummary[] | null>(null)
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [year, setYear] = useState<number | null>(null)
  const [season, setSeason] = useState<SeasonResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const track = useTrackToggle()

  useEffect(() => {
    let live = true
    fetchSeasons()
      .then((list) => {
        if (!live) return
        setSeasons(list)
        const first = list.find((s) => s.count !== null) ?? list[0]
        setPickedKey((prev) => prev ?? first?.key ?? null)
        setYear((prev) => prev ?? first?.year ?? null)
      })
      .catch((e: Error) => live && setError(e.message))
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (!pickedKey) return
    let live = true
    setSeason(null)
    setError(null)
    fetchSeason(pickedKey)
      .then((r) => live && setSeason(r))
      .catch((e: Error) => live && setError(e.message))
    return () => { live = false }
  }, [pickedKey])

  const years = useMemo(() => [...new Set((seasons ?? []).map((s) => s.year))].sort((a, b) => b - a), [seasons])
  const ofYear = useMemo(() => new Map((seasons ?? []).filter((s) => s.year === year).map((s) => [s.q, s])), [seasons, year])

  // 换年份时留在同一个季度：从 2026 秋点 2025，就是 2025 秋。那一年没有这个季度才退到那一年最新的一季。
  const pickYear = (y: number): void => {
    setYear(y)
    const inYear = (seasons ?? []).filter((s) => s.year === y)
    const same = inYear.find((s) => s.q === pickedSeason?.q)
    const next = same ?? inYear[0]
    if (next) setPickedKey(next.key)
  }

  const picked = seasons?.find((s) => s.key === pickedKey)
  const pickedSeason = picked
  const days = season?.data.filter((d) => d.items.length > 0) ?? []

  return (
    <>
      <header className="hist-head">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('calendar')}>
          <Ic name="back" cls="ic ic-sm" />
          回到本周
        </button>
        <h1 className="title-sketch" style={{ fontSize: 34 }}>往期周历</h1>
        <p className="muted small">一季一季，我都替哥哥收好了。</p>
      </header>

      {seasons && seasons.length === 0 && (
        <div className="tl-empty">
          <img src="/assets/pop/empty.webp" alt="" />
          <p>……还一页都没有。哥哥晚点再来看吧。</p>
        </div>
      )}

      {years.length > 0 && (
        <div className="hist-picker">
          <div className="hist-years" role="group" aria-label="选择年份">
            {years.map((y) => (
              <button key={y} type="button" className={`hist-year-btn${y === year ? ' on' : ''}`} aria-pressed={y === year} onClick={() => pickYear(y)}>
                {y}
              </button>
            ))}
          </div>
          <div className="hist-seasons">
            {SEASONS.map((s) => {
              const item = ofYear.get(s.q)
              return (
                <button
                  key={s.q}
                  type="button"
                  className={`hist-chip${item && item.key === pickedKey ? ' on' : ''}`}
                  disabled={!item}
                  onClick={() => item && setPickedKey(item.key)}
                >
                  <b>{s.kanji}</b>
                  <span>{s.month}月番</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {error && <p className="form-note err mt8" aria-live="polite">⚠ {error}</p>}
      {track.error && <p className="form-note err mt8" aria-live="polite">⚠ {track.error}</p>}

      {picked && season && (
        <p className="hist-note font-hand">
          {picked.year} 年 {SEASONS[picked.q].month} 月番，共 {season.data.reduce((n, d) => n + d.items.length, 0)} 部
          {season.current
            ? '，这一季还在跟着周历更新'
            : season.derived
              ? '。这一季是我照首播日翻出来补的，星期偶尔会差一天，从上一季接着播的番也没算进来'
              : `，${stamp(season.updatedAt)} 以后就没再变过`}
        </p>
      )}

      {pickedKey && !season && !error && (
        <div className="page-state">
          <Spinner size={36} />
          <p className="faint small">
            {picked?.count === null ? '这一季我还没翻过，正在去找，要等几秒…' : '正在翻出那一季的手帐…'}
          </p>
        </div>
      )}

      {days.map((day) => (
        <section key={day.id} className="day-sec">
          <div className="day-head">
            <span className="ribbon">{day.label}</span>
            <span className="font-hand muted">{day.items.length} 部</span>
            <hr className="hr-dash" />
            <span className="sparkle">✦</span>
          </div>
          <FilmRow label={`${day.label}在播番剧`} itemCount={day.items.length} vertical>
            <DayFilm day={day} canTrack={track.canTrack} tracked={track.tracked} onToggle={track.toggle} />
          </FilmRow>
        </section>
      ))}
    </>
  )
}

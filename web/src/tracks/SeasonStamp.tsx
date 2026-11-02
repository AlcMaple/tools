import { airSeasonOf } from './season'

// 播出季印章：大字季名 + 竖排小字年份；缺日期盖一枚虚线空印「未定」，保证每张卡都有这一格
export function SeasonStamp({ airDate, className }: { airDate: string; className: string }): JSX.Element {
  const s = airSeasonOf(airDate)
  if (!s) return <span className={`season-stamp is-unknown ${className}`} title="播出日期未定">未定</span>
  return (
    <span className={`season-stamp ${s.season ? `is-${s.season}` : 'is-unknown'} ${className}`} title={s.title}>
      <span className="season-year">{s.year}</span>
      {s.season && <span className="season-name">{s.label}</span>}
    </span>
  )
}

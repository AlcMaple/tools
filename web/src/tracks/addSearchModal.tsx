import { useEffect, useState } from 'react'
import { searchAnime, type AnimeHit } from '../api'
import { Ic, Spinner } from '../SketchIcon'

// ── 加番搜索弹窗 ───────────────────────────────────────────────────────────────
// 搜索顺序由服务端统一控制：离线索引 → 已加番共享补充 → BGM 在线兜底。防抖 300ms；
// 点「贴进手帐」即时加、弹窗不关（可连着加多部）；已在追的显示已存在、不可重复加。
// 索引超过这个天数没更新就提示。一周一档 + 3 天容错：正常同步永远碰不到，挂了才会露头
const STALE_AFTER_DAYS = 10

const ADD_COPY = {
  subtitle: '哼，挑一部想看的，贴进纱雾的手帐里吧。默认先放在「想看」哦。',
  searchPlaceholder: '想找哪部番？番名、日文原名或罗马音都可以……',
  loading: '纱雾正在翻目录……',
  idle: '把番名写进来，让纱雾帮你翻翻……',
  noIndex: '番剧目录还没整理好……晚点再来，别催。',
  stale: (days: number) => `索引已经 ${days} 天没更新……纱雾先照现有的找，新番可能还没翻到。`,
  noResults: (query: string) => `没有找到「${query}」……换个名字再试试？`,
  online: '本地没翻到，纱雾再去 Bangumi 找找看……',
  tracked: '已在追番',
  add: '加入',
} as const

export function AddSearchModal({
  trackedIds,
  onAdd,
  onClose,
}: {
  trackedIds: Set<number>
  onAdd: (hit: AnimeHit) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AnimeHit[]>([])
  const [ready, setReady] = useState(true)
  const [loading, setLoading] = useState(false)
  // 离线索引和共享补充都没命中时，后端才退回一次 BGM 在线搜。在线结果要标来源，
  // 失败也要**如实**说原因（限流 / 超时 / 冷却），别让用户以为是自己名字打错了。
  const [source, setSource] = useState<'local' | 'learned' | 'online' | undefined>()
  const [onlineError, setOnlineError] = useState('')
  const [builtAt, setBuiltAt] = useState(0) // 索引生成时间，用来提示「同步是不是挂了」

  // 开弹窗就先问一次索引状态（q 为空 = 只回统计、不搜也不联网）。
  // 不等用户输入才知道 —— 「索引没生成」和「同步挂了」都该进门就看见。
  useEffect(() => {
    searchAnime('')
      .then((r) => {
        setReady(r.ready)
        setBuiltAt(r.builtAt ?? 0)
      })
      .catch(() => {
        /* 状态查不到就不提示，别让它盖住正常搜索 */
      })
  }, [])
  const [added, setAdded] = useState<Set<number>>(new Set()) // 本次弹窗点过的，即时变「已追」

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 防抖搜索 —— 停手 300ms 再打接口，别每个键都发；旧请求用 cancelled 作废，避免乱序覆盖
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      searchAnime(q)
        .then((r) => {
          if (cancelled) return
          setReady(r.ready)
          setResults(r.data)
          setSource(r.source)
          setOnlineError(r.onlineError ?? '')
          if (r.builtAt) setBuiltAt(r.builtAt)
        })
        .catch(() => {
          if (cancelled) return
          setResults([])
          setOnlineError('')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const add = (hit: AnimeHit): void => {
    setAdded((prev) => new Set(prev).add(hit.bgmId))
    onAdd(hit)
  }

  const q = query.trim()
  const staleDays = builtAt ? Math.floor((Date.now() - builtAt) / 86400000) : 0

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="加番" className="dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">加番</h3>
        <p className="dlg-sub">{ADD_COPY.subtitle}</p>

        <div className="searchbar mb16" style={{ maxWidth: 'none' }}>
          <Ic name="search" cls="ic" />
          <input
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索要贴进手帐的番剧"
            placeholder={ADD_COPY.searchPlaceholder}
          />
        </div>

        {/* 索引太旧 = 服务器上每周的同步任务多半挂了。不提示的话，用户只会觉得「新番搜不到」，
            跟正常的一周滞后长得一模一样，永远发现不了。10 天 = 一周档期 + 3 天容错。 */}
        {ready && staleDays >= STALE_AFTER_DAYS && (
          <p className="form-note err mb16">
            {ADD_COPY.stale(staleDays)}
          </p>
        )}

        {/* 定高结果区：弹窗尺寸不随「空搜索 / 搜到 8 条 / 没搜到」跳动 —— 输入时容器
            忽大忽小，视线要跟着窗口重新找位置 */}
        <div className="add-pane">
          {!ready ? (
            <p className="faint small">
              {ADD_COPY.noIndex}
            </p>
          ) : loading ? (
            <div className="page-state">
              <Spinner size={26} />
              <p className="faint small">{ADD_COPY.loading}</p>
            </div>
          ) : !q ? (
            <p className="faint small">
              {ADD_COPY.idle}
            </p>
          ) : results.length === 0 ? (
            <p className="faint small">
              {ADD_COPY.noResults(q)}
              {/* 本地没有 + 在线补充也没成 → 说清是哪一种，用户才知道该等还是该改词 */}
              {onlineError && (
                <>
                  <br />
                  <span style={{ color: 'var(--ink-sub)' }}>{onlineError}</span>
                </>
              )}
            </p>
          ) : (
            /* 定高列表（原型稿 #addList）：容器不随结果条数变高变矮，多出来的走竖向滚动 */
            <div id="addList">
              {source === 'online' && (
                <p className="faint small">{ADD_COPY.online}</p>
              )}
              {results.map((h) => {
                const tracked = trackedIds.has(h.bgmId) || added.has(h.bgmId)
                const year = h.date && h.date.length >= 4 ? h.date.slice(0, 4) : ''
                // 主标题要一眼可读：中文译名优先；副信息（原名 / 年份 / 评分）弱化成第二行
                const mainTitle = h.nameCn || h.name
                const sub = [h.nameCn && h.name !== h.nameCn ? h.name : '', year ? `${year}年` : '', h.score > 0 ? `★ ${h.score.toFixed(1)}` : '']
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <div key={h.bgmId} className="sugg-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mainTitle}>
                        {mainTitle}
                      </div>
                      {sub && (
                        <div className="faint small" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sub}>
                          {sub}
                        </div>
                      )}
                    </div>
                    {tracked ? (
                      <span className="tagx mine" style={{ flex: 'none' }}>
                        {ADD_COPY.tracked}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        style={{ flex: 'none' }}
                        onClick={() => add(h)}
                      >
                        <Ic name="plus" cls="ic ic-sm" />
                        {ADD_COPY.add}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useState, useRef, useEffect } from 'react'
import TopBar from '../components/TopBar'
import type { BgmSearchResult, BgmDetail } from '../types/bgm'

// ── 状态机类型 ────────────────────────────────────────────────
type PageState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'results'; items: BgmSearchResult[] }
  | { status: 'loading' }
  | { status: 'detail'; data: BgmDetail }
  | { status: 'error'; message: string }

// ── 工具函数 ──────────────────────────────────────────────────
function extractSubjectId(link: string): number | null {
  const m = link.match(/\/subject\/(\d+)/)
  return m ? parseInt(m[1]) : null
}

// ── 子组件 ────────────────────────────────────────────────────
function LoadingSpinner(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-32 gap-4">
      <span
        className="material-symbols-outlined text-primary/60 text-4xl animate-spin"
        style={{ animationDuration: '1.2s' }}
      >
        progress_activity
      </span>
      <p className="font-label text-xs text-on-surface-variant/40 tracking-widest uppercase">
        Accessing Archive...
      </p>
    </div>
  )
}

function IdleState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-40 gap-6 opacity-40">
      <span className="material-symbols-outlined text-on-surface-variant text-6xl">
        manage_search
      </span>
      <div className="text-center">
        <p className="font-headline text-lg font-bold text-on-surface">
          Query the Archive
        </p>
        <p className="font-label text-xs text-on-surface-variant mt-1 tracking-wide">
          Type a title in the search bar above and press Enter
        </p>
      </div>
    </div>
  )
}

function SearchResults({
  items,
  onSelect,
}: {
  items: BgmSearchResult[]
  onSelect: (item: BgmSearchResult) => void
}): JSX.Element {
  return (
    <div className="max-w-3xl mx-auto">
      <p className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40 mb-6">
        {items.length} result{items.length !== 1 ? 's' : ''} found
      </p>
      <div className="space-y-2">
        {items.map((item) => (
          <button
            key={item.link}
            onClick={() => onSelect(item)}
            className="w-full flex items-center justify-between bg-surface-container hover:bg-surface-container-high border border-outline-variant/10 hover:border-primary/20 rounded-xl px-6 py-4 text-left transition-all duration-150 group"
          >
            <div>
              <p className="font-bold text-on-surface text-sm group-hover:text-primary transition-colors">
                {item.title}
              </p>
              <p className="font-label text-[11px] text-on-surface-variant/50 mt-0.5">
                {item.date || '日期未知'}
                {item.rate && item.rate !== 'N/A' && (
                  <span className="ml-3 text-primary/70">★ {item.rate}</span>
                )}
              </p>
            </div>
            <span className="material-symbols-outlined text-on-surface-variant/20 group-hover:text-primary/50 transition-colors text-lg">
              arrow_forward
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function DetailView({
  data,
  onBack,
}: {
  data: BgmDetail
  onBack?: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const hasStaff = data.staff.length > 0
  const displayTitle = (data.title_cn || data.title).toUpperCase()
  // 末尾单词高亮
  const words = displayTitle.split(' ')
  const lastWord = words.pop()
  const restTitle = words.join(' ')

  // 角色图标映射
  const roleIcon: Record<string, string> = {
    导演: 'videocam',
    监督: 'videocam',
    音乐: 'music_note',
    系列构成: 'edit_note',
    脚本: 'edit_note',
    人物设定: 'draw',
    人物原案: 'draw',
    总作画监督: 'brush',
    色彩脚本: 'palette',
    原作: 'book',
  }
  const getIcon = (role: string): string =>
    Object.entries(roleIcon).find(([k]) => role.includes(k))?.[1] ?? 'person'

  return (
    <div className="max-w-6xl mx-auto">
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-on-surface-variant/50 hover:text-primary transition-colors font-label text-xs uppercase tracking-wider mb-8 group"
        >
          <span className="material-symbols-outlined text-base leading-none group-hover:-translate-x-0.5 transition-transform">
            arrow_back
          </span>
          Back to results
        </button>
      )}
      <div className="grid grid-cols-12 gap-12 items-start">
        {/* ── 左栏：海报 + 按钮 ── */}
        <div className="col-span-4 sticky top-28">
          <div className="relative group mb-16">
            {/* 光晕 */}
            <div className="absolute -inset-4 bg-primary/5 rounded-xl blur-3xl opacity-0 group-hover:opacity-100 transition-opacity" />

            {/* 封面 */}
            {data.cover ? (
              <img
                src={data.cover}
                alt={data.title_cn || data.title}
                className="relative rounded-lg shadow-2xl w-full aspect-[2/3] object-cover"
              />
            ) : (
              <div className="relative rounded-lg w-full aspect-[2/3] bg-surface-container-high flex items-center justify-center">
                <span className="material-symbols-outlined text-on-surface-variant/20 text-6xl">
                  image
                </span>
              </div>
            )}

            {/* 评分浮层 */}
            <div className="absolute -bottom-6 -right-6 bg-surface-variant/70 backdrop-blur-2xl p-6 rounded-xl border border-outline-variant/15 shadow-2xl">
              <p className="font-label text-[10px] uppercase tracking-widest text-primary mb-1">
                Bangumi Rating
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-4xl font-black text-on-surface tracking-tighter">
                  {data.score > 0 ? data.score.toFixed(1) : '--'}
                </span>
                <span className="text-on-surface-variant font-label text-sm">
                  / 10
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <button className="w-full py-4 rounded-full bg-gradient-to-r from-primary to-primary-container text-on-primary font-bold text-sm tracking-tight flex items-center justify-center gap-2 active:scale-95 transition-transform">
              <span className="material-symbols-outlined text-lg leading-none">
                download
              </span>
              Add to Archive
            </button>
            <button
              className="w-full py-4 rounded-full bg-secondary-container/30 hover:bg-secondary-container/50 border border-secondary/20 transition-colors font-label text-sm text-on-secondary-container"
              onClick={() => window.open(data.link, '_blank')}
            >
              Official Site
            </button>
          </div>
        </div>

        {/* ── 右栏：信息 ── */}
        <div className="col-span-8">
          {/* 状态徽章 */}
          <div className="flex items-center gap-3 mb-4">
            <span className="px-3 py-1 bg-secondary-container text-on-secondary-container font-label text-[10px] tracking-widest uppercase rounded-sm">
              {data.platform || 'TV Series'}
            </span>
            <span className="text-on-surface-variant font-label text-xs">
              {data.episodes > 0 ? `${data.episodes} Episodes` : ''}
              {data.tags.length > 0 && data.episodes > 0 ? ' · ' : ''}
              {data.tags.slice(0, 2).join(' · ')}
            </span>
          </div>

          {/* 标题 */}
          <h2 className="text-7xl font-black text-on-surface tracking-tighter leading-[0.9] mb-6">
            {restTitle && <>{restTitle}<br /></>}
            <span className="text-primary">{lastWord}</span>
          </h2>

          {/* Stats 行 */}
          <div className="flex gap-8 mb-12">
            <div>
              <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                Air Date
              </p>
              <p className="font-body font-bold text-on-surface">
                {data.date || '—'}
              </p>
            </div>
            {data.studio && (
              <div>
                <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                  Studio
                </p>
                <p className="font-body font-bold text-on-surface">
                  {data.studio}
                </p>
              </div>
            )}
            {data.tags.length > 0 && (
              <div>
                <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">
                  Genre
                </p>
                <p className="font-body font-bold text-on-surface">
                  {data.tags.slice(0, 3).join(' · ')}
                </p>
              </div>
            )}
          </div>

          {/* 简介 */}
          <div className="bg-surface-container rounded-xl p-10 mb-12">
            <h3 className="font-label text-xs text-primary uppercase tracking-[0.2em] mb-4">
              The Narrative
            </h3>
            <p className="text-on-surface-variant leading-relaxed text-xl font-light">
              {data.summary || 'No summary available for this entry.'}
            </p>
          </div>

          {/* Staff 区块 / 无 staff 占位 */}
          {hasStaff ? (
            <div>
              <h3 className="text-[10px] font-label text-on-surface-variant/40 tracking-widest uppercase mb-4">
                Staff
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {data.staff.map((s) => (
                  <div
                    key={s.role}
                    className="flex items-center space-x-3 bg-surface-container p-4 rounded-xl border border-outline-variant/20"
                  >
                    <div className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center flex-shrink-0">
                      <span className="material-symbols-outlined text-on-surface-variant/30 text-base leading-none">
                        {getIcon(s.role)}
                      </span>
                    </div>
                    <div>
                      <p className="text-[9px] font-label text-on-surface-variant/40 uppercase tracking-widest">
                        {s.role}
                      </p>
                      <p className="text-sm font-bold text-on-surface">
                        {s.name_cn || s.name}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="pt-8 border-t border-outline-variant/10">
              <div className="flex items-center gap-4 text-on-surface-variant/40">
                <span className="font-label text-[10px] uppercase tracking-[0.2em] whitespace-nowrap">
                  Metadata Record
                </span>
                <span className="h-px w-8 bg-outline-variant/20" />
                <p className="font-body text-xs italic">
                  Staff metadata is not included in this record.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 底部 Metadata Strip ── */}
      <div className="mt-20 pt-8 border-t border-outline-variant/10 flex justify-between items-center">
        <div className="flex gap-12">
          <div className="flex flex-col">
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
              Database ID
            </span>
            <span className="font-label text-sm font-bold">
              BGM-{data.id}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
              File Density
            </span>
            <span className="font-label text-sm font-bold">
              {data.episodes > 0 ? `${data.episodes} eps` : '—'}
              {data.platform ? ` · ${data.platform}` : ''}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
              Metadata Sync
            </span>
            <span className="font-label text-sm font-bold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-secondary" />
              100% Secure
            </span>
          </div>
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(data.link)
            setCopied(true)
            setTimeout(() => setCopied(false), 3000)
          }}
          className="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors font-label text-xs uppercase tracking-wider"
        >
          <span className="material-symbols-outlined text-lg leading-none">share</span>
          Export Record
        </button>
      </div>

      {/* ── 复制成功弹窗 ── */}
      {copied && (
        <div className="fixed inset-x-0 top-16 bottom-0 z-[200] flex items-center justify-center pointer-events-none">
          <div className="w-[340px] border border-outline-variant/30 rounded-2xl p-8 flex flex-col items-center gap-6 shadow-[0_0_50px_rgba(240,145,153,0.15)] bg-surface-container-high pointer-events-auto">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-4xl leading-none">
                check_circle
              </span>
            </div>
            <div className="text-center">
              <h4 className="font-label text-primary uppercase tracking-[0.2em] text-xs mb-2">
                Success
              </h4>
              <p className="font-body text-lg text-on-surface font-semibold leading-snug">
                Share link copied to clipboard
              </p>
            </div>
            <button
              onClick={() => setCopied(false)}
              className="mt-2 px-8 py-2.5 rounded-full bg-primary text-on-primary font-label text-xs font-black uppercase tracking-widest hover:brightness-110 transition-all active:scale-95 shadow-lg shadow-primary/20"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 模块级缓存：页面切换后恢复状态 ───────────────────────────
let _cachedState: PageState = { status: 'idle' }
let _cachedResults: BgmSearchResult[] = []

// ── 主页面 ────────────────────────────────────────────────────
function AnimeInfo(): JSX.Element {
  const [state, setState] = useState<PageState>(_cachedState)
  const lastResults = useRef<BgmSearchResult[]>(_cachedResults)

  useEffect(() => {
    _cachedState = state
  }, [state])

  const handleSearch = async (keyword: string): Promise<void> => {
    setState({ status: 'searching' })
    try {
      const results = await window.bgmApi.search(keyword)
      results.sort((a, b) => {
        const da = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '0000-00-00'
        const db = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '0000-00-00'
        return db.localeCompare(da)
      })
      if (results.length === 0) {
        setState({ status: 'error', message: `未找到与"${keyword}"相关的结果` })
      } else if (results.length === 1) {
        lastResults.current = []
        _cachedResults = []
        await loadDetail(results[0])
      } else {
        lastResults.current = results
        _cachedResults = results
        setState({ status: 'results', items: results })
      }
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  const loadDetail = async (item: BgmSearchResult): Promise<void> => {
    const sid = extractSubjectId(item.link)
    if (!sid) {
      setState({ status: 'error', message: 'Could not parse subject ID from link.' })
      return
    }
    setState({ status: 'loading' })
    try {
      const detail = await window.bgmApi.detail(sid)
      setState({ status: 'detail', data: detail })
    } catch (err) {
      setState({ status: 'error', message: String(err) })
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <TopBar placeholder="Lookup titles from bgm.tv..." onSearch={handleSearch} />

      <main className="ml-0 pt-16 px-10 py-10">
        {state.status === 'idle' && <IdleState />}
        {(state.status === 'searching' || state.status === 'loading') && <LoadingSpinner />}
        {state.status === 'results' && (
          <SearchResults items={state.items} onSelect={loadDetail} />
        )}
        {state.status === 'detail' && (
          <DetailView
            data={state.data}
            onBack={
              lastResults.current.length > 0
                ? () => setState({ status: 'results', items: lastResults.current })
                : undefined
            }
          />
        )}
        {state.status === 'error' && (
          <div className="flex flex-col items-center justify-center py-32 gap-4 opacity-60">
            <span className="material-symbols-outlined text-error text-4xl">
              error_outline
            </span>
            <p className="font-label text-xs text-on-surface-variant tracking-wide">
              {state.message}
            </p>
            <button
              onClick={() => setState({ status: 'idle' })}
              className="mt-2 font-label text-[11px] text-primary/70 hover:text-primary underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

export default AnimeInfo

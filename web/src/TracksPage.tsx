// 我的追番 —— 卡片墙 + 「今天更新」置顶分组。设计稿：scratchpad/tracks-mockup.html（已定稿）。
//
// 跟 app 的 MyAnime 对齐的几条语义（都是 app 踩过坑定下来的，别改）：
//   - `totalEpisodes == null` = **连载中**，不是 0。徽章本身就是「点这里填总集数」的入口
//   - 进度推到满 **不**自动切「看完」——用户填 12 不一定是看到 12，可能是「还剩 12 没看」的备忘
//   - 「想看」首次 +1 才自动转「在追」（这个方向没歧义）
//   - 标签在卡片上**只读**，增删在弹窗里；BGM 标签不可编辑，自定义标签点一下删
//
// 页头**不置顶**，只有顶栏置顶。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Track, TrackPatch, TrackStatus, XifanBinding, XifanCandidate } from './api'
import {
  bindXifan,
  coverUrl,
  deleteTrack,
  fetchTracks,
  fetchXifanBindings,
  locateXifan,
  playPageUrl,
  putTrack,
} from './api'
import { useAuth } from './auth'
import { Icon, Spinner } from './Icon'

const SHORT_DAY: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
const STATUS_META: { key: TrackStatus; label: string }[] = [
  { key: 'watching', label: '在追' },
  { key: 'plan', label: '想看' },
  { key: 'done', label: '看完' },
]
type FilterKey = 'all' | TrackStatus

function todayBgmId(): number {
  const d = new Date().getDay()
  return d === 0 ? 7 : d
}

const allTagsOf = (t: Track): string[] => [...t.bgmTags, ...t.userTags]

// 「继续看」默认落在**下一集**（= 已看 +1）—— 「继续」就是接着往下看，周更用户打开时新集刚好是这一集。
// 夹到总集数上限；已看 0 也从第 1 集起。真开到没更新的集，播放页会提示「按◀退一集」，不至于卡死。
function nextEp(t: Track): number {
  const n = t.totalEpisodes != null ? Math.min(t.totalEpisodes, t.episode + 1) : t.episode + 1
  return Math.max(1, n)
}

// 定位用的标题集合 —— 中文名 / 别名最可能对上稀饭（简体中文站），日文原名兜底。
const titlesOf = (t: Track): string[] => [t.titleCn, ...t.aliases, t.title].filter(Boolean)

interface PickerState {
  track: Track
  candidates: XifanCandidate[]
}

/** 标题 / 别名命中（app 还搜备注，网页版没有备注字段） */
function matches(t: Track, q: string): boolean {
  if (!q) return true
  const hay = [t.title, t.titleCn, ...t.aliases].join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}

export function TracksPage(): JSX.Element {
  const { user, ready } = useAuth()
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  // 稀饭绑定：bgmId → {xifanId,xifanName}。加载时一次拿齐，绑过的「继续看」直接是链接。
  const [bindings, setBindings] = useState<Record<number, XifanBinding>>({})
  const [locating, setLocating] = useState<number | null>(null) // 正在定位的 bgmId（转圈用）
  const [picker, setPicker] = useState<PickerState | null>(null)
  const today = useMemo(todayBgmId, [])

  useEffect(() => {
    if (!ready) return
    if (!user) {
      setTracks([])
      setBindings({})
      return
    }
    fetchTracks()
      .then(setTracks)
      .catch((e: Error) => setError(e.message))
    // 绑定失败不影响追番展示 —— 静默，「继续看」退化成「点了现去定位」
    fetchXifanBindings().then(setBindings).catch(() => undefined)
  }, [ready, user])

  // 未绑定的「继续看」：去周表定位 → 命中候选就弹选择框让用户确认（= 建绑定），零候选也弹（说明没找到）。
  const continueWatch = (t: Track): void => {
    if (locating != null) return
    setLocating(t.bgmId)
    locateXifan(t.bgmId, titlesOf(t))
      .then((r) => {
        if (r.bound) {
          // 极少见：加载后别的用户刚绑上 → 记下来（卡片下次即变链接），并尽力开一下
          setBindings((prev) => ({ ...prev, [t.bgmId]: { xifanId: r.bound!.xifanId, xifanName: r.bound!.xifanName } }))
          window.open(playPageUrl(r.bound.xifanId, nextEp(t)), '_blank', 'noopener')
        } else {
          setPicker({ track: t, candidates: r.candidates })
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLocating(null))
  }

  // 用户在选择框点了某个候选 = 确认绑定：落库 + 本地记下（卡片即变链接）。开播由候选行自身的链接完成。
  const confirmBind = (bgmId: number, cand: XifanCandidate): void => {
    setBindings((prev) => ({ ...prev, [bgmId]: { xifanId: cand.xifanId, xifanName: cand.xifanName } }))
    setPicker(null)
    void bindXifan(bgmId, cand.xifanId, cand.xifanName).catch((e: Error) => setError(e.message))
  }

  // 本地先改、后端后写 —— +1 要跟手，不能等一个来回。失败就把这条重新拉回来纠正。
  const patch = (bgmId: number, p: TrackPatch): void => {
    setTracks((prev) =>
      prev ? prev.map((t) => (t.bgmId === bgmId ? applyLocal(t, p) : t)) : prev
    )
    void putTrack(bgmId, p)
      .then((fresh) => setTracks((prev) => (prev ? prev.map((t) => (t.bgmId === bgmId ? fresh : t)) : prev)))
      .catch((e: Error) => setError(e.message))
  }

  const remove = (bgmId: number): void => {
    setTracks((prev) => (prev ? prev.filter((t) => t.bgmId !== bgmId) : prev))
    setEditing(null)
    setConfirming(null)
    void deleteTrack(bgmId).catch((e: Error) => setError(e.message))
  }

  const counts = useMemo(() => {
    const c = { all: 0, watching: 0, plan: 0, done: 0 }
    for (const t of tracks ?? []) {
      c.all++
      c[t.status]++
    }
    return c
  }, [tracks])

  const filtered = useMemo(() => {
    let list = tracks ?? []
    if (filter !== 'all') list = list.filter((t) => t.status === filter)
    const q = query.trim()
    if (q) list = list.filter((t) => matches(t, q))
    if (tags.size) list = list.filter((t) => allTagsOf(t).some((x) => tags.has(x)))
    return list
  }, [tracks, filter, query, tags])

  const allTags = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tracks ?? []) for (const x of allTagsOf(t)) m.set(x, (m.get(x) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [tracks])

  const todayList = filtered.filter((t) => t.airWeekday === today && t.status === 'watching')
  const rest = filtered.filter((t) => !todayList.includes(t))
  const editingTrack = tracks?.find((t) => t.bgmId === editing) ?? null
  const confirmingTrack = tracks?.find((t) => t.bgmId === confirming) ?? null

  return (
    <>
      {/* 页头不置顶 —— 只有顶栏置顶。标题和搜索同一行：标题右边本来空着一大片。 */}
      <div className="border-b border-outline-variant/10 px-4 pb-2.5 pt-3 md:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-black tracking-tighter text-on-surface md:text-3xl">我的追番</h1>
            <p className="mt-1 hidden font-label text-sm text-on-surface-variant/80 md:block">
              {user
                ? `在追 ${counts.watching} 部${todayList.length ? `，今天有 ${todayList.length} 部更新。` : '。'}`
                : '登录后才能追番。'}
            </p>
          </div>

          <div className="flex flex-1 items-center justify-end gap-2 md:flex-none">
            <div className="relative min-w-0 flex-1 md:flex-none">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant/50">
                <Icon name="search" size={15} />
              </span>
              <input
                spellCheck={false}
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题、别名…"
                className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-high py-1.5 pl-8 pr-7 text-[13px] text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70 md:w-[196px]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-on-surface-variant/60 transition-colors hover:text-primary"
                >
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>

            <TagFilter all={allTags} selected={tags} onChange={setTags} />
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1">
          {([['all', '全部'], ...STATUS_META.map((m) => [m.key, m.label])] as [FilterKey, string][]).map(
            ([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                // 两态只变颜色 —— 不动 border / 字重 / padding，否则相邻 chip 会被挤（AI_GUIDELINES）
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-semibold transition-colors ${
                  filter === k ? 'bg-primary/15 text-primary' : 'text-on-surface-variant/70 hover:text-on-surface'
                }`}
              >
                {label}
                <span className="font-label text-[10px] tabular-nums opacity-60">{counts[k]}</span>
              </button>
            )
          )}
        </div>
      </div>

      {error && (
        <div className="px-4 pt-3 md:px-6">
          <p className="font-label text-xs text-error">⚠ {error}</p>
        </div>
      )}

      {!ready || tracks === null ? (
        <div className="flex justify-center py-32">
          <Spinner size={38} className="text-primary/60" />
        </div>
      ) : !user ? (
        <Empty icon="person" text="登录后才能追番" hint="追番数据存在账号里，换设备也在" />
      ) : counts.all === 0 ? (
        <Empty icon="bookmark" text="还没追任何番" hint="去「番剧周历」，鼠标移到海报上点 ＋追番" />
      ) : filtered.length === 0 ? (
        <Empty icon="search" text="没有匹配的追番" hint="换个词，或清掉类型过滤" />
      ) : (
        <div className="px-4 py-3 md:px-6">
          {todayList.length > 0 && (
            <>
              <SectionLabel>今天更新</SectionLabel>
              <Grid>
                {todayList.map((t) => (
                  <Card
                    key={t.bgmId}
                    t={t}
                    isToday
                    binding={bindings[t.bgmId]}
                    locating={locating === t.bgmId}
                    onContinue={() => continueWatch(t)}
                    onPatch={patch}
                    onEdit={() => setEditing(t.bgmId)}
                    onAskRemove={() => setConfirming(t.bgmId)}
                  />
                ))}
              </Grid>
            </>
          )}
          {rest.length > 0 && (
            <>
              <SectionLabel>{todayList.length ? '其余' : '全部'}</SectionLabel>
              <Grid>
                {rest.map((t) => (
                  <Card
                    key={t.bgmId}
                    t={t}
                    isToday={false}
                    binding={bindings[t.bgmId]}
                    locating={locating === t.bgmId}
                    onContinue={() => continueWatch(t)}
                    onPatch={patch}
                    onEdit={() => setEditing(t.bgmId)}
                    onAskRemove={() => setConfirming(t.bgmId)}
                  />
                ))}
              </Grid>
            </>
          )}
        </div>
      )}

      {editingTrack && <EditModal t={editingTrack} onPatch={patch} onClose={() => setEditing(null)} />}

      {picker && (
        <BindPickerModal
          picker={picker}
          onPick={(cand) => confirmBind(picker.track.bgmId, cand)}
          onClose={() => setPicker(null)}
        />
      )}

      {confirmingTrack && (
        <ConfirmRemoveModal
          t={confirmingTrack}
          onConfirm={() => remove(confirmingTrack.bgmId)}
          onClose={() => setConfirming(null)}
        />
      )}
    </>
  )
}

/** 本地乐观更新 —— 跟服务端 patch 同样的夹取规则，免得手感和落库结果对不上 */
function applyLocal(t: Track, p: TrackPatch): Track {
  const next = { ...t, ...p } as Track
  const total = 'totalEpisodes' in p ? p.totalEpisodes ?? null : t.totalEpisodes
  if (total != null && next.episode > total) next.episode = total
  return next
}

const Grid = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">{children}</div>
)

const SectionLabel = ({ children }: { children: React.ReactNode }): JSX.Element => (
  <div className="mb-2 mt-5 flex items-center gap-2.5 first:mt-0">
    <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40">{children}</span>
    <span className="h-px flex-1 bg-outline-variant/15" />
  </div>
)

const TAG_CLS =
  'inline-flex shrink-0 items-center rounded bg-primary/10 px-1.5 py-px font-label text-[9px] font-bold tracking-wider text-primary/80'

// ── 标签行 ───────────────────────────────────────────────────────────────────────
// 按**可用宽度**决定显示几个标签，放不下的收成「+N」——而不是写死「前 3 个」。
// 写死个数的老毛病：3 个长标签（2026年7月 / CloverWorks…）照样撑破盒子，最后一个被
// overflow 裁成半个。这里量出每个标签真实宽度，累加到放不下为止。
// 定高 15px：标签多少都不改卡片高度（AI_GUIDELINES：可变内容不得改盒模型 → 卡片墙不抖）。
function TagRow({ tags }: { tags: string[] }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(tags.length)

  const key = tags.join('')
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const recompute = (): void => {
      const avail = el.clientWidth
      if (!avail) return
      const chips = Array.from(el.querySelectorAll<HTMLElement>('[data-measure] [data-chip]'))
      if (!chips.length) return
      const GAP = 4 // gap-1 = 0.25rem
      const BADGE = 26 // 「+N」徽章预留宽（含它前面那个 gap），两位数也够
      let used = 0
      let fit = 0
      for (let i = 0; i < chips.length; i++) {
        const need = (i === 0 ? 0 : GAP) + chips[i].offsetWidth
        // 不是最后一个 → 后面还得挂 +N，先给它留位
        const reserve = i < chips.length - 1 ? BADGE : 0
        if (used + need + reserve <= avail) {
          used += need
          fit = i + 1
        } else break
      }
      setCount(Math.max(1, fit)) // 至少留 1 个；单个就超宽时靠 overflow-hidden 兜住
    }
    recompute()
    // 字体晚加载会让首次测量偏小 → 字体就绪后再算一次
    void document.fonts?.ready.then(recompute).catch(() => undefined)
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [key])

  const more = tags.length - count

  return (
    <div ref={ref} className="relative flex h-[15px] items-center gap-1 overflow-hidden">
      {tags.slice(0, count).map((x) => (
        <span key={x} className={TAG_CLS}>
          {x}
        </span>
      ))}
      {more > 0 && (
        <span
          className={`${TAG_CLS} bg-on-surface/[0.08] text-on-surface-variant/50`}
          title={tags.slice(count).join('、')}
        >
          +{more}
        </span>
      )}
      {/* 测量层：全部标签，不换行、不可见、绝对定位不占流 —— 只为量真实宽度 */}
      <div
        data-measure
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex gap-1 whitespace-nowrap"
      >
        {tags.map((x) => (
          <span key={x} data-chip className={TAG_CLS}>
            {x}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── 卡片 ───────────────────────────────────────────────────────────────────────
function Card({
  t,
  isToday,
  binding,
  locating,
  onContinue,
  onPatch,
  onEdit,
  onAskRemove,
}: {
  t: Track
  isToday: boolean
  binding: XifanBinding | undefined
  locating: boolean
  onContinue: () => void
  onPatch: (bgmId: number, p: TrackPatch) => void
  onEdit: () => void
  onAskRemove: () => void
}): JSX.Element {
  const title = t.titleCn || t.title
  const capped = t.totalEpisodes != null && t.episode >= t.totalEpisodes
  const ep = nextEp(t)

  const step = (delta: number): void => {
    const ep = Math.max(0, t.totalEpisodes != null ? Math.min(t.totalEpisodes, t.episode + delta) : t.episode + delta)
    const p: TrackPatch = { episode: ep }
    // 「想看」首次推进 → 自动转「在追」。反方向（推满 → 看完）**不**自动，见文件头注释。
    if (ep > 0 && t.status === 'plan') p.status = 'watching'
    onPatch(t.bgmId, p)
  }

  return (
    <div className="group relative overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container transition-colors hover:border-primary/30">
      {/* 点封面 = 打开编辑弹窗；遮罩里的按钮各自 stopPropagation，不会连带触发 */}
      <div onClick={onEdit} title="点封面编辑" className="relative aspect-[3/4] cursor-pointer">
        {t.cover ? (
          <img src={coverUrl(t.cover)} alt={title} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-container-high text-on-surface-variant/20">
            <Icon name="image" size={30} />
          </div>
        )}
        {isToday && (
          <span className="absolute left-1.5 top-1.5 z-10 rounded bg-primary px-1.5 py-0.5 font-label text-[9px] font-bold uppercase tracking-wider text-on-primary">
            更新
          </span>
        )}
        {/* 取消追番入口 —— 右上角悬浮。删除是「针对整条记录」的操作，跟卡片对应而非编辑框内容。
            stopPropagation 免得连带触发点封面进编辑；默认透明、hover 卡片才浮现，避免误点。 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onAskRemove()
          }}
          title="取消追番"
          aria-label="取消追番"
          className="absolute right-1.5 top-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-all hover:bg-error hover:text-on-error group-hover:opacity-100"
        >
          <Icon name="delete" size={13} />
        </button>
        <div className="absolute inset-0 flex flex-col justify-end gap-1.5 bg-gradient-to-t from-black/95 via-black/75 to-black/20 p-2 opacity-0 transition-opacity group-hover:opacity-100">
          {/* 在线观看：绑过稀饭 → 直接链接（原生 <a>，无异步、不吃弹窗拦截）；没绑 → 点了去周表定位。
              集数落在下一集（nextEp）—— 「继续」就是接着往下看。 */}
          {binding ? (
            <a
              href={playPageUrl(binding.xifanId, ep)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={`稀饭：${binding.xifanName || binding.xifanId}`}
              className="flex w-full items-center justify-center gap-1 rounded-xl border border-primary/40 bg-primary/25 py-1.5 font-label text-[10px] uppercase tracking-widest text-white backdrop-blur-sm transition-colors hover:bg-primary/40"
            >
              <Icon name="play_arrow" size={12} />
              <span>继续看 EP {ep}</span>
            </a>
          ) : (
            <button
              type="button"
              disabled={locating}
              onClick={(e) => {
                e.stopPropagation()
                onContinue()
              }}
              title="定位稀饭片源"
              className="flex w-full items-center justify-center gap-1 rounded-xl border border-white/20 bg-white/10 py-1.5 font-label text-[10px] uppercase tracking-widest text-white/90 backdrop-blur-sm transition-colors hover:bg-white/20 disabled:cursor-wait disabled:opacity-60"
            >
              {locating ? <Spinner size={12} /> : <Icon name="play_arrow" size={12} />}
              <span>{locating ? '定位中…' : `继续看 EP ${ep}`}</span>
            </button>
          )}
          <a
            href={`https://bgm.tv/subject/${t.bgmId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full items-center justify-center gap-1 rounded-xl border border-white/20 bg-black/55 py-1.5 font-label text-[10px] uppercase tracking-widest text-white/90 backdrop-blur-sm transition-colors hover:bg-black/70"
          >
            <Icon name="open_in_new" size={12} />
            <span>BGM</span>
          </a>
        </div>
      </div>

      <div className="flex flex-col gap-1 px-2 py-2">
        <h3 className="line-clamp-2 h-[30px] text-xs font-bold leading-tight text-on-surface" title={title}>
          {title}
        </h3>
        {/* 标签只读，紧贴标题下方（app 的位置）。按宽度截断，放不下收成 +N，定高不抖。 */}
        <TagRow tags={allTagsOf(t)} />
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1">
            <StepBtn icon="remove" onClick={() => step(-1)} disabled={t.episode <= 0} />
            <span className="text-center font-label text-[11px] tabular-nums">
              <b className="text-[13px] font-extrabold text-on-surface">{t.episode}</b>
              <span className="text-on-surface-variant/40"> / {t.totalEpisodes ?? '—'}</span>
            </span>
            <StepBtn icon="add" onClick={() => step(1)} disabled={capped} />
          </div>
          {t.totalEpisodes == null && (
            <span className="shrink-0 rounded bg-on-surface/[0.08] px-1.5 py-0.5 font-label text-[9px] uppercase tracking-wider text-on-surface-variant/50">
              连载中
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function StepBtn({
  icon,
  onClick,
  disabled,
}: {
  icon: 'add' | 'remove'
  onClick: () => void
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded border border-outline-variant/25 bg-surface-container-high text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-25"
    >
      <Icon name={icon} size={13} />
    </button>
  )
}

// ── 类型过滤 ───────────────────────────────────────────────────────────────────
function TagFilter({
  all,
  selected,
  onChange,
}: {
  all: [string, number][]
  selected: Set<string>
  onChange: (s: Set<string>) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // mousedown 而非 click —— 勾选会重建列表，click 冒泡上来时 e.target 已不在 DOM 上，
  // contains 判 false，弹窗会自己关掉（Select.tsx 同款写法）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (t: string): void => {
    const next = new Set(selected)
    next.has(t) ? next.delete(t) : next.add(t)
    onChange(next)
  }

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-outline-variant/30 bg-surface-container-high px-2.5 py-1.5 text-left text-[13px] transition-colors hover:border-primary/40"
      >
        <span className="text-on-surface-variant/60">类型</span>
        {/* invisible 不用 hidden，且写死宽度 —— hidden 会脱离文档流，角标一出现就把按钮撑宽、
            把搜索框挤走（AI_GUIDELINES「UI/样式」：临时状态要留常驻空位，两态盒子尺寸不变）。 */}
        <span
          className={`w-3.5 rounded bg-primary text-center font-label text-[10px] font-bold leading-[14px] text-on-primary ${
            selected.size ? '' : 'invisible'
          }`}
        >
          {selected.size}
        </span>
        <Icon name="expand_more" size={14} className={`opacity-50 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        // z-30：盖住卡片，但不盖顶栏（顶栏 z-40）
        <div className="absolute right-0 top-[calc(100%+5px)] z-30 w-[176px] rounded-md border border-outline-variant/35 bg-surface-container-low p-1 shadow-2xl">
          {all.length === 0 ? (
            <p className="px-2.5 py-2 text-[12px] text-on-surface-variant/40">还没有标签</p>
          ) : (
            <div className="custom-scrollbar max-h-[260px] overflow-y-auto">
              {all.map(([t, n]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggle(t)}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-on-surface/5"
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                      selected.has(t) ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant/40'
                    }`}
                  >
                    {selected.has(t) && <Icon name="check" size={10} />}
                  </span>
                  <span className={`flex-1 truncate ${selected.has(t) ? 'text-primary' : 'text-on-surface-variant'}`}>{t}</span>
                  <span className="font-label text-[10px] tabular-nums text-on-surface-variant/40">{n}</span>
                </button>
              ))}
            </div>
          )}
          {selected.size > 0 && (
            <div className="mt-1 border-t border-outline-variant/15 pt-1">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="w-full rounded px-2.5 py-1.5 text-left text-[13px] text-on-surface-variant/60 transition-colors hover:bg-on-surface/5 hover:text-error"
              >
                清空
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 编辑弹窗 ───────────────────────────────────────────────────────────────────
// 没有保存按钮 —— 改完即生效。外壳照抄 AuthModal。
function EditModal({
  t,
  onPatch,
  onClose,
}: {
  t: Track
  onPatch: (bgmId: number, p: TrackPatch) => void
  onClose: () => void
}): JSX.Element {
  const [totalDraft, setTotalDraft] = useState(t.totalEpisodes != null ? String(t.totalEpisodes) : '')
  const [adding, setAdding] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const title = t.titleCn || t.title
  const sub = t.titleCn && t.title !== t.titleCn ? t.title : ''

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commitTotal = (): void => {
    const raw = totalDraft.trim()
    const n = parseInt(raw, 10)
    // 清空 = 连载中（app 的语义，placeholder 也这么写）
    const total = raw === '' || !Number.isFinite(n) || n <= 0 ? null : n
    if (total !== t.totalEpisodes) onPatch(t.bgmId, { totalEpisodes: total })
    setTotalDraft(total != null ? String(total) : '')
  }

  const commitTag = (): void => {
    const v = tagDraft.trim()
    if (v && !allTagsOf(t).includes(v)) onPatch(t.bgmId, { userTags: [...t.userTags, v] })
    setTagDraft('')
    setAdding(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-5 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative m-auto w-full max-w-[420px] rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="absolute right-3.5 top-3.5 flex h-6 w-6 items-center justify-center rounded text-on-surface-variant/50 transition-colors hover:bg-surface-container-high hover:text-on-surface"
        >
          <Icon name="close" size={16} />
        </button>

        <div className="font-label text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">编辑追番</div>
        <h2 className="mb-4 mt-1.5 line-clamp-2 pr-6 text-lg font-extrabold leading-tight text-on-surface">{title}</h2>

        <div className="mb-4 flex gap-3">
          {t.cover && <img src={coverUrl(t.cover)} alt="" className="h-[92px] w-[68px] shrink-0 rounded object-cover" />}
          <div className="min-w-0 flex-1 space-y-2">
            <div className="line-clamp-2 text-[11px] leading-snug text-on-surface-variant/50">{sub || '—'}</div>
            <div className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40">
              {t.airWeekday ? `星期${SHORT_DAY[t.airWeekday]}` : ''}
              {t.score > 0 ? ` · ★ ${t.score.toFixed(1)}` : ''}
            </div>
          </div>
        </div>

        <div className="mb-3 grid grid-cols-3 gap-1.5 rounded-md bg-surface-container p-1">
          {STATUS_META.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onPatch(t.bgmId, { status: m.key })}
              className={`rounded border py-1.5 text-sm font-semibold transition-colors ${
                t.status === m.key
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-transparent text-on-surface-variant/70 hover:text-on-surface'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="mb-4 flex items-center gap-3">
          <span className="w-12 shrink-0 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40">进度</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={t.episode <= 0}
              onClick={() => onPatch(t.bgmId, { episode: Math.max(0, t.episode - 1) })}
              className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant/30 bg-surface-container-high transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-25"
            >
              <Icon name="remove" size={14} />
            </button>
            <b className="min-w-[28px] text-center text-base font-extrabold tabular-nums text-on-surface">{t.episode}</b>
            <button
              type="button"
              disabled={t.totalEpisodes != null && t.episode >= t.totalEpisodes}
              onClick={() => onPatch(t.bgmId, { episode: t.episode + 1, ...(t.status === 'plan' ? { status: 'watching' as const } : {}) })}
              className="flex h-7 w-7 items-center justify-center rounded border border-outline-variant/30 bg-surface-container-high transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-25"
            >
              <Icon name="add" size={14} />
            </button>
          </div>
          <span className="text-on-surface-variant/30">/</span>
          <input
            value={totalDraft}
            onChange={(e) => setTotalDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commitTotal}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTotal()
            }}
            placeholder="留空 = 连载中"
            inputMode="numeric"
            maxLength={4}
            className="h-7 w-[104px] rounded-lg border border-outline-variant/30 bg-surface-container-high px-2 text-[13px] text-on-surface outline-none transition-colors placeholder:text-on-surface-variant/35 focus:border-primary/70"
          />
        </div>

        <div className="mb-1.5 flex items-center gap-3">
          <span className="w-12 shrink-0 font-label text-[10px] uppercase tracking-widest text-on-surface-variant/40">类型</span>
          <span className="font-label text-[10px] tracking-wider text-on-surface-variant/25">BGM 的不可改 · 自定义的点一下删</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {t.bgmTags.map((x) => (
            <span
              key={`b-${x}`}
              title="来自 Bangumi（不可编辑）"
              className="inline-flex items-center rounded border border-primary/25 bg-primary/[0.12] px-2 py-0.5 font-label text-[10px] font-bold tracking-wider text-primary"
            >
              {x}
            </span>
          ))}
          {t.userTags.map((x) => (
            <button
              key={`u-${x}`}
              type="button"
              onClick={() => onPatch(t.bgmId, { userTags: t.userTags.filter((y) => y !== x) })}
              title={`自定义「${x}」（点击移除）`}
              className="group inline-flex items-center gap-0.5 rounded border border-primary/25 bg-primary/[0.12] px-2 py-0.5 font-label text-[10px] font-bold tracking-wider text-primary transition-colors hover:border-error/40 hover:bg-error/15 hover:text-error"
            >
              <span>{x}</span>
              <Icon name="close" size={11} className="-mr-0.5 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          ))}
          {adding ? (
            <input
              autoFocus
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={commitTag}
              onKeyDown={(e) => {
                // isComposing 守卫 —— 中文输入法按回车是「确认拼音」，不是「提交标签」
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitTag()
                if (e.key === 'Escape') {
                  setTagDraft('')
                  setAdding(false)
                }
              }}
              placeholder="例：下饭"
              maxLength={20}
              spellCheck={false}
              className="w-24 rounded border border-primary/40 bg-surface px-2 py-0.5 font-label text-[10px] font-bold tracking-wider text-on-surface outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-0.5 rounded border border-dashed border-outline-variant/40 px-2 py-0.5 font-label text-[10px] font-bold tracking-wider text-on-surface-variant/50 transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Icon name="add" size={11} />
              <span>标签</span>
            </button>
          )}
        </div>

      </div>
    </div>
  )
}

// 取消追番二次确认 —— 删除是不可逆操作，且追番带着进度 / 自定义标签，不能点一下就没。
function ConfirmRemoveModal({
  t,
  onConfirm,
  onClose,
}: {
  t: Track
  onConfirm: () => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const title = t.titleCn || t.title
  // 会一并丢失的本地数据 —— 有才提，让用户据此判断（AI_GUIDELINES：只留可行动的文案，不写空话）
  const lost: string[] = []
  if (t.episode > 0) lost.push(`第 ${t.episode} 集的进度`)
  if (t.userTags.length > 0) lost.push(`${t.userTags.length} 个自定义标签`)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-5 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative m-auto w-full max-w-[340px] rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-2xl"
      >
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-error/10 text-error">
          <Icon name="delete" size={22} />
        </div>
        <h2 className="text-lg font-extrabold leading-tight text-on-surface">取消追番</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-on-surface-variant/70">
          不再追踪《{title}》。
          {lost.length > 0 && (
            <span className="mt-1 block text-on-surface-variant/45">{lost.join(' 和 ')}会一并删除，无法恢复。</span>
          )}
        </p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-outline-variant/30 py-2 text-sm font-semibold text-on-surface-variant/80 transition-colors hover:bg-surface-container-high hover:text-on-surface"
          >
            保留
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-error py-2 text-sm font-bold text-on-error transition-colors hover:brightness-110"
          >
            取消追番
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 绑定选择框 ─────────────────────────────────────────────────────────────────
// 首次「继续看」时弹：把周表里名字相近的候选列出来，用户点一个 = 确认「这部 bgm 在稀饭里就是它」。
// **不自动认**（跟 app「绝不模糊匹配自动绑源」一条原则）—— 名字季度后缀 / 简繁 / 日文原名都可能对不齐，
// 让人眼确认一次最稳，之后记住、直接开。候选行本身是 <a>：点它既确认绑定、又原生开播（不吃弹窗拦截）。
function BindPickerModal({
  picker,
  onPick,
  onClose,
}: {
  picker: PickerState
  onPick: (cand: XifanCandidate) => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { track, candidates } = picker
  const title = track.titleCn || track.title
  const ep = nextEp(track)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-5 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative m-auto w-full max-w-[440px] rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="absolute right-3.5 top-3.5 flex h-6 w-6 items-center justify-center rounded text-on-surface-variant/50 transition-colors hover:bg-surface-container-high hover:text-on-surface"
        >
          <Icon name="close" size={16} />
        </button>

        <div className="font-label text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">选择稀饭片源</div>
        <h2 className="mb-1 mt-1.5 line-clamp-2 pr-6 text-lg font-extrabold leading-tight text-on-surface">{title}</h2>
        <p className="mb-4 text-[12px] leading-relaxed text-on-surface-variant/60">
          稀饭用的是另一套编号，按名字匹配出以下几部。<b className="text-on-surface-variant/80">点一下确认是哪部</b>，之后就记住、直接开播（EP {ep}）。
        </p>

        {candidates.length === 0 ? (
          <div className="rounded-lg border border-outline-variant/20 bg-surface-container p-4 text-[12.5px] leading-relaxed text-on-surface-variant/60">
            没在稀饭<b>本季周表</b>里找到相近的名字。多半是：这部不是当季在播（周表只列在播），或译名差得远。
            <span className="mt-1 block text-on-surface-variant/40">在播番剧过阵子更新到周表后再试；往季旧番暂时没法自动定位。</span>
          </div>
        ) : (
          <div className="custom-scrollbar flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
            {candidates.map((c) => (
              <a
                key={c.xifanId}
                href={playPageUrl(c.xifanId, ep)}
                target="_blank"
                rel="noreferrer"
                onClick={() => onPick(c)}
                className="flex items-center gap-3 rounded-lg border border-outline-variant/25 bg-surface-container px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-on-surface">{c.xifanName || `稀饭 #${c.xifanId}`}</div>
                  <div className="mt-0.5 font-label text-[10px] uppercase tracking-wider text-on-surface-variant/45">
                    {c.day ? `星期${SHORT_DAY[c.day]}` : '—'}
                    {c.remarks ? ` · ${c.remarks.replace('|', ' · ')}` : ''}
                  </div>
                </div>
                <Icon name="play_arrow" size={16} className="shrink-0 text-primary/70" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Empty({ icon, text, hint }: { icon: 'person' | 'bookmark' | 'search'; text: string; hint: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-28 text-on-surface-variant/30">
      <Icon name={icon} size={52} />
      <p className="font-label text-xs uppercase tracking-widest">{text}</p>
      <p className="font-label text-[11px] text-on-surface-variant/25">{hint}</p>
    </div>
  )
}

// 我的追番 —— 皮肤 = 原型稿 tracks.html：等宽卡片网格（不按更新日分组，今天更新的番贴
// 「今天更新」小贴纸）、一体式步进器 + 铅笔排线进度条钉同一行、状态分段（想看/在追/看完）
// 常驻直点、纸片弹窗。便签 Toast 做操作反馈。
//
// 几条与桌面端对齐的语义(都是踩过坑定下来的,别改):
//   - `totalEpisodes == null` = **连载中**,不是 0。徽章本身就是「点这里填总集数」的入口。
//   - 进度推到满**不**自动切「看完」—— 用户填 12 不一定是看到 12,可能是「还剩 12 没看」的备忘。
//   - 「想看」首次 +1 才自动转「在追」(这个方向没有歧义)。
//   - 标签在卡片上**只读**,增删在弹窗里;BGM 标签不可编辑。
//
// 页头不置顶,只有顶栏置顶。
//
// 卡片 / 弹窗 / 在线源逻辑拆到 src/tracks/*；稀饭 / Girigiri（以后还有嗷呜 / B站）统一走
// api.ts 的 OnlineSource 适配器，这里的 state / handler / 弹窗都参数化到 `source`。
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnimeHit,
  BgmImportStatus,
  CalendarResult,
  OnlineSource,
  SourceBinding,
  SourceCandidate,
  SourceId,
  SourceSearchHit,
  Track,
  TrackPatch,
  TrackStatus,
  WatchMode,
} from './api'
import { SOURCES, deleteTrack, importTracksFromBgm, putTrack, sourceById, uploadTrackCover } from './api'
import { isRecentAir } from '../shared/anime-age'
import { useAuth } from './auth'
import { cacheGet } from './dataCache'
import { Ic, Spinner } from './SketchIcon'
import { toast } from './Toast'
import { GoodEpisodesModal } from './GoodEpisodesModal'
import {
  loadBindings,
  loadTracks,
  runTracksMutation,
  saveBindingsCache,
  saveTracksCache,
} from './tracksSync'
import { STATUS_META, allTagsOf, tagLimitToast, watchEp } from './tracks/common'
import { TrackCard } from './tracks/TrackCard'
import { BgmImportModal } from './tracks/importModal'
import { ConfirmRemoveModal, EditModal } from './tracks/editModals'
import { AddSearchModal } from './tracks/addSearchModal'
import {
  SourceBindPickerModal,
  SourceSearchModal,
  type PickerFlow,
  type SearchFlow,
} from './tracks/sourceModals'

type FilterKey = 'all' | TrackStatus

function todayBgmId(): number {
  const d = new Date().getDay()
  return d === 0 ? 7 : d
}

// 定位用的标题集合 —— 中文名 / 别名最可能对上简体中文站,日文原名兜底。
const titlesOf = (t: Track): string[] => [t.titleCn, ...t.aliases, t.title].filter(Boolean)

// 「新番 / 老番」分流 —— 源站的番剧周表只列**在播**的番,老番在里面必然查不到,
// 拿老番去走一趟周表定位是纯浪费(冷缓存那次还要等源站抓 7 天)。判据见 shared/anime-age.ts,
// 跟服务端「要不要自动填总集数」用的是同一把尺,不要在这儿另立一套。
const isRecentAnime = (t: Track): boolean => isRecentAir(t.airDate)

const emptyBindings = (): Record<SourceId, Record<number, SourceBinding>> => ({ xifan: {}, girigiri: {} })

/** 标题 / 别名命中(网页版没有备注字段) */
function matches(t: Track, q: string): boolean {
  if (!q) return true
  const hay = [t.title, t.titleCn, ...t.aliases].join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}

/** 本地乐观更新 —— 跟服务端 patch 同样的夹取规则，免得手感和落库结果对不上 */
function applyLocal(t: Track, p: TrackPatch): Track {
  const next = { ...t, ...p } as Track
  const total = 'totalEpisodes' in p ? p.totalEpisodes ?? null : t.totalEpisodes
  if (total != null && next.episode > total) next.episode = total
  return next
}

export function TracksPage(): JSX.Element {
  const { user, ready } = useAuth()
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tracksError, setTracksError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [markingGood, setMarkingGood] = useState<number | null>(null)
  // 在线源绑定：source → (bgmId → {id,name})。加载时一次拿齐，绑过的源「继续看」直接开。
  const [bindings, setBindings] = useState<Record<SourceId, Record<number, SourceBinding>>>(emptyBindings)
  const [locating, setLocating] = useState<{ source: SourceId; bgmId: number } | null>(null)
  const [pickerFlow, setPickerFlow] = useState<PickerFlow | null>(null)
  const [searchFlow, setSearchFlow] = useState<SearchFlow | null>(null)
  const [adding, setAdding] = useState(false) // 加番搜索弹窗
  const [importOpen, setImportOpen] = useState(false)
  const today = useMemo(todayBgmId, [])

  // 秒开缓存 + 后台校验:缓存先渲染,服务器响应随后整份校正。缓存只是首屏优化
  // **不能覆盖**同一账号在另一台设备上已经落库的新状态。
  useEffect(() => {
    if (!ready) return
    if (!user) {
      setTracks([])
      setTracksError(null)
      setBindings(emptyBindings())
      return
    }
    const stopTracks = loadTracks(user.username, setTracks, setTracksError)
    const stopBindings = SOURCES.map((s) =>
      loadBindings(s.id, user.username, (b) => setBindings((prev) => ({ ...prev, [s.id]: b }))),
    )
    return () => {
      stopTracks()
      stopBindings.forEach((fn) => fn())
    }
  }, [ready, user])

  // 状态一变就同步写回缓存 —— 这样切去周历页再切回来、或下次挂载,直接复用最新状态
  // 不用再等一轮网络。
  useEffect(() => {
    if (user && tracks) saveTracksCache(user.username, tracks)
  }, [user, tracks])
  useEffect(() => {
    if (user) for (const s of SOURCES) saveBindingsCache(s.id, user.username, bindings[s.id])
  }, [user, bindings])

  // 未绑定的「继续看」：老番跳过周表直接进搜索；新番去周表定位 → 有候选就弹选择框让用户确认
  // （= 建绑定）。零候选说明周表里没有（名字对不上 / 判新老判错了），**不弹空框**，直接落到
  // 搜索 —— 空框的唯一用途就是让用户再点一次「去搜索」。
  const continueWatch = (source: OnlineSource, t: Track, mode: WatchMode): void => {
    if (locating != null) return
    // 已绑定：直接开 —— online 走播放页，source 跳源站站内页（都在用户点击手势内，不吃弹窗拦截）
    const bound = bindings[source.id][t.bgmId]
    if (bound) {
      const url = mode === 'source'
        ? source.sourcePageUrl(bound.id, watchEp(t))
        : source.playPageUrl(bound.id, watchEp(t), t.bgmId)
      window.open(url, '_blank', 'noopener')
      return
    }
    if (!isRecentAnime(t)) {
      setSearchFlow({ source: source.id, track: t, mode })
      return
    }
    setLocating({ source: source.id, bgmId: t.bgmId })
    source.locate(t.bgmId, titlesOf(t))
      .then((r) => {
        if (r.bound) {
          // 极少见：加载后别的用户刚绑上 → 记下来（卡片下次即变链接），并尽力开一下
          const b = r.bound
          setBindings((prev) => ({ ...prev, [source.id]: { ...prev[source.id], [t.bgmId]: { id: b.id, name: b.name } } }))
          const url = mode === 'source'
            ? source.sourcePageUrl(b.id, watchEp(t))
            : source.playPageUrl(b.id, watchEp(t), t.bgmId)
          window.open(url, '_blank', 'noopener')
        } else if (r.candidates.length) {
          setPickerFlow({ source: source.id, track: t, candidates: r.candidates, mode })
        } else {
          setSearchFlow({ source: source.id, track: t, mode })
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLocating(null))
  }

  // 用户在选择框点了某个候选 = 确认绑定：落库 + 本地记下（卡片即变链接）。开播由候选行自身的链接完成。
  const confirmBind = (source: OnlineSource, bgmId: number, cand: SourceCandidate): void => {
    const previous = bindings[source.id][bgmId]
    setBindings((prev) => ({ ...prev, [source.id]: { ...prev[source.id], [bgmId]: { id: cand.id, name: cand.name } } }))
    setPickerFlow(null)
    void source.bind(bgmId, cand.id, cand.name).catch((e: Error) => {
      setError(e.message)
      setBindings((prev) => {
        const nextSrc = { ...prev[source.id] }
        if (previous) nextSrc[bgmId] = previous
        else delete nextSrc[bgmId]
        return { ...prev, [source.id]: nextSrc }
      })
    })
  }

  // 搜索结果也走一次显式确认:点结果行时先落绑定,**再用原生链接**打开播放页 ——
  // 异步请求会吃掉浏览器的弹窗手势。
  const confirmSearchBind = (source: OnlineSource, hit: SourceSearchHit): void => {
    const flow = searchFlow
    if (!flow) return
    const remarks = [hit.episode, hit.year, hit.area].filter(Boolean).join(' · ')
    setSearchFlow(null)
    confirmBind(source, flow.track.bgmId, { id: hit.id, name: hit.name, day: 0, remarks, score: 0 })
  }

  // 搜索结果加追番 —— 乐观先塞占位（默认「想看」），最后统一用权威全量 GET 收口。
  // 单条 PUT 响应可能比随后一次操作更晚回来，不能拿它覆盖较新的页面状态。
  const addFromSearch = (hit: AnimeHit): void => {
    if (!user) return
    setError(null)
    // 周历缓存里若有这部（加番大多加当季新番），封面 / 放送星期立刻带上：
    // 乐观卡片即时有图，cover 随 PUT 落库，不用等服务端后台补
    const cal = cacheGet<CalendarResult>('calendar', 14 * 24 * 60 * 60_000)
    const calDay = cal?.data.find((d) => d.items.some((i) => i.id === hit.bgmId))
    const calItem = calDay?.items.find((i) => i.id === hit.bgmId)
    const optimistic: Track = {
      bgmId: hit.bgmId, status: 'plan', episode: 0, totalEpisodes: null,
      title: hit.name, titleCn: hit.nameCn, cover: calItem?.cover ?? '', airWeekday: calDay?.id ?? 0,
      airDate: hit.date, score: hit.score, bgmTags: [], userTags: [], aliases: [],
      observeCount: 0, subjectType: 'anime', goodEpisodes: [], goodEpisodeNotes: {}, favorite: 0, updatedAt: Date.now(),
    }
    setTracks((prev) => (prev && prev.some((t) => t.bgmId === hit.bgmId) ? prev : [optimistic, ...(prev ?? [])]))
    toast(`已加入『${hit.nameCn || hit.name}』，默认想看`)
    void runTracksMutation(user.username, () =>
      putTrack(hit.bgmId, {
        title: hit.name,
        titleCn: hit.nameCn,
        status: 'plan',
        airDate: hit.date,
        score: hit.score,
        ...(calItem?.cover ? { cover: calItem.cover } : {}),
        ...(calDay ? { airWeekday: calDay.id } : {}),
      }, { searchAdditionToken: hit.searchAdditionToken })
    ).catch((e: Error) => setError(e.message))
  }

  // 本地先改、后端后写 —— +1 要跟手，不能等一个来回。成功与失败都由最后一次全量 GET
  // 校正整份列表，快速连续点击时不会被较早返回的 PUT 盖回去。
  const patch = (bgmId: number, p: TrackPatch): void => {
    if (!user) return
    setError(null)
    setTracks((prev) =>
      prev ? prev.map((t) => (t.bgmId === bgmId ? applyLocal(t, p) : t)) : prev
    )
    void runTracksMutation(user.username, () => putTrack(bgmId, p)).catch((e: Error) => {
      // 标签超限（前端已拦一道，这里兜底并发写）：走便签，不挂页头红字警示条
      if (e.message.includes('标签')) tagLimitToast()
      else setError(e.message)
    })
  }

  // 本地图片上传封面 —— 不走 patch()：写入的是文件而不是字段，服务端存完盘才知道最终
  // URL（/api/tracks/<id>/cover-file），所以拿服务端返回的整条记录覆盖本地，而不是乐观先改。
  const uploadCover = async (bgmId: number, file: File): Promise<void> => {
    if (!user) return
    setError(null)
    try {
      const updated = await uploadTrackCover(bgmId, file)
      setTracks((prev) => (prev ? prev.map((t) => (t.bgmId === bgmId ? updated : t)) : prev))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // 状态分段直点：与编辑弹窗同一入口；已是当前状态的点击不产生请求
  const setStatus = (t: Track, status: TrackStatus): void => {
    if (t.status === status) return
    const label = STATUS_META.find((m) => m.key === status)?.label ?? ''
    patch(t.bgmId, { status })
    toast(`『${t.titleCn || t.title}』已标为「${label}」`)
  }

  const remove = (bgmId: number): void => {
    if (!user) return
    setError(null)
    const t = tracks?.find((x) => x.bgmId === bgmId)
    setTracks((prev) => (prev ? prev.filter((x) => x.bgmId !== bgmId) : prev))
    setEditing(null)
    setConfirming(null)
    if (t) toast(`已移出『${t.titleCn || t.title}』`)
    void runTracksMutation(user.username, () => deleteTrack(bgmId))
      .catch((e: Error) => setError(e.message))
  }

  const importFromBgm = (
    bgmUserId: string,
    onProgress: (status: BgmImportStatus) => void,
  ): Promise<BgmImportStatus> => {
    if (!user) return Promise.reject(new Error('未登录'))
    setError(null)
    return runTracksMutation(user.username, () => importTracksFromBgm(bgmUserId, onProgress))
  }

  const animeTracks = useMemo(
    () => (tracks ?? []).filter((track) => (track.subjectType ?? 'anime') === 'anime'),
    [tracks],
  )

  const counts = useMemo(() => {
    const c = { all: 0, watching: 0, plan: 0, considering: 0, done: 0 }
    for (const t of animeTracks) {
      c.all++
      c[t.status]++
    }
    return c
  }, [animeTracks])

  const filtered = useMemo(() => {
    let list = animeTracks
    if (filter !== 'all') list = list.filter((t) => t.status === filter)
    const q = query.trim()
    if (q) list = list.filter((t) => matches(t, q))
    if (tags.size) list = list.filter((t) => allTagsOf(t).some((x) => tags.has(x)))
    const isToday = (t: Track) => t.airWeekday === today && t.status !== 'done' && isRecentAir(t.airDate)
    // 服务端已按加入顺序倒序返回；分成两段而不是按 updatedAt 重排，今天更新仍置顶，
    // 其余卡片则保持真正的创建顺序（新加的更靠前）。
    return [...list.filter(isToday), ...list.filter((t) => !isToday(t))]
  }, [animeTracks, filter, query, tags, today])

  const allTags = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of animeTracks) for (const x of allTagsOf(t)) m.set(x, (m.get(x) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [animeTracks])

  // 「想看」中的在播番也是用户关注的更新。
  //
  // 判据是 airDate 而**不是**「总集数为空」：老番自动补上集数之后，原判据会把「有没有填集数」
  // 和「是不是在播」混为一谈 —— 新番一旦被用户手填集数就掉出当天分组，而这跟它在不在播没关系。
  // 现在两件事彻底分开：在播看 airDate，进度看 totalEpisodes。
  // 顺带修掉一个旧毛病：往季老番只要放送星期恰好是今天，过去会一直顶着「今天更新」。
  const todayIds = useMemo(
    () =>
      new Set(
        filtered
          .filter((t) => t.airWeekday === today && t.status !== 'done' && isRecentAir(t.airDate))
          .map((t) => t.bgmId),
      ),
    [filtered, today],
  )
  const todayCount = todayIds.size
  const editingTrack = animeTracks.find((t) => t.bgmId === editing) ?? null
  const confirmingTrack = animeTracks.find((t) => t.bgmId === confirming) ?? null
  const markingGoodTrack = animeTracks.find((t) => t.bgmId === markingGood) ?? null

  return (
    <>
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <h1 className="title-sketch" style={{ fontSize: 34 }}>
            我的追番
          </h1>
          <p className="muted small mt8">
            {user ? (
              <>
                在追 {counts.watching} 部
                {todayCount > 0 && (
                  <>
                    ，今天有 <span className="hl" style={{ fontWeight: 600 }}>{todayCount} 部更新</span>
                  </>
                )}
              </>
            ) : (
              '登录后，这一页就是你的手帐'
            )}
          </p>
        </div>
        {user && (
          <div className="row">
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setImportOpen(true)}>
              <Ic name="refresh" cls="ic ic-sm" />
              从 Bangumi 导入
            </button>
            <button className="btn btn-sm btn-primary" type="button" onClick={() => setAdding(true)}>
              <Ic name="plus" cls="ic ic-sm" />
              加番
            </button>
          </div>
        )}
      </div>

      {/* 立绘只在「当前列表真的有卡片」时驻场：任何空态（没追过 / 搜索无结果 / 过滤无结果）
          都只留 Q 版纱雾空态面板，不叠第二个角色 */}
      {user && filtered.length > 0 && (
        <>
          {/* 手机：立绘内联（桌面为页尾驻场，CSS 切换） */}
          <div className="rig-inline mt16">
            <img className="rig" src="/assets/chara_03.webp" alt="山田エルフ · 官方立绘" />
            <div className="bubble rig-bubble">
              <span>
                {todayCount > 0
                  ? `今天有 ${todayCount} 部更新，快去看快去看！`
                  : '今天没有更新，慢慢补番也好～'}
              </span>
            </div>
          </div>
        </>
      )}

      <div className="row mb16" style={{ flexWrap: 'wrap' }}>
        <div className="searchbar">
          <Ic name="search" cls="ic" />
          <input
            id="trkSearch"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="在这页里搜番名…"
          />
          {query && (
            <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清空搜索">
              <Ic name="x" cls="ic ic-sm" />
            </button>
          )}
        </div>
        <TagFilter all={allTags} selected={tags} onChange={setTags} />
      </div>

      <div className="tabf-row">
        {([['all', '全部'], ...STATUS_META.map((m) => [m.key, m.label])] as [FilterKey, string][]).map(
          ([k, label]) => (
            <button
              key={k}
              type="button"
              className={`tabf${filter === k ? ' on' : ''}`}
              onClick={() => setFilter(k)}
            >
              {label} <span className="badge-num">{counts[k]}</span>
            </button>
          )
        )}
      </div>

      {(error ?? tracksError) && (
        <p className="form-note err mt8" aria-live="polite">
          ⚠ {error ?? tracksError}
        </p>
      )}

      {!ready || tracks === null ? (
        <div className="page-state">
          <Spinner size={36} />
          <p className="faint small">正在翻开追番手帐…</p>
        </div>
      ) : !user ? (
        <EmptyState text="登录后才能追番" hint="追番数据存在账号里，换设备也在" goCalendar />
      ) : counts.all === 0 ? (
        <EmptyState text="还没追任何番" hint="去「番剧周历」，点封面上的 ＋ 追番" goCalendar />
      ) : filtered.length === 0 ? (
        <EmptyState text="没有匹配的追番" hint="换个词，或清掉类型过滤" />
      ) : (
        <div className="trk-grid">
          {filtered.map((t) => (
            <TrackCard
              key={t.bgmId}
              t={t}
              isToday={todayIds.has(t.bgmId)}
              boundSources={new Set(SOURCES.filter((s) => bindings[s.id][t.bgmId]).map((s) => s.id))}
              locating={locating?.bgmId === t.bgmId}
              onContinue={(sourceId, mode) => continueWatch(sourceById(sourceId), t, mode)}
              onPatch={patch}
              onStatus={(s) => setStatus(t, s)}
              onEdit={() => setEditing(t.bgmId)}
              onAskRemove={() => setConfirming(t.bgmId)}
              onMarkGood={() => setMarkingGood(t.bgmId)}
            />
          ))}
        </div>
      )}

      {user && filtered.length > 0 && (
        <div className="rig-slot">
          <div className="rig-box">
            <img className="rig" src="/assets/chara_03.webp" alt="山田エルフ · 官方立绘" />
            <div className="bubble rig-bubble">
              <span>
                {todayCount > 0
                  ? `今天有 ${todayCount} 部更新，快去看快去看！`
                  : '今天没有更新，慢慢补番也好～'}
              </span>
            </div>
            <span className="kira" style={{ bottom: 70, right: -12, transform: 'rotate(7deg)' }}>
              エルフ先生
            </span>
          </div>
        </div>
      )}

      {editingTrack && (
        <EditModal
          t={editingTrack}
          onPatch={patch}
          onUploadCover={uploadCover}
          onClose={() => setEditing(null)}
        />
      )}

      {pickerFlow && (
        <SourceBindPickerModal
          source={sourceById(pickerFlow.source)}
          flow={pickerFlow}
          onPick={(cand) => confirmBind(sourceById(pickerFlow.source), pickerFlow.track.bgmId, cand)}
          onSearch={() => {
            setSearchFlow({ source: pickerFlow.source, track: pickerFlow.track, mode: pickerFlow.mode })
            setPickerFlow(null)
          }}
          onClose={() => setPickerFlow(null)}
        />
      )}

      {searchFlow && (
        <SourceSearchModal
          source={sourceById(searchFlow.source)}
          flow={searchFlow}
          onPick={(hit) => confirmSearchBind(sourceById(searchFlow.source), hit)}
          onClose={() => setSearchFlow(null)}
        />
      )}

      {adding && (
        <AddSearchModal
          trackedIds={new Set(animeTracks.map((t) => t.bgmId))}
          onAdd={addFromSearch}
          onClose={() => setAdding(false)}
        />
      )}

      {importOpen && user && (
        <BgmImportModal
          initialUserId={user.bgmUid}
          onImport={importFromBgm}
          onClose={() => setImportOpen(false)}
        />
      )}

      {confirmingTrack && (
        <ConfirmRemoveModal
          t={confirmingTrack}
          onConfirm={() => remove(confirmingTrack.bgmId)}
          onClose={() => setConfirming(null)}
        />
      )}

      {markingGoodTrack && (
        <GoodEpisodesModal t={markingGoodTrack} onPatch={patch} onClose={() => setMarkingGood(null)} />
      )}
    </>
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
    <div ref={box} className={`dd-host${open ? ' open' : ''}`}>
      <button
        type="button"
        className="dd-trigger"
        style={{ minWidth: 128 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dd-val">类型</span>
        {/* invisible 不用 hidden —— hidden 脱离文档流，角标一出现就把按钮撑宽（AI_GUIDELINES：
            临时状态要留常驻空位，两态盒子尺寸不变） */}
        <span className="tagx mine" style={{ visibility: selected.size ? 'visible' : 'hidden' }}>
          {selected.size}
        </span>
        <Ic name="chev" cls="ic" />
      </button>

      {open && (
        <div className="dd">
          {all.length === 0 ? (
            <p className="sugg-note">还没有标签</p>
          ) : (
            all.map(([t, n]) => (
              <button key={t} type="button" className={`dd-item${selected.has(t) ? ' on' : ''}`} onClick={() => toggle(t)}>
                <span className={`dd-check${selected.has(t) ? ' on' : ''}`}>
                  {selected.has(t) && <Ic name="check" cls="ic ic-sm" />}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t}
                </span>
                <span className="faint">{n}</span>
              </button>
            ))
          )}
          {selected.size > 0 && (
            <button type="button" className="dd-item" style={{ color: 'var(--sakura)' }} onClick={() => onChange(new Set())}>
              清空过滤
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── 空态（Q 版纱雾 + 气泡） ─────────────────────────────────────────────────────
function EmptyState({ text, hint, goCalendar }: { text: string; hint: string; goCalendar?: boolean }): JSX.Element {
  return (
    /* 横排：立绘在左、气泡在右，尾巴从气泡左缘指回人物（竖排时尾巴悬在人物脚边的空气里，
       而且整块面板被撑得又高又空） */
    <div className="empty panel mt16">
      <img className="mascot" src="/assets/sagiri-mascot.webp" alt="" />
      <div className="empty-say">
        <div className="bubble empty-bubble">
          {text}。{hint}
        </div>
        {goCalendar && (
          <a className="btn btn-primary" href="#/">
            去番剧周历
          </a>
        )}
      </div>
    </div>
  )
}

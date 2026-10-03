import { AGENT_NAVIGATION_EVENT,takeAgentNavigation } from './agent/navigation'
// 我的追番 —— 皮肤 = 原型稿 tracks.html：等宽卡片网格（不按更新日分组，今天更新的番贴
// 「今天更新」小贴纸）、一体式步进器 + 铅笔排线进度条钉同一行、状态分段（想看/在看/看完）
// 常驻直点、纸片弹窗。便签 Toast 做操作反馈。
//
// 几条与桌面端对齐的语义(都是踩过坑定下来的,别改):
//   - `totalEpisodes == null` = **连载中**,不是 0。徽章本身就是「点这里填总集数」的入口。
//   - 进度推到满**不**自动切「看完」—— 用户填 12 不一定是看到 12,可能是「还剩 12 没看」的备忘。
//   - 「想看」首次 +1 才自动转「在看」(这个方向没有歧义)。
//   - 标签在卡片上**只读**,增删在弹窗里;BGM 标签不可编辑。
//   - 负数 bgmId = 尚未对上 BGM 的手动条目；回填时服务端只换主键与 BGM 元数据，进度/用户标签/用户封面留在原卡。
//
// 页头不置顶,只有顶栏置顶。
//
// 卡片 / 列表 / 弹窗 / 在线源逻辑拆到 src/tracks/*；稀饭 / Girigiri（以后还有嗷呜 / B站）统一走
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
  TracksLoadProgress,
  WatchMode,
} from './api'
import { SOURCES, backfillTrack, deleteTrack, importTracksFromBgm, putTrack, sourceById, uploadTrackCover } from './api'
import { isRecentAir } from '../shared/anime-age'
import { auth, useAuth } from './auth'
import { cacheGet } from './dataCache'
import { Ic, Spinner } from './SketchIcon'
import { toast } from './Toast'
import { GoodEpisodesModal } from './GoodEpisodesModal'
import { ReviewAssistantModal } from './reviews/ReviewAssistantModal'
import { PosterModal } from './reviews/PosterModal'
import type { PosterInput } from './reviews/poster'
import { fetchMaterial, fetchReviewsState } from './reviews/reviewsApi'
import {
  loadBindings,
  loadTracks,
  reloadTracks,
  runTracksMutation,
  saveBindingsCache,
  saveTracksCache,
} from './tracksSync'
import { STATUS_META, allTagsOf, tagLimitToast, watchEp } from './tracks/common'
import { TrackCard } from './tracks/TrackCard'
import { TrackListRow } from './tracks/TrackList'
import { BgmImportModal } from './tracks/importModal'
import { ConfirmRemoveModal, EditModal } from './tracks/editModals'
import { AddSearchModal, type BackfillTarget } from './tracks/addSearchModal'
import { SketchSheet } from './SketchSheet'
import {
  SourceBindPickerModal,
  SourceSearchModal,
  type PickerFlow,
  type SearchFlow,
} from './tracks/sourceModals'

type FilterKey = 'all' | TrackStatus
type TrackView = 'cards' | 'list'
type AddFlow = { initialQuery?: string; backfill?: BackfillTarget }

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

let customIdCursor = 0
function nextCustomBgmId(tracks: Track[]): number {
  const used = new Set(tracks.map((t) => t.bgmId))
  let candidate = customIdCursor < 0 ? Math.min(customIdCursor, -Date.now()) : -Date.now()
  while (used.has(candidate)) candidate--
  customIdCursor = candidate - 1
  return candidate
}

const emptyBindings = (): Record<SourceId, Record<number, SourceBinding>> => ({ xifan: {}, girigiri: {} })

/** 标题 / 别名命中(网页版没有备注字段) */
function matches(t: Track, q: string): boolean {
  if (!q) return true
  const hay = [t.title, t.titleCn, ...t.aliases].join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}

/** 本地乐观更新 —— 跟服务端 patch 同样的夹取规则，免得手感和落库结果对不上 */
function applyLocal(t: Track, p: TrackPatch): Track {
  // updatedAt 跟服务端同语义（任何改动都刷新），乐观更新也要带上——页头「今天的功课」靠它当场划掉
  const next = { ...t, ...p, updatedAt: Date.now() } as Track
  const total = 'totalEpisodes' in p ? p.totalEpisodes ?? null : t.totalEpisodes
  if (total != null && next.episode > total) next.episode = total
  return next
}

export function TracksPage(): JSX.Element {
  const { user, ready, error: authError } = useAuth()
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tracksError, setTracksError] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<TracksLoadProgress | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [view, setView] = useState<TrackView>('cards')
  const [query, setQuery] = useState('')
  const [tags, setTags] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [markingGood, setMarkingGood] = useState<number | null>(null)
  const [writingReview, setWritingReview] = useState<number | null>(null)
  const [poster, setPoster] = useState<PosterInput | null>(null)
  const [posterBusy, setPosterBusy] = useState(false)
  // 在线源绑定：source → (bgmId → {id,name})。加载时一次拿齐，绑过的源「继续看」直接开。
  const [bindings, setBindings] = useState<Record<SourceId, Record<number, SourceBinding>>>(emptyBindings)
  const [locating, setLocating] = useState<{ source: SourceId; bgmId: number } | null>(null)
  const locateRequest = useRef<AbortController | null>(null)
  useEffect(() => () => locateRequest.current?.abort(), [user?.id])
  const [pickerFlow, setPickerFlow] = useState<PickerFlow | null>(null)
  const [searchFlow, setSearchFlow] = useState<SearchFlow | null>(null)
  const [adding, setAdding] = useState<AddFlow | null>(null) // 加番搜索弹窗
  const [importOpen, setImportOpen] = useState(false)
  const today = useMemo(todayBgmId, [])

  useEffect(() => {
    if (!user || !tracks) return
    const receive = (): void => {
      const action = takeAgentNavigation(user.id)
      if (!action) return
      if (action.kind === 'search') {
        if (loadProgress) { toast('追番列表尚未加载完整'); return }
        setAdding({}); return
      }
      const track = tracks.find(item => item.bgmId === action.bgmId)
      if (!track) { toast('先在我的追番里找到这部番，再打开这个入口吧'); return }
      if (action.kind === 'review') {
        if (track.bgmId > 0 && (track.status === 'watching' || track.status === 'done')) setWritingReview(track.bgmId)
        else toast('在看或看完的番，才可以打开点评助手')
      } else if (track.bgmId > 0) setSearchFlow({source:action.source,track,mode:'online',agentAction:action.actionId})
    }
    receive()
    window.addEventListener(AGENT_NAVIGATION_EVENT,receive)
    return () => window.removeEventListener(AGENT_NAVIGATION_EVENT,receive)
  },[user,tracks,loadProgress])


  // 秒开缓存 + 后台校验:缓存先渲染,服务器响应随后整份校正。缓存只是首屏优化
  // **不能覆盖**同一账号在另一台设备上已经落库的新状态。
  useEffect(() => {
    if (!ready) return
    if (!user) {
      setTracks([])
      setTracksError(null)
      setLoadProgress(null)
      setBindings(emptyBindings())
      return
    }
    setTracks(null)
    setTracksError(null)
    setLoadProgress(null)
    const stopTracks = loadTracks(user.username, setTracks, setTracksError, setLoadProgress)
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

  // 稀饭新版搜索不再需要验证码，未绑定或重新绑定都直接搜，不再额外等待周表。
  // Girigiri 仍保留新番周表候选；候选由用户确认，不自动绑定。
  const continueWatch = (source: OnlineSource, t: Track, mode: WatchMode, rebind = false): void => {
    if (locating != null) return
    // 已绑定：直接开 —— online 走播放页，source 跳源站站内页（都在用户点击手势内，不吃弹窗拦截）。
    // rebind = 用户在弹窗里点了「不对，重认」，跳过已有绑定，重新挑选。
    const bound = bindings[source.id][t.bgmId]
    if (bound && !rebind) {
      const url = mode === 'source'
        ? source.sourcePageUrl(bound.id, watchEp(t))
        : source.playPageUrl(bound.id, watchEp(t), t.bgmId)
      window.open(url, '_blank', 'noopener')
      return
    }
    if (source.id === 'xifan' || !isRecentAnime(t)) {
      setSearchFlow({ source: source.id, track: t, mode })
      return
    }
    locateRequest.current?.abort()
    const controller = new AbortController()
    locateRequest.current = controller
    setLocating({ source: source.id, bgmId: t.bgmId })
    source.locate(t.bgmId, titlesOf(t), rebind, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return
        if (r.bound && !rebind) {
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
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (locateRequest.current === controller) setLocating(null) })
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
    toast(`哼，『${hit.nameCn || hit.name}』已经贴进手帐啦，先放在「想看」里。`)
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

  const addCustom = async (title: string): Promise<void> => {
    if (!user) throw new Error('未登录')
    const customBgmId = nextCustomBgmId(tracks ?? [])
    const optimistic: Track = {
      bgmId: customBgmId,
      status: 'plan',
      episode: 0,
      totalEpisodes: null,
      title,
      titleCn: '',
      cover: '',
      airWeekday: 0,
      airDate: '',
      score: 0,
      bgmTags: [],
      userTags: [],
      aliases: [],
      observeCount: 0,
      subjectType: 'anime',
      goodEpisodes: [],
      goodEpisodeNotes: {},
      favorite: 0,
      updatedAt: Date.now(),
    }
    setError(null)
    setTracks((prev) => [optimistic, ...(prev ?? [])])
    toast(`哼，『${title}』先贴进手帐啦，等 BGM 出现再回填。`)
    try {
      await runTracksMutation(user.username, () => putTrack(customBgmId, {
        title,
        titleCn: '',
        status: 'plan',
        episode: 0,
        totalEpisodes: null,
        cover: '',
        airWeekday: 0,
        airDate: '',
        score: 0,
      }))
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  const backfill = async (customBgmId: number, hit: AnimeHit): Promise<void> => {
    if (!user) throw new Error('未登录')
    setError(null)
    try {
      const updated = await runTracksMutation(user.username, () => backfillTrack(customBgmId, hit.bgmId))
      setTracks((prev) => {
        if (!prev) return [updated]
        const found = prev.some((t) => t.bgmId === customBgmId)
        return found ? prev.map((t) => (t.bgmId === customBgmId ? updated : t)) : [updated, ...prev]
      })
      setAdding(null)
      toast(`『${updated.titleCn || updated.title}』对上 BGM 啦，进度、标签和封面都留着。`)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      throw error
    }
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
    if (loadProgress) return loadProgress.counts
    const c = { all: 0, watching: 0, plan: 0, considering: 0, done: 0 }
    for (const t of animeTracks) {
      c.all++
      c[t.status]++
    }
    return c
  }, [animeTracks, loadProgress])

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

  const renderKey = JSON.stringify([user?.username, filter, query, [...tags].sort(), view])
  const [renderWindow, setRenderWindow] = useState({ key: '', count: 18 })
  const visibleCount = renderWindow.key === renderKey ? renderWindow.count : 18
  const moreRef = useRef<HTMLDivElement>(null)
  const showMore = (): void => setRenderWindow({ key: renderKey, count: visibleCount + 18 })
  useEffect(() => {
    const target = moreRef.current
    if (!target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect()
        setRenderWindow({ key: renderKey, count: visibleCount + 18 })
      }
    }, { rootMargin: '600px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [renderKey, visibleCount, filtered.length])

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
  // 今天的功课：页头便签上手写列出今天更新的番，下面卡片里动过进度（updatedAt 是今天）就被铅笔划掉。
  // updatedAt 是服务端时间戳，换设备也算数；任何改动都会刷新它，改标签也会被当成看过。
  const homework = useMemo(() => {
    const dayStart = new Date().setHours(0, 0, 0, 0)
    return animeTracks
      .filter((t) => t.airWeekday === today && t.status !== 'done' && isRecentAir(t.airDate))
      .map((t) => ({ id: t.bgmId, title: t.titleCn || t.title, done: t.updatedAt >= dayStart }))
  }, [animeTracks, today])
  const homeworkDone = homework.length > 0 && homework.every((h) => h.done)
  const editingTrack = animeTracks.find((t) => t.bgmId === editing) ?? null
  const confirmingTrack = animeTracks.find((t) => t.bgmId === confirming) ?? null
  const markingGoodTrack = animeTracks.find((t) => t.bgmId === markingGood) ?? null
  const writingReviewTrack = animeTracks.find((t) => t.bgmId === writingReview) ?? null

  async function makePoster(t: Track): Promise<void> {
    const modes = t.publishedReviews ?? []
    if (!modes.length || !user || posterBusy) return
    const mode = modes.includes('review') ? 'review' : 'recommend'
    setPosterBusy(true)
    try {
      const [state, material] = await Promise.all([fetchReviewsState(t.bgmId), fetchMaterial(t.bgmId).catch(() => null)])
      const content = state[mode].content
      if (!content) {
        toast('这篇还没发布……', { err: true })
        return
      }
      setPoster({
        cover: t.cover,
        titleCn: t.titleCn || t.title,
        titleAlt: material?.title && material.title !== (t.titleCn || t.title) ? material.title : undefined,
        mode,
        body: content.body,
        spoiler: content.spoiler,
        // 海报分数由爱心、鉴赏神回和备注共同计算；t.score 只保留给 BGM 综合分。
        scoreSignals: {
          favorite: t.favorite,
          goodEpisodeCount: t.goodEpisodes.length,
          notedEpisodeCount: Object.values(t.goodEpisodeNotes).filter((note) => typeof note === 'string' && note.trim()).length,
          totalEpisodes: t.totalEpisodes,
          watchedEpisodes: t.episode,
        },
        bgmScore: material && material.score > 0 ? material.score : t.score > 0 ? t.score : undefined,
        airDate: t.airDate || undefined,
        tags: (content.tagsShown.length
          ? content.tagsShown
          : t.userTags.length
            ? t.userTags
            : material?.tags ?? []
        ).slice(0, 6),
        publishedAt: content.publishedAt ?? undefined,
        serial: t.bgmId,
        qrUrl: `${window.location.origin}/u/${encodeURIComponent(user.username)}`,
        username: user.username,
      })
    } catch (err) {
      toast(err instanceof Error ? err.message : '海报没做成……', { err: true })
    } finally {
      setPosterBusy(false)
    }
  }

  return (
    <>
      <header className="sketch-hero">
        <div className="spread sketch-hero-body" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1 className="title-sketch" style={{ fontSize: 34 }}>
              我的追番
            </h1>
            <p className="muted small mt8">
              {user ? (
                <>
                  在看 {counts.watching} 部
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
              <button className="btn btn-sm btn-ghost" type="button" disabled={!!loadProgress} onClick={() => setImportOpen(true)}>
                <Ic name="refresh" cls="ic ic-sm" />
                从 Bangumi 导入
              </button>
              <button className="btn btn-sm btn-primary" type="button" disabled={!!loadProgress} onClick={() => setAdding({})}>
                <Ic name="plus" cls="ic ic-sm" />
                加番
              </button>
            </div>
          )}
        </div>
        <SketchSheet src="/assets/pop/tracks.webp" paper="note" className={`sketch-hero-art${homework.length ? ' with-list' : ''}`}>
          {homework.length > 0 && (
            <>
              <ol className="homework">
                <li className="homework-head">今天的功课</li>
                {homework.slice(0, 4).map((h) => (
                  <li key={h.id} className={h.done ? 'done' : ''}>
                    {h.title}
                  </li>
                ))}
                {homework.length > 4 && <li className="homework-more">还有 {homework.length - 4} 部…</li>}
              </ol>
              {homeworkDone && <span className="homework-stamp">済</span>}
            </>
          )}
        </SketchSheet>
      </header>

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
        <ViewModeToggle value={view} onChange={setView} />
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

      {loadProgress && (
        <div className="trk-load-progress" role="status">
          {loadProgress.loading ? `正在加载其余追番（${loadProgress.loaded}/${loadProgress.total}）` : `已加载 ${loadProgress.loaded}/${loadProgress.total}`}
          {!loadProgress.loading && user && <button type="button" className="link" onClick={() => reloadTracks(user.username)}>继续加载</button>}
        </div>
      )}

      {!ready || (tracks === null && !tracksError) ? (
        <div className="page-state">
          <Spinner size={36} />
          <p className="faint small">正在翻开追番手帐…</p>
        </div>
      ) : tracks === null && tracksError ? (
        <div className="page-state"><p>追番列表暂时无法读取</p>{user && <button type="button" className="btn btn-ghost" onClick={() => reloadTracks(user.username)}>重新加载</button>}</div>
      ) : !user && authError ? (
        <div className="page-state">
          <p className="form-note err">{authError}</p>
          <button className="btn btn-ghost" type="button" onClick={() => void auth.init()}>重新连接</button>
        </div>
      ) : !user ? (
        <EmptyState text="登录后就能开始追番" />
      ) : counts.all === 0 ? (
        <EmptyState text="还没有在追的番，点上面的「加番」开始吧" />
      ) : filtered.length === 0 ? (
        <EmptyState text={loadProgress ? (loadProgress.loading ? '正在查找其余追番…' : '列表尚未加载完整，请继续加载') : '没有匹配的追番，换个词或清掉类型过滤试试'} />
      ) : (
        <div className={view === 'list' ? 'trk-list' : 'trk-grid'}>
          {filtered.slice(0, visibleCount).map((t) => {
            const bound: Partial<Record<SourceId, SourceBinding>> = {}
            for (const s of SOURCES) {
              const b = bindings[s.id][t.bgmId]
              if (b) bound[s.id] = b
            }
            const locatingThis = locating?.bgmId === t.bgmId
            const onContinue = (sourceId: SourceId, mode: WatchMode, rebind?: boolean): void => {
              continueWatch(sourceById(sourceId), t, mode, rebind)
            }
            const onMarkGood = (): void => setMarkingGood(t.bgmId)
            const onBackfill = (): void => {
              const title = t.titleCn || t.title
              setAdding({
                initialQuery: title,
                backfill: { customBgmId: t.bgmId, title },
              })
            }
            if (view === 'list') {
              return (
                <TrackListRow
                  key={t.bgmId}
                  t={t}
                  bound={bound}
                  locating={locatingThis}
                  onContinue={onContinue}
                  onMarkGood={onMarkGood}
                  onBackfill={onBackfill}
                />
              )
            }
            return (
              <TrackCard
                key={t.bgmId}
                t={t}
                isToday={todayIds.has(t.bgmId)}
                bound={bound}
                locating={locatingThis}
                onContinue={onContinue}
                onPatch={patch}
                onStatus={(s) => setStatus(t, s)}
                onEdit={() => setEditing(t.bgmId)}
                onAskRemove={() => setConfirming(t.bgmId)}
                onMarkGood={onMarkGood}
                onBackfill={onBackfill}
                onWriteReview={() => setWritingReview(t.bgmId)}
                onMakePoster={t.publishedReviews?.length ? () => void makePoster(t) : undefined}
                posterBusy={posterBusy}
              />
            )
          })}
          {visibleCount < filtered.length && (
            <div ref={moreRef} className="trk-more">
              {typeof IntersectionObserver === 'undefined' && (
                <button type="button" className="btn btn-ghost" onClick={showMore}>加载更多</button>
              )}
            </div>
          )}
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
            setSearchFlow({ source: pickerFlow.source, track: pickerFlow.track, mode: pickerFlow.mode, agentAction: pickerFlow.agentAction })
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
          key={adding.backfill ? `backfill:${adding.backfill.customBgmId}` : 'new'}
          trackedIds={new Set(animeTracks.map((t) => t.bgmId))}
          onAdd={addFromSearch}
          onAddCustom={addCustom}
          initialQuery={adding.initialQuery}
          backfill={adding.backfill}
          onBackfill={backfill}
          onClose={() => setAdding(null)}
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

      {writingReviewTrack && (
        <ReviewAssistantModal track={writingReviewTrack} onClose={() => setWritingReview(null)} />
      )}

      {poster && (
        <PosterModal input={poster} fileTitle={poster.titleCn} onClose={() => setPoster(null)} />
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
  const [tagQuery, setTagQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const tagSearch = useRef<HTMLInputElement>(null)

  // mousedown 而非 click —— 勾选会重建列表，click 冒泡上来时 e.target 已不在 DOM 上，
  // contains 判 false，弹窗会自己关掉（Select.tsx 同款写法）
  useEffect(() => {
    if (!open) {
      setTagQuery('')
      return
    }
    const focusTimer = window.setTimeout(() => tagSearch.current?.focus(), 0)
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (t: string): void => {
    const next = new Set(selected)
    next.has(t) ? next.delete(t) : next.add(t)
    onChange(next)
  }

  const visibleTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase()
    return q ? all.filter(([tag]) => tag.toLowerCase().includes(q)) : all
  }, [all, tagQuery])

  return (
    <div ref={box} className={`dd-host${open ? ' open' : ''}`}>
      <button
        type="button"
        className="dd-trigger"
        style={{ minWidth: 128 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dd-val">类型</span>
        {/* invisible 不用 hidden —— hidden 脱离文档流，角标一出现就把按钮撑宽（AGENTS：
            临时状态要留常驻空位，两态盒子尺寸不变） */}
        <span className="tagx mine" style={{ visibility: selected.size ? 'visible' : 'hidden' }}>
          {selected.size}
        </span>
        <Ic name="chev" cls="ic" />
      </button>

      {open && (
        <div className="dd dd-tag-filter">
          <div className="tag-filter-search">
            <Ic name="search" cls="ic ic-sm" />
            <input
              ref={tagSearch}
              type="text"
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
              placeholder="搜标签…"
              aria-label="搜索标签"
              autoComplete="off"
              spellCheck={false}
            />
            {tagQuery && (
              <button type="button" className="tag-filter-clear-search" onClick={() => setTagQuery('')} aria-label="清空标签搜索">
                <Ic name="x" cls="ic ic-sm" />
              </button>
            )}
          </div>

          <div className="tag-filter-list">
            {all.length === 0 ? (
              <p className="sugg-note">还没有标签</p>
            ) : visibleTags.length === 0 ? (
              <p className="sugg-note">没有匹配的标签</p>
            ) : (
              visibleTags.map(([t, n]) => (
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
          </div>

          {selected.size > 0 && (
            <button type="button" className="dd-item tag-filter-clear-all" onClick={() => onChange(new Set())}>
              清空过滤
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── 查看方式 ──────────────────────────────────────────────────────────────────
function ViewModeToggle({
  value,
  onChange,
}: {
  value: TrackView
  onChange: (value: TrackView) => void
}): JSX.Element {
  return (
    <div className="view-mode" role="group" aria-label="追番查看方式">
      <button type="button" className={value === 'cards' ? 'on' : ''} aria-pressed={value === 'cards'} onClick={() => onChange('cards')}>
        卡片
      </button>
      <button type="button" className={value === 'list' ? 'on' : ''} aria-pressed={value === 'list'} onClick={() => onChange('list')}>
        列表
      </button>
    </div>
  )
}

// ── 空态 ─────────────────────────────────────────────────────
function EmptyState({ text }: { text: string }): JSX.Element {
  return (
    <div className="empty panel mt16">
      <p className="empty-text">{text}</p>
    </div>
  )
}

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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type {
  AnimeHit,
  BgmImportStatus,
  GirigiriBinding,
  GirigiriCandidate,
  GirigiriSearchHit,
  Track,
  TrackPatch,
  TrackStatus,
  XifanBinding,
  XifanCandidate,
  XifanSearchHit,
} from './api'
import {
  bindGirigiri,
  bindXifan,
  coverUrl,
  deleteTrack,
  fetchGirigiriCaptcha,
  fetchXifanCaptcha,
  girigiriPlayPageUrl,
  importTracksFromBgm,
  locateGirigiri,
  locateXifan,
  playPageUrl,
  putTrack,
  searchAnime,
  searchGirigiri,
  searchXifan,
  uploadTrackCover,
  verifyGirigiriCaptcha,
  verifyXifanCaptcha,
  XIFAN_CAPTCHA_EVENT_KEY,
} from './api'
import { isRecentAir } from '../shared/anime-age'
import { useAuth } from './auth'
import { cacheGet } from './dataCache'
import type { CalendarResult } from './api'
import { Ic, Spinner } from './SketchIcon'
import { toast } from './Toast'
import {
  loadBindings,
  loadGirigiriBindings,
  loadTracks,
  runTracksMutation,
  saveBindingsCache,
  saveGirigiriBindingsCache,
  saveTracksCache,
} from './tracksSync'

const SHORT_DAY: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
const STATUS_META: { key: TrackStatus; label: string }[] = [
  { key: 'watching', label: '在追' },
  { key: 'plan', label: '想看' },
  { key: 'considering', label: '观望' },
  { key: 'done', label: '看完' },
]
// 状态分段的展示顺序（想看 → 观望 → 在追 → 看完）与印章配色（银 / 薰衣草 / 青 / 金）
const SEG_ORDER: TrackStatus[] = ['plan', 'considering', 'watching', 'done']
const SEG_CLS: Record<TrackStatus, string> = { plan: 'wish', considering: 'watch', watching: 'doing', done: 'done' }
const STAMP_CLS: Record<TrackStatus, string> = { plan: 'st-silver', considering: 'st-lav', watching: 'st-teal', done: 'st-gold' }
type FilterKey = 'all' | TrackStatus

function todayBgmId(): number {
  const d = new Date().getDay()
  return d === 0 ? 7 : d
}

const allTagsOf = (t: Track): string[] => [...t.bgmTags, ...t.userTags]

// 与 server/tracks.ts 的 USER_TAG_MAX_COUNT 对齐。前端先拦一道：不拦的话乐观更新会先
// 贴上第 13 个标签、再被后端 400 回滚，用户看到的是「贴上了又消失」。
const USER_TAG_MAX = 12
/** 超限时的统一反馈：走便签 Toast（红字警示条离标签输入太远，看不见） */
function tagLimitToast(): void {
  toast(`这部番的自定义标签已经贴满 ${USER_TAG_MAX} 个啦，先撕掉一张再贴吧`, { err: true })
}

// 卡片上的计数就是当前要看的那一集:显示 N 就播 N,还没开始(0)则从第 1 集起。
// 同时夹到总集数上限,避免异常同步数据生成不存在的集数链接。
function watchEp(t: Track): number {
  const n = t.totalEpisodes != null ? Math.min(t.totalEpisodes, t.episode) : t.episode
  return Math.max(1, n)
}

// 定位用的标题集合 —— 中文名 / 别名最可能对上简体中文站,日文原名兜底。
const titlesOf = (t: Track): string[] => [t.titleCn, ...t.aliases, t.title].filter(Boolean)

// 「新番 / 老番」分流 —— 源站的番剧周表只列**在播**的番,老番在里面必然查不到,
// 拿老番去走一趟周表定位是纯浪费(冷缓存那次还要等源站抓 7 天)。判据见 shared/anime-age.ts,
// 跟服务端「要不要自动填总集数」用的是同一把尺,不要在这儿另立一套。
const isRecentAnime = (t: Track): boolean => isRecentAir(t.airDate)

interface PickerState {
  track: Track
  candidates: XifanCandidate[]
}

interface GirigiriPickerState {
  track: Track
  candidates: GirigiriCandidate[]
}

/** 标题 / 别名命中(网页版没有备注字段) */
function matches(t: Track, q: string): boolean {
  if (!q) return true
  const hay = [t.title, t.titleCn, ...t.aliases].join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
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
  // 稀饭绑定：bgmId → {xifanId,xifanName}。加载时一次拿齐，绑过的「继续看」直接是链接。
  const [bindings, setBindings] = useState<Record<number, XifanBinding>>({})
  // Girigiri 绑定独立维护；两个站点的编号没有可推断关系。
  const [girigiriBindings, setGirigiriBindings] = useState<Record<number, GirigiriBinding>>({})
  const [locating, setLocating] = useState<number | null>(null) // 正在定位的 bgmId（转圈用）
  const [girigiriLocating, setGirigiriLocating] = useState<number | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [girigiriPicker, setGirigiriPicker] = useState<GirigiriPickerState | null>(null)
  const [searchTrack, setSearchTrack] = useState<Track | null>(null)
  const [girigiriSearchTrack, setGirigiriSearchTrack] = useState<Track | null>(null)
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
      setBindings({})
      setGirigiriBindings({})
      return
    }
    const stopTracks = loadTracks(user.username, setTracks, setTracksError)
    const stopBindings = loadBindings(user.username, setBindings)
    const stopGirigiriBindings = loadGirigiriBindings(user.username, setGirigiriBindings)
    return () => {
      stopTracks()
      stopBindings()
      stopGirigiriBindings()
    }
  }, [ready, user])

  // 状态一变就同步写回缓存 —— 这样切去周历页再切回来、或下次挂载,直接复用最新状态
  // 不用再等一轮网络。
  useEffect(() => {
    if (user && tracks) saveTracksCache(user.username, tracks)
  }, [user, tracks])
  useEffect(() => {
    if (user) saveBindingsCache(user.username, bindings)
  }, [user, bindings])
  useEffect(() => {
    if (user) saveGirigiriBindingsCache(user.username, girigiriBindings)
  }, [user, girigiriBindings])

  // 未绑定的「继续看」：老番跳过周表直接进搜索；新番去周表定位 → 有候选就弹选择框让用户确认
  // （= 建绑定）。零候选说明周表里没有（名字对不上 / 判新老判错了），**不弹空框**，直接落到
  // 搜索 —— 空框的唯一用途就是让用户再点一次「去搜索」。
  const continueWatch = (t: Track): void => {
    if (locating != null) return
    if (!isRecentAnime(t)) {
      setSearchTrack(t)
      return
    }
    setLocating(t.bgmId)
    locateXifan(t.bgmId, titlesOf(t))
      .then((r) => {
        if (r.bound) {
          // 极少见：加载后别的用户刚绑上 → 记下来（卡片下次即变链接），并尽力开一下
          setBindings((prev) => ({ ...prev, [t.bgmId]: { xifanId: r.bound!.xifanId, xifanName: r.bound!.xifanName } }))
          window.open(playPageUrl(r.bound.xifanId, watchEp(t), t.bgmId), '_blank', 'noopener')
        } else if (r.candidates.length) {
          setPicker({ track: t, candidates: r.candidates })
        } else {
          setSearchTrack(t)
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLocating(null))
  }

  // 用户在选择框点了某个候选 = 确认绑定：落库 + 本地记下（卡片即变链接）。开播由候选行自身的链接完成。
  const confirmBind = (bgmId: number, cand: XifanCandidate): void => {
    const previous = bindings[bgmId]
    setBindings((prev) => ({ ...prev, [bgmId]: { xifanId: cand.xifanId, xifanName: cand.xifanName } }))
    setPicker(null)
    void bindXifan(bgmId, cand.xifanId, cand.xifanName).catch((e: Error) => {
      setError(e.message)
      setBindings((prev) => {
        const next = { ...prev }
        if (previous) next[bgmId] = previous
        else delete next[bgmId]
        return next
      })
    })
  }

  // Girigiri 定位与稀饭同形，但状态、绑定和候选严格分开。
  const continueGirigiri = (t: Track): void => {
    if (girigiriLocating != null) return
    if (!isRecentAnime(t)) {
      setGirigiriSearchTrack(t)
      return
    }
    setGirigiriLocating(t.bgmId)
    locateGirigiri(t.bgmId, titlesOf(t))
      .then((result) => {
        if (result.bound) {
          setGirigiriBindings((prev) => ({
            ...prev,
            [t.bgmId]: { girigiriId: result.bound!.girigiriId, girigiriName: result.bound!.girigiriName },
          }))
          window.open(girigiriPlayPageUrl(result.bound.girigiriId, watchEp(t), t.bgmId), '_blank', 'noopener')
        } else if (result.candidates.length) {
          setGirigiriPicker({ track: t, candidates: result.candidates })
        } else {
          setGirigiriSearchTrack(t)
        }
      })
      .catch((error: Error) => setError(error.message))
      .finally(() => setGirigiriLocating(null))
  }

  const confirmGirigiriBind = (bgmId: number, candidate: GirigiriCandidate): void => {
    const previous = girigiriBindings[bgmId]
    setGirigiriBindings((prev) => ({
      ...prev,
      [bgmId]: { girigiriId: candidate.girigiriId, girigiriName: candidate.girigiriName },
    }))
    setGirigiriPicker(null)
    void bindGirigiri(bgmId, candidate.girigiriId, candidate.girigiriName).catch((error: Error) => {
      setError(error.message)
      setGirigiriBindings((prev) => {
        const next = { ...prev }
        if (previous) next[bgmId] = previous
        else delete next[bgmId]
        return next
      })
    })
  }

  // 搜索结果也走一次显式确认:点结果行时先落绑定,**再用原生链接**打开播放页 ——
  // 异步请求会吃掉浏览器的弹窗手势。
  const confirmSearchBind = (hit: XifanSearchHit): void => {
    const t = searchTrack
    if (!t) return
    const remarks = [hit.episode, hit.year, hit.area].filter(Boolean).join(' · ')
    setSearchTrack(null)
    confirmBind(t.bgmId, {
      xifanId: hit.xifanId,
      xifanName: hit.xifanName,
      day: 0,
      remarks,
      score: 0,
    })
  }

  const confirmGirigiriSearchBind = (hit: GirigiriSearchHit): void => {
    const track = girigiriSearchTrack
    if (!track) return
    const remarks = [hit.episode, hit.year, hit.area].filter(Boolean).join(' · ')
    setGirigiriSearchTrack(null)
    confirmGirigiriBind(track.bgmId, {
      girigiriId: hit.girigiriId,
      girigiriName: hit.girigiriName,
      day: 0,
      remarks,
      score: 0,
    })
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
      observeCount: 0, updatedAt: Date.now(),
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

  const counts = useMemo(() => {
    const c = { all: 0, watching: 0, plan: 0, considering: 0, done: 0 }
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
    const isToday = (t: Track) => t.airWeekday === today && t.status !== 'done' && isRecentAir(t.airDate)
    return [...list].sort((a, b) => Number(isToday(b)) - Number(isToday(a)))
  }, [tracks, filter, query, tags, today])

  const allTags = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of tracks ?? []) for (const x of allTagsOf(t)) m.set(x, (m.get(x) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [tracks])

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
  const editingTrack = tracks?.find((t) => t.bgmId === editing) ?? null
  const confirmingTrack = tracks?.find((t) => t.bgmId === confirming) ?? null

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
            <Card
              key={t.bgmId}
              t={t}
              isToday={todayIds.has(t.bgmId)}
              binding={bindings[t.bgmId]}
              girigiriBinding={girigiriBindings[t.bgmId]}
              locating={locating === t.bgmId}
              girigiriLocating={girigiriLocating === t.bgmId}
              onContinue={() => continueWatch(t)}
              onContinueGirigiri={() => continueGirigiri(t)}
              onPatch={patch}
              onStatus={(s) => setStatus(t, s)}
              onEdit={() => setEditing(t.bgmId)}
              onAskRemove={() => setConfirming(t.bgmId)}
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

      {picker && (
        <BindPickerModal
          picker={picker}
          onPick={(cand) => confirmBind(picker.track.bgmId, cand)}
          onSearch={() => {
            setPicker(null)
            setSearchTrack(picker.track)
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {searchTrack && (
        <XifanSearchModal
          track={searchTrack}
          onPick={confirmSearchBind}
          onClose={() => setSearchTrack(null)}
        />
      )}

      {girigiriPicker && (
        <GirigiriBindPickerModal
          picker={girigiriPicker}
          onPick={(candidate) => confirmGirigiriBind(girigiriPicker.track.bgmId, candidate)}
          onSearch={() => {
            setGirigiriPicker(null)
            setGirigiriSearchTrack(girigiriPicker.track)
          }}
          onClose={() => setGirigiriPicker(null)}
        />
      )}

      {girigiriSearchTrack && (
        <GirigiriSearchModal
          track={girigiriSearchTrack}
          onPick={confirmGirigiriSearchBind}
          onClose={() => setGirigiriSearchTrack(null)}
        />
      )}

      {adding && (
        <AddSearchModal
          trackedIds={new Set((tracks ?? []).map((t) => t.bgmId))}
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
    </>
  )
}

function emptyImportStatus(state: BgmImportStatus['state'] = 'running'): BgmImportStatus {
  return { state, total: 0, processed: 0, added: 0, updated: 0, failed: 0, error: null }
}

function BgmImportModal({
  initialUserId,
  onImport,
  onClose,
}: {
  initialUserId: string
  onImport: (bgmUserId: string, onProgress: (status: BgmImportStatus) => void) => Promise<BgmImportStatus>
  onClose: () => void
}): JSX.Element {
  const [bgmUserId, setBgmUserId] = useState(initialUserId)
  const [view, setView] = useState<'idle' | BgmImportStatus['state']>('idle')
  const [status, setStatus] = useState<BgmImportStatus>(() => emptyImportStatus())
  const mounted = useRef(true)
  const busy = view === 'running'

  useEffect(() => {
    // StrictMode 会执行 setup → cleanup → setup；第二次 setup 必须把标记恢复。
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const start = async (): Promise<void> => {
    const userId = bgmUserId.trim()
    if (!userId) {
      setView('error')
      setStatus({ ...emptyImportStatus('error'), error: '请输入 Bangumi UID 或用户名' })
      return
    }

    setView('running')
    setStatus(emptyImportStatus())
    try {
      const result = await onImport(userId, (next) => {
        if (!mounted.current) return
        setStatus(next)
        setView(next.state)
      })
      if (!mounted.current) return
      setStatus(result)
      setView(result.state)
      if (result.state === 'done') {
        toast(`Bangumi 导入完成：新增 ${result.added} 部，更新 ${result.updated} 部`)
      }
    } catch (error) {
      if (!mounted.current) return
      setView('error')
      setStatus((previous) => ({
        ...previous,
        state: 'error',
        error: error instanceof Error ? error.message : 'Bangumi 导入失败',
      }))
    }
  }

  const percentage = status.total > 0
    ? Math.min(100, Math.round((status.processed / status.total) * 100))
    : view === 'done' ? 100 : 0
  const progressText = view === 'idle'
    ? '等待开始导入'
    : view === 'running'
      ? status.total > 0
        ? `已处理 ${status.processed}/${status.total} 部${status.processed < status.total ? ` · 正在处理第 ${status.processed + 1} 部` : ''}`
        : '正在读取 Bangumi 收藏…'
      : view === 'done'
        ? `导入完成 · 共处理 ${status.processed}/${status.total} 部`
        : status.error || '导入没有完成'

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="从 Bangumi 导入" className="dlg bgm-import-dlg">
        <span className="tape tl teal" />
        <button
          type="button"
          className="dlg-close"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭"
          title={busy ? '导入完成后可关闭' : '关闭'}
        >
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">从 Bangumi 导入</h3>
        <p className="dlg-sub">再次导入时，Bangumi 有值的标题、进度、状态和封面会覆盖本站；自定义标签与播放绑定会保留。</p>

        <label className="field mb16" htmlFor="bgm-import-user-id">
          <span className="field-label">Bangumi UID / 用户名</span>
          <span className="field-row">
            <input
              id="bgm-import-user-id"
              type="text"
              value={bgmUserId}
              onChange={(event) => setBgmUserId(event.target.value)}
              placeholder="数字 UID 或自定义用户名"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              disabled={busy}
              autoFocus
            />
          </span>
        </label>

        <div className={`bgm-import-progress${view === 'error' ? ' has-error' : ''}`}>
          <div className="bgm-import-progress-head" aria-live="polite">
            <span>{progressText}</span>
            <b>{percentage}%</b>
          </div>
          <div
            className="prog"
            role="progressbar"
            aria-label="Bangumi 导入进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
          >
            <i style={{ width: `${percentage}%` }} />
          </div>
          <div className="bgm-import-counts">
            <div><b>{status.added}</b><span>新增</span></div>
            <div><b>{status.updated}</b><span>更新</span></div>
            <div><b>{status.failed}</b><span>失败</span></div>
          </div>
        </div>

        <div className="dlg-actions bgm-import-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>
            {view === 'idle' ? '取消' : busy ? '导入中' : '关闭'}
          </button>
          <button className="btn btn-primary" type="button" onClick={() => void start()} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Ic name="refresh" cls="ic ic-sm" />}
            {busy ? '正在导入' : view === 'done' ? '再次导入' : view === 'error' ? '重新尝试' : '开始导入'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 本地乐观更新 —— 跟服务端 patch 同样的夹取规则，免得手感和落库结果对不上 */
function applyLocal(t: Track, p: TrackPatch): Track {
  const next = { ...t, ...p } as Track
  const total = 'totalEpisodes' in p ? p.totalEpisodes ?? null : t.totalEpisodes
  if (total != null && next.episode > total) next.episode = total
  return next
}

// ── 卡片（手帐内页行卡） ───────────────────────────────────────────────────────
function Card({
  t,
  isToday,
  binding,
  girigiriBinding,
  locating,
  girigiriLocating,
  onContinue,
  onContinueGirigiri,
  onPatch,
  onStatus,
  onEdit,
  onAskRemove,
}: {
  t: Track
  isToday: boolean
  binding: XifanBinding | undefined
  girigiriBinding: GirigiriBinding | undefined
  locating: boolean
  girigiriLocating: boolean
  onContinue: () => void
  onContinueGirigiri: () => void
  onPatch: (bgmId: number, p: TrackPatch) => void
  onStatus: (s: TrackStatus) => void
  onEdit: () => void
  onAskRemove: () => void
}): JSX.Element {
  const title = t.titleCn || t.title
  const capped = t.totalEpisodes != null && t.episode >= t.totalEpisodes
  const ep = watchEp(t)
  // 卡片上的行内标签输入（＋ 标签 → 回车贴上）
  const [addingTag, setAddingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  // 进度条：有总集数按比例；连载中给个「看过的集数」渐增（原型稿同款公式）
  const pct =
    t.totalEpisodes != null
      ? Math.min(100, Math.round((t.episode / t.totalEpisodes) * 100))
      : t.episode > 0
        ? Math.min(100, 8 + t.episode * 6)
        : 0

  const commitTag = (): void => {
    const v = tagDraft.trim()
    if (v && !allTagsOf(t).includes(v)) {
      if (t.userTags.length >= USER_TAG_MAX) {
        tagLimitToast()
      } else {
        onPatch(t.bgmId, { userTags: [...t.userTags, v] })
        toast(`贴上了『${v}』标签`)
      }
    }
    setTagDraft('')
    setAddingTag(false)
  }

  const step = (delta: number): void => {
    const ep = Math.max(0, t.totalEpisodes != null ? Math.min(t.totalEpisodes, t.episode + delta) : t.episode + delta)
    const p: TrackPatch = { episode: ep }
    // 「想看」首次推进 → 自动转「在追」。反方向（推满 → 看完）**不**自动，见文件头注释。
    if (ep > 0 && t.status === 'plan') {
      p.status = 'watching'
      toast(`『${title}』开始追啦`)
    }
    onPatch(t.bgmId, p)
  }

  const considering = t.status === 'considering'
  // 0–5：翻旧的档位。次数再多也只到 5，痕迹不会无限堆下去。
  const heat = considering ? Math.min(5, t.observeCount) : undefined

  return (
    <article className={`trk-row${considering ? ' is-considering' : ''}`} data-heat={heat}>
      <span className={`tape tr ${considering ? 'lav' : isToday ? 'sakura' : 'teal'}`} />
      {considering && <WearLayer />}
      <div className="trk-cover" onClick={onEdit} title="点封面编辑" style={{ cursor: 'pointer' }}>
        {/* 「详情」角标是压在封面图上的浮层：没有封面时它会裸露在空白占位格上，
            像张贴歪的标签；此时卡片正文里的「BGM」按钮已经是同一个入口，直接不渲染 */}
        {t.cover ? (
          <>
            <img className="cover-img" src={coverUrl(t.cover)} alt={title} loading="lazy" decoding="async" />
            <a
              className="bgm-link"
              href={`https://bgm.tv/subject/${t.bgmId}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="在 Bangumi 查看"
            >
              <Ic name="external" cls="ic ic-sm" />
              详情
            </a>
          </>
        ) : (
          <div className="cover-ph">☆</div>
        )}
        {considering && <span className="cover-seal">観望中</span>}
      </div>
      <div className="trk-body">
        <div className="trk-head">
          <div className="trk-marks">
            <span
              className={`stamp small ${STAMP_CLS[t.status]}`}
            >
              {STATUS_META.find((m) => m.key === t.status)?.label}
            </span>
            {isToday && <span className="chip-today">今天更新</span>}
          </div>
          <div className="trk-title" title={title}>
            {title}
          </div>
          <span className="trk-ep">
            {considering
              ? '还没开动'
              : t.totalEpisodes != null ? `${t.episode} / ${t.totalEpisodes}` : `${t.episode} 集`}
          </span>
        </div>

        <div className="ep-ctrl">
          {/* 观望：不放集数、不放步进器、不放进度条 —— 那一套是「看到第几集」的语义 */}
          {t.status === 'considering' ? (
            <>
              <WatchMarks value={t.observeCount} onChange={(n) => onPatch(t.bgmId, { observeCount: Math.max(0, n) })} />
              <span className="wm-rule" />
            </>
          ) : (
          <>
          <div className="stepper">
            <button
              type="button"
              className="ep-minus"
              aria-label="减一集"
              onClick={() => step(-1)}
              disabled={t.episode <= 0}
            >
              <Ic name="minus" cls="ic ic-sm" />
            </button>
            <span className="ep-num">EP {t.episode}</span>
            <button
              type="button"
              className="ep-plus"
              aria-label="加一集"
              onClick={() => step(1)}
              disabled={capped}
            >
              <Ic name="plus" cls="ic ic-sm" />
            </button>
          </div>
          <div className={`prog${t.status === 'done' ? ' done' : ''}`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          </>
          )}
        </div>

        {/* 标签：BGM 标签只读；自定义标签卡片上直接增删（原型稿形态） */}
        <div className="tagx-row">
          {t.bgmTags.map((x) => (
            <span key={`b-${x}`} className="tagx" title="来自 Bangumi（不可编辑）">
              {x}
            </span>
          ))}
          {t.userTags.map((x) => (
            <span key={`u-${x}`} className="tagx mine" title={`自定义「${x}」（点击移除）`}>
              {x}
              <button
                type="button"
                aria-label={`删除标签 ${x}`}
                onClick={() => onPatch(t.bgmId, { userTags: t.userTags.filter((y) => y !== x) })}
              >
                <Ic name="x" cls="ic ic-sm" />
              </button>
            </span>
          ))}
          {addingTag ? (
            <input
              className="tagx-input"
              style={{ borderStyle: 'dashed', borderColor: 'var(--teal-line)' }}
              autoFocus
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={commitTag}
              onKeyDown={(e) => {
                // isComposing 守卫 —— 中文输入法按回车是「确认拼音」，不是「提交标签」
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitTag()
                if (e.key === 'Escape') {
                  setTagDraft('')
                  setAddingTag(false)
                }
              }}
              placeholder="回车贴上，≤20 字"
              maxLength={20}
              spellCheck={false}
            />
          ) : (
            <button type="button" className="tagx tagx-add" onClick={() => setAddingTag(true)}>
              ＋ 标签
            </button>
          )}
        </div>

        <div className="trk-actions">
          <SourcePlayAction
            cls="btn btn-sm btn-primary"
            label={considering ? '试看一集' : '继续看'}
            ep={ep}
            binding={binding ? { id: String(binding.xifanId), name: binding.xifanName } : undefined}
            href={binding ? playPageUrl(binding.xifanId, ep, t.bgmId) : undefined}
            locating={locating}
            onLocate={onContinue}
          />
          <a
            className="btn btn-sm btn-ghost"
            href={`https://bgm.tv/subject/${t.bgmId}`}
            target="_blank"
            rel="noreferrer"
            title="在 Bangumi 查看详情"
          >
            <Ic name="external" cls="ic ic-sm" />
            BGM
          </a>
          <div className="status-seg" role="group" aria-label="追番状态">
            {SEG_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                className={`seg-btn${t.status === s ? ' on' : ''}`}
                data-status={SEG_CLS[s]}
                aria-pressed={t.status === s}
                onClick={() => onStatus(s)}
              >
                {s === 'watching' && considering && t.observeCount >= NUDGE_AT && <Nudge />}
                {STATUS_META.find((m) => m.key === s)?.label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm btn-danger trk-rm" type="button" onClick={onAskRemove}>
            <Ic name="x" cls="ic ic-sm" />
            移出
          </button>
        </div>
      </div>
    </article>
  )
}

/**
 * 「瞄了一眼」印记条 —— 观望态下替掉集数步进器和进度条那一整行。
 *
 * 观望的番压根没在看，「看到第几集」的那套控件在这儿全是空转。点第 N 枚眼睛章直接记成
 * N 次，点当前最后一枚退回 N−1；盖满 5 枚之后章不再增加，靠末尾的 ＋ 继续累计，总数写成
 * 右上角那个手写小字。总数**绝对定位**：插进流里会在盖第 6 章的瞬间把 ＋ 往右顶，
 * 按钮从指尖底下跑掉。次数不设上限（跟评分类字段有意区分：一个是行为统计，一个是评分）。
 */
const WM_SLOTS = 5
function WatchMarks({ value, onChange }: { value: number; onChange: (n: number) => void }): JSX.Element {
  return (
    <div className="watchmarks" title={`观望 ${value} 次`}>
      <span className="wm-cap">瞄了</span>
      {Array.from({ length: WM_SLOTS }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          className={`wm-eye${n <= value ? ' on' : ''}`}
          aria-label={`记成观望 ${n} 次`}
          // 点当前最后一枚 = 撤回一次，省掉一个专门的「−」按钮
          onClick={() => onChange(value === n ? n - 1 : n)}
        >
          <Ic name="eye" cls="ic ic-sm" />
        </button>
      ))}
      <button type="button" className="wm-add" aria-label="再瞄一眼" onClick={() => onChange(value + 1)}>
        <Ic name="plus" cls="ic ic-sm" />
      </button>
      {value > WM_SLOTS && <span className="wm-more">{value}</span>}
    </div>
  )
}

/**
 * 翻旧痕迹层 —— 观望次数越多，这一页被翻回来看过的证据越多（铅笔线 / 补的胶带 /
 * 圈一圈 / 茶渍 / 折角）。哪一档显示哪几样全在 CSS 的 `[data-heat]` 里，这里只负责
 * 把这些痕迹摆进 DOM。整层 `pointer-events:none` 且绝对定位，翻得再旧也不动布局。
 * 铅笔波浪线和圈是 CSS 伪元素，长在标题和印记条自己身上，不在这儿。
 */
function WearLayer(): JSX.Element {
  return (
    <div className="wear" aria-hidden="true">
      <span className="w-stain s1" />
      <span className="w-stain s2" />
      <span className="w-tape" />
      <span className="w-dogear" />
    </div>
  )
}

/** 观望次数够多时，纱雾从「在追」上方探头催一句。沿用页尾立绘那套「头像 + 手写气泡」。 */
const NUDGE_AT = 4
function Nudge(): JSX.Element {
  return (
    <span className="nudge" aria-hidden="true">
      <img className="nudge-face" src="/assets/sagiri-nudge.webp" alt="" />
      <span className="bubble">追吧！</span>
    </span>
  )
}

function SourcePlayAction({
  cls,
  label,
  ep,
  binding,
  href,
  locating,
  onLocate,
}: {
  cls: string
  label: string
  ep: number
  binding?: { id: string; name: string }
  href?: string
  locating: boolean
  onLocate: () => void
}): JSX.Element {
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={`继续看：${binding?.name || binding?.id || ''} · EP ${ep}`}
        className={cls}
      >
        <Ic name="play" cls="ic ic-sm" />
        {label}
      </a>
    )
  }
  return (
    <button type="button" disabled={locating} onClick={onLocate} title={`定位稀饭片源`} className={cls}>
      {locating ? <Spinner size={12} /> : <Ic name="play" cls="ic ic-sm" />}
      <span>{locating ? '定位中…' : label}</span>
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

// ── 编辑弹窗 ───────────────────────────────────────────────────────────────────
// 没有保存按钮 —— 改完即生效。
function EditModal({
  t,
  onPatch,
  onUploadCover,
  onClose,
}: {
  t: Track
  onPatch: (bgmId: number, p: TrackPatch) => void
  onUploadCover: (bgmId: number, file: File) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [totalDraft, setTotalDraft] = useState(t.totalEpisodes != null ? String(t.totalEpisodes) : '')
  const [adding, setAdding] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const [coverEditing, setCoverEditing] = useState(false)
  const [coverUrlDraft, setCoverUrlDraft] = useState('')
  const [coverUploading, setCoverUploading] = useState(false)
  const coverFileRef = useRef<HTMLInputElement>(null)
  const title = t.titleCn || t.title
  const sub = t.titleCn && t.title !== t.titleCn ? t.title : ''
  // 副标题行只在真有内容时才占位 —— 没有副标题也没有放送日 / 评分,就当这行容器不存在。
  const subLine = [sub, t.airWeekday ? `周${SHORT_DAY[t.airWeekday]}更新` : '', t.score > 0 ? `★ ${t.score.toFixed(1)}` : '']
    .filter(Boolean)
    .join(' · ')

  const commitCoverUrl = (): void => {
    const v = coverUrlDraft.trim()
    setCoverEditing(false)
    setCoverUrlDraft('')
    if (v && v !== t.cover) onPatch(t.bgmId, { cover: v })
  }

  const pickCoverFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCoverUploading(true)
    void onUploadCover(t.bgmId, file).finally(() => setCoverUploading(false))
  }

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
    if (v && !allTagsOf(t).includes(v)) {
      if (t.userTags.length >= USER_TAG_MAX) tagLimitToast()
      else onPatch(t.bgmId, { userTags: [...t.userTags, v] })
    }
    setTagDraft('')
    setAdding(false)
  }

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="编辑追番" className="dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">{title}</h3>
        {subLine && <p className="dlg-sub">{subLine}</p>}

        <div className="mb16" style={{ display: 'flex', gap: 14 }}>
          <div className="dlg-cover-edit">
            <button
              type="button"
              className="dlg-cover-btn"
              onClick={() => {
                setCoverUrlDraft(t.cover && !t.cover.startsWith('/api/tracks/') ? t.cover : '')
                setCoverEditing((v) => !v)
              }}
              title="点击编辑封面"
              disabled={coverUploading}
            >
              {t.cover ? (
                <img className="dlg-cover" src={coverUrl(t.cover)} alt="" />
              ) : (
                <span className="dlg-cover dlg-cover-ph">{coverUploading ? <Spinner /> : '＋ 封面'}</span>
              )}
            </button>
            {coverEditing && (
              <div className="dlg-cover-pop">
                <input
                  value={coverUrlDraft}
                  onChange={(e) => setCoverUrlDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCoverUrl()
                    if (e.key === 'Escape') setCoverEditing(false)
                  }}
                  placeholder="网图 URL"
                  autoFocus
                />
                <div className="dlg-cover-pop-actions">
                  <button type="button" onClick={commitCoverUrl}>确定</button>
                  <button type="button" onClick={() => coverFileRef.current?.click()}>本地上传</button>
                </div>
                <input
                  ref={coverFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    setCoverEditing(false)
                    pickCoverFile(e)
                  }}
                />
              </div>
            )}
          </div>
          <div className="field" style={{ flex: 1, minWidth: 0 }}>
            <span className="field-label">状态</span>
            <div className="status-seg" style={{ marginLeft: 0 }} role="group" aria-label="追番状态">
              {SEG_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`seg-btn${t.status === s ? ' on' : ''}`}
                  data-status={SEG_CLS[s]}
                  aria-pressed={t.status === s}
                  onClick={() => onPatch(t.bgmId, { status: s })}
                >
                  {STATUS_META.find((m) => m.key === s)?.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="field mb16">
          <span className="field-label">进度</span>
          <div className="ep-ctrl">
            <div className="stepper">
              <button
                type="button"
                className="ep-minus"
                aria-label="减一集"
                disabled={t.episode <= 0}
                onClick={() => onPatch(t.bgmId, { episode: Math.max(0, t.episode - 1) })}
              >
                <Ic name="minus" cls="ic ic-sm" />
              </button>
              <span className="ep-num">EP {t.episode}</span>
              <button
                type="button"
                className="ep-plus"
                aria-label="加一集"
                disabled={t.totalEpisodes != null && t.episode >= t.totalEpisodes}
                onClick={() =>
                  onPatch(t.bgmId, { episode: t.episode + 1, ...(t.status === 'plan' ? { status: 'watching' as const } : {}) })
                }
              >
                <Ic name="plus" cls="ic ic-sm" />
              </button>
            </div>
            <span className="field-row" style={{ flex: 1 }}>
              <input
                value={totalDraft}
                onChange={(e) => setTotalDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={commitTotal}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTotal()
                }}
                placeholder="总集数，留空 = 连载中"
                inputMode="numeric"
                maxLength={4}
                style={{ width: '100%', maxWidth: 180 }}
              />
            </span>
          </div>
        </div>

        <div className="field">
          <span className="field-label">类型标签（BGM 的不可改 · 自定义的点一下删）</span>
          <div className="tagx-row">
            {t.bgmTags.map((x) => (
              <span key={`b-${x}`} className="tagx" title="来自 Bangumi（不可编辑）">
                {x}
              </span>
            ))}
            {t.userTags.map((x) => (
              <span key={`u-${x}`} className="tagx mine" title={`自定义「${x}」（点击移除）`}>
                {x}
                <button type="button" aria-label={`删除标签 ${x}`} onClick={() => onPatch(t.bgmId, { userTags: t.userTags.filter((y) => y !== x) })}>
                  <Ic name="x" cls="ic ic-sm" />
                </button>
              </span>
            ))}
            {adding ? (
              <input
                className="tagx-input"
                style={{ borderStyle: 'dashed', borderColor: 'var(--teal-line)' }}
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
              />
            ) : (
              <button type="button" className="tagx tagx-add" onClick={() => setAdding(true)}>
                ＋ 标签
              </button>
            )}
          </div>
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
  // 会一并丢失的本地数据 —— 有才提，让用户据此判断
  const lost: string[] = []
  if (t.episode > 0) lost.push(`第 ${t.episode} 集的进度`)
  if (t.userTags.length > 0) lost.push(`${t.userTags.length} 个自定义标签`)

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="移出追番" className="dlg">
        <span className="tape tl sakura" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>
        <h3 className="dlg-title">移出追番</h3>
        <p className="dlg-sub">
          确定把『<b style={{ color: 'var(--sakura)' }}>{title}</b>』从手帐里撕掉吗？
          {lost.length > 0 && <span className="faint">{lost.join(' 和 ')}会一并删除，无法恢复。</span>}
        </p>
        <div className="dlg-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            先留着
          </button>
          <button className="btn btn-danger" type="button" onClick={onConfirm}>
            <Ic name="x" cls="ic ic-sm" />
            移除
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
  onSearch,
  onClose,
}: {
  picker: PickerState
  onPick: (cand: XifanCandidate) => void
  onSearch: () => void
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
  const ep = watchEp(track)

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="选择稀饭片源" className="dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">{title}</h3>
        <p className="dlg-sub">
          稀饭用的是另一套编号，按名字匹配出以下几部。<b>点一下确认是哪部</b>，之后就记住、直接开播（EP {ep}）。
        </p>

        {/* candidates 必非空：零候选由 continueWatch 直接落到搜索弹窗，不会走到这里 */}
        <div className="cand-list custom-scrollbar">
          {candidates.map((c) => (
            <a
              key={c.xifanId}
              className="sugg-item"
              href={playPageUrl(c.xifanId, ep, track.bgmId)}
              target="_blank"
              rel="noreferrer"
              onClick={() => onPick(c)}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {c.xifanName || `稀饭 #${c.xifanId}`}
              </span>
              <span className="sugg-meta">
                {c.day ? `周${SHORT_DAY[c.day]}` : ''}
                {c.remarks ? `${c.day ? ' · ' : ''}${c.remarks.replace('|', ' · ')}` : ''}
              </span>
              <Ic name="play" cls="ic ic-sm" />
            </a>
          ))}
        </div>

        <button className="btn btn-sm btn-ghost btn-block mt16" type="button" onClick={onSearch}>
          <Ic name="search" cls="ic ic-sm" />
          搜索稀饭全站资源
        </button>
      </div>
    </div>
  )
}

function GirigiriBindPickerModal({
  picker,
  onPick,
  onSearch,
  onClose,
}: {
  picker: GirigiriPickerState
  onPick: (candidate: GirigiriCandidate) => void
  onSearch: () => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { track, candidates } = picker
  const title = track.titleCn || track.title
  const ep = watchEp(track)
  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="选择 Girigiri 片源" className="dlg">
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>
        <h3 className="dlg-title">{title}</h3>
        <p className="dlg-sub">
          Girigiri 用的是另一套编号，按名字匹配出以下候选。<b>点一下确认是哪部</b>，之后就记住、直接开播（EP {ep}）。
        </p>
        {/* candidates 必非空：零候选由 continueGirigiri 直接落到搜索弹窗，不会走到这里 */}
        <div className="cand-list custom-scrollbar">
          {candidates.map((candidate) => (
            <a
              key={candidate.girigiriId}
              className="sugg-item"
              href={girigiriPlayPageUrl(candidate.girigiriId, ep, track.bgmId)}
              target="_blank"
              rel="noreferrer"
              onClick={() => onPick(candidate)}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {candidate.girigiriName || candidate.girigiriId}
              </span>
              <span className="sugg-meta">
                {candidate.day ? `周${SHORT_DAY[candidate.day]}` : ''}
                {candidate.remarks ? `${candidate.day ? ' · ' : ''}${candidate.remarks.replace('|', ' · ')}` : ''}
              </span>
              <Ic name="play" cls="ic ic-sm" />
            </a>
          ))}
        </div>
        <button className="btn btn-sm btn-ghost btn-block mt16" type="button" onClick={onSearch}>
          <Ic name="search" cls="ic ic-sm" />
          搜索 Girigiri 全站资源
        </button>
      </div>
    </div>
  )
}

// ── 稀饭全站搜索弹窗 ─────────────────────────────────────────────────────────────
// 周表定位只覆盖当季在播；旧番 / 剧场版改走稀饭搜索。搜索页有站点验证码，流程与桌面
// 端一致：搜索 → 验证码 → 重搜 → 用户点结果确认绑定。结果行保留原生链接，点一下同时
// 完成绑定并打开播放页，不让异步绑定请求吃掉新标签页的用户手势。
type XifanSearchModalStatus = 'searching' | 'captcha' | 'verifying' | 'results' | 'error'

function XifanSearchModal({
  track,
  onPick,
  onClose,
}: {
  track: Track
  onPick: (hit: XifanSearchHit) => void
  onClose: () => void
}): JSX.Element {
  const initialKeyword = track.titleCn || track.title
  const [keyword, setKeyword] = useState(initialKeyword)
  const [status, setStatus] = useState<XifanSearchModalStatus>('searching')
  const [results, setResults] = useState<XifanSearchHit[]>([])
  const [imageB64, setImageB64] = useState('')
  const [mime, setMime] = useState('image/png')
  const [captchaInput, setCaptchaInput] = useState('')
  const [message, setMessage] = useState('')
  const started = useRef(false)
  const captchaGeneration = useRef(0)
  const captchaActive = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (
        event.key !== XIFAN_CAPTCHA_EVENT_KEY
        || (!captchaActive.current && status !== 'captcha' && status !== 'verifying')
      ) return
      captchaGeneration.current += 1
      captchaActive.current = false
      setImageB64('')
      setCaptchaInput('')
      setMessage('验证码已在其他页面刷新，请重新获取')
      setStatus('captcha')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [status])

  const refreshCaptcha = async (errorMessage = ''): Promise<void> => {
    const generation = ++captchaGeneration.current
    captchaActive.current = true
    setImageB64('')
    setCaptchaInput('')
    setStatus('captcha')
    try {
      const captcha = await fetchXifanCaptcha()
      if (generation !== captchaGeneration.current) return
      setImageB64(captcha.imageB64)
      setMime(captcha.mime || 'image/png')
      setCaptchaInput('')
      setMessage(errorMessage)
      setStatus('captcha')
    } catch (e) {
      if (generation !== captchaGeneration.current) return
      setStatus('error')
      setMessage(e instanceof Error ? e.message : '验证码请求失败')
    } finally {
      if (generation === captchaGeneration.current) captchaActive.current = false
    }
  }

  const runSearch = async (rawKeyword: string): Promise<void> => {
    const q = rawKeyword.trim()
    if (!q) return
    setKeyword(q)
    setResults([])
    setMessage('')
    setStatus('searching')
    try {
      const result = await searchXifan(q)
      if (result.needsCaptcha) {
        await refreshCaptcha()
      } else {
        setResults(result.data)
        setStatus('results')
      }
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : '稀饭搜索失败')
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void runSearch(initialKeyword)
  }, [])

  const verify = async (): Promise<void> => {
    const code = captchaInput.trim()
    if (!code || status !== 'captcha') return
    setStatus('verifying')
    const generation = captchaGeneration.current
    try {
      const result = await verifyXifanCaptcha(code)
      if (generation !== captchaGeneration.current) return
      if (!result.success) {
        await refreshCaptcha('验证码不正确，请重新输入')
        return
      }
      await runSearch(keyword)
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : '验证码校验失败')
    }
  }

  const title = track.titleCn || track.title
  const ep = watchEp(track)

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="稀饭全站搜索"
        className="dlg"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '86vh' }}
      >
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">稀饭全站搜索</h3>
        <p className="dlg-sub">
          {title} · 点选正确条目后直接播放 EP {ep}
        </p>

        <div className="field-row mb16">
          <input
            value={keyword}
            spellCheck={false}
            autoComplete="off"
            maxLength={100}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void runSearch(keyword)
            }}
            placeholder="番名 / 别名"
            disabled={status === 'searching' || status === 'verifying'}
          />
          <button
            className="btn btn-sm btn-primary"
            style={{ flex: 'none', marginLeft: 8 }}
            type="button"
            onClick={() => { void runSearch(keyword) }}
            disabled={status === 'searching' || status === 'verifying' || !keyword.trim()}
          >
            <Ic name="search" cls="ic ic-sm" />
            搜索
          </button>
        </div>

        <div className="dlg-scroll custom-scrollbar">
          {status === 'searching' || status === 'verifying' ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Spinner size={28} />
              <span className="faint small">{status === 'verifying' ? '正在校验验证码' : '正在搜索稀饭'}</span>
            </div>
          ) : status === 'captcha' ? (
            <div>
              <div className="row mb16" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>需要验证码</b>
                  <p className="faint small mt8">输入图片中的字符后继续搜索。</p>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 34, height: 34 }}
                  onClick={() => { void refreshCaptcha() }}
                  title="刷新验证码"
                  aria-label="刷新验证码"
                >
                  <Ic name="refresh" cls="ic ic-sm" />
                </button>
              </div>
              <div className="captcha-img mb16">
                {imageB64 && <img src={`data:${mime};base64,${imageB64}`} alt="稀饭验证码" />}
              </div>
              {message && <p className="form-note err" style={{ marginTop: 0 }}>{message}</p>}
              <div className="field-row">
                <input
                  type="text"
                  autoFocus
                  disabled={!imageB64}
                  value={captchaInput}
                  onChange={(e) => setCaptchaInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && captchaInput.trim()) void verify()
                  }}
                  placeholder="输入验证码"
                  style={{ letterSpacing: '.2em' }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  style={{ flex: 'none', marginLeft: 8 }}
                  type="button"
                  onClick={() => { void verify() }}
                  disabled={!imageB64 || !captchaInput.trim()}
                >
                  验证
                </button>
              </div>
            </div>
          ) : status === 'error' ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Ic name="alert" cls="ic" />
              <p className="small" style={{ color: 'var(--sakura)', maxWidth: 360 }}>{message || '稀饭搜索失败'}</p>
              <button className="btn btn-sm" type="button" onClick={() => { void runSearch(keyword) }}>
                <Ic name="refresh" cls="ic ic-sm" />
                再试一次
              </button>
            </div>
          ) : results.length === 0 ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Ic name="search" cls="ic" />
              <p className="small">没有找到“{keyword}”相关的稀饭资源</p>
              <p className="faint small">换一个中文名、别名或关键词再搜。</p>
            </div>
          ) : (
            <div>
              <p className="field-label mb16">搜索结果 · {results.length} 部</p>
              <div className="cand-list custom-scrollbar" style={{ maxHeight: '45vh' }}>
                {results.map((hit) => {
                  const meta = [hit.episode, hit.year, hit.area].filter(Boolean).join(' · ')
                  return (
                    <a
                      key={hit.xifanId}
                      className="sugg-item"
                      href={playPageUrl(hit.xifanId, ep, track.bgmId)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => onPick(hit)}
                    >
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {hit.xifanName}
                      </span>
                      {meta && <span className="sugg-meta">{meta}</span>}
                      <Ic name="play" cls="ic ic-sm" />
                    </a>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Girigiri 全站搜索弹窗 ──────────────────────────────────────────────────────
// Girigiri 的搜索验证码和稀饭是两套会话，界面沿用同一套交互，但请求走独立的 API。
// 结果行仍保留原生链接：点击时先建绑定，再让浏览器在用户手势内打开播放页。
type GirigiriSearchModalStatus = 'searching' | 'captcha' | 'verifying' | 'results' | 'error'

function GirigiriSearchModal({
  track,
  onPick,
  onClose,
}: {
  track: Track
  onPick: (hit: GirigiriSearchHit) => void
  onClose: () => void
}): JSX.Element {
  const initialKeyword = track.titleCn || track.title
  const [keyword, setKeyword] = useState(initialKeyword)
  const [status, setStatus] = useState<GirigiriSearchModalStatus>('searching')
  const [results, setResults] = useState<GirigiriSearchHit[]>([])
  const [imageB64, setImageB64] = useState('')
  const [mime, setMime] = useState('image/png')
  const [captchaInput, setCaptchaInput] = useState('')
  const [message, setMessage] = useState('')
  const started = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const refreshCaptcha = async (errorMessage = ''): Promise<void> => {
    try {
      const captcha = await fetchGirigiriCaptcha()
      setImageB64(captcha.imageB64)
      setMime(captcha.mime || 'image/png')
      setCaptchaInput('')
      setMessage(errorMessage)
      setStatus('captcha')
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : '验证码请求失败')
    }
  }

  const runSearch = async (rawKeyword: string): Promise<void> => {
    const q = rawKeyword.trim()
    if (!q) return
    setKeyword(q)
    setResults([])
    setMessage('')
    setStatus('searching')
    try {
      const result = await searchGirigiri(q)
      if (result.needsCaptcha) {
        await refreshCaptcha()
      } else {
        setResults(result.data)
        setStatus('results')
      }
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : 'Girigiri 搜索失败')
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void runSearch(initialKeyword)
  }, [])

  const verify = async (): Promise<void> => {
    const code = captchaInput.trim()
    if (!code || status !== 'captcha') return
    setStatus('verifying')
    try {
      const result = await verifyGirigiriCaptcha(code)
      if (!result.success) {
        await refreshCaptcha('验证码不正确，请重新输入')
        return
      }
      await runSearch(keyword)
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : '验证码校验失败')
    }
  }

  const title = track.titleCn || track.title
  const ep = watchEp(track)

  return (
    <div
      className="dlg-backdrop open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Girigiri 全站搜索"
        className="dlg"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '86vh' }}
      >
        <span className="tape tl teal" />
        <button type="button" className="dlg-close" onClick={onClose} aria-label="关闭" title="关闭">
          <Ic name="x" cls="ic" />
        </button>

        <h3 className="dlg-title">Girigiri 全站搜索</h3>
        <p className="dlg-sub">
          {title} · 点选正确条目后直接播放 EP {ep}
        </p>

        <div className="field-row mb16">
          <input
            value={keyword}
            spellCheck={false}
            autoComplete="off"
            maxLength={100}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void runSearch(keyword)
            }}
            placeholder="番名 / 别名"
            disabled={status === 'searching' || status === 'verifying'}
          />
          <button
            className="btn btn-sm btn-primary"
            style={{ flex: 'none', marginLeft: 8 }}
            type="button"
            onClick={() => { void runSearch(keyword) }}
            disabled={status === 'searching' || status === 'verifying' || !keyword.trim()}
          >
            <Ic name="search" cls="ic ic-sm" />
            搜索
          </button>
        </div>

        <div className="dlg-scroll custom-scrollbar">
          {status === 'searching' || status === 'verifying' ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Spinner size={28} />
              <span className="faint small">{status === 'verifying' ? '正在校验验证码' : '正在搜索 Girigiri'}</span>
            </div>
          ) : status === 'captcha' ? (
            <div>
              <div className="row mb16" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>需要验证码</b>
                  <p className="faint small mt8">输入图片中的字符后继续搜索。</p>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 34, height: 34 }}
                  onClick={() => { void refreshCaptcha() }}
                  title="刷新验证码"
                  aria-label="刷新验证码"
                >
                  <Ic name="refresh" cls="ic ic-sm" />
                </button>
              </div>
              <div className="captcha-img mb16">
                {imageB64 && <img src={`data:${mime};base64,${imageB64}`} alt="Girigiri 验证码" />}
              </div>
              {message && <p className="form-note err" style={{ marginTop: 0 }}>{message}</p>}
              <div className="field-row">
                <input
                  type="text"
                  autoFocus
                  value={captchaInput}
                  onChange={(e) => setCaptchaInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && captchaInput.trim()) void verify()
                  }}
                  placeholder="输入验证码"
                  style={{ letterSpacing: '.2em' }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  style={{ flex: 'none', marginLeft: 8 }}
                  type="button"
                  onClick={() => { void verify() }}
                  disabled={!captchaInput.trim()}
                >
                  验证
                </button>
              </div>
            </div>
          ) : status === 'error' ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Ic name="alert" cls="ic" />
              <p className="small" style={{ color: 'var(--sakura)', maxWidth: 360 }}>{message || 'Girigiri 搜索失败'}</p>
              <button className="btn btn-sm" type="button" onClick={() => { void runSearch(keyword) }}>
                <Ic name="refresh" cls="ic ic-sm" />
                再试一次
              </button>
            </div>
          ) : results.length === 0 ? (
            <div className="page-state" style={{ padding: '48px 12px' }}>
              <Ic name="search" cls="ic" />
              <p className="small">没有找到“{keyword}”相关的 Girigiri 资源</p>
              <p className="faint small">换一个中文名、别名或关键词再搜。</p>
            </div>
          ) : (
            <div>
              <p className="field-label mb16">搜索结果 · {results.length} 部</p>
              <div className="cand-list custom-scrollbar" style={{ maxHeight: '45vh' }}>
                {results.map((hit) => {
                  const meta = [hit.episode, hit.year, hit.area].filter(Boolean).join(' · ')
                  return (
                    <a
                      key={hit.girigiriId}
                      className="sugg-item"
                      href={girigiriPlayPageUrl(hit.girigiriId, ep, track.bgmId)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => onPick(hit)}
                    >
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {hit.girigiriName}
                      </span>
                      {meta && <span className="sugg-meta">{meta}</span>}
                      <Ic name="play" cls="ic ic-sm" />
                    </a>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 加番搜索弹窗 ───────────────────────────────────────────────────────────────
// 搜索顺序由服务端统一控制：离线索引 → 已加番共享补充 → BGM 在线兜底。防抖 300ms；
// 点「追」即时加、弹窗不关（可连着加多部）；已在追的显示「已追」不可重复加。
// 索引超过这个天数没更新就提示。一周一档 + 3 天容错：正常同步永远碰不到，挂了才会露头
const STALE_AFTER_DAYS = 10

function AddSearchModal({
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
        <p className="dlg-sub">从索引里挑一部贴进手帐，加进来默认是「想看」</p>

        <div className="searchbar mb16" style={{ maxWidth: 'none' }}>
          <Ic name="search" cls="ic" />
          <input
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="番名 / 别名（中文、日文、罗马音都行）"
          />
        </div>

        {/* 索引太旧 = 服务器上每周的同步任务多半挂了。不提示的话，用户只会觉得「新番搜不到」，
            跟正常的一周滞后长得一模一样，永远发现不了。10 天 = 一周档期 + 3 天容错。 */}
        {ready && staleDays >= STALE_AFTER_DAYS && (
          <p className="form-note err mb16">
            索引已 {staleDays} 天没更新 —— 正常每周自动同步一次，多半是服务器上的同步任务挂了，新番会搜不到。
          </p>
        )}

        {/* 定高结果区：弹窗尺寸不随「空搜索 / 搜到 8 条 / 没搜到」跳动 —— 输入时容器
            忽大忽小，视线要跟着窗口重新找位置 */}
        <div className="add-pane">
          {!ready ? (
            <p className="faint small">
              动漫索引还没生成。
              <br />
              在服务器上跑一次 <code>npm run sync:index</code> 即可。
            </p>
          ) : loading ? (
            <div className="page-state">
              <Spinner size={26} />
            </div>
          ) : !q ? (
            <p className="faint small">
              输入番名开始搜索（覆盖 BGM 全量动漫）
            </p>
          ) : results.length === 0 ? (
            <p className="faint small">
              没搜到「{q}」，换个词试试
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
                <p className="faint small">本地索引里没有，以下是 BGM 在线补充的结果（多半是刚上架的新条目）</p>
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
                        已在追番
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        style={{ flex: 'none' }}
                        onClick={() => add(h)}
                      >
                        <Ic name="plus" cls="ic ic-sm" />
                        加入
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

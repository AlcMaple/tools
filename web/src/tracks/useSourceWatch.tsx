import { useEffect, useRef, useState } from 'react'
import type {
  OnlineSource,
  SourceBinding,
  SourceCandidate,
  SourceId,
  SourceSearchHit,
  Track,
  WatchMode,
} from '../api'
import { SOURCES, sourceById } from '../api'
import { isRecentAir } from '../../shared/anime-age'
import { useAuth } from '../auth'
import { loadBindings, saveBindingsCache } from '../tracksSync'
import { watchEp } from './common'
import { SourceBindPickerModal, SourceSearchModal, type PickerFlow, type SearchFlow } from './sourceModals'

// 「继续看 / 试看」的共用流程：源绑定表、片源定位、候选 / 搜索弹窗。
// 我的追番和番剧周历都走这一份，请求预算、绑定缓存和弹窗行为才不会出现两套。

// 定位用的标题集合 —— 中文名 / 别名最可能对上简体中文站,日文原名兜底。
const titlesOf = (t: Track): string[] => [t.titleCn, ...t.aliases, t.title].filter(Boolean)

// 「新番 / 老番」分流 —— 源站的番剧周表只列**在播**的番,老番在里面必然查不到,
// 拿老番去走一趟周表定位是纯浪费(冷缓存那次还要等源站抓 7 天)。判据见 shared/anime-age.ts,
// 跟服务端「要不要自动填总集数」用的是同一把尺,不要在这儿另立一套。
const isRecentAnime = (t: Track): boolean => isRecentAir(t.airDate)

const emptyBindings = (): Record<SourceId, Record<number, SourceBinding>> => ({ xifan: {}, girigiri: {} })

export function useSourceWatch(onError: (message: string) => void): {
  bindings: Record<SourceId, Record<number, SourceBinding>>
  locating: { source: SourceId; bgmId: number } | null
  continueWatch: (source: OnlineSource, t: Track, mode: WatchMode, rebind?: boolean) => void
  startSearch: (flow: SearchFlow) => void
  modals: JSX.Element
} {
  const { user } = useAuth()
  const setError = onError
  const [bindings, setBindings] = useState<Record<SourceId, Record<number, SourceBinding>>>(emptyBindings)
  const [locating, setLocating] = useState<{ source: SourceId; bgmId: number } | null>(null)
  const locateRequest = useRef<AbortController | null>(null)
  useEffect(() => () => locateRequest.current?.abort(), [user?.id])
  const [pickerFlow, setPickerFlow] = useState<PickerFlow | null>(null)
  const [searchFlow, setSearchFlow] = useState<SearchFlow | null>(null)

  useEffect(() => {
    if (!user) {
      setBindings(emptyBindings())
      return
    }
    const stops = SOURCES.map((s) =>
      loadBindings(s.id, user.username, (b) => setBindings((prev) => ({ ...prev, [s.id]: b }))),
    )
    return () => stops.forEach((fn) => fn())
  }, [user])

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

  const modals = (
    <>
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
    </>
  )

  return { bindings, locating, continueWatch, startSearch: setSearchFlow, modals }
}

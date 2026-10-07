import { useEffect, useState } from 'react'
import type { CalendarItem } from './api'
import { deleteTrack, putTrack } from './api'
import { useAuth } from './auth'
import { toast } from './Toast'
import { loadTracks, runTracksMutation } from './tracksSync'

// 周历页和往期周历页共用的「海报上点一下追 / 取消追」。
// 已追集合复用 TracksPage 同一套「秒开缓存 + 后台校验」（tracksSync.ts），两页共享
// 同一份 tracks:<username> 缓存，谁先加载过谁就替对方省一次请求。
export function useTrackToggle(): {
  canTrack: boolean
  tracked: Set<number>
  error: string | null
  toggle: (item: CalendarItem, weekday: number) => void
} {
  const { user } = useAuth()
  // 已追的 bgmId —— 用来给海报画「已收藏」描边 / 切圆章按钮图标。未登录就是空集（按钮不显示）。
  const [tracked, setTracked] = useState<Set<number>>(new Set())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      setTracked(new Set())
      setLoadError(null)
      return
    }
    return loadTracks(
      user.username,
      (ts) => setTracked(new Set(ts.map((t) => t.bgmId))),
      setLoadError,
    )
  }, [user])

  // 先改本地再发请求 —— 点了要立刻有反馈。单条响应不直接落页面；最后一个并行写结束后
  // tracksSync 会拉权威全量列表，成功和失败都据此校正角标。
  const toggle = (item: CalendarItem, weekday: number): void => {
    if (!user) return
    setWriteError(null)
    const on = tracked.has(item.id)
    const title = item.name_cn || item.name
    setTracked((prev) => {
      const next = new Set(prev)
      on ? next.delete(item.id) : next.add(item.id)
      return next
    })
    toast(on ? '已取消追番' : `已把『${title}』加入追番`)
    void runTracksMutation(user.username, async () => {
      if (on) {
        await deleteTrack(item.id)
      } else {
        await putTrack(item.id, {
          status: 'watching',
          title: item.name,
          titleCn: item.name_cn,
          cover: item.cover,
          airWeekday: weekday,
          score: item.score,
        })
      }
    }).catch((e: Error) => setWriteError(e.message))
  }

  return { canTrack: !!user, tracked, error: writeError ?? loadError, toggle }
}

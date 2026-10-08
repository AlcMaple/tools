import { useEffect, useRef, useState } from 'react'
import type { CalendarItem } from './api'
import { deleteTrack, putTrack } from './api'
import { useAuth } from './auth'
import { toast } from './Toast'
import { loadTracks, runTrackMutation } from './tracksSync'

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
  const pending = useRef(new Set<number>())

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

  // 角标先响应点击，成功提示等写入确认；共享列表先合并成功响应，再用全量校验收口。
  const toggle = (item: CalendarItem, weekday: number): void => {
    if (!user || pending.current.has(item.id)) return
    pending.current.add(item.id)
    setWriteError(null)
    const on = tracked.has(item.id)
    const title = item.name_cn || item.name
    setTracked((prev) => {
      const next = new Set(prev)
      on ? next.delete(item.id) : next.add(item.id)
      return next
    })
    void runTrackMutation(user.username, item.id, async () => {
      if (on) {
        return deleteTrack(item.id)
      } else {
        return putTrack(item.id, {
          status: 'watching',
          title: item.name,
          titleCn: item.name_cn,
          cover: item.cover,
          airWeekday: weekday,
          score: item.score,
        })
      }
    }).then(() => {
      toast(on ? '已取消追番' : `已把『${title}』加入追番`)
    }).catch((e: Error) => {
      setWriteError(e.message)
      setTracked(prev => {
        const next = new Set(prev)
        on ? next.add(item.id) : next.delete(item.id)
        return next
      })
      toast(e.message, { err: true })
    }).finally(() => pending.current.delete(item.id))
  }

  return { canTrack: !!user, tracked, error: writeError ?? loadError, toggle }
}

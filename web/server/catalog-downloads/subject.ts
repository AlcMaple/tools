import { readCalendarSnapshot, type CalendarItem, type CalendarWeekday } from '../bgm/calendar'
import { getSeason } from '../bgm/calendar-history'
import { getCatalogDetails, isAdultEntry } from '../bgm/catalog'
import { searchAdditionById } from '../bgm/search-additions'
import { ownsAnimeTrack } from '../tracks'
import type { DownloadSubject } from './match'

function calendarItem(id: number, days?: CalendarWeekday[]): CalendarItem | undefined {
  for (const day of days ?? []) {
    const item = day.items.find(entry => entry.id === id)
    if (item) return item
  }
}

export function downloadSubject(id: number, uid: number | undefined, season?: string): { ready: boolean; subject: DownloadSubject | null } {
  const catalog = getCatalogDetails(id, !!uid)
  if (catalog.detail) return { ready: true, subject: catalog.detail }
  if (!uid && (!catalog.ready || isAdultEntry(id))) return { ready: catalog.ready, subject: null }

  // 周历和在线加番可能先于每周归档，只读已经取得的 Bangumi 资料
  const archived = season ? calendarItem(id, getSeason(season)?.data) : undefined
  const item = archived ?? calendarItem(id, readCalendarSnapshot()?.data)
  if (item) {
    const { name = '', name_cn: nameCn = '', episodes: eps = 0, airDate: date = '' } = item
    return { ready: true, subject: { item: { bgmId: id, name, nameCn, date, eps, tags: [] }, aliases: [] } }
  }
  if (uid) {
    const addition = searchAdditionById(id)
    if (addition) {
      const { name, nameCn, date, aliases } = addition
      return { ready: true, subject: { item: { bgmId: id, name, nameCn, date, eps: 0, tags: [] }, aliases } }
    }
    // 私人手帐（包括导入的旧记录）只向资源站提供作品编号，手填番名、别名和集数不能当作公开资料
    if (ownsAnimeTrack(uid, id)) {
      return { ready: true, subject: { item: { bgmId: id, name: '', nameCn: '', date: '', eps: 0, tags: [] }, aliases: [] } }
    }
  }
  return { ready: catalog.ready, subject: null }
}

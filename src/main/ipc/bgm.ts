import { ipcMain } from 'electron'
import { searchBgm } from '../bgm/search'
import { getBgmDetail } from '../bgm/detail'
import { getBgmCalendar } from '../bgm/calendar'

export function registerBgmIpc(): void {
  ipcMain.handle(
    'bgm:search',
    async (event, keyword: string, update?: boolean) => {
      // `update=true` forces a fresh fetch through the rate-limiter, bypassing
      // any cached HTML. Renderer triggers this when the user clicks the
      // refresh affordance.
      //
      // Progress is broadcast back on a separate channel rather than as part of
      // the invoke response — multi-page searches can fire ~5 events over ~10s,
      // and a single resolved Promise can't deliver intermediates.
      return searchBgm(keyword, update ?? false, (current, total) => {
        event.sender.send('bgm:search-progress', current, total)
      })
    },
  )
  ipcMain.handle('bgm:detail', async (_event, subjectId: number) => getBgmDetail(subjectId))
  // `update=true` bypasses the 24h cache and refetches. Renderer wires this
  // up to a small refresh button on the calendar page.
  ipcMain.handle('bgm:calendar', async (_event, update?: boolean) =>
    getBgmCalendar(update ?? false),
  )
}

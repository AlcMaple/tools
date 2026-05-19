import { ipcMain } from 'electron'
import { searchBgm, type BgmSearchCat } from '../bgm/search'
import { getBgmDetail } from '../bgm/detail'
import { getBgmCalendar } from '../bgm/calendar'

/**
 * 把 renderer 传来的 cat 值收敛到 `BgmSearchCat`（动画 2 / 书籍 1）。
 * 非法值或者缺失 → 默认 2（动画），保留与旧 IPC 调用方的兼容性。
 */
function coerceCat(raw: unknown): BgmSearchCat {
  if (raw === 1) return 1
  if (raw === 2) return 2
  return 2
}

export function registerBgmIpc(): void {
  ipcMain.handle(
    'bgm:search',
    async (event, keyword: string, update?: boolean, cat?: number) => {
      // `update=true` forces a fresh fetch through the rate-limiter, bypassing
      // any cached HTML. Renderer triggers this when the user clicks the
      // refresh affordance.
      //
      // `cat` 是 BGM 类目数字：2=动画（默认）/ 1=书籍（漫画+小说混合，由
      // detail 的 platform 字段细分到 manga / novel）。其他类目（音乐/游戏
      // /三次元）未启用，coerceCat 会回退到 2。
      //
      // Progress is broadcast back on a separate channel rather than as part of
      // the invoke response — multi-page searches can fire ~5 events over ~10s,
      // and a single resolved Promise can't deliver intermediates.
      return searchBgm(
        keyword,
        update ?? false,
        (current, total) => {
          event.sender.send('bgm:search-progress', current, total)
        },
        coerceCat(cat),
      )
    },
  )
  ipcMain.handle('bgm:detail', async (_event, subjectId: number) => getBgmDetail(subjectId))
  // `update=true` bypasses the 24h cache and refetches. Renderer wires this
  // up to a small refresh button on the calendar page.
  ipcMain.handle('bgm:calendar', async (_event, update?: boolean) =>
    getBgmCalendar(update ?? false),
  )
}

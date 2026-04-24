import { ipcMain } from 'electron'
import { searchBgm } from '../bgm/search'
import { getBgmDetail } from '../bgm/detail'

export function registerBgmIpc(): void {
  ipcMain.handle('bgm:search', async (_event, keyword: string) => searchBgm(keyword))
  ipcMain.handle('bgm:detail', async (_event, subjectId: number) => getBgmDetail(subjectId))
}

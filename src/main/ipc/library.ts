import { ipcMain, shell } from 'electron'
import { addPath, removePath, getEntries, getFiles, reconcilePaths, scanLibrary } from '../library/api'

export function registerLibraryIpc(): void {
  ipcMain.handle('library:get-paths', async () => reconcilePaths())
  ipcMain.handle('library:add-path', async (_event, folderPath: string, label: string) => addPath(folderPath, label))
  ipcMain.handle('library:remove-path', async (_event, folderPath: string) => removePath(folderPath))
  ipcMain.handle('library:get-entries', async () => getEntries())
  ipcMain.handle('library:get-files', async (_event, folderPath: string) => getFiles(folderPath))
  ipcMain.handle('library:open-folder', async (_event, folderPath: string) => shell.openPath(folderPath))
  ipcMain.handle('library:play-video', async (_event, filePath: string) => shell.openPath(filePath))
  ipcMain.handle('library:play-folder', async (_event, folderPath: string) => {
    const files = await getFiles(folderPath)
    if (files.length > 0) await shell.openPath(files[0].path)
  })
  ipcMain.handle('library:scan', async (event) => {
    return scanLibrary((status: string, currentVal: number, totalVal: number) => {
      event.sender.send('library:scan-status', { status, currentVal, totalVal })
    })
  })
}

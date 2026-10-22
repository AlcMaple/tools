import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { convertMaterial, type ConvertKind } from '../order-judge/convert'
import {
  deleteHistory, getSettings, historyBase, judge, listHistory, addPath, removePath, movePath, setSharedMode, judgeWebsite, type JudgeInput,
} from '../order-judge/service'

const MAX_CONVERT_BYTES = 1024 * 1024 * 1024
const CMAP_NAME = /^[A-Za-z0-9-]{1,40}$/

// pdf.js 读中文 PDF 要用的 CMap。打包时由 extraResources 拷到 resources/pdf-cmaps
function cmapDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'pdf-cmaps') : join(app.getAppPath(), 'node_modules/pdfjs-dist/cmaps')
}

function toArchivistUrl(absPath: string): string {
  const fwd = absPath.replace(/\\/g, '/')
  const withSlash = fwd.startsWith('/') ? fwd : '/' + fwd
  return 'archivist://local' + withSlash.split('/').map(encodeURIComponent).join('/')
}

export function registerOrderJudgeIpc(): void {
  ipcMain.handle('order-judge:get-settings', () => getSettings())
  ipcMain.handle('order-judge:set-shared', (_e, shared: unknown) => setSharedMode(shared === true))
  ipcMain.handle('order-judge:open-web', () => shell.openExternal(judgeWebsite()))

  // 路径只能由主进程弹的系统对话框选出来，渲染进程传不进任意路径
  ipcMain.handle('order-judge:pick-file', async (e, which: unknown) => {
    if (which !== 'profile' && which !== 'log') return getSettings()
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: which === 'profile' ? '选择能力档案' : '选择项目日志',
      properties: ['openFile'],
      filters: [{ name: 'Markdown / 文本', extensions: ['md', 'markdown', 'txt'] }],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (!r.canceled && r.filePaths[0]) await addPath(which, r.filePaths[0])
    return getSettings()
  })
  // 删除 / 调序只认已有列表里的下标，渲染进程仍然塞不进新路径
  ipcMain.handle('order-judge:remove-path', async (_e, which: unknown, index: unknown) => {
    if ((which === 'profile' || which === 'log') && Number.isInteger(index)) await removePath(which, index as number)
    return getSettings()
  })
  ipcMain.handle('order-judge:move-path', async (_e, which: unknown, index: unknown, offset: unknown) => {
    if ((which === 'profile' || which === 'log') && Number.isInteger(index) && (offset === -1 || offset === 1)) await movePath(which, index as number, offset)
    return getSettings()
  })

  ipcMain.handle('order-judge:history', async () => {
    const entries = await listHistory(), base = await historyBase()
    return { base: base.startsWith('archivist:') ? base : toArchivistUrl(base), entries }
  })

  ipcMain.handle('order-judge:delete-history', (_e, id: unknown) =>
    deleteHistory(typeof id === 'string' ? id : ''))

  ipcMain.handle('order-judge:judge', (e, input: JudgeInput) =>
    judge(input, (p) => { if (!e.sender.isDestroyed()) e.sender.send('order-judge:progress', p) }))

  ipcMain.handle('order-judge:cmap', async (_e, name: unknown) => {
    if (typeof name !== 'string' || !CMAP_NAME.test(name)) return null
    try {
      return await readFile(join(cmapDir(), `${name}.bcmap`))
    } catch {
      return null
    }
  })

  ipcMain.handle('order-judge:convert', async (_e, kind: unknown, bytes: unknown, ext: unknown) => {
    if ((kind !== 'image' && kind !== 'video' && kind !== 'doc') || !(bytes instanceof Uint8Array) || typeof ext !== 'string') {
      return { ok: false, code: 'UNSUPPORTED' }
    }
    if (bytes.byteLength > MAX_CONVERT_BYTES) return { ok: false, code: 'FAILED', detail: '文件超过 1GB' }
    return convertMaterial(kind as ConvertKind, bytes, ext.toLowerCase())
  })
}

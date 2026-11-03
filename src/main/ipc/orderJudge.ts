import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { convertMaterial, type ConvertKind } from '../order-judge/convert'
import { onWebAccountChange } from './webAccount'
import { deleteProject, judgeWebsite, loadProjects, organize, type OrganizeInput } from '../order-judge/service'

const MAX_CONVERT_BYTES = 1024 * 1024 * 1024
const CMAP_NAME = /^[A-Za-z0-9-]{1,40}$/

// pdf.js 读中文 PDF 要用的 CMap。打包时由 extraResources 拷到 resources/pdf-cmaps
function cmapDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'pdf-cmaps') : join(app.getAppPath(), 'node_modules/pdfjs-dist/cmaps')
}

export function registerOrderJudgeIpc(): void {
  // 换账号 / 登出后项目列表属于另一个人了，让页面重新拉
  onWebAccountChange(() => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('order-judge:changed') })
  ipcMain.handle('order-judge:open-web', () => shell.openExternal(judgeWebsite()))
  ipcMain.handle('order-judge:load', () => loadProjects())
  ipcMain.handle('order-judge:delete-project', (_e, id: unknown) => deleteProject(typeof id === 'string' ? id : ''))
  ipcMain.handle('order-judge:organize', (e, input: OrganizeInput) =>
    organize(input, (stage) => { if (!e.sender.isDestroyed()) e.sender.send('order-judge:progress', stage) }))

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

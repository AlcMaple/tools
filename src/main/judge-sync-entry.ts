import { app, BrowserWindow } from 'electron'
import { getSettings, initializeJudgeSync } from './order-judge/service'
import { stopJudgeSync } from './order-judge/sync-manager'
import { initConsoleCapture, logError, logInfo } from './shared/logger'

initConsoleCapture()
app.on('second-instance', (_event, args) => {
  if (args.includes('--order-judge-sync')) return
  app.relaunch({ args: process.argv.slice(1).filter(arg => arg !== '--order-judge-sync') }); app.quit()
})
app.on('before-quit', stopJudgeSync)
process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())
app.whenReady().then(async () => {
  app.dock?.hide()
  const settings = await getSettings()
  if (!settings.shared || !settings.hasWebAccount) throw new Error('请先在应用设置登录网页版账号，并在评估设置开启「与网页版共用评估和历史」。')
  await initializeJudgeSync()
  logInfo('order-judge:background', `后台模式已启动，仅同步选定的 MD；windows=${BrowserWindow.getAllWindows().length}。`)
}).catch(error => { logError('order-judge:background', error); stopJudgeSync(); app.exit(1) })

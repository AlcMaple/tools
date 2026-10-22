import './shared/uv-bootstrap'
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { isAbsolute, join } from 'path'

const isolatedData = !app.isPackaged && process.env.MAPLETOOLS_TEST_USER_DATA
if (isolatedData) {
  if (!isAbsolute(isolatedData)) throw new Error('MAPLETOOLS_TEST_USER_DATA must be absolute')
  mkdirSync(isolatedData, { recursive: true }); app.setPath('userData', isolatedData)
  app.setAppLogsPath(join(isolatedData, 'logs'))
}

if (!app.requestSingleInstanceLock()) app.quit()
else if (process.argv.includes('--order-judge-sync')) void import('./judge-sync-entry')
else void import('./index')

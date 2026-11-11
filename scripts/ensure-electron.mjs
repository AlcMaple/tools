// electron-vite 直接读 node_modules/electron/path.txt 去 spawn，绕过了 electron 包自带的
// 「二进制缺失就补下」逻辑；这里在启动前 require 一次，由它自己判断并补下
import { createRequire } from 'node:module'

createRequire(import.meta.url)('electron')

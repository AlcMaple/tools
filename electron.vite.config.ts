import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const versionDefine = {
  __APP_VERSION__: JSON.stringify(pkg.version)
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: versionDefine,
    build: {
      rollupOptions: {
        // 主入口 + 媒体库扫描 worker 各自打包成 out/main/*.js。worker 在独立线程
        // 跑全量扫描，主进程线程不被占（见 library/scan-worker.ts）。
        input: {
          index: resolve('src/main/index.ts'),
          'scan-worker': resolve('src/main/library/scan-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: versionDefine
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    define: versionDefine
  }
})

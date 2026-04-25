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
    define: versionDefine
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

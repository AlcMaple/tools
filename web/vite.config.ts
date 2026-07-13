import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devServer from '@hono/vite-dev-server'

// 本地开发一条命令跑通前后端：@hono/vite-dev-server 把 server/index.ts 里的 Hono 应用
// 挂进 Vite dev server，只接管 /api/*（exclude 排除所有非 /api 请求 → 交给 Vite 出页面 /
// HMR / 静态资源）。生产（Vercel）不走这里：前端由 Vite 构建成静态站，/api 由 web/api 下的
// serverless 函数跑同一个 Hono 应用（见 api/[[...route]].ts）。
export default defineConfig({
  plugins: [
    react(),
    devServer({
      entry: './server/index.ts',
      exclude: [/^(?!\/api\/).*/],
    }),
  ],
})

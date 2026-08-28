import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devServer from '@hono/vite-dev-server'
import { sentryVitePlugin } from '@sentry/vite-plugin'

const PRODUCTION_SECURITY_META = `
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://user.alcmaple.cn; style-src 'self'; img-src 'self' https: data:; font-src 'self'; connect-src 'self' https:; media-src 'self' https: blob:; worker-src 'self' blob:; frame-src 'none'; upgrade-insecure-requests" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />`

// 本地开发一条命令跑通前后端：@hono/vite-dev-server 把 server/index.ts 里的 Hono 应用
// 挂进 Vite dev server，只接管 /api/*（exclude 排除所有非 /api 请求 → 交给 Vite 出页面 /
// HMR / 静态资源）。生产（Vercel）不走这里：前端由 Vite 构建成静态站，/api 由 web/api 下的
// serverless 函数跑同一个 Hono 应用（见 api/[[...route]].ts）。
// Source map 上传：仅在构建、且注入了 SENTRY_AUTH_TOKEN 时启用（token 在部署目录外，
// 见 web/README.md）。`sourcemap: 'hidden'` 让 Vite 产出 .map 但不写 sourceMappingURL 注释；
// 插件靠 debug id 关联，上传后 filesToDeleteAfterUpload 立刻把 .map 从 dist 删掉 ——
// server/node.ts 的 serveStatic 会把整个 dist 对外暴露，留一个 .map 就是源码泄露。
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim()
const uploadSourceMaps = (command: string): boolean => command === 'build' && Boolean(sentryAuthToken)

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'maple-production-security-meta',
      transformIndexHtml(html: string): string {
        // Vite 开发页会注入 React Refresh 的内联脚本，不能让开发专用 CSP 误伤 HMR；
        // 生产构建才把严格 CSP 写入静态 HTML。API / 播放器响应的 CSP 仍由 server/security.ts 提供。
        return command === 'build' ? html.replace('</head>', `${PRODUCTION_SECURITY_META}\n  </head>`) : html
      },
    },
    devServer({
      entry: './server/index.ts',
      exclude: [/^(?!\/api\/).*/],
    }),
    ...(uploadSourceMaps(command)
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: sentryAuthToken,
            telemetry: false,
            release: process.env.VITE_SENTRY_RELEASE
              ? { name: process.env.VITE_SENTRY_RELEASE }
              : undefined,
            sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
          }),
        ]
      : []),
  ],
  build: {
    // 只有要上传时才产出 map；否则保持关闭，dist 里根本不出现 .map。
    sourcemap: uploadSourceMaps(command) ? 'hidden' : false,
    // 字体一律产出成独立文件，**不许内联成 data: URI**。
    //
    // Vite 默认把小于 4096 字节的资源内联，而我们的 CSP 是 `font-src 'self'` —— data: 不在其中。
    // 于是 `yusei-magic-latin-ext-400-normal.woff2`（2,844 字节）被内联后**在线上被 CSP 直接拦掉**，
    // 扩展拉丁字符（ā ē ō 等带音标的字形）静默掉回 fallback 字体，控制台只留一条 CSP 报错。
    // 同目录的 latin 正常子集是 17,412 字节、超过阈值，所以一直是好的 —— 这就是「只坏了一半、
    // 页面看着还行」的原因，很难靠肉眼发现。
    //
    // 修构建而不是往 CSP 里加 `data:`：CSP 本身是对的，内联才是那个越界的行为；
    // 放开 `data:` 等于为一个 2.8KB 的字体永久削弱一条策略。
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
  },
  // better-sqlite3 是原生模块（.node），Vite SSR 不能把它当普通 JS 打包 —— 标 external
  // 让 dev-server 直接 require 原生二进制，否则 /api/auth 一被命中就崩。
  ssr: {
    external: ['better-sqlite3'],
  },
}))

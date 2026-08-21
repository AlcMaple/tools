import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 字体：正文走系统中日韩栈、标题/数字用手写体 Yusei Magic（woff2 在 src/assets/fonts，
// 由 sketch-tokens.css 的 @font-face 引入并经 Vite 打包）。不再引入 Inter / Space Grotesk。
import App from './App'
import { registerCoverCacheWorker } from './coverCache'
import './index.css'

registerCoverCacheWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

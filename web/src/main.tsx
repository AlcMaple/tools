import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 字体本地打包（不走 Google Fonts CDN —— 国内被墙）：Inter=headline/body、
// Space Grotesk=label。图标不用 material-symbols 字体（3.9MB 太重），改内联 SVG（见 Icon.tsx）。
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/900.css'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

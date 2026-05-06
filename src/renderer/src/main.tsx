import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Self-hosted fonts — no CDN dependency at runtime. Fixes blank icons / fallback
// glyphs when the device has no internet (or no VPN against blocked CDNs).
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/900.css'
import '@fontsource/space-grotesk/300.css'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import 'material-symbols/outlined.css'

import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

import { HashRouter, Routes, Route } from 'react-router-dom'
import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import SearchDownload from './pages/SearchDownload'
import DownloadQueue from './pages/DownloadQueue'
import AnimeInfo from './pages/AnimeInfo'
import BiuSync from './pages/BiuSync'
import Settings from './pages/Settings'
import { downloadStore } from './stores/downloadStore'

function DownloadProgressListener(): null {
  useEffect(() => {
    const unlisten = window.xifanApi.onDownloadProgress((taskId, event) => {
      downloadStore.handleProgressEvent(taskId, event)
    })
    return unlisten
  }, [])
  return null
}

function App(): JSX.Element {
  return (
    <HashRouter>
      <DownloadProgressListener />
      <div className="h-screen overflow-hidden bg-background text-on-surface font-body">
        <Sidebar />
        <div className="ml-64 h-full overflow-y-auto custom-scrollbar">
          <Routes>
            <Route path="/" element={<SearchDownload />} />
            <Route path="/queue" element={<DownloadQueue />} />
            <Route path="/anime-info" element={<AnimeInfo />} />
            <Route path="/biu-sync" element={<BiuSync />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </div>
    </HashRouter>
  )
}

export default App

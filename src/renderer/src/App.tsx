import { HashRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import SearchDownload from './pages/SearchDownload'
import DownloadQueue from './pages/DownloadQueue'
import AnimeInfo from './pages/AnimeInfo'
import MyAnime from './pages/MyAnime'
import AnimeCalendar from './pages/AnimeCalendar'
import Settings from './pages/Settings'
import LocalLibrary from './pages/LocalLibrary'
import FileExplorer from './pages/FileExplorer'
import HomeworkLookup from './pages/HomeworkLookup'
import { downloadStore } from './stores/downloadStore'

function DownloadProgressListener(): null {
  useEffect(() => {
    downloadStore.init()
    const unlisten = window.downloadApi.onProgress((taskId, event) => {
      downloadStore.handleProgressEvent(taskId, event)
    })
    return unlisten
  }, [])
  return null
}

/**
 * Settings is a "fullscreen" route — it renders its own category rail in place
 * of the global Sidebar, so we hide the Sidebar (and its 16rem left margin)
 * while on /settings.
 */
function Shell(): JSX.Element {
  const location = useLocation()
  const isFullscreen = location.pathname.startsWith('/settings')

  return (
    <div className="h-screen overflow-hidden bg-background text-on-surface font-body">
      {!isFullscreen && <Sidebar />}
      <div
        id="page-scroll"
        className={`h-full overflow-y-auto custom-scrollbar ${isFullscreen ? '' : 'ml-64'}`}
      >
        <Routes>
          <Route path="/" element={<LocalLibrary />} />
          <Route path="/search" element={<SearchDownload />} />
          <Route path="/queue" element={<DownloadQueue />} />
          <Route path="/anime-info" element={<AnimeInfo />} />
          <Route path="/my-anime" element={<MyAnime />} />
          <Route path="/calendar" element={<AnimeCalendar />} />
          <Route path="/file-explorer" element={<FileExplorer />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/homework" element={<HomeworkLookup />} />
        </Routes>
      </div>
    </div>
  )
}

function App(): JSX.Element {
  return (
    <HashRouter>
      <DownloadProgressListener />
      <Shell />
    </HashRouter>
  )
}

export default App

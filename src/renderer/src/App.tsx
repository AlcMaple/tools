import { HashRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import SearchDownload from './pages/SearchDownload'
import DownloadQueue from './pages/DownloadQueue'
import AnimeInfo from './pages/AnimeInfo'
import MyAnime from './pages/MyAnime'
import AnimeCalendar from './pages/AnimeCalendar'
import AnimeCalendarScreenshot from './pages/AnimeCalendarScreenshot'
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

/**
 * Screenshot 模式：主进程开隐藏 BrowserWindow 时附带 `?screenshot=calendar`
 * query 参数。这里在最早一刻识别这个参数并整体走极简渲染路径 —— 不挂
 * HashRouter、不挂 Sidebar、不挂 download progress 监听，只渲染一个无 chrome
 * 的周历视图，等图片加载完后上报 scrollHeight 让主进程 capturePage。
 */
function App(): JSX.Element {
  const isCalendarScreenshot =
    new URLSearchParams(window.location.search).get('screenshot') === 'calendar'

  if (isCalendarScreenshot) {
    return <AnimeCalendarScreenshot />
  }

  return (
    <HashRouter>
      <DownloadProgressListener />
      <Shell />
    </HashRouter>
  )
}

export default App

import { HashRouter, Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import SearchDownload from './pages/SearchDownload'
import DownloadQueue from './pages/DownloadQueue'
import AnimeInfo from './pages/AnimeInfo'
import BiuSync from './pages/BiuSync'

function App(): JSX.Element {
  return (
    <HashRouter>
      <div className="min-h-screen bg-background text-on-surface font-body">
        <Sidebar />
        <div className="ml-64">
          <Routes>
            <Route path="/" element={<SearchDownload />} />
            <Route path="/queue" element={<DownloadQueue />} />
            <Route path="/anime-info" element={<AnimeInfo />} />
            <Route path="/biu-sync" element={<BiuSync />} />
          </Routes>
        </div>
      </div>
    </HashRouter>
  )
}

export default App

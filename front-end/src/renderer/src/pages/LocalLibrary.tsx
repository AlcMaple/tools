import { useState, useMemo, useEffect } from "react";
import TopBar from "../components/TopBar";
import defaultCover from "../assets/default-cover.png";

function SearchingState(): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6">
      <div className="w-12 h-12 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <p className="font-label text-xs text-on-surface-variant/50 tracking-widest uppercase">
        Indexing Maple Tools...
      </p>
    </div>
  );
}

export default function LocalLibrary(): JSX.Element {
  const [isScanModalOpen, setIsScanModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [posters, setPosters] = useState<any[]>([]);
  const [paths, setPaths] = useState<any[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState({
    status: "Idle",
    currentVal: 0,
    totalVal: 0,
  });
  const [isRefreshing, setIsRefreshing] = useState(true);

  useEffect(() => {
    // 初次加载数据
    window.libraryApi.getEntries().then((data) => {
      setPosters(data);
      setIsRefreshing(false); // 读完本地数据，关闭 Loading
    });
    window.libraryApi.getPaths().then(setPaths);

    // 监听扫描进度
    const cleanupScan = window.libraryApi.onScanStatus((status) => {
      setScanStatus(status);
      // 只要主进程开始扫描（无论是手动还是后台自动），且未完成，就立刻开启页面 Loading
      if (status.status !== "Scan complete" && status.status !== "Idle") {
        setIsRefreshing(true);
      }
    });

    // 监听后台动态更新
    window.libraryApi.onLibraryUpdated((newEntries) => {
      setPosters(newEntries);
      setIsRefreshing(false); // 收到最新的数据了，瞬间关闭 Loading 显示海报！
      setScanStatus({ status: "Idle", currentVal: 0, totalVal: 0 }); // 顺手把右下角的进度条重置
    });

    return cleanupScan;
  }, []);

  const filteredPosters = useMemo(() => {
    if (!searchQuery.trim()) return posters;
    const query = searchQuery.toLowerCase();
    return posters.filter(
      (p) =>
        p.title.toLowerCase().includes(query) ||
        p.nativeTitle.toLowerCase().includes(query),
    );
  }, [searchQuery, posters]);

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="Search in library..." onSearch={setSearchQuery} />
      <div className="pt-24 pb-8">
        {/* Hero Actions & Stats Area */}
        <section className="px-12 pb-6">
          <div className="flex justify-between items-start mb-12">
            <div>
              <h2 className="font-headline font-black text-5xl tracking-tighter text-on-surface mb-2">
                Local Library
              </h2>
              <div className="flex items-center gap-4 text-on-surface-variant font-label text-sm">
                <span className="flex items-center gap-1.5">
                  <span className="text-primary font-bold">
                    {posters.length}
                  </span>{" "}
                  Titles
                </span>
                <span className="w-1 h-1 bg-outline-variant rounded-full"></span>
                <span className="flex items-center gap-1.5">
                  <span className="text-primary font-bold">
                    {posters.reduce((acc, p) => acc + (p.episodes || 0), 0)}
                  </span>{" "}
                  Episodes
                </span>
                <span className="w-1 h-1 bg-outline-variant rounded-full"></span>
                <span className="flex items-center gap-1.5">
                  Last update: recently
                </span>
              </div>
            </div>
            <button
              className="bg-primary text-on-primary font-label font-bold text-sm px-8 py-4 rounded-full flex items-center gap-3 shadow-lg shadow-primary/20 hover:brightness-110 transition-all active:scale-95 group"
              onClick={() => setIsScanModalOpen(true)}
            >
              <span className="material-symbols-outlined leading-none">
                folder_zip
              </span>
              SCAN LOCAL FOLDERS
            </button>
          </div>

          {/* Filter Bar */}
          <div className="flex flex-col gap-6 mb-8">
            <div className="flex items-center gap-3">
              <span className="font-label text-xs text-on-surface-variant uppercase tracking-widest mr-2">
                Sort by
              </span>
              <button className="px-5 py-2 rounded-full bg-primary text-on-primary font-label text-xs font-bold uppercase tracking-widest">
                All Titles
              </button>
              <button className="px-5 py-2 rounded-full bg-surface-container-high text-on-surface-variant font-label text-xs font-bold uppercase tracking-widest hover:text-on-surface transition-colors">
                Recently Added
              </button>
              <button className="px-5 py-2 rounded-full bg-surface-container-high text-on-surface-variant font-label text-xs font-bold uppercase tracking-widest hover:text-on-surface transition-colors">
                By Resolution
              </button>
              <button className="px-5 py-2 rounded-full bg-surface-container-high text-on-surface-variant font-label text-xs font-bold uppercase tracking-widest hover:text-on-surface transition-colors">
                A-Z
              </button>
            </div>
          </div>
        </section>

        {/* Poster Wall Grid */}
        {isRefreshing ? (
          <SearchingState />
        ) : (
          <section className="px-12 pb-32 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-8 gap-y-12">
            {filteredPosters.length > 0 ? (
              filteredPosters.map((poster) => (
                <div key={poster.id} className="group relative cursor-pointer">
                  <div className="aspect-[2/3] w-full rounded-lg overflow-hidden bg-surface-container-lowest relative ring-1 ring-outline-variant/30 transition-transform duration-500">
                    <img
                      className="w-full h-full object-cover grayscale-[20%] group-hover:grayscale-0 transition-all duration-500"
                      alt={poster.title}
                      src={poster.image || defaultCover}
                    />
                    <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-surface-variant/70 backdrop-blur-md p-6 flex flex-col justify-start pt-8">
                      <div className="mb-4">
                        <h4 className="font-headline font-bold text-lg text-on-surface mb-1 leading-tight line-clamp-2">
                          {poster.title}
                        </h4>
                        <p className="font-body text-primary text-[10px] font-bold uppercase tracking-widest mb-2">
                          {poster.tags}
                        </p>
                        <p className="font-body text-primary text-sm font-bold italic opacity-80">
                          {poster.nativeTitle}
                        </p>
                      </div>
                      <div className="flex items-center justify-between border-t border-outline-variant/30 pt-4 mt-auto">
                        <span className="font-label text-xs text-primary/80">
                          {poster.episodes} Episodes
                        </span>
                        <span className="material-symbols-outlined text-primary leading-none">
                          play_circle
                        </span>
                      </div>
                    </div>
                  </div>
                  <h3 className="mt-4 font-headline font-bold text-on-surface truncate group-hover:text-primary transition-colors">
                    {poster.title}
                  </h3>
                  <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
                    {poster.specs}
                  </p>
                </div>
              ))
            ) : (
              // 可选：如果没有任何视频时的占位文本
              <div className="col-span-full py-24 flex justify-center text-on-surface-variant/50 font-label text-sm uppercase tracking-widest">
                Library is empty
              </div>
            )}
          </section>
        )}

        {/* Floating Status Bar */}
        <div className="fixed bottom-8 right-8 bg-surface-container-lowest/80 backdrop-blur-md ring-1 ring-outline-variant/30 rounded-full px-6 py-3 flex items-center justify-between shadow-2xl z-[55]">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 ${isScanning ? "bg-green-400 animate-pulse" : "bg-outline-variant"} rounded-full`}
              ></div>
              <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
                {isScanning ? "Scanning Active" : "Idle"}
              </span>
            </div>
            <div className="h-4 w-[1px] bg-outline-variant/30"></div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-sm leading-none">
                hard_drive
              </span>
              <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
                {paths.length} SOURCES
              </span>
            </div>
          </div>
          {isScanning && (
            <div className="flex items-center gap-4 ml-8">
              <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest italic">
                {scanStatus.status}
              </span>
              <div className="w-32 h-1 bg-surface-container-highest rounded-full overflow-hidden">
                <div
                  className="h-full bg-secondary transition-all"
                  style={{
                    width: `${scanStatus.totalVal > 0 ? (scanStatus.currentVal / scanStatus.totalVal) * 100 : 0}%`,
                  }}
                ></div>
              </div>
            </div>
          )}
        </div>

        {/* Scan Folders Modal */}
        {isScanModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-surface-container-lowest/80 backdrop-blur-sm">
            <div
              className="absolute inset-0"
              onClick={() => setIsScanModalOpen(false)}
            ></div>

            <div className="relative bg-surface border border-outline-variant/30 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl">
              <div className="p-8 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container-low">
                <div>
                  <h3 className="font-headline font-black text-2xl tracking-tighter text-on-surface">
                    Path Manager
                  </h3>
                  <p className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest mt-1">
                    Configure library source folders
                  </p>
                </div>
                <button
                  className="text-on-surface-variant hover:text-on-surface transition-colors leading-none"
                  onClick={() => setIsScanModalOpen(false)}
                >
                  <span className="material-symbols-outlined leading-none">
                    close
                  </span>
                </button>
              </div>

              <div className="p-8 space-y-4">
                <div className="space-y-3">
                  {paths.map((p) => (
                    <div
                      key={p.path}
                      className="flex items-center justify-between p-4 rounded-xl bg-surface-container-high border border-outline-variant/30 group"
                    >
                      <div className="flex items-center gap-4">
                        <span className="material-symbols-outlined text-on-surface-variant leading-none">
                          folder
                        </span>
                        <div>
                          <p className="text-xs font-label text-on-surface font-bold">
                            {p.path}
                          </p>
                          <p className="text-[10px] text-on-surface-variant font-label uppercase">
                            {p.label}
                          </p>
                        </div>
                      </div>
                      <button
                        className="text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 transition-all leading-none"
                        onClick={async () => {
                          const newPaths = await window.libraryApi.removePath(
                            p.path,
                          );
                          setPaths(newPaths);
                        }}
                      >
                        <span className="material-symbols-outlined text-sm leading-none">
                          delete
                        </span>
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  className="w-full py-4 border-2 border-dashed border-outline-variant/30 rounded-xl text-on-surface-variant hover:text-primary hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-center gap-3 font-label text-xs font-bold uppercase tracking-widest"
                  onClick={async () => {
                    const folder = await window.systemApi.pickFolder();
                    if (folder) {
                      const newPaths = await window.libraryApi.addPath(
                        folder,
                        "Local Folder",
                      );
                      setPaths(newPaths);
                    }
                  }}
                >
                  <span className="material-symbols-outlined text-sm leading-none">
                    add
                  </span>
                  Add New Path
                </button>
              </div>

              <div className="p-8 bg-surface-container-low border-t border-outline-variant/30 flex gap-4">
                <button
                  className="flex-1 py-4 bg-surface-container-highest text-on-surface font-label text-xs font-bold uppercase tracking-widest rounded-full hover:bg-surface-bright transition-colors"
                  onClick={() => setIsScanModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="flex-[2] py-4 bg-primary text-on-primary font-label text-xs font-bold uppercase tracking-widest rounded-full shadow-lg shadow-primary/20 hover:brightness-110 transition-all active:scale-95 disabled:opacity-50"
                  disabled={isScanning}
                  onClick={async () => {
                    setIsScanning(true);
                    setIsRefreshing(true);
                    setIsScanModalOpen(false);
                    const entries = await window.libraryApi.scan();
                    setPosters(entries);
                    setIsScanning(false);
                    setIsRefreshing(false);
                  }}
                >
                  {isScanning ? "Scanning..." : "Start Scanning"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

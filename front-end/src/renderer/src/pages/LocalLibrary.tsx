import { useState, useMemo, useEffect } from "react";
import TopBar from "../components/TopBar";
import type { LibraryFile } from "../env";

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}


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
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderFiles, setFolderFiles] = useState<LibraryFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
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
    window.libraryApi.getEntries().then((data) => {
      setPosters(data);
      setIsRefreshing(false);
    });
    window.libraryApi.getPaths().then(setPaths);

    const cleanupScan = window.libraryApi.onScanStatus((status) => {
      setScanStatus(status);
      if (status.status !== "Scan complete" && status.status !== "Idle") {
        setIsRefreshing(true);
      }
    });

    window.libraryApi.onLibraryUpdated((newEntries) => {
      setPosters(newEntries);
      setIsRefreshing(false);
      setScanStatus({ status: "Idle", currentVal: 0, totalVal: 0 });
    });

    return cleanupScan;
  }, []);

  const filteredPosters = useMemo(() => {
    if (!searchQuery.trim()) return posters;
    const q = searchQuery.toLowerCase();
    return posters.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.nativeTitle.toLowerCase().includes(q),
    );
  }, [searchQuery, posters]);

  // Auto-select first folder when list changes
  useEffect(() => {
    if (filteredPosters.length === 0) {
      setSelectedFolderId(null);
      return;
    }
    if (
      !selectedFolderId ||
      !filteredPosters.find((p) => p.id === selectedFolderId)
    ) {
      setSelectedFolderId(filteredPosters[0].id);
    }
  }, [filteredPosters, selectedFolderId]);

  const selectedPoster = useMemo(
    () => posters.find((p) => p.id === selectedFolderId) || null,
    [posters, selectedFolderId],
  );

  // Load files of selected folder
  useEffect(() => {
    if (!selectedPoster) {
      setFolderFiles([]);
      return;
    }
    setIsLoadingFiles(true);
    window.libraryApi.getFiles(selectedPoster.folderPath).then((files) => {
      setFolderFiles(files);
      setIsLoadingFiles(false);
    });
  }, [selectedPoster]);

  return (
    <div className="relative min-h-full bg-background">
      <TopBar placeholder="Search in library..." onSearch={setSearchQuery} />
      <div className="pt-24 pb-8">
        {/* Hero Actions & Stats Area */}
        <section className="px-12 pb-6">
          <div className="flex justify-between items-start mb-10">
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
                <span className="w-1 h-1 bg-outline-variant rounded-full" />
                <span className="flex items-center gap-1.5">
                  <span className="text-primary font-bold">
                    {posters.reduce((acc, p) => acc + (p.episodes || 0), 0)}
                  </span>{" "}
                  Episodes
                </span>
                <span className="w-1 h-1 bg-outline-variant rounded-full" />
                <span className="flex items-center gap-1.5">
                  Last update: recently
                </span>
              </div>
            </div>
            <button
              className="bg-primary text-on-primary font-label font-bold text-sm px-8 py-4 rounded-full flex items-center gap-3 shadow-lg shadow-primary/20 hover:brightness-110 transition-all active:scale-95"
              onClick={() => setIsScanModalOpen(true)}
            >
              <span className="material-symbols-outlined leading-none">
                folder_zip
              </span>
              SCAN LOCAL FOLDERS
            </button>
          </div>
        </section>

        {isRefreshing ? (
          <SearchingState />
        ) : filteredPosters.length === 0 ? (
          <section className="px-12 pb-32">
            <div className="py-24 flex justify-center text-on-surface-variant/50 font-label text-sm uppercase tracking-widest">
              Library is empty
            </div>
          </section>
        ) : (
          <section className="px-12 pb-32">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 mb-6 text-sm font-label text-outline uppercase tracking-widest">
              <span className="material-symbols-outlined text-[16px] leading-none">
                folder_open
              </span>
              <span className="text-on-surface-variant">Local Storage</span>
              {selectedPoster && (
                <>
                  <span className="text-outline-variant">/</span>
                  <span className="text-on-surface font-bold truncate max-w-[40vw]">
                    {selectedPoster.title}
                  </span>
                </>
              )}
            </div>

            {/* Folder Chips */}
            <div className="flex flex-wrap gap-3 mb-8">
              {filteredPosters.map((p) => {
                const active = p.id === selectedFolderId;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedFolderId(p.id)}
                    title={p.title}
                    className={`px-6 py-2 rounded-full font-label text-xs uppercase tracking-widest transition-all active:scale-95 max-w-[280px] truncate ${
                      active
                        ? "bg-primary-container text-on-primary-container shadow-lg shadow-primary/10"
                        : "bg-surface-container-high border border-outline-variant/10 text-on-surface hover:border-primary/50"
                    }`}
                  >
                    {p.title}
                  </button>
                );
              })}
              <button
                className="w-10 h-10 rounded-full flex items-center justify-center border border-dashed border-outline-variant/40 text-outline hover:text-primary hover:border-primary/50 transition-all"
                onClick={async () => {
                  const folder = await window.systemApi.pickFolder();
                  if (folder) {
                    const newPaths = await window.libraryApi.addPath(folder, 'Local Folder');
                    setPaths(newPaths);
                    setIsScanning(true);
                    setIsRefreshing(true);
                    const entries = await window.libraryApi.scan();
                    setPosters(entries);
                    setIsScanning(false);
                    setIsRefreshing(false);
                  }
                }}
                title="Add folder"
              >
                <span className="material-symbols-outlined leading-none">
                  add
                </span>
              </button>
            </div>

            {/* High-Density Video List */}
            <div className="bg-surface-container-lowest rounded-xl overflow-hidden flex flex-col shadow-2xl">
              {/* Path bar */}
              {selectedPoster && (
                <button
                  className="group flex items-center gap-3 px-6 py-3 bg-surface-container border-b border-white/5 text-left hover:bg-surface-container-high transition-colors"
                  onClick={() => window.libraryApi.openFolder(selectedPoster.folderPath)}
                >
                  <span className="material-symbols-outlined text-[14px] text-outline leading-none shrink-0">folder</span>
                  <span className="font-label text-[10px] text-on-surface-variant/50 tracking-wide truncate flex-1">
                    {selectedPoster.folderPath}
                  </span>
                  <span className="material-symbols-outlined text-[14px] text-primary/0 group-hover:text-primary/60 leading-none shrink-0 transition-colors">
                    open_in_new
                  </span>
                </button>
              )}
              <div className="grid grid-cols-12 gap-4 px-6 py-4 bg-surface-container-low font-label text-[10px] uppercase tracking-[0.15em] text-outline border-b border-white/5">
                <div className="col-span-9">File Name</div>
                <div className="col-span-2 text-right">Size</div>
                <div className="col-span-1"></div>
              </div>

              {isLoadingFiles ? (
                <div className="flex items-center justify-center py-16">
                  <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                </div>
              ) : folderFiles.length === 0 ? (
                <div className="py-16 text-center font-label text-xs text-on-surface-variant/40 uppercase tracking-widest">
                  No video files found
                </div>
              ) : (
                <div className="divide-y divide-white/[0.02]">
                  {folderFiles.map((file, i) => (
                    <div
                      key={file.path}
                      onDoubleClick={() => window.libraryApi.playVideo(file.path)}
                      className={`group grid grid-cols-12 gap-4 px-6 py-4 items-center transition-colors cursor-pointer ${
                        i % 2 === 0
                          ? "bg-surface hover:bg-surface-container"
                          : "bg-surface-container-low hover:bg-surface-container"
                      }`}
                    >
                      <div className="col-span-9 flex items-center gap-4 min-w-0">
                        <span className="material-symbols-outlined text-primary/40 group-hover:text-primary transition-colors leading-none shrink-0">
                          movie
                        </span>
                        <span className="text-sm font-headline font-bold text-on-surface truncate">
                          {file.name}
                        </span>
                      </div>
                      <div className="col-span-2 text-right font-label text-xs text-on-surface-variant tabular-nums">
                        {formatSize(file.sizeBytes)}
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary shadow-lg shadow-primary/20"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.libraryApi.playVideo(file.path);
                          }}
                          title="Play"
                        >
                          <span
                            className="material-symbols-outlined leading-none"
                            style={{ fontVariationSettings: "'FILL' 1" }}
                          >
                            play_arrow
                          </span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Floating Status Bar */}
        <div className="fixed bottom-8 right-8 bg-surface-container-lowest/80 backdrop-blur-md ring-1 ring-outline-variant/30 rounded-full px-6 py-3 flex items-center justify-between shadow-2xl z-[55]">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 ${isScanning ? "bg-green-400 animate-pulse" : "bg-outline-variant"} rounded-full`}
              />
              <span className="font-label text-[10px] text-on-surface-variant uppercase tracking-widest">
                {isScanning ? "Scanning Active" : "Idle"}
              </span>
            </div>
            <div className="h-4 w-[1px] bg-outline-variant/30" />
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
                />
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
            />
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
                  className="text-on-surface-variant hover:text-on-surface transition-colors"
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
                          const removed = p.path;
                          const newPaths = await window.libraryApi.removePath(removed);
                          setPaths(newPaths);
                          setPosters(prev => prev.filter(e => !e.folderPath.startsWith(removed)));
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

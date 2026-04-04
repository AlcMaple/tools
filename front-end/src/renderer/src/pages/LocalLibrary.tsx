import { useState, useMemo, useEffect } from "react";
import TopBar from "../components/TopBar";
import defaultCover from "../assets/default-cover-2.png";
import type { LibraryFile } from "../env";

type SortMode = "default" | "recent" | "size" | "az";

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
  const [selectedPoster, setSelectedPoster] = useState<any | null>(null);
  const [modalFiles, setModalFiles] = useState<LibraryFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("default");
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

  // Load real file list when modal opens
  useEffect(() => {
    if (!selectedPoster) {
      setModalFiles([]);
      return;
    }
    setIsLoadingFiles(true);
    window.libraryApi.getFiles(selectedPoster.folderPath).then((files) => {
      setModalFiles(files);
      setIsLoadingFiles(false);
    });
  }, [selectedPoster]);

  const filteredPosters = useMemo(() => {
    const base = searchQuery.trim()
      ? posters.filter((p) => {
          const q = searchQuery.toLowerCase();
          return (
            p.title.toLowerCase().includes(q) ||
            p.nativeTitle.toLowerCase().includes(q)
          );
        })
      : [...posters];

    switch (sortMode) {
      case "recent":
        return base.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
      case "size":
        return base.sort((a, b) => (b.totalSize ?? 0) - (a.totalSize ?? 0));
      case "az":
        return base.sort((a, b) => a.title.localeCompare(b.title));
      default:
        return base;
    }
  }, [searchQuery, posters, sortMode]);

  const modalTotalSize = modalFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
  const modalExts = [
    ...new Set(modalFiles.map((f) => f.name.split(".").pop()?.toUpperCase() ?? "")),
  ].join(", ");

  const SORT_OPTIONS: { label: string; value: SortMode }[] = [
    { label: "Default", value: "default" },
    { label: "Recently Added", value: "recent" },
    { label: "By Size", value: "size" },
    { label: "A–Z", value: "az" },
  ];

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
                  <span className="text-primary font-bold">{posters.length}</span>{" "}
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
              <span className="material-symbols-outlined leading-none">folder_zip</span>
              SCAN LOCAL FOLDERS
            </button>
          </div>

          {/* Sort Bar */}
          <div className="flex items-center gap-3 mb-8">
            <span className="font-label text-xs text-on-surface-variant uppercase tracking-widest mr-2">
              Sort by
            </span>
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSortMode(opt.value)}
                className={`px-5 py-2 rounded-full font-label text-xs font-bold uppercase tracking-widest transition-colors ${
                  sortMode === opt.value
                    ? "bg-primary text-on-primary"
                    : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        {/* Card Grid */}
        {isRefreshing ? (
          <SearchingState />
        ) : (
          <section className="px-12 pb-32 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {filteredPosters.length > 0 ? (
              filteredPosters.map((poster) => (
                <div
                  key={poster.id}
                  className="group bg-surface-container-low rounded-xl overflow-hidden border border-white/5 transition-all duration-300"
                >
                  {/* Landscape Thumbnail with hover overlay */}
                  <div className="aspect-video w-full overflow-hidden bg-surface-container-lowest relative">
                    <img
                      className="w-full h-full object-cover grayscale-[30%] group-hover:grayscale-0 transition-all duration-700"
                      alt={poster.title}
                      src={poster.image || defaultCover}
                    />
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-all duration-300 flex items-center justify-center gap-4">
                      <button
                        className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all flex items-center justify-center"
                        title="View File List"
                        onClick={(e) => { e.stopPropagation(); setSelectedPoster(poster); }}
                      >
                        <span className="material-symbols-outlined leading-none">list</span>
                      </button>
                      <button
                        className="w-14 h-14 rounded-full bg-primary text-on-primary shadow-xl shadow-primary/20 hover:scale-110 transition-all flex items-center justify-center"
                        title="Play"
                        onClick={(e) => { e.stopPropagation(); window.libraryApi.playFolder(poster.folderPath); }}
                      >
                        <span className="material-symbols-outlined text-2xl leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>
                          play_arrow
                        </span>
                      </button>
                      <button
                        className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all flex items-center justify-center"
                        title="Open Folder"
                        onClick={(e) => { e.stopPropagation(); window.libraryApi.openFolder(poster.folderPath); }}
                      >
                        <span className="material-symbols-outlined leading-none">folder_open</span>
                      </button>
                    </div>
                  </div>

                  {/* Info Area */}
                  <div className="p-5 flex flex-col">
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex flex-col gap-1">
                        <p className="font-label text-[10px] font-bold text-primary tracking-[0.2em] uppercase">LOCAL</p>
                        <p className="font-label text-[11px] text-on-surface-variant uppercase tracking-widest">
                          {poster.episodes || 0} Episodes
                        </p>
                      </div>
                      <span className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest text-right">
                        {poster.specs || "Unknown"}
                      </span>
                    </div>
                    <h3 className="font-headline font-bold text-xl text-on-surface truncate group-hover:text-primary transition-colors">
                      {poster.title}
                    </h3>
                  </div>
                </div>
              ))
            ) : (
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
            <div className="absolute inset-0" onClick={() => setIsScanModalOpen(false)} />
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
                  <span className="material-symbols-outlined leading-none">close</span>
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
                          <p className="text-xs font-label text-on-surface font-bold">{p.path}</p>
                          <p className="text-[10px] text-on-surface-variant font-label uppercase">
                            {p.label}
                          </p>
                        </div>
                      </div>
                      <button
                        className="text-on-surface-variant hover:text-error opacity-0 group-hover:opacity-100 transition-all leading-none"
                        onClick={async () => {
                          const newPaths = await window.libraryApi.removePath(p.path);
                          setPaths(newPaths);
                        }}
                      >
                        <span className="material-symbols-outlined text-sm leading-none">delete</span>
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  className="w-full py-4 border-2 border-dashed border-outline-variant/30 rounded-xl text-on-surface-variant hover:text-primary hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-center gap-3 font-label text-xs font-bold uppercase tracking-widest"
                  onClick={async () => {
                    const folder = await window.systemApi.pickFolder();
                    if (folder) {
                      const newPaths = await window.libraryApi.addPath(folder, "Local Folder");
                      setPaths(newPaths);
                    }
                  }}
                >
                  <span className="material-symbols-outlined text-sm leading-none">add</span>
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

        {/* Episode List Modal */}
        {selectedPoster && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-surface-container-lowest/40 backdrop-blur-md">
            <div className="absolute inset-0" onClick={() => setSelectedPoster(null)} />

            <div className="relative w-full max-w-4xl max-h-[870px] rounded-3xl overflow-hidden shadow-2xl flex flex-col border border-white/5 bg-[rgba(53,53,53,0.7)] backdrop-blur-[40px]">
              {/* Modal Header */}
              <div className="p-8 flex items-center justify-between border-b border-white/5">
                <div className="flex items-center gap-6">
                  <div className="w-20 h-28 rounded-lg overflow-hidden shadow-xl bg-surface-container-lowest flex-shrink-0">
                    <img
                      alt="Poster"
                      className="w-full h-full object-cover"
                      src={selectedPoster.image || defaultCover}
                    />
                  </div>
                  <div>
                    <h2 className="text-3xl font-black font-headline tracking-tighter text-on-surface">
                      {selectedPoster.title}
                    </h2>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="font-label text-sm text-primary">Local</span>
                      <span className="w-1 h-1 rounded-full bg-outline-variant" />
                      <span className="font-label text-sm text-on-surface-variant/60">
                        {selectedPoster.episodes || 0} Video Files
                      </span>
                      {selectedPoster.totalSize > 0 && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-outline-variant" />
                          <span className="font-label text-sm text-on-surface-variant/60">
                            {formatSize(selectedPoster.totalSize)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Open folder from modal header */}
                  <button
                    className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors text-on-surface-variant hover:text-on-surface"
                    title="Open Folder"
                    onClick={() => window.libraryApi.openFolder(selectedPoster.folderPath)}
                  >
                    <span className="material-symbols-outlined text-xl leading-none">folder_open</span>
                  </button>
                  <button
                    className="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center transition-colors"
                    onClick={() => setSelectedPoster(null)}
                  >
                    <span className="material-symbols-outlined text-on-surface-variant leading-none">close</span>
                  </button>
                </div>
              </div>

              {/* Scrollable File List */}
              <div className="flex-1 overflow-y-auto p-4 space-y-0.5">
                {isLoadingFiles ? (
                  <div className="flex items-center justify-center py-16">
                    <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                  </div>
                ) : modalFiles.length === 0 ? (
                  <div className="py-16 text-center font-label text-xs text-on-surface-variant/40 uppercase tracking-widest">
                    No video files found
                  </div>
                ) : (
                  modalFiles.map((file, i) => (
                    <div
                      key={file.path}
                      className="group grid grid-cols-[2rem_1fr_5rem_6rem] items-center gap-4 px-4 py-3 rounded-xl hover:bg-white/5 transition-all cursor-default"
                    >
                      {/* Index */}
                      <span className="font-label text-sm text-on-surface-variant/40 group-hover:text-primary transition-colors text-right tabular-nums">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {/* Filename */}
                      <div className="min-w-0">
                        <span className="font-headline font-semibold text-on-surface text-sm truncate block">
                          {file.name}
                        </span>
                      </div>
                      {/* Size */}
                      <span className="font-label text-xs text-on-surface-variant/50 text-right tabular-nums">
                        {formatSize(file.sizeBytes)}
                      </span>
                      {/* Play button */}
                      <button
                        className="opacity-0 group-hover:opacity-100 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-on-primary transition-all active:scale-95 ml-auto"
                        onClick={() => window.libraryApi.playVideo(file.path)}
                      >
                        <span
                          className="material-symbols-outlined text-sm leading-none"
                          style={{ fontVariationSettings: "'FILL' 1" }}
                        >
                          play_arrow
                        </span>
                        <span className="font-label font-bold text-xs">PLAY</span>
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Footer Stats */}
              <div className="p-6 bg-surface-container-lowest/50 border-t border-white/5 flex items-center justify-between">
                <div className="flex gap-6">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[9px] font-label text-on-surface-variant uppercase tracking-tighter">
                      Files
                    </span>
                    <span className="text-xs font-headline font-bold">
                      {modalFiles.length}
                    </span>
                  </div>
                  {modalExts && (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[9px] font-label text-on-surface-variant uppercase tracking-tighter">
                        Container
                      </span>
                      <span className="text-xs font-headline font-bold text-secondary">
                        {modalExts}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <span className="text-[9px] font-label text-on-surface-variant uppercase tracking-widest block mb-0.5">
                      Total Size
                    </span>
                    <span className="text-xs font-headline text-primary font-bold">
                      {formatSize(modalTotalSize)}
                    </span>
                  </div>
                  <button
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-on-primary font-label font-bold text-xs hover:brightness-110 transition-all active:scale-95 shadow-lg shadow-primary/20"
                    onClick={() => window.libraryApi.playFolder(selectedPoster.folderPath)}
                  >
                    <span
                      className="material-symbols-outlined text-sm leading-none"
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      play_arrow
                    </span>
                    PLAY ALL
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import type {
  GirigiriWatchInfo,
  GirigiriEpisode,
} from "../types/girigiri";
import type { SearchCard } from "../types/search";

interface Props {
  card: SearchCard;
  watchInfo: GirigiriWatchInfo;
  onClose: () => void;
  onStart: (selectedEps: GirigiriEpisode[]) => void;
}

export function GirigiriDownloadConfigModal({
  card,
  watchInfo,
  onClose,
  onStart,
}: Props): JSX.Element {
  // 如果没有 sources 数组，则提供一个默认片源
  const sources =
    watchInfo.sources.length > 0
      ? watchInfo.sources
      : [{ name: "默认片源", episodes: watchInfo.episodes }];
  const [sourceIdx, setSourceIdx] = useState(0);
  const eps = sources[sourceIdx]?.episodes ?? [];
  const [startStr, setStartStr] = useState("1");
  const [endStr, setEndStr] = useState(String(eps.length));

  const clampStart = (s: string): number =>
    Math.max(1, Math.min(eps.length, parseInt(s, 10) || 1));
  const clampEnd = (s: string, start: number): number =>
    Math.max(start, Math.min(eps.length, parseInt(s, 10) || eps.length));

  const handleSourceChange = (idx: number): void => {
    setSourceIdx(idx);
    const newEps = sources[idx]?.episodes ?? [];
    setStartStr("1");
    setEndStr(String(newEps.length));
  };

  const handleStart = (): void => {
    const s = clampStart(startStr);
    const e = clampEnd(endStr, s);
    onStart(eps.slice(s - 1, e));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-container-lowest/60 backdrop-blur-sm">
      <div className="bg-surface-container w-full max-w-lg rounded-xl border border-outline-variant/20 p-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="font-headline font-black text-lg text-on-surface tracking-tight">
              {watchInfo.title || card.title}
            </h3>
            <p className="font-label text-xs text-on-surface-variant/50 mt-1 tracking-widest uppercase">
              {eps.length} Episodes · Girigiri · HLS
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors text-on-surface-variant/60"
          >
            <span className="material-symbols-outlined text-xl leading-none">
              close
            </span>
          </button>
        </div>

        <div className="mb-6">
          <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">
            Download Source
          </p>
          <div className="space-y-2">
            {sources.map((src, i) => (
              <label
                key={i}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${sourceIdx === i ? "border-primary/40 bg-primary/5" : "border-outline-variant/20 hover:bg-surface-container-high"}`}
              >
                <input
                  type="radio"
                  name="girigiri_source"
                  value={i}
                  checked={sourceIdx === i}
                  onChange={() => handleSourceChange(i)}
                  className="accent-primary"
                />
                <span className="font-label text-sm text-on-surface">
                  {src.name.replace(/[\uE000-\uF8FF]/g, "").trim()}
                </span>
                <span className="ml-auto font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest">
                  {src.episodes.length} Episodes
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="mb-8">
          <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">
            Episode Range
          </p>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest block mb-1.5">
                From
              </label>
              <input
                type="number"
                min={1}
                max={eps.length}
                value={startStr}
                onChange={(e) => setStartStr(e.target.value)}
                onBlur={() => setStartStr(String(clampStart(startStr)))}
                className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2.5 text-sm font-label text-on-surface outline-none focus:border-primary/40 transition-colors"
              />
            </div>
            <span className="text-on-surface-variant/30 mt-5">—</span>
            <div className="flex-1">
              <label className="font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest block mb-1.5">
                To
              </label>
              <input
                type="number"
                min={1}
                max={eps.length}
                value={endStr}
                onChange={(e) => setEndStr(e.target.value)}
                onBlur={() =>
                  setEndStr(String(clampEnd(endStr, clampStart(startStr))))
                }
                className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg px-3 py-2.5 text-sm font-label text-on-surface outline-none focus:border-primary/40 transition-colors"
              />
            </div>
            <div className="mt-5">
              <span className="font-label text-[10px] text-on-surface-variant/30">
                / {eps.length}
              </span>
            </div>
          </div>
          <p className="font-label text-[10px] text-on-surface-variant/30 mt-3 leading-relaxed">
            Each episode uses Playwright to capture the stream link — download
            may take longer than Xifan.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-outline-variant/20 text-sm font-label text-on-surface-variant hover:bg-surface-container-high transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={eps.length === 0}
            className="flex-1 py-3 rounded-xl primary-gradient text-on-primary text-sm font-black tracking-widest hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base leading-none">
              bolt
            </span>
            START DOWNLOAD
          </button>
        </div>
      </div>
    </div>
  );
}

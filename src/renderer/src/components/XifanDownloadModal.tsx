import { useState } from "react";
import type { XifanWatchInfo } from "../types/xifan";
import type { SearchCard } from "../types/search";

interface Props {
  card: SearchCard;
  watchInfo: XifanWatchInfo;
  onClose: () => void;
  onStart: (templates: string[], startEp: number, endEp: number) => void;
}

export function XifanDownloadConfigModal({
  card,
  watchInfo,
  onClose,
  onStart,
}: Props): JSX.Element {
  const validSources = watchInfo.sources.filter((s) => s.template);
  const [selectedIdx, setSelectedIdx] = useState(validSources[0]?.idx ?? 1);
  const [startStr, setStartStr] = useState("1");
  const [endStr, setEndStr] = useState(String(watchInfo.total));

  const clampStart = (s: string): number =>
    Math.max(1, Math.min(watchInfo.total, parseInt(s, 10) || 1));
  const clampEnd = (s: string, start: number): number =>
    Math.max(
      start,
      Math.min(watchInfo.total, parseInt(s, 10) || watchInfo.total),
    );

  const handleStart = (): void => {
    const selected = validSources.find((s) => s.idx === selectedIdx);
    if (!selected?.template) return;
    // Pass all valid templates (selected first) so user can cycle sources if it fails.
    const ordered = [
      selected.template,
      ...validSources
        .filter((s) => s.idx !== selectedIdx)
        .map((s) => s.template!),
    ];
    onStart(
      ordered,
      clampStart(startStr),
      clampEnd(endStr, clampStart(startStr)),
    );
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
              {watchInfo.total} Episodes · Xifan
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

        {validSources.length > 0 ? (
          <div className="mb-6">
            <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">
              Download Source
            </p>
            <div className="space-y-2">
              {validSources.map((src) => (
                <label
                  key={src.idx}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selectedIdx === src.idx ? "border-primary/40 bg-primary/5" : "border-outline-variant/20 hover:bg-surface-container-high"}`}
                >
                  <input
                    type="radio"
                    name="source"
                    value={src.idx}
                    checked={selectedIdx === src.idx}
                    onChange={() => setSelectedIdx(src.idx)}
                    className="accent-primary"
                  />
                  <span className="font-label text-sm text-on-surface">
                    {src.name.replace(/[\uE000-\uF8FF]/g, "").trim()}
                  </span>
                  <span className="ml-auto font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest">
                    {watchInfo.total} Episodes
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div className="mb-6 p-4 rounded-lg bg-error/10 border border-error/20">
            <p className="font-label text-xs text-error">
              No valid download sources found.
            </p>
          </div>
        )}

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
                max={watchInfo.total}
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
                max={watchInfo.total}
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
                / {watchInfo.total}
              </span>
            </div>
          </div>
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
            disabled={validSources.length === 0}
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

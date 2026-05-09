import { useState } from "react";

/**
 * Shared shell for the per-source DownloadConfigModal trio (xifan / girigiri /
 * aowu). All three render the same chrome — overlay, header, source radio list,
 * Episode Range From/To inputs, footer Cancel + START — differing only in the
 * shape of `sources` / `onStart` they need from the caller.
 *
 * Each per-source wrapper collapses to ~30 lines of data shaping; visual changes
 * are made in one place here and apply to all sources at once.
 */

export interface SourceOption {
  /** Stable id for the radio's `value` and `onSelectSource` callback. */
  id: string | number;
  name: string;
  episodeCount: number;
}

interface Props {
  title: string;
  subtitle: string;
  sources: SourceOption[];
  /** Index into `sources` of the initial pick. Default 0. */
  initialSourceIndex?: number;
  /** Optional footnote shown below the Episode Range input. */
  footerNote?: string;
  /** Shown in place of the source list when `sources` is empty. */
  noSourceMessage?: string;
  onClose: () => void;
  /** Called with the picked source plus the validated (startEp, endEp) range. */
  onStart: (source: SourceOption, startEp: number, endEp: number) => void;
}

export function DownloadConfigShell({
  title,
  subtitle,
  sources,
  initialSourceIndex = 0,
  footerNote,
  noSourceMessage,
  onClose,
  onStart,
}: Props): JSX.Element {
  const [sourceIdx, setSourceIdx] = useState(
    Math.min(Math.max(0, initialSourceIndex), Math.max(0, sources.length - 1)),
  );
  const selected: SourceOption | undefined = sources[sourceIdx];
  const epCount = selected?.episodeCount ?? 0;
  const [startStr, setStartStr] = useState("1");
  const [endStr, setEndStr] = useState(String(epCount || 1));

  const clampStart = (s: string): number =>
    Math.max(1, Math.min(epCount || 1, parseInt(s, 10) || 1));
  const clampEnd = (s: string, start: number): number =>
    Math.max(start, Math.min(epCount || 1, parseInt(s, 10) || epCount || 1));

  const handleSourceChange = (i: number): void => {
    setSourceIdx(i);
    const newCount = sources[i]?.episodeCount ?? 0;
    setStartStr("1");
    setEndStr(String(newCount || 1));
  };

  const handleStart = (): void => {
    if (!selected || epCount === 0) return;
    const s = clampStart(startStr);
    const e = clampEnd(endStr, s);
    onStart(selected, s, e);
  };

  const startDisabled = !selected || epCount === 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-container-lowest/60 backdrop-blur-sm">
      <div className="bg-surface-container w-full max-w-lg rounded-xl border border-outline-variant/20 p-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="font-headline font-black text-lg text-on-surface tracking-tight">
              {title}
            </h3>
            <p className="font-label text-xs text-on-surface-variant/50 mt-1 tracking-widest uppercase">
              {subtitle}
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

        {sources.length > 0 ? (
          <div className="mb-6">
            <p className="font-label text-[10px] text-on-surface-variant/60 uppercase tracking-widest mb-3">
              Download Source
            </p>
            <div className="space-y-2">
              {sources.map((src, i) => (
                <label
                  key={`${src.id}-${i}`}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${sourceIdx === i ? "border-primary/40 bg-primary/5" : "border-outline-variant/20 hover:bg-surface-container-high"}`}
                >
                  <input
                    type="radio"
                    name="download-source"
                    value={i}
                    checked={sourceIdx === i}
                    onChange={() => handleSourceChange(i)}
                    className="accent-primary"
                  />
                  <span className="font-label text-sm text-on-surface">
                    {src.name}
                  </span>
                  <span className="ml-auto font-label text-[10px] text-on-surface-variant/40 uppercase tracking-widest">
                    {src.episodeCount} Episodes
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div className="mb-6 p-4 rounded-lg bg-error/10 border border-error/20">
            <p className="font-label text-xs text-error">
              {noSourceMessage ?? "No valid download sources found."}
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
                max={epCount || 1}
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
                max={epCount || 1}
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
                / {epCount}
              </span>
            </div>
          </div>
          {footerNote && (
            <p className="font-label text-[10px] text-on-surface-variant/30 mt-3 leading-relaxed">
              {footerNote}
            </p>
          )}
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
            disabled={startDisabled}
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

/** Strip Private-Use Area glyphs that some sites embed in source labels. */
export function cleanSourceName(s: string): string {
  return s.replace(/[\u{E000}-\u{F8FF}]/gu, "").trim();
}

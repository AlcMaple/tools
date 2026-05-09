import type { AowuWatchInfo, AowuEpisode, AowuSource } from "../types/aowu";
import type { SearchCard } from "../types/search";
import {
  DownloadConfigShell,
  type SourceOption,
} from "./DownloadConfigShell";

interface Props {
  card: SearchCard;
  watchInfo: AowuWatchInfo;
  onClose: () => void;
  onStart: (
    sourceIdx: number,
    epList: AowuEpisode[],
    selectedIdxs: number[],
  ) => void;
}

export function AowuDownloadConfigModal({
  card,
  watchInfo,
  onClose,
  onStart,
}: Props): JSX.Element {
  const sources: AowuSource[] =
    watchInfo.sources.length > 0
      ? watchInfo.sources
      : [{ idx: 1, name: "默认片源", episodes: [] }];

  const options: SourceOption[] = sources.map((s) => ({
    id: s.idx,
    name: s.name,
    episodeCount: s.episodes.length,
  }));

  const handleStart = (
    source: SourceOption,
    startEp: number,
    endEp: number,
  ): void => {
    const src = sources.find((s) => s.idx === source.id);
    if (!src) return;
    const slice = src.episodes.slice(startEp - 1, endEp);
    onStart(
      src.idx,
      src.episodes,
      slice.map((ep) => ep.idx),
    );
  };

  return (
    <DownloadConfigShell
      title={watchInfo.title || card.title}
      subtitle={`${sources[0]?.episodes.length ?? 0} Episodes · Aowu · MP4`}
      sources={options}
      footerNote="Each episode resolves a fresh signed URL (3 hops + AES decrypt) before the 8-thread Range download begins."
      onClose={onClose}
      onStart={handleStart}
    />
  );
}

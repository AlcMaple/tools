import type {
  GirigiriWatchInfo,
  GirigiriEpisode,
  GirigiriSource,
} from "../types/girigiri";
import type { SearchCard } from "../types/search";
import {
  DownloadConfigShell,
  cleanSourceName,
  type SourceOption,
} from "./DownloadConfigShell";

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
  // Fall back to a synthetic single source if the watch page didn't expose any.
  const sources: GirigiriSource[] =
    watchInfo.sources.length > 0
      ? watchInfo.sources
      : [{ name: "默认片源", episodes: watchInfo.episodes }];

  const options: SourceOption[] = sources.map((s, i) => ({
    id: i,
    name: cleanSourceName(s.name),
    episodeCount: s.episodes.length,
  }));

  const handleStart = (
    source: SourceOption,
    startEp: number,
    endEp: number,
  ): void => {
    const eps = sources[source.id as number]?.episodes ?? [];
    onStart(eps.slice(startEp - 1, endEp));
  };

  return (
    <DownloadConfigShell
      title={watchInfo.title || card.title}
      subtitle={`${sources[0]?.episodes.length ?? 0} Episodes · Girigiri · HLS`}
      sources={options}
      footerNote="Each episode uses Playwright to capture the stream link — download may take longer than Xifan."
      onClose={onClose}
      onStart={handleStart}
    />
  );
}

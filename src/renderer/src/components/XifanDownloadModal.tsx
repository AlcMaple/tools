import type { XifanWatchInfo } from "../types/xifan";
import type { SearchCard } from "../types/search";
import {
  DownloadConfigShell,
  cleanSourceName,
  type SourceOption,
} from "./DownloadConfigShell";

interface Props {
  card: SearchCard;
  watchInfo: XifanWatchInfo;
  onClose: () => void;
  onStart: (
    templates: string[],
    startEp: number,
    endEp: number,
    excluded: number[],
  ) => void;
}

export function XifanDownloadConfigModal({
  card,
  watchInfo,
  onClose,
  onStart,
}: Props): JSX.Element {
  const validSources = watchInfo.sources.filter((s) => s.template);
  const options: SourceOption[] = validSources.map((s) => ({
    id: s.idx,
    name: cleanSourceName(s.name),
    // Xifan doesn't expose per-source episode counts — total is the same
    // across templates, so reuse watchInfo.total for every option.
    episodeCount: watchInfo.total,
  }));

  const handleStart = (
    source: SourceOption,
    startEp: number,
    endEp: number,
    excluded: number[],
  ): void => {
    const selected = validSources.find((s) => s.idx === source.id);
    if (!selected?.template) return;
    // Pass all valid templates (selected first) so user can cycle sources if it fails.
    const ordered = [
      selected.template,
      ...validSources
        .filter((s) => s.idx !== selected.idx)
        .map((s) => s.template!),
    ];
    // Xifan 的集号 == 序号,排除项直接就是要跳过的 ep 号。
    onStart(ordered, startEp, endEp, excluded);
  };

  return (
    <DownloadConfigShell
      title={watchInfo.title || card.title}
      subtitle={`${watchInfo.total} Episodes · Xifan`}
      sources={options}
      onClose={onClose}
      onStart={handleStart}
    />
  );
}

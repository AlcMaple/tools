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
    epPages: string[],
    startEp: number,
    endEp: number,
    excluded: number[],
  ) => void;
}

/**
 * 站点集名 → 网格展示名:「第01集」「01」这类普通集显示集号 n,
 * 非数字的特殊集(OVA / SP / 剧场版等)原样显示,让用户知道这一格不是正片。
 */
function displayEpLabel(label: string, n: number): string {
  const core = label.replace(/^第/, "").replace(/[集话話]$/, "").trim();
  return /^\d+$/.test(core) ? String(n) : label;
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
    epLabels: s.epLabels.map((l, i) => displayEpLabel(l, i + 1)),
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
    // epPages 与 templates 同序平行,切换源时 sourceIdx 同时索引两个数组。
    const ordered = [
      selected,
      ...validSources.filter((s) => s.idx !== selected.idx),
    ];
    // Xifan 的集号 == 序号,排除项直接就是要跳过的 ep 号。
    onStart(
      ordered.map((s) => s.template!),
      ordered.map((s) => s.epPage),
      startEp,
      endEp,
      excluded,
    );
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

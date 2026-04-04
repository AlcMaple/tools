import { useState, useRef, useEffect } from "react";
import TopBar from "../components/TopBar";
import type { XifanSearchResult, XifanWatchInfo } from "../types/xifan";
import type {
  GirigiriSearchResult,
  GirigiriWatchInfo,
  GirigiriEpisode,
} from "../types/girigiri";
import { downloadStore } from "../stores/downloadStore";

// ── Types ──────────────────────────────────────────────────────────────────────

type Source = "Xifan" | "Girigiri";

/** Normalized card for display — works for both sources */
interface SearchCard {
  title: string;
  cover: string;
  year: string;
  tag: string; // region (girigiri) or area (xifan)
  count: string; // episode count (xifan) or empty
  key: string; // watch_url (xifan) or play_url (girigiri)
  source: Source;
}

type PageState =
  | { status: "idle" }
  | {
      status: "captcha";
      imageB64: string;
      keyword: string;
      captchaSource: Source;
      captchaError?: string;
    }
  | { status: "verifying"; keyword: string; captchaSource: Source }
  | { status: "searching" }
  | { status: "results"; cards: SearchCard[]; keyword: string }
  | {
      status: "xifan_config";
      cards: SearchCard[];
      card: SearchCard;
      watchInfo: XifanWatchInfo;
    }
  | {
      status: "girigiri_config";
      cards: SearchCard[];
      card: SearchCard;
      watchInfo: GirigiriWatchInfo;
    }
  | { status: "error"; message: string };

// ── Module-level cache ─────────────────────────────────────────────────────────

let _cachedState: PageState = { status: "idle" };
let _cachedSearchQuery = "";
let _cachedKeyword = "";

// ── Cache helpers ──────────────────────────────────────────────────────────────

function isSearchCacheEnabled(): boolean {
  try {
    return (
      JSON.parse(localStorage.getItem("xifan_settings") || "{}")
        .searchCacheEnabled !== false
    );
  } catch {
    return true;
  }
}

async function getCachedSearch(
  keyword: string,
  source: Source,
): Promise<SearchCard[] | null> {
  try {
    const key = `search_cache_${source.toLowerCase()}`;
    const cache = (await window.systemApi.cacheGet(key)) as Record<
      string,
      SearchCard[]
    > | null;
    if (cache && cache[keyword]) {
      console.log(`[Cache 读取] 成功命中关键词: "${keyword}"`);
      return cache[keyword];
    }
    console.log(`[Cache 读取] 未找到关键词: "${keyword}"`);
    return null;
  } catch (err) {
    console.error(`[Cache 读取错误] 无法读取本地缓存:`, err);
    return null;
  }
}

async function setCachedSearch(
  keyword: string,
  source: Source,
  cards: SearchCard[],
): Promise<void> {
  const key = `search_cache_${source.toLowerCase()}`;
  try {
    console.log(
      `[Cache 写入] 正在保存 "${keyword}" 的 ${cards.length} 条数据...`,
    );
    const existingCache =
      ((await window.systemApi.cacheGet(key)) as Record<
        string,
        SearchCard[]
      >) || {};
    existingCache[keyword] = cards;
    await window.systemApi.cacheSet(key, existingCache);
    console.log(`[Cache 写入] 成功保存到本地硬盘！`);
  } catch (err) {
    console.error(
      `[Cache 写入致命错误] 缓存保存失败，可能是 Base64 数据过大或底层 API 报错:`,
      err,
    );
  }
}

function getCachedXifanWatch(url: string): XifanWatchInfo | null {
  try {
    return (
      (
        JSON.parse(
          localStorage.getItem("xifan_watch_cache_v3") || "{}",
        ) as Record<string, XifanWatchInfo>
      )[url] ?? null
    );
  } catch {
    return null;
  }
}

function setCachedXifanWatch(url: string, info: XifanWatchInfo): void {
  try {
    const cache = JSON.parse(
      localStorage.getItem("xifan_watch_cache_v3") || "{}",
    ) as Record<string, XifanWatchInfo>;
    cache[url] = info;
    localStorage.setItem("xifan_watch_cache_v3", JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

function getSavePath(): string | undefined {
  try {
    return (
      JSON.parse(localStorage.getItem("xifan_settings") || "{}").downloadPath ||
      undefined
    );
  } catch {
    return undefined;
  }
}

// ── Normalizers ────────────────────────────────────────────────────────────────

function normalizeXifan(r: XifanSearchResult): SearchCard {
  return {
    title: r.title,
    cover: r.cover,
    year: r.year,
    tag: r.area,
    count: r.episode,
    key: r.watch_url,
    source: "Xifan",
  };
}

function normalizeGirigiri(r: GirigiriSearchResult): SearchCard {
  return {
    title: r.title,
    cover: r.cover,
    year: r.year,
    tag: r.region,
    count: "",
    key: r.play_url,
    source: "Girigiri",
  };
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ImagePlaceholder({
  className = "",
}: {
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`bg-surface-container-high flex items-center justify-center ${className}`}
    >
      <span className="material-symbols-outlined text-on-surface-variant/20 text-4xl">
        movie
      </span>
    </div>
  );
}

function CoverImage({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [hasError, setHasError] = useState(false);

  if (!src || hasError) {
    return <ImagePlaceholder className="w-full h-full" />;
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      className="w-full h-full object-cover"
      onError={() => setHasError(true)}
    />
  );
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

// ── Xifan Download Config Modal ────────────────────────────────────────────────

interface XifanConfigProps {
  card: SearchCard;
  watchInfo: XifanWatchInfo;
  onClose: () => void;
  onStart: (templates: string[], startEp: number, endEp: number) => void;
}

function XifanDownloadConfigModal({
  card,
  watchInfo,
  onClose,
  onStart,
}: XifanConfigProps): JSX.Element {
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
    onStart(
      [selected.template],
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

// ── Girigiri Download Config Modal ─────────────────────────────────────────────

interface GirigiriConfigProps {
  card: SearchCard;
  watchInfo: GirigiriWatchInfo;
  onClose: () => void;
  onStart: (selectedEps: GirigiriEpisode[]) => void;
}

interface GirigiriConfigProps {
  card: SearchCard;
  watchInfo: GirigiriWatchInfo;
  onClose: () => void;
  onStart: (selectedEps: GirigiriEpisode[]) => void;
}

function GirigiriDownloadConfigModal({
  card,
  watchInfo,
  onClose,
  onStart,
}: GirigiriConfigProps): JSX.Element {
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

// ── Main component ─────────────────────────────────────────────────────────────

function SearchDownload(): JSX.Element {
  const [state, setState] = useState<PageState>(() => {
    const s = _cachedState;
    if (s.status === "searching" || s.status === "verifying")
      return { status: "idle" };
    if (s.status === "xifan_config" || s.status === "girigiri_config") {
      return { status: "results", cards: s.cards, keyword: _cachedKeyword };
    }
    return s;
  });
  const [source, setSource] = useState<Source>("Xifan");
  const [searchQuery, setSearchQuery] = useState(() => _cachedSearchQuery);
  const [captchaInput, setCaptchaInput] = useState("");
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const currentKeyword = useRef(_cachedKeyword);

  useEffect(() => {
    _cachedState = state;
  }, [state]);
  useEffect(() => {
    _cachedSearchQuery = searchQuery;
  }, [searchQuery]);
  useEffect(() => {
    _cachedKeyword = currentKeyword.current;
  }, [state]);

  // ── Search ──────────────────────────────────────────────────────────────────

  const handleSearch = async (keyword: string): Promise<void> => {
    if (!keyword.trim()) return;
    currentKeyword.current = keyword;
    setSearchQuery(keyword);

    if (isSearchCacheEnabled()) {
      const cached = await getCachedSearch(keyword, source);
      if (cached) {
        setState({ status: "results", cards: cached, keyword });
        return;
      }
    }

    setState({ status: "searching" });
    try {
      if (source === "Girigiri") {
        const result = await window.girigiriApi.search(keyword);
        if (!Array.isArray(result) && result.needs_captcha) {
          const { image_b64 } = await window.girigiriApi.getCaptcha();
          setCaptchaInput("");
          setState({
            status: "captcha",
            imageB64: image_b64,
            keyword,
            captchaSource: "Girigiri",
          });
        } else if (Array.isArray(result)) {
          const cards = result.map(normalizeGirigiri);
          setCachedSearch(keyword, source, cards);
          setState({ status: "results", cards, keyword });
        }
      } else {
        const result = await window.xifanApi.search(keyword);
        if (!Array.isArray(result) && result.needs_captcha) {
          const { image_b64 } = await window.xifanApi.getCaptcha();
          setCaptchaInput("");
          setState({
            status: "captcha",
            imageB64: image_b64,
            keyword,
            captchaSource: "Xifan",
          });
        } else if (Array.isArray(result)) {
          const cards = result.map(normalizeXifan);
          setCachedSearch(keyword, source, cards);
          setState({ status: "results", cards, keyword });
        }
      }
    } catch (err) {
      setState({ status: "error", message: String(err) });
    }
  };

  // ── Captcha ─────────────────────────────────────────────────────────────────

  const handleRefreshCaptcha = async (): Promise<void> => {
    if (state.status !== "captcha") return;
    try {
      const api =
        state.captchaSource === "Girigiri"
          ? window.girigiriApi
          : window.xifanApi;
      const { image_b64 } = await api.getCaptcha();
      setCaptchaInput("");
      setState({ ...state, imageB64: image_b64, captchaError: undefined });
    } catch {
      /* silently fail */
    }
  };

  const handleVerify = async (): Promise<void> => {
    if (state.status !== "captcha") return;
    const { keyword, captchaSource } = state;
    setState({ status: "verifying", keyword, captchaSource });
    const api =
      captchaSource === "Girigiri" ? window.girigiriApi : window.xifanApi;
    try {
      const { success } = await api.verifyCaptcha(captchaInput.trim());
      if (success) {
        setState({ status: "searching" });
        if (captchaSource === "Girigiri") {
          const result = await window.girigiriApi.search(keyword);
          if (Array.isArray(result)) {
            const cards = result.map(normalizeGirigiri);
            setCachedSearch(keyword, captchaSource, cards);
            setState({ status: "results", cards, keyword });
          } else {
            const { image_b64 } = await window.girigiriApi.getCaptcha();
            setCaptchaInput("");
            setState({
              status: "captcha",
              imageB64: image_b64,
              keyword,
              captchaSource,
              captchaError: "Verification failed, please retry.",
            });
          }
        } else {
          const result = await window.xifanApi.search(keyword);
          if (Array.isArray(result)) {
            const cards = result.map(normalizeXifan);
            setCachedSearch(keyword, captchaSource, cards);
            setState({ status: "results", cards, keyword });
          } else {
            const { image_b64 } = await window.xifanApi.getCaptcha();
            setCaptchaInput("");
            setState({
              status: "captcha",
              imageB64: image_b64,
              keyword,
              captchaSource,
              captchaError: "Verification failed, please retry.",
            });
          }
        }
      } else {
        const { image_b64 } = await api.getCaptcha();
        setCaptchaInput("");
        setState({
          status: "captcha",
          imageB64: image_b64,
          keyword,
          captchaSource,
          captchaError: "Wrong code, try again.",
        });
      }
    } catch (err) {
      setState({ status: "error", message: String(err) });
    }
  };

  // ── Download click (open config modal) ──────────────────────────────────────

  const handleDownloadClick = async (card: SearchCard): Promise<void> => {
    if (state.status !== "results") return;
    const { cards } = state;

    setLoadingKey(card.key);
    try {
      if (card.source === "Girigiri") {
        const watchInfo = await window.girigiriApi.getWatch(card.key);
        if (watchInfo.error) {
          alert(`Failed to load episodes: ${watchInfo.error}`);
          return;
        }
        setState({ status: "girigiri_config", cards, card, watchInfo });
      } else {
        if (isSearchCacheEnabled()) {
          const cached = getCachedXifanWatch(card.key);
          if (cached) {
            setState({
              status: "xifan_config",
              cards,
              card,
              watchInfo: cached,
            });
            return;
          }
        }
        const watchInfo = await window.xifanApi.getWatch(card.key);
        if (watchInfo.error) {
          alert(`Failed to load sources: ${watchInfo.error}`);
          return;
        }
        setCachedXifanWatch(card.key, watchInfo);
        setState({ status: "xifan_config", cards, card, watchInfo });
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      setLoadingKey(null);
    }
  };

  // ── Start xifan download ────────────────────────────────────────────────────

  const handleStartXifanDownload = async (
    templates: string[],
    startEp: number,
    endEp: number,
  ): Promise<void> => {
    if (state.status !== "xifan_config") return;
    const { card, cards, watchInfo } = state;
    const title = watchInfo.title || card.title;
    const savePath = getSavePath();
    try {
      const { taskId, pid } = await window.xifanApi.startDownload(
        title,
        templates,
        startEp,
        endEp,
        savePath,
      );
      const epStatus: Record<number, "pending"> = {};
      for (let ep = startEp; ep <= endEp; ep++) epStatus[ep] = "pending";
      downloadStore.addTask({
        id: taskId,
        source: "xifan",
        title,
        cover: card.cover,
        startEp,
        endEp,
        templates,
        savePath,
        status: "running",
        epStatus,
        epProgress: {},
        startedAt: Date.now(),
        pid,
      });
      setDownloadStarted(true);
      setTimeout(() => setDownloadStarted(false), 3000);
      setState({ status: "results", cards, keyword: currentKeyword.current });
    } catch (err) {
      alert(`Download error: ${err}`);
    }
  };

  // ── Start girigiri download ─────────────────────────────────────────────────

  const handleStartGirigiriDownload = async (
    selectedEps: GirigiriEpisode[],
  ): Promise<void> => {
    if (state.status !== "girigiri_config") return;
    const { card, cards, watchInfo } = state;
    const title = watchInfo.title || card.title;
    const savePath = getSavePath();
    const selectedIdxs = selectedEps.map((e) => e.idx);
    try {
      const { taskId } = await window.girigiriApi.startDownload(
        title,
        selectedEps,
        selectedIdxs,
        savePath,
      );
      const epStatus: Record<number, "pending"> = {};
      for (const idx of selectedIdxs) epStatus[idx] = "pending";
      downloadStore.addTask({
        id: taskId,
        source: "girigiri",
        title,
        cover: card.cover,
        startEp: selectedIdxs[0],
        endEp: selectedIdxs[selectedIdxs.length - 1],
        templates: [],
        girigiriEps: selectedEps,
        savePath,
        status: "running",
        epStatus,
        epProgress: {},
        startedAt: Date.now(),
      });
      setDownloadStarted(true);
      setTimeout(() => setDownloadStarted(false), 3000);
      setState({ status: "results", cards, keyword: currentKeyword.current });
    } catch (err) {
      alert(`Download error: ${err}`);
    }
  };

  const isSearching =
    state.status === "searching" || state.status === "verifying";
  const captchaSourceLabel =
    state.status === "captcha"
      ? state.captchaSource === "Girigiri"
        ? "Girigiri Love"
        : "Xifan ACG"
      : "";

  return (
    <div className="min-h-full bg-background">
      <TopBar placeholder="Quick find archives..." onSearch={handleSearch} />

      <main className="pt-16 px-8 py-8">
        {/* Hero */}
        <section className="mt-10 mb-12">
          <p className="font-label text-xs text-primary/70 tracking-[0.3em] uppercase mb-3">
            Multisource Downloader
          </p>
          <h1 className="text-7xl font-black leading-none tracking-tighter text-on-surface mb-4">
            INDEX THE <span className="text-primary">MULTIVERSE</span>
          </h1>
          <p className="text-on-surface-variant/60 text-sm max-w-lg font-label">
            Search and retrieve anime from multiple sources simultaneously.
            Automated pipeline from search to archive.
          </p>
        </section>

        {/* Search bar */}
        <section className="mb-10">
          <div className="flex items-center gap-3 max-w-3xl">
            <div className="flex-1 flex items-center bg-surface-container-highest rounded-xl px-5 py-3.5 space-x-3 border border-outline-variant/30 focus-within:border-primary/40 transition-colors">
              <span className="material-symbols-outlined text-primary text-xl leading-none">
                travel_explore
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && handleSearch(searchQuery)
                }
                placeholder="Enter anime title or keyword..."
                className="flex-1 bg-transparent text-on-surface placeholder-on-surface-variant/40 outline-none text-sm font-label"
              />
            </div>

            {/* Source selector */}
            <div className="relative">
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as Source)}
                className="appearance-none bg-surface-container-highest border border-outline-variant/30 text-on-surface text-sm font-label rounded-xl px-4 py-3.5 pr-8 outline-none cursor-pointer hover:border-primary/40 transition-colors"
              >
                <option value="Xifan">Xifan</option>
                <option value="Girigiri">Girigiri</option>
              </select>
              <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant/60 text-sm pointer-events-none leading-none">
                expand_more
              </span>
            </div>

            <button
              onClick={() => handleSearch(searchQuery)}
              disabled={isSearching}
              className="primary-gradient text-on-primary font-black text-sm tracking-widest px-7 py-3.5 rounded-xl hover:opacity-90 transition-opacity flex items-center space-x-2 disabled:opacity-50"
            >
              {isSearching ? (
                <div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />
              ) : (
                <span className="material-symbols-outlined text-base leading-none">
                  bolt
                </span>
              )}
              <span>INITIALIZE</span>
            </button>
          </div>
        </section>

        {/* Toast */}
        {downloadStarted && (
          <div className="fixed bottom-8 right-8 z-50 bg-surface-container-high border border-outline-variant/20 rounded-xl px-5 py-3 flex items-center gap-3 shadow-lg">
            <span className="material-symbols-outlined text-primary text-lg leading-none">
              check_circle
            </span>
            <span className="font-label text-sm text-on-surface">
              Download started in background
            </span>
          </div>
        )}

        {/* Results area */}
        {state.status === "idle" && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-on-surface-variant/20">
            <span className="material-symbols-outlined text-6xl">
              travel_explore
            </span>
            <p className="font-label text-xs tracking-widest uppercase">
              Enter a keyword to begin
            </p>
          </div>
        )}

        {state.status === "searching" && <SearchingState />}

        {state.status === "error" && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <span className="material-symbols-outlined text-error/60 text-5xl">
              error_outline
            </span>
            <p className="font-label text-sm text-error/80">{state.message}</p>
            <button
              onClick={() => setState({ status: "idle" })}
              className="font-label text-xs text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === "results" && state.cards.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <span className="material-symbols-outlined text-on-surface-variant/20 text-6xl">
              search_off
            </span>
            <p className="font-label text-sm text-on-surface-variant/50">
              No results found for{" "}
              <span className="text-primary">"{state.keyword}"</span>
            </p>
          </div>
        )}

        {(state.status === "results" ||
          state.status === "xifan_config" ||
          state.status === "girigiri_config") &&
          state.cards.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-xs font-label text-on-surface-variant/50 tracking-widest uppercase">
                  Search Results — {state.cards.length} entries found{" · "}
                  <span className="text-primary/60">
                    {currentKeyword.current}
                  </span>
                </h2>
                <div className="flex items-center space-x-2 text-xs font-label text-on-surface-variant/40">
                  <span className="material-symbols-outlined text-sm leading-none">
                    filter_list
                  </span>
                  <span>Sort by relevance</span>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-4">
                {state.cards.map((card, idx) => (
                  <div
                    key={idx}
                    className="group relative bg-surface-container rounded-xl overflow-hidden border border-outline-variant/20 hover:border-primary/30 transition-all duration-300"
                  >
                    <div className="aspect-[2/3] relative overflow-hidden">
                      {/* 处理封面或占位图 */}
                      <CoverImage src={card.cover} alt={card.title} />

                      {/* 点击下载后，加载剧集信息时的转圈动画 */}
                      {loadingKey === card.key && (
                        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                          <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        </div>
                      )}

                      {/* 鼠标悬浮时显示的黑色渐变遮罩和下载按钮 */}
                      {loadingKey !== card.key && (
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">
                          <button
                            onClick={() => handleDownloadClick(card)}
                            className="w-full primary-gradient text-on-primary text-xs font-black tracking-widest py-2.5 rounded-lg mb-2 flex items-center justify-center space-x-1.5"
                          >
                            <span className="material-symbols-outlined text-sm leading-none">
                              download
                            </span>
                            <span>DOWNLOAD</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="p-3">
                      <h3 className="text-sm font-bold text-on-surface truncate mb-1">
                        {card.title}
                      </h3>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-label text-on-surface-variant/50">
                          {card.year}
                          {card.tag ? ` · ${card.tag}` : ""}
                        </span>
                        {card.count && (
                          <span className="text-xs font-label text-primary/70">
                            {card.count}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
      </main>

      {/* CAPTCHA Modal */}
      {(state.status === "captcha" || state.status === "verifying") && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-surface-container-lowest/40 backdrop-blur-sm">
          <div className="glass-effect w-full max-w-md rounded-xl p-8 border border-outline-variant/30">
            <div className="flex items-start justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-primary text-xl leading-none">
                    security
                  </span>
                </div>
                <div>
                  <h3 className="text-sm font-black tracking-wider text-on-surface">
                    CRAWLER VERIFICATION
                  </h3>
                  <p className="text-[10px] font-label text-on-surface-variant/50 mt-0.5">
                    Source: {captchaSourceLabel}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setState({ status: "idle" })}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container transition-colors text-on-surface-variant/60 hover:text-on-surface"
              >
                <span className="material-symbols-outlined text-xl leading-none">
                  close
                </span>
              </button>
            </div>

            <div className="aspect-video rounded-lg overflow-hidden mb-4 relative bg-surface-container-high">
              {state.status === "captcha" && state.imageB64 ? (
                <img
                  src={`data:image/png;base64,${state.imageB64}`}
                  alt="CAPTCHA"
                  className="w-full h-full object-contain"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                </div>
              )}
            </div>

            {state.status === "captcha" && state.captchaError && (
              <p className="text-xs font-label text-error mb-3">
                {state.captchaError}
              </p>
            )}

            <button
              onClick={handleRefreshCaptcha}
              disabled={state.status === "verifying"}
              className="flex items-center space-x-1.5 text-xs font-label text-on-surface-variant/50 hover:text-primary transition-colors mb-5 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-sm leading-none">
                refresh
              </span>
              <span>Refresh image</span>
            </button>

            <div className="mb-6">
              <input
                type="text"
                value={captchaInput}
                onChange={(e) => setCaptchaInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleVerify()}
                placeholder="Enter characters above..."
                disabled={state.status === "verifying"}
                className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-4 py-3 text-sm font-label text-on-surface placeholder-on-surface-variant/40 outline-none focus:border-primary/40 transition-colors tracking-[0.3em] disabled:opacity-50"
              />
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={() => setState({ status: "idle" })}
                className="flex-1 py-3 rounded-xl border border-outline-variant/30 text-sm font-label text-on-surface-variant hover:bg-surface-container transition-colors"
              >
                CANCEL
              </button>
              <button
                onClick={handleVerify}
                disabled={state.status === "verifying" || !captchaInput.trim()}
                className="flex-1 py-3 rounded-xl primary-gradient text-on-primary text-sm font-black tracking-widest hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {state.status === "verifying" && (
                  <div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />
                )}
                VERIFY
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Xifan Download Config Modal */}
      {state.status === "xifan_config" && (
        <XifanDownloadConfigModal
          card={state.card}
          watchInfo={state.watchInfo}
          onClose={() =>
            setState({
              status: "results",
              cards: state.cards,
              keyword: currentKeyword.current,
            })
          }
          onStart={handleStartXifanDownload}
        />
      )}

      {/* Girigiri Download Config Modal */}
      {state.status === "girigiri_config" && (
        <GirigiriDownloadConfigModal
          card={state.card}
          watchInfo={state.watchInfo}
          onClose={() =>
            setState({
              status: "results",
              cards: state.cards,
              keyword: currentKeyword.current,
            })
          }
          onStart={handleStartGirigiriDownload}
        />
      )}
    </div>
  );
}

export default SearchDownload;

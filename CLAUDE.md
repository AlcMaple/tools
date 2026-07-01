# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file is the architecture reference. Two companion docs at the repo root are maintained alongside it: `AI_GUIDELINES.md` (中文, AI 代码生成护栏 — mistake log, locked tech stack/architecture boundaries, commit convention) and `DEVLOG.md` (中文, per-change dev log written before each commit). The deepest rationale for the network/scraping rules lives in `docs/scraping/bgm-集成参考手册.md`. To find where a feature lives, start at `docs/功能索引.md` (功能 → 文件地图).

## Project Overview

**MapleTools** is an Electron desktop app for searching, downloading, and managing anime. It integrates with three streaming sites (Xifan, Girigiri, Aowu) and pulls metadata from Bangumi (BGM) and Moegirl. Around that core sit a local library scanner (ffmpeg thumbnails), a seasonal anime calendar, WebDAV sync, mail-report jobs, a Windows recycle-bin helper, an in-app file explorer, a 妙语库 (witty-reply) study deck, and a self-rolled auto-updater.

Legacy prototypes under `archive/` (`python_legacy/`, `js_legacy/`, `image-tools/`) are kept for reference only and are **not** part of the Electron build.

Conventions worth knowing up front: reply in **Chinese**, write **code comments in Chinese** (explain *why*, not *what*), and when editing existing code **touch only what the change needs** — no incidental import reordering / reformatting / renames. No ESLint/Prettier is wired up; match the existing style (2-space indent, **no semicolons**, single quotes, `strict: true`, no `any`).

## Commands

All commands run from the project root:

```bash
npm install            # Install deps
npm run dev            # Dev server with hot reload (electron-vite)
npm run build          # Build main + preload + renderer into out/
npm run dist           # Build + electron-builder package into dist/
npm run build:win      # Local/cross Windows packaging (scripts/build-win.mjs)
npm run sync:manifest  # Sync update-manifest.json version ← package.json (run before every release)
```

There are no tests and no linter wired into npm scripts.

## Architecture

### Three-process model

- **Main** (`src/main/index.ts`) — Node env. Lifecycle, window creation, tray, custom protocol, updater bootstrap. All IPC handlers are registered via `registerAllIpc()` from `src/main/ipc/`.
- **Preload** (`src/preload/index.ts`) — Bridges main ↔ renderer with `contextBridge.exposeInMainWorld`. Exposes typed APIs as `window.bgmApi`, `window.xifanApi`, `window.girigiriApi`, `window.aowuApi`, `window.downloadApi`, `window.systemApi`, `window.libraryApi`, `window.fileExplorerApi`, `window.webdavApi`, `window.mailApi`, `window.miaoyuApi`, etc.
- **Renderer** (`src/renderer/src/`) — React + Tailwind SPA. Talks to main *only* through preload globals — it never touches network / filesystem / Node APIs directly.

### Main process layout (`src/main/`)

| Dir | Purpose |
|-----|---------|
| `ipc/` | One file per surface (`bgm.ts`, `xifan.ts`, `girigiri.ts`, `aowu.ts`, `library.ts`, `system.ts`, `fileExplorer.ts`, `webdav.ts`, `mail.ts`, `miaoyu.ts`). `index.ts` exports `registerAllIpc()`. |
| `bgm/` | Bangumi metadata: search, detail, calendar, cover caching. |
| `xifan/` | Xifan site: captcha + search + watch-page scraping, HLS/mp4 downloader with Range resume. |
| `girigiri/` | Girigiri site: api, downloader, cookie session. |
| `aowu/` | Aowu site: api, downloader, `secure.ts`, `url-resolver.ts`. See `docs/scraping/aowu-FantasyKon-逆向与反爬手册.md`. |
| `moegirl/` | `synopsis.ts` — fetch synopsis from Moegirl wiki. |
| `library/` | Local library scanner, ffmpeg thumbnail extraction, JSON persistence, file watcher. |
| `mail/` | SMTP transport + scheduled "anime report" and "calendar" mailers. |
| `updater/` | electron-updater wrapper. |
| `recycle/` | Windows-only recycle-bin helper (shells out to `recycle-helper.ps1`). |
| `shared/` | Cross-cutting utilities: `net-request.ts`, `rate-limit.ts`, `browser-session.ts`, `scrape-guard.ts`, `site-download-queue.ts`, `mp4-range-downloader.ts`, `json-store.ts`, `speed-tracker.ts` broadcaster, `logger.ts`. |

### Networking & scraping — the red lines (most important, non-obvious)

These are project red lines; violating them actively harms users. Full rationale in `docs/scraping/bgm-集成参考手册.md`.

- **All main-process HTTP goes through `src/main/shared/net-request.ts` (`netRequest()`), which uses Electron `net`** — never Node `https`/`axios`/`node-fetch`. Node `https` ignores the system proxy; with a Clash fake-ip proxy this resolves to unroutable `198.18.x` addresses and black-holes. Electron `net` follows the system proxy/PAC like the browser does.
- **No application-layer retry or probing after a failure.** A rate-limit / 5xx must `throw` up to the UI; the user decides when to retry via a countdown button. Do **not** auto-retry, do **not** periodically probe "is it back yet", do **not** silently `catch → return null`. The *only* allowed code-level retry is transport-layer transient blips (`withTransientRetry`: a single ECONNRESET-class socket jitter retry). No IP pools / proxy rotation / Playwright to "bypass" limits — all previously rejected.
- **User-Agent is deliberately opposite by target:** API endpoints (`api.bgm.tv`) use an honest `MapleTools/<ver>` UA; HTML scraping (`bgm.tv` etc.) uses a randomized browser-spoof UA via `BrowserSession`. Don't mix them.
- External API calls share `shared/rate-limit.ts` `RateLimiter` (interval + jitter) for serial throttling.

### Download queue design

Per-source in-memory queues live inside each downloader module (xifan, girigiri, aowu), built on `shared/site-download-queue.ts`. Each queue has `pending[]`, `priorityFront[]` (for resuming a specific episode), a `pausedEps` Set, and an `AbortController` for the currently running episode. Episodes run sequentially, one at a time. **Queue state is lost on restart** — the renderer persists task metadata in `localStorage` and recreates queues via `resume` IPCs.

All three downloaders emit progress on a single channel `download:progress` so the renderer only needs one listener (subscribe via `window.downloadApi.onProgress`).

### Renderer (`src/renderer/src/`)

- **Pages** (`pages/`): `SearchDownload`, `DownloadQueue`, `AnimeInfo`, `AnimeCalendar` (+ `AnimeCalendarScreenshot`), `MyAnime`, `LocalLibrary`, `FileExplorer`, `HomeworkLookup` (+ `homework/`), `MiaoyuLibrary`, `Settings`. One per route.
- **Stores** (`stores/`): plain observable stores — internal `Map` + listener set + `localStorage`, no React context. Components subscribe via hooks.
  - `downloadStore.ts` — central download state for all three sources.
  - `animeTrackStore.ts` — "my anime" tracking list, BGM alias index for local search.
  - `recommendationStore.ts`, `updateStore.ts` (auto-update banner), `uiStore.ts`.
  - `siteApi.ts` — abstracts the per-site `window.*Api` surfaces behind a uniform interface for source-agnostic UI.
- `utils/` holds the search cache wrapper (`cache:get` / `cache:set` IPCs), a nav guard that blocks navigation while downloads are active, and `friendlyError()` which classifies main-process errors into actionable UI copy.

**Store persistence rules (don't regress):**
- Each store has a `normalize()` that fills defaults for any missing field — **zero-migration backward compat**, no migration scripts.
- Some fields (e.g. `bgmTags`) **lock on first content**: once populated, later fetches don't overwrite, so the user's snapshot stays stable across devices.
- Track data syncs across devices via WebDAV, so **never persist machine-absolute paths** (e.g. a `archivist:///Users/.../cover.jpg` userData path). Store portable URLs; localize only at display time (`hooks/useCover.ts`).

### Styling

Use **MD3 color tokens only** (`bg-surface-container`, `text-on-surface`, `text-primary`, …) — no raw color values (`#xxx` / `bg-[#...]`), or dark/light theme switching breaks. Tokens are defined in `src/renderer/src/index.css`. Mobile/responsive layouts must mirror `docs/design-mockups/responsive-design.html`, not be improvised.

### Custom protocol

`archivist://` is registered in `app.whenReady()` and serves arbitrary local files (thumbnails, cached covers) to the renderer. Usage from renderer: `archivist:///absolute/path/to/file.jpg`.

### Persistence (Electron `userData`)

- `library_paths.json`, `library_entries.json` — user library config + cached scan results
- `thumbnails/` — extracted video thumbnails (wiped on each full scan)
- `search_cache.json`, `xifan_settings_history.json`
- `bgm_cover_cache/` — locally cached BGM cover images served via `archivist://`
- `anime_tracks.json`, `recommendations.json` and similar per-feature JSONs

### Vite alias

`@renderer` → `src/renderer/src/`. Use it for all renderer imports.

## Adding a new IPC channel

Four steps, none optional. Channel names use `域:动作` form (`bgm:search`, `system:disk-free`, `library:updated`).

1. **Main**: add a `registerXxxIpc()` under `src/main/ipc/`, registering `ipcMain.handle('xxx:action', ...)`.
2. **Wire** it into `registerAllIpc()` in `src/main/ipc/index.ts`.
3. **Preload**: expose via `contextBridge.exposeInMainWorld('xxxApi', { ... })` forwarding `ipcRenderer.invoke`.
4. **Types**: declare the `*Api` in `src/renderer/src/env.d.ts`, then call `window.xxxApi.method(...)`.

Prefer `invoke/handle` (has a return value); use `send` for one-way notifications (`app:renderer-ready`); for progress streams use `ipcRenderer.on` returning an unsubscribe fn (see `downloadApi.onProgress`). New download-progress sources must emit on the unified `download:progress` channel.

## Releasing

Pushing a `v*` tag triggers `.github/workflows/release.yml` (Windows + macOS parallel build → draft release). **Before tagging:** bump `package.json`, then run `npm run sync:manifest` and commit the updated `update-manifest.json` alongside the release commit. That manifest is the *only* way clients on the 国内加速 (China-mirror) updater discover a new version — skip it and every mirror-routed user stops getting updates. Mechanism + how to swap proxies: `docs/release/自动更新-国内加速.md`. Versioning follows SemVer; full flow in the `electron-release` skill and `docs/release/how-to-release.md`.

## Window startup detail (don't regress)

`createWindow()` deliberately does **not** call `mainWindow.show()` on `ready-to-show`. The renderer sends `app:renderer-ready` (via `window.systemApi.signalReady()`) after React mount + `document.fonts.ready`; main shows the window then, with a 4s fallback. This avoids icon-font pop-in flicker. `backgroundColor: '#131313'` matches the dark theme so the pre-render frame isn't white.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MapleTools** is an Electron desktop app for searching, downloading, and managing anime. It integrates with three streaming sites (Xifan, Girigiri, Aowu) and pulls metadata from Bangumi (BGM) and Moegirl. Around that core sit a local library scanner (ffmpeg thumbnails), a seasonal anime calendar, WebDAV sync, mail-report jobs, a Windows recycle-bin helper, an in-app file explorer, and an auto-updater.

Standalone Python scripts under `python/` are prototyping/data tools and are **not** part of the Electron app.

## Commands

All commands run from the project root:

```bash
npm install        # Install deps
npm run dev        # Dev server with hot reload (electron-vite)
npm run build      # Build main + preload + renderer into out/
npm run dist       # Build + electron-builder package into dist/
npm run build:win  # Cross/local Windows packaging (scripts/build-win.mjs)
```

There are no tests and no linter wired into npm scripts.

## Architecture

### Three-process model

- **Main** (`src/main/index.ts`) — Node env. Lifecycle, window creation, tray, custom protocol, updater bootstrap. All IPC handlers are registered via `registerAllIpc()` from `src/main/ipc/`.
- **Preload** (`src/preload/index.ts`) — Bridges main ↔ renderer with `contextBridge.exposeInMainWorld`. Exposes typed APIs as `window.bgmApi`, `window.xifanApi`, `window.girigiriApi`, `window.aowuApi`, `window.downloadApi`, `window.systemApi`, `window.libraryApi`, `window.fileExplorerApi`, `window.webdavApi`, `window.mailApi`, etc.
- **Renderer** (`src/renderer/src/`) — React + Tailwind SPA. Talks to main *only* through preload globals.

### Main process layout (`src/main/`)

| Dir | Purpose |
|-----|---------|
| `ipc/` | One file per surface (`bgm.ts`, `xifan.ts`, `girigiri.ts`, `aowu.ts`, `library.ts`, `system.ts`, `fileExplorer.ts`, `webdav.ts`, `mail.ts`). `index.ts` exports `registerAllIpc()`. |
| `bgm/` | Bangumi metadata: `search.ts`, `detail.ts`, calendar, cover caching. |
| `xifan/` | Xifan site: captcha + search + watch-page scraping, HLS/mp4 downloader with Range resume. |
| `girigiri/` | Girigiri site: api, downloader, `http-session.ts` cookie session. |
| `aowu/` | Aowu site: api, downloader, `secure.ts`, `url-resolver.ts`. |
| `moegirl/` | `synopsis.ts` — fetch synopsis from Moegirl wiki. |
| `library/` | Local library scanner, ffmpeg thumbnail extraction, JSON persistence, file watcher. |
| `mail/` | SMTP transport + scheduled "anime report" and "calendar" mailers. |
| `updater/` | electron-updater wrapper. |
| `recycle/` | Windows-only recycle-bin helper (`runner.ts` shells out to `recycle-helper.ps1`). |
| `tray.ts` | System tray. |
| `shared/` | Shared utilities, including `speed-tracker.ts` broadcaster. |

### Download queue design

Per-source in-memory queues are kept inside each downloader module (xifan, girigiri, aowu). Each queue has `pending[]`, `priorityFront[]` (for resuming a specific episode), a `pausedEps` Set, and an `AbortController` for the currently running episode. Episodes run sequentially, one at a time. **Queue state is lost on restart** — the renderer persists task metadata in `localStorage` and recreates queues via `resume` IPCs.

All three downloaders emit progress on a single channel `download:progress` so the renderer only needs one listener (subscribe via `window.downloadApi.onProgress`).

### Renderer (`src/renderer/src/`)

- **Pages** (`pages/`): `SearchDownload`, `DownloadQueue`, `AnimeInfo`, `AnimeCalendar` (+ `AnimeCalendarScreenshot`), `MyAnime`, `LocalLibrary`, `FileExplorer`, `HomeworkLookup` (+ `homework/`), `Settings`. One per route.
- **Stores** (`stores/`): plain observable stores — no React context, listeners + `localStorage` for persistence.
  - `downloadStore.ts` — central download state for all three sources.
  - `animeTrackStore.ts` — "my anime" tracking list, BGM alias index for local search.
  - `recommendationStore.ts` — recommendations.
  - `siteApi.ts` — abstracts the per-site `window.*Api` surfaces behind a uniform interface used by source-agnostic UI.
  - `updateStore.ts` — auto-update banner state.
- `utils/searchCache.ts` wraps `cache:get` / `cache:set` IPCs; `utils/navGuard.ts` blocks navigation while downloads are active.

### Custom protocol

`archivist://` is registered in `app.whenReady()` and serves arbitrary local files (thumbnails, cached covers) to the renderer. Usage from renderer: `archivist:///absolute/path/to/file.jpg`.

### Persistence (Electron `userData`)

- `library_paths.json`, `library_entries.json` — user library config + cached scan results
- `thumbnails/` — extracted video thumbnails (wiped on each full scan)
- `search_cache.json` — search result cache
- `xifan_settings_history.json` — settings history
- `bgm_cover_cache/` — locally cached BGM cover images served via `archivist://`
- `anime_tracks.json`, `recommendations.json` and similar per-feature JSONs

### Vite alias

`@renderer` → `src/renderer/src/`. Use it for all renderer imports.

## Adding a new IPC channel

1. Add a `registerXxxIpc()` in a new or existing file under `src/main/ipc/`, registering `ipcMain.handle(...)` calls there.
2. Wire it into `registerAllIpc()` in `src/main/ipc/index.ts`.
3. Expose via `contextBridge.exposeInMainWorld('xxxApi', { ... })` in `src/preload/index.ts`.
4. Add the type declaration in `src/renderer/src/env.d.ts`.
5. Call from the renderer via `window.xxxApi.method(...)`.

For new download-progress sources, emit on the unified `download:progress` channel so the existing `downloadApi.onProgress` listener picks it up.

## Window startup detail (don't regress)

`createWindow()` deliberately does **not** call `mainWindow.show()` on `ready-to-show`. The renderer sends `app:renderer-ready` (via `window.systemApi.signalReady()`) after React mount + `document.fonts.ready`; main shows the window then, with a 4s fallback. This avoids the icon-font pop-in flicker. `backgroundColor: '#131313'` matches the dark theme so the pre-render frame isn't white.

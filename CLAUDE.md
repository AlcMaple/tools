# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MapleTools** is an Electron desktop app for searching, downloading, and managing anime. It integrates with two anime streaming sites (Xifan and Girigiri) and Bangumi (BGM) for metadata. The app also has a local library feature that scans folders for video files and extracts embedded thumbnails via ffmpeg.

There are also standalone Python scripts in the root for prototyping crawlers and APIs. These are standalone tools, not part of the Electron app.

## Commands

All commands are run from the project root:

```bash
npm install        # Install dependencies
npm run dev        # Start dev server with hot reload (recommended)
npm run build      # Build all (main + preload + renderer)
npm run dist       # Build + package into installer (output: dist/)
```

There are no tests.

## Architecture

### Electron Process Structure

The app follows the standard Electron three-process model:

- **Main process** (`src/main/index.ts`) — Node.js environment. Handles all IPC, download queues, file I/O, and ffmpeg operations.
- **Preload** (`src/preload/index.ts`) — Bridges main ↔ renderer via `contextBridge.exposeInMainWorld`. Defines the typed API surface exposed as `window.xifanApi`, `window.girigiriApi`, `window.bgmApi`, `window.systemApi`, `window.libraryApi`.
- **Renderer** (`src/renderer/src/`) — React + Tailwind SPA. Communicates with main exclusively through the preloaded window globals.

### Main Process Modules (`src/main/`)

| Directory | Purpose |
|-----------|---------|
| `bgm/` | Bangumi API: `search.ts`, `detail.ts` — fetches anime metadata |
| `xifan/` | Xifan site: `api.ts` (captcha, search, watch page scraping), `download.ts` (HLS/mp4 download with Range resume) |
| `girigiri/` | Girigiri site: `api.ts`, `download.ts`, `http-session.ts` (cookie session management) |
| `library/` | Local library: `api.ts` — scans configured paths, extracts ffmpeg thumbnails, persists entries as JSON |
| `shared/` | Shared utilities |

### Download Queue Design

Two in-memory queues are maintained in `src/main/index.ts`:
- `episodeQueues` (Map) — Xifan tasks
- `giriEpQueues` (Map) — Girigiri tasks

Each queue has `pending[]`, `priorityFront[]` (for resuming individual episodes), `pausedEps` (Set), and an `AbortController` for the currently running episode. Episodes are processed one-at-a-time sequentially. Queue state is lost on app restart; the renderer persists task info in `localStorage` and recreates queues on resume via IPC `resume` handlers.

### Renderer State (`src/renderer/src/`)

- **`stores/downloadStore.ts`** — plain observable store (no React state, uses listeners + `localStorage` for persistence). Handles all `download:progress` IPC events and maps them to task/episode statuses.
- **`stores/bgm.ts`, `girigiri.ts`, `xifan.ts`** — search/session state per source.
- **`stores/navGuard.ts`** — prevents navigation away during active downloads.
- **`pages/`** — one file per route: `SearchDownload`, `DownloadQueue`, `AnimeInfo`, `BiuSync`, `LocalLibrary`, `Settings`.

### Custom Protocol

`archivist://` is a custom Electron protocol registered in `app.whenReady()`. It serves local files (thumbnails) to the renderer. Usage: `archivist:///absolute/path/to/file.jpg`.

### Persistence

App data is stored in Electron's `userData` directory:
- `library_paths.json` — user-configured library roots
- `library_entries.json` — cached scan results
- `thumbnails/` — extracted video thumbnails (wiped on each scan)
- `search_cache.json` — search result cache (via `cache:get`/`cache:set` IPC)
- `xifan_settings_history.json` — settings history

### Vite Alias

`@renderer` resolves to `src/renderer/src/` — use this for all renderer imports.

## Adding New IPC Channels

1. Add handler in `src/main/index.ts` (`ipcMain.handle(...)`)
2. Expose via `contextBridge.exposeInMainWorld` in `src/preload/index.ts`
3. Add type declaration in `src/renderer/src/env.d.ts` (or wherever window globals are typed)
4. Call from renderer via the corresponding `window.*Api` global

## Python Scripts (`python/`)

Standalone scripts used for prototyping/data work. Not integrated with the Electron app. Key ones:
- `xifan_api.py`, `girigiri_api.py` — site API clients
- `bgm_detail.py`, `search_anime.py` — Bangumi helpers
- `girigiri_download.py` — standalone downloader prototype
- `sync_biu.py`, `push_biu.py` — BiuSync related scripts

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MapleTools is an Electron desktop application for searching, downloading, and managing anime. It integrates with multiple sources (Girigiri, Xifan) and the Bangumi metadata database.

## Development Commands

All frontend commands run from the `front-end/` directory:

```bash
cd front-end
npm install       # Install dependencies
npm run dev       # Dev server with hot reload
npm run build     # Compile TypeScript + assets
npm run dist      # Full build + package installer (.exe/.dmg)
```

No test runner is configured. There are no lint scripts defined in `package.json`.

## Architecture

### Electron Three-Process Model

- **Main process** (`src/main/index.ts`): IPC handlers, download queue state machine, Python subprocess spawning, system API (disk, settings, speed tracking)
- **Preload** (`src/preload/index.ts`): Context bridge exposing `window.bgmApi`, `window.girigiriApi`, `window.xifanApi`, `window.systemApi`
- **Renderer** (`src/renderer/src/`): React 18 + React Router (hash-based) + Tailwind CSS

### IPC Convention

Channels use `namespace:action` format (e.g., `girigiri:search`, `download:progress`). Main registers via `ipcMain.handle()`; renderer calls via the preload-bridged window APIs. Download progress is pushed from main to renderer via `ipcRenderer.on('download:progress', ...)`.

### Download Queue (Main Process)

The download system in `src/main/index.ts` is a priority-aware state machine:
- Per-source queues (xifan vs. girigiri) with `priorityFront` and `pending` arrays
- Per-episode pause state tracked in `Set<number>`
- `AbortController` per episode for cancellation
- Byte accumulation for real-time speed tracking
- Next episode auto-starts in `.finally()` after each download completes
- State persists across app restarts via `downloadStore` → localStorage

### Frontend State

`src/renderer/src/stores/downloadStore.ts` is a vanilla TypeScript store (no Redux/Zustand):
- Listener/subscription pattern for React component updates
- Persists to `localStorage` and recovers on restart

### Python Backend

Python scripts in the repo root handle scraping and downloading. Electron main process spawns them via `child_process`. Key scripts:
- `girigiri_api.py` / `girigiri_download.py` — Girigiri source
- `xifan_api.py` / `xifan_crawler.py` — Xifan source
- `bgm_detail.py` — Bangumi metadata API
- Session persistence via pickle files (`.girigiri_session.pkl`, `.xifan_session.pkl`)

Python dependencies: `requests`, `beautifulsoup4`, `aiohttp`, `playwright`, `pycryptodome`

### Design System

Tailwind is configured with Material Design 3 tokens (`tailwind.config.js`):
- CSS custom properties `--color-*` for all semantic colors (primary, secondary, tertiary, error + surface variants)
- Dark mode via `class` strategy
- Typography: Inter for headline/body, Space Grotesk for labels
- Path alias: `@renderer/*` → `src/renderer/src/*`

### Pages

Six pages under `src/renderer/src/pages/`: `LocalLibrary`, `SearchDownload`, `DownloadQueue`, `AnimeInfo`, `BiuSync`, `Settings`. Fixed 256px sidebar (`Sidebar.tsx`) with hash-based navigation and a download-pending navigation guard (`utils/navGuard.ts`).

## GitNexus Integration

This repo is indexed by GitNexus for code intelligence. After significant commits, re-index with:

```bash
npx gitnexus analyze
```

See `AGENTS.md` for full GitNexus tool reference.

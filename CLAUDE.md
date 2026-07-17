# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This file is the architecture reference. Two companion docs at the repo root are maintained alongside it: `AI_GUIDELINES.md` (中文, AI 代码生成护栏 — mistake log, locked tech stack/architecture boundaries, commit convention) and `DEVLOG.md` (中文, per-change dev log written before each commit). The deepest rationale for the network/scraping rules lives in `docs/scraping/bgm-集成参考手册.md`. To find where a feature lives, start at `docs/功能索引.md` (功能 → 文件地图).

## Project Overview

**MapleTools** is an Electron desktop app for searching, downloading, and managing anime. It integrates with three streaming sites (Xifan, Girigiri, Aowu) plus Bilibili, and pulls metadata from Bangumi (BGM) and Moegirl. Around that core sit a local library scanner (ffmpeg thumbnails), a seasonal anime calendar, an in-app online player, WebDAV sync, mail-report jobs, a Windows recycle-bin helper, an in-app file explorer, a 妙语库 (witty-reply) study deck, and a self-rolled auto-updater.

Conventions worth knowing up front: reply in **Chinese**, write **code comments in Chinese** (explain *why*, not *what*), and when editing existing code **touch only what the change needs** — no incidental import reordering / reformatting / renames. No ESLint/Prettier is wired up; match the existing style (2-space indent, **no semicolons**, single quotes, `strict: true`, no `any`).

## Two independent projects in one repo

| Path | What | Deps |
|---|---|---|
| `/` (root) | The Electron desktop app. This is the main project. | root `package.json` |
| `web/` | The **web version** (番剧周历 + accounts). A physically isolated subproject with its own `package.json` / `node_modules` / `tsconfig`. | `web/package.json` |

The root `package.json` stays untouched by web work, and vice versa. `cd web` before running any web command. See the [Web version](#web-version-web) section below.

Legacy prototypes under `archive/` (`python_legacy/`, `js_legacy/`, `image-tools/`) are kept for reference only and are **not** part of any build.

## Commands

Desktop app — from the repo root:

```bash
npm install            # Install deps
npm run dev            # Dev server with hot reload (electron-vite)
npm run build          # Build main + preload + renderer into out/
npm run dist           # Build + electron-builder package into dist/
npm run build:win      # Local/cross Windows packaging (scripts/build-win.mjs)
npm run sync:manifest  # Sync update-manifest.json version ← package.json (run before every release)
```

Web version — from `web/`:

```bash
cd web && npm install
npm run dev            # One command for both ends: Vite serves the page, Hono takes /api/*
npm run build          # Static frontend build
npm start              # Run the Hono server standalone on Node (tsx server/node.ts)
```

**There are no tests and no linter wired into either project** — and per `AI_GUIDELINES.md`, don't add Jest/Vitest on your own initiative.

## Architecture

### Three-process model

- **Main** (`src/main/index.ts`) — Node env. Lifecycle, window creation, tray, custom protocols, updater bootstrap. All IPC handlers are registered via `registerAllIpc()` from `src/main/ipc/`.
- **Preload** (`src/preload/index.ts`) — Bridges main ↔ renderer with `contextBridge.exposeInMainWorld`. Exposes typed APIs as `window.bgmApi`, `window.xifanApi`, `window.girigiriApi`, `window.aowuApi`, `window.biliApi`, `window.downloadApi`, `window.systemApi`, `window.libraryApi`, `window.fileExplorerApi`, `window.webdavApi`, `window.mailApi`, `window.miaoyuApi`, etc.
- **Renderer** (`src/renderer/src/`) — React + Tailwind SPA. Talks to main *only* through preload globals — it never touches network / filesystem / Node APIs directly. This is a security boundary, not a style preference: the renderer can only invoke the capabilities IPC hard-codes (search, download, …), never "read any file" / "run any command".

### Main process layout (`src/main/`)

| Dir | Purpose |
|-----|---------|
| `ipc/` | One file per surface (`bgm.ts`, `xifan.ts`, `girigiri.ts`, `aowu.ts`, `bili.ts`, `library.ts`, `system.ts`, `fileExplorer.ts`, `webdav.ts`, `mail.ts`, `miaoyu.ts`). `index.ts` exports `registerAllIpc()`. |
| `bgm/` | Bangumi metadata: search, detail, calendar, cover caching. |
| `xifan/` | Xifan site: captcha + search + watch-page scraping, HLS/mp4 downloader with Range resume. |
| `girigiri/` | Girigiri site: api, downloader, cookie session. |
| `aowu/` | Aowu site: api, downloader, `secure.ts`, `url-resolver.ts`. See `docs/scraping/aowu-FantasyKon-逆向与反爬手册.md`. |
| `bili/` | Bilibili: TV-appkey QR login (`persist:bili` partition), 分 P list, DASH playurl. In-app player only, no downloader. |
| `moegirl/` | `synopsis.ts` — fetch synopsis from Moegirl wiki. |
| `library/` | Local library scanner, ffmpeg thumbnail extraction, JSON persistence, file watcher. `scan-worker.ts` runs a full scan on its own thread and is a **separate rollup entry** (see `electron.vite.config.ts`), packaged unpacked from asar. |
| `mail/` | SMTP transport + scheduled "anime report" and "calendar" mailers. |
| `updater/` | electron-updater wrapper. |
| `recycle/` | Windows-only recycle-bin helper (shells out to `recycle-helper.ps1`). |
| `shared/` | Cross-cutting utilities — see below. |

Notable `shared/` modules (read the header comment before touching any of them; each encodes a hard-won incident):

- `net-request.ts` — **the** HTTP entry point for scraping (Electron `net`). See red lines below.
- `http-client.ts` — transport primitives on top: abortable `sleep`, `decodeBody`, `parseRetryAfter`, `withTransientRetry`.
- `http-session.ts` — cookie-jar session over `netRequest`, with **manual hop-by-hop redirects** (auto-follow drops intermediate `Set-Cookie`, which the captcha gate depends on).
- `media-proxy.ts` — `mtmedia://` streaming proxy for the in-app player. Uses `net.fetch` (not `netRequest`) because buffering a whole video would blow up memory.
- `site-download-queue.ts` / `download-scheduler.ts` / `download-types.ts` — queue plumbing; the scheduler enforces **one running download per source** (cross-source parallel is fine).
- `maccms-search-paginator.ts` — shared MacCMS dsn2 pagination walker (xifan / girigiri / aowu).
- `rate-limit.ts`, `browser-session.ts`, `scrape-guard.ts`, `mp4-range-downloader.ts`, `json-store.ts`, `speed-tracker.ts`, `logger.ts`.
- `uv-bootstrap.ts` — must stay the **first import** in `index.ts`; it raises `UV_THREADPOOL_SIZE` before any fs side effect, since libuv freezes the pool size at first use.

### Networking & scraping — the red lines (most important, non-obvious)

These are project red lines; violating them actively harms users. Full rationale in `docs/scraping/bgm-集成参考手册.md` and the mistake log in `AI_GUIDELINES.md`.

- **All main-process HTTP goes through `src/main/shared/net-request.ts` (`netRequest()`), which uses Electron `net`** — never Node `https`/`axios`/`node-fetch`/`undici`. Node `https` ignores the system proxy; with a Clash fake-ip proxy this resolves to unroutable `198.18.x` addresses and black-holes. Electron `net` follows the system proxy/PAC like the browser does. (`media-proxy.ts` uses `net.fetch` — same Chromium stack, streaming instead of buffering. That's the one sanctioned variant.)
- **No application-layer retry or probing after a failure.** A rate-limit / 5xx must `throw` up to the UI; the user decides when to retry via a countdown button. Do **not** auto-retry, do **not** periodically probe "is it back yet", do **not** silently `catch → return null`. The *only* allowed code-level retry is transport-layer transient blips (`withTransientRetry`: a single ECONNRESET-class socket jitter retry). No IP pools / proxy rotation / Playwright to "bypass" limits — all previously rejected.
- **User-Agent is deliberately opposite by target:** API endpoints (`api.bgm.tv`) use an honest `MapleTools/<ver>` UA; HTML scraping (`bgm.tv` etc.) uses a randomized browser-spoof UA via `BrowserSession`. Don't mix them. **One exception:** BGM binds a web login session to the UA it was minted under, so the login window partition, `verifyBgmLogin`, and any request carrying the login cookie must all use the same fixed `DESKTOP_USER_AGENT` (see DEVLOG 2026-07-04) — the randomized spoof UA is for anonymous scraping only. `DESKTOP_SEC_CH_UA` is *derived* from `DESKTOP_USER_AGENT` so the version can't drift between them; keep it that way.
- **Don't classify Cloudflare blocks by the bare `cloudflare` keyword** — BGM responses always carry `server=cloudflare`, so that flags healthy traffic. Only trust strong signals: `cf-mitigated=challenge/block/managed`, `Just a moment`, `cf-chl`.
- Static HTML parses with **cheerio**; no resident Playwright/puppeteer (BGM/Moegirl are server-rendered with no JS challenge — a real browser is just slower and fatter).
- External API calls share `shared/rate-limit.ts` `RateLimiter` (interval + jitter) for serial throttling.

### Download queue design

Per-source in-memory queues live inside each downloader module (xifan, girigiri, aowu), built on `shared/site-download-queue.ts`. Each queue has `pending[]`, `priorityFront[]` (for resuming a specific episode), a `pausedEps` Set, and an `AbortController` for the currently running episode. Episodes run sequentially, one at a time; `shared/download-scheduler.ts` additionally holds a single slot per source so two tasks of the same site can't download concurrently (that's a fast route to an IP ban). **Queue state is lost on restart** — the renderer persists task metadata in `localStorage` and recreates queues via `resume` IPCs.

All downloaders emit progress on a single channel `download:progress` so the renderer only needs one listener (subscribe via `window.downloadApi.onProgress`).

### Renderer (`src/renderer/src/`)

- **Pages** (`pages/`): `SearchDownload`, `DownloadQueue`, `AnimeInfo`, `AnimeCalendar` (+ `AnimeCalendarScreenshot`), `MyAnime`, `LocalLibrary`, `FileExplorer`, `OnlinePlayer` (route `/play?bgm=<bgmId>`), `HomeworkLookup` (+ `homework/`), `MiaoyuLibrary`, `Settings`. One per route.
- **Stores** (`stores/`): plain observable stores — internal `Map` + listener set + `localStorage`, no React context, no Redux/Zustand/MobX. Components subscribe via hooks.
  - `downloadStore.ts` — central download state for all sources.
  - `animeTrackStore.ts` — "my anime" tracking list, BGM alias index for local search.
  - `recommendationStore.ts`, `updateStore.ts` (auto-update banner), `uiStore.ts`.
  - `siteApi.ts` — abstracts the per-site `window.*Api` surfaces behind a uniform interface for source-agnostic UI.
- `utils/` holds the search cache wrapper (`cache:get` / `cache:set` IPCs), `navGuard.ts` (blocks navigation while downloads are active), and `errorMessage.ts`'s `friendlyError()`, which classifies main-process errors into actionable UI copy — **never collapse failures into one generic "网络请求失败"**; a rate-limited user who thinks their network is down will retry harder and deepen the limit.

**Store persistence rules (don't regress):**
- Each store has a `normalize()` that fills defaults for any missing field — **zero-migration backward compat**, no migration scripts.
- Some fields (e.g. `bgmTags`) **lock on first content**: once populated, later fetches don't overwrite, so the user's snapshot stays stable across devices.
- Track data syncs across devices via WebDAV, so **never persist machine-absolute paths** (e.g. a `archivist:///Users/.../cover.jpg` userData path). Store portable URLs; localize only at display time (`hooks/useCover.ts`).

### Styling

Use **MD3 color tokens only** (`bg-surface-container`, `text-on-surface`, `text-primary`, …) — no raw color values (`#xxx` / `bg-[#...]`), or dark/light theme switching breaks. Tokens are defined in `src/renderer/src/index.css`. Mobile/responsive layouts must mirror `docs/design-mockups/responsive-design.html`, not be improvised.

Three style traps with real incidents behind them (details in `AI_GUIDELINES.md`):
- **Tailwind opacity modifiers only accept multiples of 5** (`bg-primary/12` silently generates *nothing* and falls back to a default). Use `/10`, `/15`, … or an arbitrary value `bg-primary/[0.12]`, then grep the built CSS to confirm.
- **Hover/selected states must not change box metrics** (border width, font weight, padding, size) — only color/shadow. Otherwise neighbours jitter.
- **No native `<select>` or native scrollbars.** Native controls that pop a system layer will never match MD3. Scrollbar styling has a single source in `index.css` (`.custom-scrollbar`); dropdowns are hand-rolled (`button` trigger + own overlay, overlay `width: 100%` of a `relative` wrapper).

### Custom protocols

- `archivist://` — serves arbitrary local files (thumbnails, cached covers) to the renderer. Registered in `app.whenReady()`. Usage: `archivist:///absolute/path/to/file.jpg`.
- `mtmedia://` — same-origin media streaming for the in-app player (`shared/media-proxy.ts`). Exists because Chromium blocks cross-origin media with `content-disposition: attachment`, and hls.js can't fetch CORS-less CDN segments from the renderer. Playlists get their inner URLs rewritten to `mtmedia://` too; the Referer for anti-hotlinking is pinned into the URL's `r` param by main, so the renderer never sees a raw signed link.

### Persistence (Electron `userData`)

- `library_paths.json`, `library_entries.json` — user library config + cached scan results
- `thumbnails/` — extracted video thumbnails (wiped on each full scan)
- `search_cache.json`, `xifan_settings_history.json`
- `bgm_cover_cache/` — locally cached BGM cover images served via `archivist://`
- `anime_tracks.json`, `recommendations.json` and similar per-feature JSONs

All of it goes through `shared/json-store.ts` — plain JSON files, no SQLite/ORM in the desktop app.

### Vite alias

`@renderer` → `src/renderer/src/`. Use it for all renderer imports.

## Adding a new IPC channel

Four steps, none optional. Channel names use `域:动作` form (`bgm:search`, `system:disk-free`, `library:updated`).

1. **Main**: add a `registerXxxIpc()` under `src/main/ipc/`, registering `ipcMain.handle('xxx:action', ...)`.
2. **Wire** it into `registerAllIpc()` in `src/main/ipc/index.ts`.
3. **Preload**: expose via `contextBridge.exposeInMainWorld('xxxApi', { ... })` forwarding `ipcRenderer.invoke`.
4. **Types**: declare the `*Api` in `src/renderer/src/env.d.ts`, then call `window.xxxApi.method(...)`.

Prefer `invoke/handle` (has a return value); use `send` for one-way notifications (`app:renderer-ready`); for progress streams use `ipcRenderer.on` returning an unsubscribe fn (see `downloadApi.onProgress`). New download-progress sources must emit on the unified `download:progress` channel.

## Web version (`web/`)

A separate React + Vite frontend with a **Hono** backend. Design doc: `docs/ideas/012-网页版.md`. Live at `https://anime.alcmaple.cn` on a 唐人云 VPS (git pull + pm2 + nginx + certbot) — runbook: `docs/web/唐人云部署保姆教程.md`. `docs/web/Vercel部署保姆教程.md` and `Oracle开机保姆教程.md` are alternatives that aren't in use.

- **`server/index.ts` is the single source of truth for the API.** One Hono app, three hosts: local dev mounts it into Vite via `@hono/vite-dev-server` (only `/api/*`), Vercel wraps it in `api/[[...route]].ts` (the *only* platform glue), a future VPS runs it via `@hono/node-server` (`server/node.ts`). Routes are written once.
- **Scraping is copied from the app, not shared.** `server/bgm/calendar.ts` is a copy of `src/main/bgm` with Electron `net` swapped for `fetch` (`server/http.ts` — proxy-aware fetch + single transient retry). Node's `fetch` ignores the system proxy, so local dev behind non-TUN Clash needs `HTTPS_PROXY=http://127.0.0.1:7890 npm run dev`.
- **Data is SQLite** (`better-sqlite3`, `server/db.ts`) — the one place SQLite is allowed. The DB file **must live outside the deploy dir** (`DATA_DIR=/opt/mapletools-data` in prod; redeploy does `rm -rf /opt/web` and would wipe every user). `better-sqlite3` is a native module and is marked `ssr.external` in `web/vite.config.ts` — without that, `/api/auth` crashes on first hit.
- **Auth**: scrypt password hashes, httpOnly signed-cookie JWT sessions. The `token_version` column is load-bearing — it's what makes a password change actually revoke existing sessions (stateless JWTs can't be revoked otherwise), so bump it on password/security-question change and re-issue for the current device.
- **Cover proxy** is path-style (`/api/cover/pic/...`, host hard-coded to `lain.bgm.tv`, `/pic/` prefix only). Never put `bgm.tv` in the URL — the GFW RSTs those requests and got the origin's port 80 temporarily blocked in testing. The path form also blocks SSRF.
- The web UI does **not** copy the app's UI wholesale: it uses a top nav (web convention) where the app uses a sidebar, and a hash router (`src/router.ts`) instead of react-router.

## Releasing

Pushing a `v*` tag triggers `.github/workflows/release.yml` (Windows + macOS parallel build → draft release). **Before tagging:** bump `package.json`, then run `npm run sync:manifest` and commit the updated `update-manifest.json` alongside the release commit. That manifest is the *only* way clients on the 国内加速 (China-mirror) updater discover a new version — skip it and every mirror-routed user stops getting updates. Mechanism + how to swap proxies: `docs/release/自动更新-国内加速.md`. Versioning follows SemVer; full flow in the `electron-release` skill and `docs/release/how-to-release.md`.

## Window startup detail (don't regress)

`createWindow()` deliberately does **not** call `mainWindow.show()` on `ready-to-show`. The renderer sends `app:renderer-ready` (via `window.systemApi.signalReady()`) after React mount + `document.fonts.ready`; main shows the window then, with a 4s fallback. This avoids icon-font pop-in flicker. `backgroundColor: '#131313'` matches the dark theme so the pre-render frame isn't white.

## Committing

Conventional Commits with Chinese descriptions (`<type>(<scope>): <描述>`); title states the user-visible symptom or result, not the low-level term. **No AI signature trailers.** Commit/push only when explicitly asked, and **add a `DEVLOG.md` entry first — that's a required step, not an optional one.** Full rules: `AI_GUIDELINES.md`「提交规范」.

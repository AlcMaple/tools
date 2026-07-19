# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Companion docs at the repo root, maintained alongside this one: `AI_GUIDELINES.md` (中文, AI 代码生成护栏 — 错误日志、锁定的技术栈/架构边界、提交规范) and `DEVLOG.md` (中文, 每次提交前先补一条的开发日志). To find *where a feature lives*, use `docs/功能索引.md` (功能 → 文件地图). The deepest rationale for the scraping rules is in `docs/scraping/`.
>
> Conventions to internalize before writing code: reply in **中文**, write **code comments in 中文** (explain *why*, not *what*), and when editing existing code **touch only what the change needs** — no incidental import reordering / reformatting / renames. No ESLint/Prettier is wired up; match the surrounding style (2-space indent, **no semicolons**, single quotes, `strict: true`, avoid `any`).

## Two independent projects in one repo

| Path | What | Deps / config |
|---|---|---|
| `/` (root) | **MapleTools** — the Electron desktop app. The main project. | root `package.json`, `electron.vite.config.ts` |
| `web/` | The **web version** (番剧周历 + 账号 + 追番). A physically isolated subproject: own `package.json` / `node_modules` / `tsconfig` / `vite.config.ts`. | `web/package.json` |

The two never share `node_modules`. `cd web` before running any web command. Legacy prototypes under `archive/` (`python_legacy/`, `js_legacy/`, `image-tools/`) are reference only and **not** part of any build.

## Commands

**Desktop app** (repo root) — there is **no test runner and no linter** (don't add Jest/Vitest on your own initiative — see `AI_GUIDELINES.md`):

```bash
npm install
npm run dev            # electron-vite dev, hot reload (main + preload + renderer)
npm run build          # electron-vite build → out/
npm run dist           # build + electron-builder → dist/  (installer for current OS)
npm run build:win      # scripts/build-win.mjs — Windows packaging
npm run sync:manifest  # scripts/sync-manifest.mjs — update-manifest.json version ← package.json (before every release)
```

**Web version** (`web/`):

```bash
cd web && npm install
npm run dev            # vite: serves the SPA + mounts Hono at /api/* in one process
npm run build          # vite build → web/dist/
npm start              # tsx server/node.ts — standalone Hono on Node (VPS), serves dist/ + /api/*
```

Local web dev behind a non-TUN Clash proxy needs `HTTPS_PROXY=http://127.0.0.1:7890 npm run dev` (Node's undici `fetch` doesn't auto-read the system proxy; `server/http.ts` installs an `EnvHttpProxyAgent` that honors `HTTP(S)_PROXY`).

## Desktop architecture

### Three-process model

- **Main** — `src/main/index.ts`. Node env. First line is `import './shared/uv-bootstrap'` (raises `UV_THREADPOOL_SIZE` before any fs side effect — libuv freezes the pool size at first use). Registers privileged schemes *before* `app.ready`, calls `registerAllIpc()` (`src/main/ipc/index.ts`), boots the tray/updater/media-proxy, and creates the window. Library scan + directory watch are deliberately deferred until ~1.2s after `app:renderer-ready` so they don't starve the fs threadpool while first-screen covers localize.
- **Preload** — `src/preload/index.ts`. The security boundary. `contextBridge.exposeInMainWorld` publishes one typed object per surface: `window.bgmApi`, `xifanApi`, `girigiriApi`, `aowuApi`, `biliApi`, `downloadApi`, `systemApi`, `libraryApi`, `fileExplorerApi`, `webdavApi`, `mailApi`, `miaoyuApi`, `updaterApi`, `screenshotApi`, `versions`. The renderer can only invoke the exact capabilities listed here — it never touches network/fs/Node directly. Tokens/cookies/authCodes never cross this bridge in plaintext (auth surfaces return booleans only).
- **Renderer** — `src/renderer/src/`. React 18 + Tailwind SPA, `HashRouter`. Entry `main.tsx` self-hosts fonts (no CDN), forwards `window.error`/`unhandledrejection` to main's log, and fires `systemApi.signalReady()` after first paint + `document.fonts.ready`. Vite alias `@renderer` → `src/renderer/src/`.

### Window reveal (don't regress — `src/main/index.ts:120-151`)

`createWindow()` shows the window only when **both** `ready-to-show` (painted — Windows white-flashes without it) **and** `app:renderer-ready` (React mounted + fonts ready — avoids icon-font pop-in) have fired. `graceTimer` 6s and `hardTimer` 9s are the fallbacks. `backgroundColor: '#131313'` matches the dark theme so the pre-render frame isn't white. Closing to tray uses `getMinimizeOnClose()` + `event.preventDefault()` + `hide()`; on macOS it also hides the Dock icon.

### Main process layout (`src/main/`)

| Dir | Purpose |
|-----|---------|
| `ipc/` | One file per surface (`bgm.ts` `xifan.ts` `girigiri.ts` `aowu.ts` `bili.ts` `library.ts` `system.ts` `fileExplorer.ts` `webdav.ts` `mail.ts` `miaoyu.ts`). `index.ts` = `registerAllIpc()`. |
| `bgm/` | Bangumi: search, detail, calendar, `cover-cache.ts` (`toArchivistUrl`), web-login window. |
| `xifan/` `girigiri/` `aowu/` | Per-site `api.ts` (captcha + search + watch-page scrape) + `download.ts`. Aowu also has `secure.ts` / `url-resolver.ts`. |
| `moegirl/` | `synopsis.ts` — Moegirl fallback synopsis when BGM is 日文原文. |
| `library/` | Scanner + ffmpeg thumbnails + JSON persistence + native fs watcher. `scan-worker.ts` is a **separate rollup entry** (`electron.vite.config.ts`), runs full scans on its own thread, packaged asar-unpacked. |
| `mail/` | SMTP transport + scheduled 番剧报告 / 周历 mailers. |
| `updater/` | electron-updater wrapper (自建国内加速). |
| `recycle/` | Windows-only recycle-bin helper (shells `recycle-helper.ps1`). |
| `tray.ts` | Tray icon + menu. |
| `shared/` | Cross-cutting utilities — see below. |

### Networking & scraping — the red lines (most important, non-obvious)

Rationale in `docs/scraping/` and the mistake log in `AI_GUIDELINES.md`. Violating these actively harms users.

- **All main-process HTTP goes through `src/main/shared/net-request.ts` (`netRequest()`), which uses Electron `net`** — never Node `https`/`axios`/`node-fetch`/`undici`. Node `https` ignores the system proxy; with a Clash fake-ip proxy `bgm.tv` resolves to unroutable `198.18.x` and black-holes. Electron `net` follows the system proxy/PAC like the browser. `netRequest` strips Chromium-managed headers (`host`/`connection`/`content-length`/`accept-encoding` — `NET_MANAGED_HEADERS`, net-request.ts:33) and lets `net` auto-decompress. `redirect: 'manual'` resolves the 3xx headers itself (net-request.ts:94-103) so callers can read `Location` and ingest per-hop `Set-Cookie`. The **one** sanctioned variant is `shared/media-proxy.ts`, which uses `net.fetch` (same Chromium stack, streaming instead of buffering — a whole video would blow up memory).
- **No application-layer retry or probing after a failure.** A rate-limit / 5xx must `throw` up to the UI; the user retries via a countdown button. The *only* allowed code-level retry is transport-layer transient blips — `withTransientRetry()` in `shared/http-client.ts` retries **exactly once** on an ECONNRESET-class errno (`TRANSIENT_ERRNOS`), never on `aborted` or an HTTP status. No IP pools / proxy rotation / Playwright — all previously rejected.
- **User-Agent is deliberately opposite by target.** API endpoints (`api.bgm.tv`) use an honest `MapleTools/<ver>` UA; HTML scraping uses a randomized browser-spoof UA (`BrowserSession`). **Exception:** BGM binds a web-login session to the UA it was minted under, so the login window, `verifyBgmLogin`, and any request carrying the login cookie must all use one fixed `DESKTOP_USER_AGENT`; `DESKTOP_SEC_CH_UA` is *derived* from it so the two can't drift.
- **Cookie-gated sites go through `shared/http-session.ts` (`HttpSession`).** It keeps a `Map` cookie jar persisted to `.<name>_cookies.json` under `userData`, and does **manual** redirect following (up to 5 hops, http-session.ts:78) ingesting `Set-Cookie` every hop — Electron `net`'s auto-follow drops intermediate cookies, which the captcha gate depends on.
- **Don't classify Cloudflare blocks by the bare `cloudflare` keyword** — BGM always sends `server=cloudflare`, so that flags healthy traffic. Trust only strong signals (`cf-mitigated`, `Just a moment`, `cf-chl`). This lives in `friendlyError()` (renderer) and the scrapers.
- Static HTML parses with **cheerio**; no resident Playwright/puppeteer. External API calls share `shared/rate-limit.ts` `RateLimiter` (interval + jitter).

Notable `shared/` modules (read the header comment before touching — each encodes an incident): `net-request.ts`, `http-client.ts` (`sleep`/`decodeBody`/`parseRetryAfter`/`withTransientRetry`), `http-session.ts`, `media-proxy.ts` (`mtmedia://`), `site-download-queue.ts` / `download-scheduler.ts` / `download-types.ts`, `maccms-search-paginator.ts` (shared dsn2 pagination for xifan/girigiri/aowu), `rate-limit.ts`, `browser-session.ts`, `scrape-guard.ts`, `mp4-range-downloader.ts`, `json-store.ts`, `speed-tracker.ts`, `logger.ts`, `uv-bootstrap.ts`.

### Download pipeline (end-to-end)

Each site's IPC module (`ipc/xifan.ts` etc.) owns a per-source `SiteDownloadQueue` (`shared/site-download-queue.ts`) whose `runEpisode` hook is wired to that site's `downloadSingleEp` (`<site>/download.ts`). Chain for one download:

1. `search()` → `HttpSession.get()` scrape → paginate via `maccms-search-paginator`.
2. `watch(url)` → parse player data → `WatchInfo.sources[]` (each with a URL `template` + `epPage`).
3. `<site>:download` IPC mints a `taskId`, builds `pending: number[]` from `startEp..endEp` minus `excludeEps`, calls `queue.create(taskId, payload)`.
4. `startNext()` pops `priorityFront.shift() ?? pending.shift()`, then `scheduler.tryAcquire(taskId)` — **one running download per source** (`girigiriScheduler`/`xifanScheduler`/`aowuScheduler`, each a single-slot `EventEmitter`; cross-source parallel is fine, same-source is not — a fast route to an IP ban). If the slot is taken, the ep is pushed back onto `priorityFront` and waits for the `'available'` event.
5. The ep downloads via `mp4-range-downloader` (per-part **Range resume**), emitting on the unified `download:progress` channel: `ep_start` / `ep_progress {ep,pct,bytes}` / `ep_url` / `ep_done` / `ep_error` / `ep_paused` / `all_done`.

`QueueState` fields (site-download-queue.ts:24-36): `pending[]`, `priorityFront[]` (resume/retry/switch-source jump the line), `current`, `currentAbort: AbortController`, `taskPaused`, `cancelled`. **There is no `pausedEps` set** — pause pushes the `current` ep back onto `priorityFront` and aborts; byte-level resume lives in `mp4-range-downloader`, not the queue. **Queue state is lost on restart** — the renderer persists task metadata (via `download:save-state` IPC) and recreates queues through the `resume` IPCs. All progress flows through **one** channel so the renderer needs a single listener (`downloadApi.onProgress`).

### Custom protocols (`src/main/index.ts`, registered privileged pre-ready)

- `archivist://` — serves local files (thumbnails, cached covers). Registered **standard + secure** so Chromium caches responses (`Cache-Control: immutable`) — otherwise covers re-read+decode on every remount and flash. URLs use a placeholder host: `archivist://local/C:/Users/.../123.jpg` (empty host breaks path parsing —踩过坑). Content-Length **must** be set or large images get truncated.
- `mtmedia://` — same-origin media streaming for the in-app player (`shared/media-proxy.ts`), so `<video>`/hls.js can play cross-origin CDN media that Chromium would otherwise block. Registered with `bypassCSP: true` but **not** `corsEnabled` (opting into CORS would force ACAO headers). The anti-hotlink Referer is pinned into the URL's `r` param by main, never exposed to the renderer.

### Persistence (Electron `userData`, all via `shared/json-store.ts` — no SQLite/ORM in the desktop app)

`library_paths.json`, `library_entries.json`, `thumbnails/` (wiped each full scan), `search_cache.json`, `xifan_settings_history.json`, `bgm_cover_cache/` (served via `archivist://`), `anime_tracks.json`-style per-feature JSONs, `.<session>_cookies.json`.

## Renderer (`src/renderer/src/`)

- **Pages** (`pages/`, one per route in `App.tsx`): `/` `LocalLibrary`, `/search` `SearchDownload`, `/queue` `DownloadQueue`, `/anime-info` `AnimeInfo`, `/my-anime` `MyAnime`, `/calendar` `AnimeCalendar` (+ headless `AnimeCalendarScreenshot`), `/file-explorer` `FileExplorer`, `/settings` `Settings`, `/homework` `HomeworkLookup`, `/miaoyu` `MiaoyuLibrary`, `/play` `OnlinePlayer`. `/settings` and `/play` are fullscreen (no global `Sidebar`). A `?screenshot=calendar` query bypasses the router entirely for the headless screenshot render.

- **Stores** (`stores/`) — three flavors, no Redux/Zustand/MobX/context:
  - **Module-singleton + IPC persistence:** `downloadStore.ts`. Module-scoped `Map<id, DownloadTask>` + `Set<Listener>`; `persist()` → `systemApi.saveDownloadState()`. State transitions call `notify()` (flush + persist); high-frequency `ep_progress` uses `notifyProgressThrottled()` (coalesce to one flush per rAF, **skip persist** — progress is ephemeral). `DownloadTask` is a discriminated union over `source` (`xifan` templates+sourceIdx / `girigiri` HLS eps / `aowu` opaque `source_id`).
  - **Class + localStorage (deferred write):** `animeTrackStore.ts`, `recommendationStore.ts`. Private `cache` + `Set` listeners + `STORAGE_KEY`; writes deferred via `deferredStorage.ts` (`requestIdleCallback` batch, forced `flushAll()` on `pagehide`/`beforeunload`). Export their own hooks (`useAnimeTrackList`, `useAnimeTrack`, …).
  - **Plain object, no persistence:** `uiStore.ts` (mobile drawer, via `useSyncExternalStore`), `updateStore.ts`.
  - `siteApi.ts` — dispatch table `siteApi(task)` returning a uniform `{ pause, cancel, resume, retry, requeue, switchSource, resolveEpUrl, resolveIsAsync }` over the per-site `window.*Api`, branching on `task.source`. Adding a 4th source = one new branch, not edits everywhere.

- **Subscription:** mostly manual `useEffect(() => store.subscribe(() => setX(store.get())), [])`; `useSyncExternalStore` only in `uiStore` and `useMediaQuery`.

- **`utils/`:** `errorMessage.ts` `friendlyError()` — an **ordered** classifier returning `{title, hint, raw, retryAfterSec?}`; specific causes win (site markers → BGM rate-limit with parsed 秒/分钟 countdown → Windows file-ops *before* network, since PowerShell stderr contains "network" → net/TLS → strict Cloudflare → HTTP status). **Never collapse failures into one generic 「网络请求失败」** — a rate-limited user who thinks their network is down retries harder and deepens the limit. Also `navGuard.ts` (blocks nav while downloads run) and the `cache:get`/`cache:set` search-cache wrapper.

### Store persistence rules (don't regress)

- Each persisted store has a `normalize()` that fills defaults for every missing field — **zero-migration backward compat**, idempotent, reused for both localStorage read and WebDAV pull. Corrupt JSON is backed up + reported, not silently cleared.
- Some fields **lock on first content**: `bgmTags` locks once non-empty (`upsert()` keeps `prev.bgmTags` if populated), so the user's community-tag snapshot stays stable across devices; `ensureBgmTagsFilled()` backfills async for entry points that lacked BGM detail at add time.
- `aliases` (from the BGM 别名 infobox field) exists **only for local search matching** — sources join to a track solely via explicit `bindings[]`, never fuzzy title match.
- **Never persist machine-absolute paths.** Tracks sync cross-device via WebDAV, and an `archivist://` path embeds this machine's `userData` absolute path — dead on another device. Store portable URLs (`track.cover`); localize to `archivist://` only at display time via `hooks/useCover.ts` (memoized per `key@maxWidth` so 480/600 variants stay distinct, no retry on failure).

### Styling

- **MD3 color tokens only** (`bg-surface-container`, `text-on-surface`, `text-primary`, …) — no raw hex / `bg-[#...]`, or theme switching breaks. Tokens are CSS vars (RGB triples) in `src/renderer/src/index.css` under `:root` and `.dark`; Tailwind maps them as `rgb(var(--color-*) / <alpha-value>)` in `tailwind.config.js` (`darkMode: 'class'`). Dark mode = a `dark` class on the root (toggled in `TopBar.tsx` / `Settings.tsx`). Fonts: `Inter` (headline/body), `Space Grotesk` (label).
- Mobile/responsive layouts mirror `docs/design-mockups/responsive-design.html`; breakpoints/`useIsCompact` conventions are in the design mockup.
- Three style traps with real incidents (details in `AI_GUIDELINES.md`):
  - **Tailwind opacity modifiers only accept multiples of 5** — `bg-primary/12` silently generates nothing. Use `/10`, `/15`, or arbitrary `bg-primary/[0.12]`.
  - **Hover/selected states must not change box metrics** (border width, font weight, padding, size) — only color/shadow, else neighbors jitter.
  - **No native `<select>` or native scrollbars.** Scrollbars have one source (`.custom-scrollbar` + `textarea` in `index.css`, 4px); dropdowns are hand-rolled.

## Adding a new IPC channel

Channel names use `域:动作` (`bgm:search`, `system:disk-free`, `library:updated`). Four steps, none optional:

1. **Main:** add `registerXxxIpc()` under `src/main/ipc/`, registering `ipcMain.handle('xxx:action', …)`.
2. **Wire** it into `registerAllIpc()` in `src/main/ipc/index.ts`.
3. **Preload:** expose via `contextBridge.exposeInMainWorld('xxxApi', { … })` forwarding `ipcRenderer.invoke`.
4. **Types:** declare `*Api` in `src/renderer/src/env.d.ts`, then call `window.xxxApi.method(...)`.

Prefer `invoke/handle` (has a return value); use `send` for one-way notifications (`app:renderer-ready`); for progress streams use `ipcRenderer.on` returning an unsubscribe fn (see `downloadApi.onProgress`). New download-progress sources **must** emit on the unified `download:progress` channel.

## Web version (`web/`)

React 18 + Vite + Tailwind frontend, **Hono** backend. Design doc `docs/ideas/012-网页版.md`; live at `https://anime.alcmaple.cn` on a 唐人云 VPS (runbook `docs/web/唐人云部署保姆教程.md`).

- **`server/index.ts` is the single API source of truth** — one Hono `app`, mounted three ways: local dev via `@hono/vite-dev-server` (only `/api/*`, `vite.config.ts`), Vercel via `api/[[...route]].ts` (`handle(app)` — the only platform glue), VPS via `server/node.ts` (`@hono/node-server`, also `serveStatic` for `dist/` + SPA fallback, binds `127.0.0.1` behind nginx).
- **Routes:** `GET /api/health`, `GET /api/calendar?force=1` (s-maxage cache), `GET /api/cover/*`; `/api/auth/*` (`questions` `register` `login` `logout` `me` `settings` `forgot`, `server/auth.ts`); `/api/tracks/*` (`GET /`, `PUT/DELETE /:bgmId`, login-gated, `server/tracks.ts`).
- **Auth:** scrypt hashes (`salt:hash`, `timingSafeEqual`), httpOnly signed-JWT cookie `mt_session` (HS256, `AUTH_SECRET`). The `token_version` column is load-bearing — the JWT carries `tv`, `getSession` rejects on mismatch, and password/security-question changes bump it (revoking all old sessions, since stateless JWTs can't otherwise be revoked) and re-issue for the current device. In-memory per-user/per-IP rate limiting on login/register/forgot.
- **Data is SQLite** (`better-sqlite3`, `server/db.ts`, WAL) — the one place SQLite is allowed. The DB file **must live outside the deploy dir** (`DATA_DIR=/opt/mapletools-data` in prod; redeploy `rm -rf`'s `/opt/web`). `better-sqlite3` is native → marked `ssr.external` in `web/vite.config.ts` (without it `/api/auth` crashes on first hit). `db.ts` uses the same zero-migration `ensureColumn` pattern.
- **Scraping is copied from the app, not shared** — `server/bgm/*` mirrors `src/main/bgm` with Electron `net` swapped for undici `fetch` (`server/http.ts`, proxy-aware + single transient retry). Honest `MapleTools-Web/<ver>` UA.
- **Cover proxy** is path-style (`/api/cover/*` → whitelist `/^\/(r\/\d{2,4}\/)?pic\//` → hardcoded `https://lain.bgm.tv${path}`). **Never** put `bgm.tv` in the URL — the GFW RSTs plaintext HTTP to it and got the origin's port 80 temporarily blocked in testing; the path form also blocks SSRF.
- **Frontend** uses a hand-rolled **hash router** (`src/router.ts`, routes `calendar`/`settings`/`tracks`) and a top nav (web convention) — it does **not** copy the app's sidebar/react-router wholesale.

## Releasing

Pushing a `v*` tag triggers `.github/workflows/release.yml` (Windows + macOS parallel build → draft release). **Before tagging:** bump `package.json`, run `npm run sync:manifest`, and commit the updated `update-manifest.json` in the release commit — that manifest is the **only** way clients on the 国内加速 (China-mirror) updater discover a new version. Full flow: the `electron-release` skill, `docs/release/`. Versioning follows SemVer.

## Committing (`AI_GUIDELINES.md`「提交规范」)

Conventional Commits with 中文 descriptions: `<type>(<scope>): <描述>`. Allowed types `feat fix docs refactor chore style perf test build ci`; scope = module name. Title states the user-visible symptom/result, not the low-level term. **No AI signature trailers.** **Only commit/push when explicitly asked** — approval of a fix is *not* approval to push (2026-07-17 incident). Run `git status`/`git diff --stat` before `git add -A` (the user may have unrelated changes in the tree). **Add a `DEVLOG.md` entry first — a required step, not optional.**

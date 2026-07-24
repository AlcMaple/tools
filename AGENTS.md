# Repository Guidelines

## Project Structure & Module Organization

This repository contains two independent TypeScript projects:

- The root is the MapleTools Electron app. Main-process code lives in `src/main/`, the security bridge in `src/preload/`, and the React UI in `src/renderer/src/`.
- `web/` is a separate Vite/Hono application with its own `package.json`, dependencies, frontend in `web/src/`, and API/server code in `web/server/`.

Shared documentation is under `docs/`; static desktop assets are in `assets/` and `src/renderer/src/assets/`. Treat `archive/` as reference-only legacy code. Use `docs/功能索引.md` to locate features before editing.

## Build, Test, and Development Commands

Run desktop commands from the repository root:

- `npm run dev` — start Electron with hot reload.
- `npm run build` — compile main, preload, and renderer bundles.
- `npm run dist` — build and package the current platform.
- `npm run build:win` — run the Windows packaging script.
- `npm run sync:manifest` — align the updater manifest before a release.

Run web commands inside `web/`:

- `npm run dev` — start Vite and mount `/api/*`.
- `npm run build` — produce `web/dist/`.
- `npm start` — run the standalone Node/Hono server.

There is no automated test runner or linter. Do not introduce Jest, Vitest, ESLint, or Prettier without agreement. Validate changes with the relevant build and focused manual checks.

## Coding Style & Architecture

Use 2-space indentation, single quotes, no semicolons, and strict TypeScript; avoid `any`. Match nearby code and avoid unrelated formatting or renames. React code uses function components, hooks, Tailwind, and existing MD3 color tokens. Write code comments in Chinese and explain why, not what.

Renderer code must not access Node, files, or networks directly; add capabilities through main IPC, preload exposure, and renderer typings. Desktop HTTP must use `src/main/shared/net-request.ts` (or the approved streaming proxy), never Axios, Node `https`, or Undici. Preserve errors and rate limits instead of adding application-level retries.

## Commits & Pull Requests

Use Conventional Commits with Chinese descriptions, for example `fix(bgm): 修复搜索超时提示`. Allowed types include `feat`, `fix`, `docs`, `refactor`, `chore`, `style`, `perf`, `test`, `build`, and `ci`. Before committing, update `DEVLOG.md` and inspect `git status` plus `git diff --stat`. Commit or push only when explicitly requested.

Pull requests should summarize user-visible behavior, identify affected desktop/web surfaces, list validation performed, link relevant issues, and include screenshots for UI changes.

---
name: Windows NPM Build Automation
description: Package / build an npm (Electron) project on Windows reliably. Use when writing or debugging build / dist / package automation that runs on Windows.
---

# Windows NPM Build Automation

Blueprint for writing a one-click "clean → install → package" pipeline for an npm project (typically Electron + electron-builder) that runs on **Chinese Windows 10/11**. Covers the traps that cause silent failures and the reliable shape of the solution.

## 1. Don't Use .bat for Orchestration

`.bat` files work for tiny ASCII-only commands, but any non-trivial pipeline on Chinese Windows hits one or more of these:

| Trap | Symptom |
|------|---------|
| LF line endings (from macOS/Linux author) | Script runs 0 lines then closes — double-click flashes a window |
| UTF-8 without BOM + OEM code page = GBK | `'xxx' is not recognized` on Chinese text, parser de-syncs into mid-line fragments |
| UTF-8 **with** BOM on some cmd builds | Same de-sync as above (BOM is not a guaranteed fix) |
| `chcp 65001` takes effect *after* the file is parsed | Chinese in `echo` / `if ( ... )` blocks still breaks |
| `setlocal EnableDelayedExpansion` + `goto` + LF endings | Silent failure inside loops |

**Rule**: if the project already has Node, write the orchestrator in **Node.js**. Keep `.bat` at most as a one-line wrapper that calls `node script.mjs`, and even that only when the user insists on double-clicking.

## 2. Skeleton: Node.js Build Orchestrator

Place at `scripts/build-win.mjs` and wire via `"build:win": "node scripts/build-win.mjs"` in `package.json`. Invocation from Windows: `node scripts/build-win.mjs` or `npm run build:win`.

```js
#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(projectRoot)

const isWin = process.platform === 'win32'
const npmCmd = isWin ? 'npm.cmd' : 'npm'

function run(cmd, args) {
  return new Promise((r) => {
    // shell: true on Windows is MANDATORY when spawning .cmd/.bat (see §3)
    const child = spawn(cmd, args, { stdio: 'inherit', shell: isWin })
    child.on('exit', (code) => r(code ?? 1))
    child.on('error', () => r(1))
  })
}
```

## 3. Node 20+ Spawn Security — `shell: true` Is Mandatory

Since Node 18.20 / 20.12 (CVE-2024-27980 fix), `spawn('npm.cmd', ...)` **without** `shell: true` throws:

```
Error: spawn EINVAL
  errno: -4071, code: 'EINVAL', syscall: 'spawn'
```

Fix: `spawn(npmCmd, args, { stdio: 'inherit', shell: isWin })`. Same applies to any `.cmd` / `.bat`: `electron-builder.cmd`, `tsc.cmd`, etc. Only set `shell: true` on Windows — keep it `false` on macOS/Linux where `.cmd` doesn't exist and `shell: true` would change argument quoting semantics.

Alternative that avoids `shell`: `spawn('node', [require.resolve('npm/bin/npm-cli.js'), ...args])`. More robust but more work; `shell: isWin` is the pragmatic default.

## 4. dist Directory Often Locked — Kill + Retry

After a previous run, the `dist/` folder is frequently locked by: a leftover `MapleTools.exe` / `electron.exe` process, an Explorer window showing the folder, or real-time antivirus scanning the new .exe. Raw `rmSync` throws `EBUSY` / `EPERM`.

Mandatory prologue:

```js
if (isWin) {
  spawnSync('taskkill', ['/F', '/IM', 'MyApp.exe'], { stdio: 'ignore' })
  spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' })
}
```

Mandatory retry loop for deletion:

```js
for (let i = 1; i <= 5; i++) {
  try {
    rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
    if (!existsSync(full)) break
  } catch {}
  // sleep 2s, retry
}
```

If it's still locked after 5 tries, exit with a message pointing at: open Explorer windows, running app instances, antivirus. Do **not** `--force` past a lock — the next `electron-builder` step will fail anyway.

## 5. Standard Pipeline Order

1. Kill residual app + electron processes
2. `rm -rf dist/` with retry, `rm -rf out/` (best-effort)
3. `node_modules` exists? → skip; missing → `npm install`
4. `npm run dist` (or `npm run build && electron-builder`)

Stream child stdio with `stdio: 'inherit'` so electron-builder's progress is visible. Do not buffer or pipe — large output + buffered pipes cause mysterious hangs.

## 6. package.json — Keep Layers Separate

```json
{
  "scripts": {
    "build": "electron-vite build",
    "dist": "npm run build && electron-builder",
    "build:win": "node scripts/build-win.mjs"
  }
}
```

- `dist` = pure packaging, called on any platform (CI etc.)
- `build:win` = Windows-specific clean + validate + dist
- `build:win` internally calls `npm run dist` — **do not** make `dist` point at `build-win.mjs` (circular, and loads Windows-only logic on macOS).

## 7. Encoding Checklist (if .bat is unavoidable)

Only relevant if a `.bat` wrapper is required. Pick ONE of:

- **ASCII-only messages** (simplest, most reliable). No Chinese in `echo`.
- **UTF-8 + BOM + `chcp 65001 >nul 2>&1` on first executable line**. Works on most Win10 1903+ but not guaranteed — tolerate this only for trivial wrappers.
- **Save as GBK (code page 936)** on Chinese Windows. Matches OEM code page so cmd parses correctly without `chcp`. Fragile if file ever gets re-saved in UTF-8 by an editor.

Line endings MUST be CRLF regardless. LF-only `.bat` = silent failure.

## 8. Diagnosing a Broken Windows Build Script

- Double-click flashes and closes → LF line endings, or `setlocal` / `exit /b` on line 1.
- `'xxx' is not recognized` on Chinese text → encoding / code page mismatch.
- `spawn EINVAL` from Node → missing `shell: true` when running `.cmd`.
- `EBUSY` / `EPERM` on `dist/` → app still running, or Explorer window open, or AV scanning.
- electron-builder hangs forever → stdio is piped/buffered; use `stdio: 'inherit'`.
- `chcp 65001` output appears but Chinese still garbled → cmd already parsed the file using OEM code page before `chcp` ran. Move messages out of that file or use Node.

## 9. When Rewriting an Existing .bat

Preserve behavior, don't over-engineer:
1. Translate each step literally into Node, no added abstractions.
2. Use `process.platform === 'win32'` guards for Windows-only steps (`taskkill`) so the script still runs on macOS/Linux for testing.
3. Keep human-readable step markers (`[1/4] …`) — they're what the user actually reads during a 5-minute build.
4. Exit non-zero on any failed step; let the caller see the real error.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A collection of Python scripts for anime search, download, and personal data sync. The primary entry point on Windows is `tools.bat`, which provides a menu-driven interface. There are two independent download pipelines targeting different source sites.

## Setup

```bash
pip install -r requirements.txt
playwright install chromium   # required by girigiri_download.py
```

> `pycryptodome` provides `Crypto.Cipher.AES`. Do not install `pycrypto` alongside it (conflicts).

## Running Scripts

All scripts are standalone and run directly with Python 3.9+:

```bash
# Xifan pipeline (xifanacg.com, MP4 direct download)
python fetch_page.py          # Search, saves HTML to html_cache/<keyword>.html
python parse_anime_list.py    # Pick from results, saves html_cache/<title>_watch.html
python parse_watch_page.py    # Extract MP4 URLs, trigger download via xifan_crawler

# Girigiri pipeline (girigirilove.com, HLS/m3u8 download)
python girigiri_search.py     # Search, CAPTCHA handling, saves html_cache/<keyword>_girigiri.html
python girigiri_download.py   # Read watch HTML, use Playwright to capture m3u8, download

# Independent tools
python search_anime.py        # Query bgm.tv for anime metadata (ratings, air dates)
python xifan_crawler.py       # Standalone multi-threaded MP4 downloader (used by parse_watch_page)
python sync_biu.py            # Sync Biu project from E: drive to ~/Documents/Biu (Windows)
python push_biu.py            # Push ~/Documents/Biu back to E: drive (Windows)
```

On Windows, `tools.bat` wraps these into a menu (uses Conda env `py39` at `C:\Users\Alc29\anaconda3`).

## Architecture

### Pipeline 1: Xifan (MP4 direct)

1. **`fetch_page.py`** — Searches `dm.xifanacg.com` with CAPTCHA handling. Saves raw search result HTML to `html_cache/<keyword>.html`.

2. **`parse_anime_list.py`** — Reads cached search HTML, lists results, lets user pick one, then fetches and saves the watch page to `html_cache/<title>_watch.html`. Writes chosen path to `.last_watch`.

3. **`parse_watch_page.py`** — Parses `_watch.html` to extract `player_aaaa` JS variable (contains MP4 URLs). Probes multiple video sources, builds URL templates with `{:02d}` episode placeholders, then calls `xifan_crawler.download_mp4_series()`.

4. **`xifan_crawler.py`** — `MultiThreadDownloader` does async chunked downloads (16 threads, 1MB chunks) using `aiohttp`. Validates file size via HEAD request (< 10MB = anti-hotlinking, skip). `download_mp4_series()` iterates episodes, tries sources in order, saves to `./<anime_title>/<title> - <ep>.mp4`.

### Pipeline 2: Girigiri (HLS/m3u8)

1. **`girigiri_search.py`** — Searches `bgm.girigirilove.com`. Always requires CAPTCHA verification. Saves `html_cache/<keyword>_girigiri.html` and `html_cache/<keyword>_girigiri_watch.html`. Writes selected play URL to `.last_watch`.

2. **`girigiri_download.py`** — Reads the local watch HTML to get episode list. Uses **Playwright** (headless Chromium) to intercept the actual m3u8 URL from network requests. Downloads TS segments via `aiohttp` (10 concurrent), decrypts with AES-CBC if `#EXT-X-KEY` present, merges with `ffmpeg`. Falls back to direct `ffmpeg` download if async fails. Saves to `downloads/<anime_title>/`.

### Shared state

- `.last_watch` — written by search scripts, read by download scripts to auto-select the previously chosen title
- `html_cache/` — search results and watch pages from both sites
- `bgm_cache/` — bgm.tv search result pages (keyed as `<keyword>_<page>.html`)
- `temp_ts/` — temporary TS segment storage during girigiri downloads (auto-cleaned on completion)

## Debugging HTML Selector Breakage

When a site updates its HTML structure and parsing returns empty results, use this pattern (see `XIFAN_TEST.md` for full details):

```python
from bs4 import BeautifulSoup
with open("html_cache/<keyword>.html", "r", encoding="utf-8") as f:
    soup = BeautifulSoup(f, "html.parser")
# Print first 20 div classes to find the real container
for div in soup.find_all("div", class_=True)[:20]:
    print(div.get("class"))
```

Then update the CSS selectors in the relevant `parse_*` script.

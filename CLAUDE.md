# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A collection of Python scripts for anime search, download, and personal data sync. The primary entry point on Windows is `tools.bat`, which provides a menu-driven interface.

## Running Scripts

All scripts are standalone and run directly with Python 3.9+:

```bash
python fetch_page.py          # Search xifanacg.com, saves HTML to html_cache/
python parse_anime_list.py    # Parse cached search HTML, fetch watch page
python parse_watch_page.py    # Parse watch page, extract download URLs, trigger download
python search_anime.py        # Search bgm.tv for anime info by keyword
python xifan_crawler.py       # Standalone multi-threaded MP4 downloader
python sync_biu.py            # Sync Biu project from E: drive to ~/Documents/Biu (Windows)
python push_biu.py            # Push ~/Documents/Biu back to E: drive (Windows)
```

On Windows, `tools.bat` wraps these into a menu (uses Conda env `py39` at `C:\Users\Alc29\anaconda3`).

## Architecture

The anime download workflow is a 3-step pipeline:

1. **`fetch_page.py`** — Searches `dm.xifanacg.com` with CAPTCHA handling. Saves raw search result HTML to `html_cache/<keyword>.html`.

2. **`parse_anime_list.py`** — Reads cached search HTML, lists results, lets user pick one, then fetches and saves the watch page to `html_cache/<title>_watch.html`.

3. **`parse_watch_page.py`** — Parses `_watch.html` to extract `player_aaaa` JS variable (contains MP4 URLs). Probes multiple video sources, builds URL templates with `{:02d}` episode placeholders, then calls `xifan_crawler.download_mp4_series()`.

4. **`xifan_crawler.py`** — `MultiThreadDownloader` does async chunked downloads (16 threads, 1MB chunks) using `aiohttp`. `download_mp4_series()` iterates episodes, tries sources in order, saves to `./<anime_title>/<title> - <ep>.mp4`.

**`search_anime.py`** is independent — it queries `bgm.tv` for anime metadata (ratings, air dates) and is not part of the download pipeline.

## Caches

- `html_cache/` — Search result and watch page HTML from xifanacg.com
- `bgm_cache/` — Search result HTML pages from bgm.tv (keyed as `<keyword>_<page>.html`)

Both are used to avoid redundant requests; scripts check for cached files before fetching.

## Dependencies

```
requests, beautifulsoup4, aiohttp, tqdm
```

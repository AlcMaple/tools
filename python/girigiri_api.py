#!/usr/bin/env python3
"""
girigiri_api.py  — Girigiri 搜索/下载 API（供 Electron IPC 调用）

用法:
  captcha                                             获取验证码 → {"image_b64": "..."}
  verify   <code>                                     提交验证码 → {"success": bool}
  search   <keyword>                                  搜索列表   → [...] | {"needs_captcha": true}
  watch    <play_url>                                 集数列表   → {"title": ..., "episodes": [...]}
  download-single <title> <ep_idx> <ep_name> <ep_url> [--save-dir <path>]
                                                      下载单集（流式 JSON 进度）
"""
import sys
import os
import json
import base64
import pickle
import re
import asyncio
import shutil
import time
import subprocess

import requests
import urllib3
from urllib.parse import urljoin, urlencode

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ── Site config ────────────────────────────────────────────────────────────────
BASE_DOMAIN = "https://bgm.girigirilove.com"
BASE_SEARCH_URL = "https://bgm.girigirilove.com/search/-------------"
VERIFY_IMG_URL = "https://bgm.girigirilove.com/verify/index.html"
VERIFY_CHECK_URL = "https://bgm.girigirilove.com/index.php/ajax/verify_check"
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".girigiri_session.pkl")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://bgm.girigirilove.com/",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _load_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    if os.path.exists(SESSION_FILE):
        with open(SESSION_FILE, "rb") as f:
            try:
                s.cookies.update(pickle.load(f))
            except Exception:
                pass
    return s


def _save_session(s: requests.Session) -> None:
    with open(SESSION_FILE, "wb") as f:
        pickle.dump(dict(s.cookies), f)


def _needs_captcha(html: str) -> bool:
    indicators = [
        'name="verify"', "ds-verify-img", "verify/index.html",
        'class="verify-', "滑动验证", "请完成验证",
    ]
    return any(ind in html for ind in indicators)


def _clean(name: str) -> str:
    return re.sub(r'[\/:*?"<>|]', "_", name)


def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


# ── captcha ────────────────────────────────────────────────────────────────────

def cmd_captcha() -> None:
    s = _load_session()
    try:
        resp = s.get(
            f"{VERIFY_IMG_URL}?t={int(time.time() * 1000)}",
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return
    _save_session(s)
    print(json.dumps({"image_b64": base64.b64encode(resp.content).decode()}))


# ── verify ─────────────────────────────────────────────────────────────────────

def cmd_verify(code: str) -> None:
    s = _load_session()
    try:
        resp = s.get(
            VERIFY_CHECK_URL,
            params={"type": "search", "verify": code},
            headers={
                **HEADERS,
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
            timeout=15,
        )
        resp.raise_for_status()
        result = resp.text
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        return
    success = any(f in result for f in ['"code":1', "成功", '"msg":"ok"', "验证通过", "验证成功"])
    _save_session(s)
    print(json.dumps({"success": success}))


# ── search ─────────────────────────────────────────────────────────────────────

def _parse_results(html: str) -> list:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    out, seen = [], set()

    items = soup.select(
        "div[class*='vod-item'][class*='col'], "
        "div[class^='g-movie-item'], "
        "li[class*='vod-list-item']"
    )
    if not items:
        items = soup.select("div[class*='mask2'] > div[class*='vod-detail']:first-child")

    for item in items:
        link = item.find("a", href=True, recursive=False) or item.find("a", href=True)
        if not link or not link["href"]:
            continue
        play_url = urljoin(BASE_DOMAIN, link["href"])
        if play_url in seen:
            continue
        seen.add(play_url)

        title_tag = (
            link.find("h3")
            or link.find("span", class_=lambda c: c and "name" in c)
            or link
        )
        title = title_tag.get_text(strip=True) if title_tag else ""
        if not title:
            continue

        img = item.find("img")
        cover = (img.get("data-src") or img.get("src") or "") if img else ""

        info = " ".join(t.get_text(strip=True) for t in item.select(
            "div[class*='info'], span[class*='desc'], div[class*='meta'], p[class*='detail']"
        ))
        year = (re.search(r"(\d{4})", info) or type("", (), {"group": lambda *_: ""})()).group(1) if re.search(r"(\d{4})", info) else ""
        region_m = re.search(r"(日本|中国|美国|韩国|国产|日漫|大陆)", info)
        region = region_m.group(1) if region_m else ""

        out.append({"title": title, "cover": cover, "year": year, "region": region, "play_url": play_url})

    # Fallback: grab any /watch/ or /GV links
    if not out:
        for link in soup.find_all("a", href=True):
            href = link["href"]
            if "/watch/" in href or "/GV" in href:
                url = urljoin(BASE_DOMAIN, href)
                t = link.get_text(strip=True)
                if url not in seen and t:
                    seen.add(url)
                    out.append({"title": t, "cover": "", "year": "", "region": "", "play_url": url})

    return out


def cmd_search(keyword: str) -> None:
    s = _load_session()
    try:
        resp = s.get(f"{BASE_SEARCH_URL}/?{urlencode({'wd': keyword})}", headers=HEADERS, timeout=15)
        resp.encoding = "utf-8"
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return
    _save_session(s)
    if _needs_captcha(resp.text):
        print(json.dumps({"needs_captcha": True}))
        return
    print(json.dumps(_parse_results(resp.text), ensure_ascii=False))


# ── watch ──────────────────────────────────────────────────────────────────────

def cmd_watch(play_url: str) -> None:
    from bs4 import BeautifulSoup
    s = _load_session()
    try:
        resp = s.get(play_url, headers=HEADERS, timeout=15)
        resp.encoding = "utf-8"
        html = resp.text
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return

    soup = BeautifulSoup(html, "html.parser")

    title = ""
    h3 = soup.find("h3", class_="slide-info-title")
    if h3:
        title = h3.get_text(strip=True)
    else:
        t = soup.find("title")
        if t:
            title = t.get_text(strip=True).split("_")[0].strip()

    episodes = []
    for idx, link in enumerate(soup.select(".anthology-list-play li a"), 1):
        name = link.get_text(strip=True) or f"第{idx}集"
        href = link.get("href", "")
        if href:
            episodes.append({"idx": idx, "name": name, "url": urljoin(BASE_DOMAIN, href)})

    if not episodes:
        for idx, path in enumerate(re.findall(r'href=["\'](/playGV\d+-\d+-\d+/?)["\']', html), 1):
            episodes.append({"idx": idx, "name": f"第{idx}集", "url": urljoin(BASE_DOMAIN, path)})

    print(json.dumps({"title": title, "episodes": episodes}, ensure_ascii=False))


# ── download-single ────────────────────────────────────────────────────────────

def cmd_download_single(
    title: str,
    ep_idx: int,
    ep_name: str,
    ep_url: str,
    save_dir: str | None = None,
) -> None:
    import aiohttp as _aiohttp
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

    _emit({"type": "ep_start", "ep": ep_idx})
    _emit({"type": "ep_progress", "ep": ep_idx, "pct": 2, "bytes": 0})

    # ── 1. Capture m3u8 via Playwright ─────────────────────────────────────────
    m3u8_url = None
    m3u8_keywords = ["ai.girigirilove.net/zijian", "playlist.m3u8", ".m3u8", "atom.php?key="]

    def _resolve_redirect(url: str) -> str:
        if "url=" in url:
            m = re.search(r"url=(.+?)(&|$)", url)
            if m:
                from urllib.parse import unquote
                return unquote(m.group(1))
        return url

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-web-security",
                "--no-proxy-server",
                f"--user-agent={HEADERS['User-Agent']}",
            ],
            timeout=60000,
        )
        ctx = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            extra_http_headers=HEADERS,
            ignore_https_errors=True,
        )
        page = ctx.new_page()
        page.route(
            "**/*",
            lambda route, req: route.abort()
            if req.resource_type in ["image", "stylesheet", "font", "media"]
            else route.continue_(),
        )

        def _on_request(request):
            nonlocal m3u8_url
            if m3u8_url and "ai.girigirilove.net" in m3u8_url:
                return
            url = request.url
            if any(kw in url for kw in m3u8_keywords) and ".m3u8" in url.lower():
                candidate = _resolve_redirect(url) if "atom.php" in url else url
                m3u8_url = candidate

        page.on("request", _on_request)

        for attempt in range(3):
            try:
                page.goto(ep_url, wait_until="domcontentloaded", timeout=60000)
                for _ in range(15):
                    if m3u8_url:
                        break
                    page.wait_for_timeout(1000)
                page.wait_for_timeout(2000)
                break
            except PlaywrightTimeoutError:
                page.wait_for_timeout(2000)
            except Exception:
                page.wait_for_timeout(2000)

        browser.close()

    if not m3u8_url:
        _emit({"type": "ep_error", "ep": ep_idx, "msg": "Failed to capture m3u8 URL"})
        _emit({"type": "all_done"})
        return

    _emit({"type": "ep_progress", "ep": ep_idx, "pct": 8, "bytes": 0})

    # ── 2. Parse m3u8 ──────────────────────────────────────────────────────────
    def _parse_m3u8(url: str):
        try:
            r = requests.get(url, headers=HEADERS, timeout=30, verify=False)
            r.raise_for_status()
            r.encoding = "utf-8"
            ts_urls, key_info = [], None
            for line in r.text.strip().split("\n"):
                line = line.strip()
                if not line:
                    continue
                if line.startswith("#EXT-X-KEY:"):
                    uri_m = re.search(r'URI="([^"]+)"', line)
                    iv_m = re.search(r"IV=0x([0-9a-fA-F]+)", line)
                    key_info = {}
                    if uri_m:
                        key_info["uri"] = urljoin(url, uri_m.group(1))
                    if iv_m:
                        key_info["iv"] = iv_m.group(1)
                    continue
                if line.startswith("#"):
                    continue
                if ".m3u8" in line:
                    return _parse_m3u8(urljoin(url, line))
                ts_urls.append(urljoin(url, line))
            return ts_urls, key_info
        except Exception:
            return [], None

    ts_urls, key_info = _parse_m3u8(m3u8_url)
    if not ts_urls:
        _emit({"type": "ep_error", "ep": ep_idx, "msg": "No TS segments found in m3u8"})
        _emit({"type": "all_done"})
        return

    total_segs = len(ts_urls)
    segs_done = [0]
    bytes_done = [0]

    # ── 3. Download TS segments (async) ────────────────────────────────────────
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
    temp_ep_dir = os.path.join(SCRIPT_DIR, "temp_ts", f"{_clean(title)}_{ep_idx:04d}")
    shutil.rmtree(temp_ep_dir, ignore_errors=True)
    os.makedirs(temp_ep_dir, exist_ok=True)

    async def _download_seg(session, ts_url, save_path, semaphore):
        async with semaphore:
            for attempt in range(8):
                try:
                    timeout = _aiohttp.ClientTimeout(total=20 + attempt * 5)
                    async with session.get(ts_url, timeout=timeout, ssl=False) as resp:
                        if resp.status == 404:
                            await asyncio.sleep(3)
                            continue
                        resp.raise_for_status()
                        content = await resp.read()
                        with open(save_path, "wb") as f:
                            f.write(content)
                        segs_done[0] += 1
                        bytes_done[0] += len(content)
                        pct = min(95, 10 + int(segs_done[0] / total_segs * 85))
                        _emit({"type": "ep_progress", "ep": ep_idx, "pct": pct, "bytes": bytes_done[0]})
                    return True
                except Exception:
                    await asyncio.sleep(min(2 + attempt * 1.5, 8))
        return False

    async def _run_all():
        sem = asyncio.Semaphore(10)
        connector = _aiohttp.TCPConnector(limit=10, ssl=False)
        async with _aiohttp.ClientSession(connector=connector, headers=HEADERS) as session:
            tasks = [
                asyncio.create_task(
                    _download_seg(session, url, os.path.join(temp_ep_dir, f"segment_{i:05d}.ts"), sem)
                )
                for i, url in enumerate(ts_urls)
            ]
            results = await asyncio.gather(*tasks)
        return sum(1 for r in results if not r)

    failed = asyncio.run(_run_all())

    if failed > 0:
        shutil.rmtree(temp_ep_dir, ignore_errors=True)
        _emit({"type": "ep_error", "ep": ep_idx, "msg": f"{failed} segments failed to download"})
        _emit({"type": "all_done"})
        return

    _emit({"type": "ep_progress", "ep": ep_idx, "pct": 96, "bytes": bytes_done[0]})

    # ── 4. Decrypt (if encrypted) ──────────────────────────────────────────────
    if key_info and "uri" in key_info:
        try:
            key_bytes = requests.get(key_info["uri"], headers=HEADERS, timeout=15, verify=False).content
            from Crypto.Cipher import AES
            iv = bytes.fromhex(key_info.get("iv", "00000000000000000000000000000000"))
            for fname in sorted(f for f in os.listdir(temp_ep_dir) if f.endswith(".ts")):
                fpath = os.path.join(temp_ep_dir, fname)
                with open(fpath, "rb") as f:
                    data = f.read()
                cipher = AES.new(key_bytes, AES.MODE_CBC, iv)
                padded = data + b"\0" * (16 - len(data) % 16)
                with open(fpath, "wb") as f:
                    f.write(cipher.decrypt(padded))
        except Exception as e:
            shutil.rmtree(temp_ep_dir, ignore_errors=True)
            _emit({"type": "ep_error", "ep": ep_idx, "msg": f"Decryption failed: {e}"})
            _emit({"type": "all_done"})
            return

    _emit({"type": "ep_progress", "ep": ep_idx, "pct": 97, "bytes": bytes_done[0]})

    # ── 5. Merge with ffmpeg ───────────────────────────────────────────────────
    base_dir = save_dir if save_dir else SCRIPT_DIR
    anime_dir = os.path.join(base_dir, _clean(title))
    os.makedirs(anime_dir, exist_ok=True)
    output_path = os.path.abspath(os.path.join(anime_dir, f"{_clean(ep_name)}.mp4"))

    ts_files = sorted(f for f in os.listdir(temp_ep_dir) if f.startswith("segment_") and f.endswith(".ts"))
    with open(os.path.join(temp_ep_dir, "segments.txt"), "w", encoding="utf-8") as f:
        for ts_file in ts_files:
            f.write(f"file '{ts_file}'\n")

    result = subprocess.run(
        ["ffmpeg", "-f", "concat", "-safe", "0", "-i", "segments.txt",
         "-c:v", "copy", "-c:a", "copy", "-bsf:a", "aac_adtstoasc",
         "-movflags", "+faststart", "-y", "-loglevel", "warning", output_path],
        capture_output=True, text=True, cwd=temp_ep_dir,
    )
    shutil.rmtree(temp_ep_dir, ignore_errors=True)

    if result.returncode == 0:
        _emit({"type": "ep_done", "ep": ep_idx})
    else:
        _emit({"type": "ep_error", "ep": ep_idx, "msg": f"FFmpeg failed: {result.stderr[:300]}"})
    _emit({"type": "all_done"})


# ── entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: girigiri_api.py <captcha|verify|search|watch|download-single> [args...]",
              file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    try:
        if cmd == "captcha":
            cmd_captcha()
        elif cmd == "verify":
            cmd_verify(sys.argv[2])
        elif cmd == "search":
            cmd_search(sys.argv[2])
        elif cmd == "watch":
            cmd_watch(sys.argv[2])
        elif cmd == "download-single":
            title   = sys.argv[2]
            ep_idx  = int(sys.argv[3])
            ep_name = sys.argv[4]
            rest    = sys.argv[5:]
            save_dir = None
            if "--save-dir" in rest:
                i = rest.index("--save-dir")
                save_dir = rest[i + 1]
                rest = rest[:i] + rest[i + 2:]
            ep_url = rest[0] if rest else ""
            if not ep_url:
                print(json.dumps({"error": "Missing ep_url"}))
                sys.exit(1)
            cmd_download_single(title, ep_idx, ep_name, ep_url, save_dir=save_dir)
        else:
            print(f"Unknown command: {cmd}", file=sys.stderr)
            sys.exit(1)
    except IndexError:
        print(json.dumps({"error": f"Missing argument for '{cmd}'"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()

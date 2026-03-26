#!/usr/bin/env python3
"""
xifan_api.py  — Xifan 搜索/下载 API（供 Electron IPC 调用）

用法:
  captcha                            获取验证码图片 → {"image_b64": "..."}
  verify   <code>                    提交验证码     → {"success": bool}
  search   <keyword>                 搜索动漫列表   → [...] | {"needs_captcha": true}
  watch    <watch_url>               获取播放源信息 → {title, id, total, sources}
  download <title> <start> <end> <tpl1> [<tpl2> ...]   后台阻塞下载（由 Electron spawn 调用）
"""
import sys
import os
import json
import base64
import pickle
import re
import requests
from urllib.parse import quote, unquote
from bs4 import BeautifulSoup

BASE_URL = "https://dm.xifanacg.com"
BASE_SEARCH_URL = f"{BASE_URL}/search.html"
VERIFY_IMG_URL = f"{BASE_URL}/verify/index.html"
VERIFY_CHECK_URL = f"{BASE_URL}/index.php/ajax/verify_check"
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".xifan_session.pkl")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": f"{BASE_URL}/",
}


# ── Session helpers ────────────────────────────────────────────────────────────

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
    return 'name="verify"' in html or "ds-verify-img" in html


# ── captcha ────────────────────────────────────────────────────────────────────

def cmd_captcha() -> None:
    s = _load_session()
    img_resp = s.get(VERIFY_IMG_URL, timeout=15)
    _save_session(s)
    img_b64 = base64.b64encode(img_resp.content).decode()
    print(json.dumps({"image_b64": img_b64}))


# ── verify ─────────────────────────────────────────────────────────────────────

def cmd_verify(code: str) -> None:
    s = _load_session()
    ajax_headers = {
        **HEADERS,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
    }
    resp = s.get(
        VERIFY_CHECK_URL,
        params={"type": "search", "verify": code},
        headers=ajax_headers,
        timeout=15,
    )
    _save_session(s)
    result = resp.text
    success = (
        '"code":1' in result
        or "成功" in result
        or '"msg":"ok"' in result.lower()
    )
    print(json.dumps({"success": success}))


# ── search ─────────────────────────────────────────────────────────────────────

def _parse_results(html: str) -> list:
    soup = BeautifulSoup(html, "html.parser")
    container = soup.find("div", class_="row mask2")
    if not container:
        return []
    out = []
    for item in container.select("div.vod-detail.search-list"):
        title_tag = item.select_one("h3.slide-info-title")
        link_tag = title_tag.find_parent("a") if title_tag else None
        title = title_tag.get_text(strip=True) if title_tag else ""
        detail_url = BASE_URL + link_tag["href"] if link_tag else ""

        play_tag = item.select_one("div.vod-detail-bnt a.button")
        watch_url = BASE_URL + play_tag["href"] if play_tag else ""

        img_tag = item.select_one("div.detail-pic img")
        cover = img_tag.get("data-src", "") if img_tag else ""

        remarks = [s.get_text(strip=True) for s in item.select("span.slide-info-remarks")]
        out.append({
            "title": title,
            "cover": cover,
            "episode": remarks[0] if len(remarks) > 0 else "",
            "year": remarks[1] if len(remarks) > 1 else "",
            "area": remarks[2] if len(remarks) > 2 else "",
            "watch_url": watch_url,
            "detail_url": detail_url,
        })
    return out


def cmd_search(keyword: str) -> None:
    s = _load_session()
    url = f"{BASE_SEARCH_URL}?wd={quote(keyword)}"
    resp = s.get(url, timeout=15)
    resp.encoding = "utf-8"
    _save_session(s)
    if _needs_captcha(resp.text):
        print(json.dumps({"needs_captcha": True}))
        return
    results = _parse_results(resp.text)
    print(json.dumps(results, ensure_ascii=False))


# ── watch ──────────────────────────────────────────────────────────────────────

def _parse_player_data(html: str):
    m = re.search(r"var player_aaaa\s*=\s*(\{.*?\})</script>", html)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    block_m = re.search(r"var player_aaaa\s*=\s*\{(.*?)\};", html, re.DOTALL)
    if not block_m:
        return None
    block = block_m.group(1)

    def get_str(key):
        pat = r"\b" + re.escape(key) + r'\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"'
        m2 = re.search(pat, block, re.DOTALL)
        if not m2:
            return ""
        try:
            return json.loads('"' + m2.group(1) + '"')
        except Exception:
            return m2.group(1).replace("\\/", "/")

    vod_m = re.search(r"vod_data\s*:\s*\{(.*?)\}", block, re.DOTALL)
    vod_data = {}
    if vod_m:
        vd = vod_m.group(1)
        fm = re.search(r'\bvod_name\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"', vd, re.DOTALL)
        if fm:
            try:
                vod_data["vod_name"] = json.loads('"' + fm.group(1) + '"')
            except Exception:
                vod_data["vod_name"] = fm.group(1)

    return {
        "url": get_str("url"),
        "from": get_str("from"),
        "id": get_str("id"),
        "vod_data": vod_data,
    }


def _build_template(ep1_url: str):
    if not ep1_url:
        return None
    result = re.sub(r"(\d{2})(\.[^./]+$)", lambda m_: "{:02d}" + m_.group(2), ep1_url)
    return result if "{:02d}" in result else None


def _fetch_source_ep1(s, anime_id: str, source_idx: int):
    url = f"{BASE_URL}/watch/{anime_id}/{source_idx}/1.html"
    print(f"    Probing source {source_idx} ...", file=sys.stderr)
    try:
        resp = s.get(url, headers=HEADERS, timeout=15)
        resp.encoding = "utf-8"
        data = _parse_player_data(resp.text)
        if not data:
            return None, None
        ep1_url = unquote(data.get("url", ""))
        if not ep1_url:
            return None, None
        return _build_template(ep1_url), ep1_url
    except Exception as e:
        print(f"    Source {source_idx} failed: {e}", file=sys.stderr)
        return None, None


def cmd_watch(watch_url: str) -> None:
    s = _load_session()
    resp = s.get(watch_url, timeout=15)
    resp.encoding = "utf-8"
    html = resp.text

    data = _parse_player_data(html)
    if not data:
        print(json.dumps({"error": "Failed to parse player data"}))
        return

    anime_id = data.get("id", "")
    title = data.get("vod_data", {}).get("vod_name", "")
    ep1_url = unquote(data.get("url", ""))
    current_from = data.get("from", "")

    soup = BeautifulSoup(html, "html.parser")
    total = 1
    active_tag = soup.find("a", attrs={"data-form": current_from})
    if active_tag:
        badge = active_tag.find("span", class_="badge")
        if badge and str(badge.text).isdigit():
            total = int(badge.text)

    tab_div = soup.find("div", class_="anthology-tab nav-swiper")
    source_tags = tab_div.select("a.vod-playerUrl") if tab_div else []

    sources = []
    for idx, tag in enumerate(source_tags, 1):
        badge = tag.find("span", class_="badge")
        badge_text = badge.get_text() if badge else ""
        name = tag.get_text(strip=True).replace(badge_text, "").strip()
        if idx == 1:
            template = _build_template(ep1_url)
            sources.append({"idx": 1, "name": name, "template": template, "ep1": ep1_url})
        else:
            template, ep1 = _fetch_source_ep1(s, anime_id, idx)
            sources.append({"idx": idx, "name": name, "template": template, "ep1": ep1 or ""})

    print(json.dumps({
        "title": title,
        "id": anime_id,
        "total": total,
        "sources": sources,
    }, ensure_ascii=False))


# ── download ───────────────────────────────────────────────────────────────────

def cmd_download_single(title: str, ep: int, templates: list) -> None:
    """下载单集，向 stdout 输出 JSON 进度行供 Electron 读取"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from xifan_crawler import download_single_ep  # type: ignore

    print(json.dumps({"type": "ep_start", "ep": ep}), flush=True)

    last_pct = [-1]

    def on_progress(*args):
        bytes_done, pct = int(args[0]), args[2]
        if pct != last_pct[0]:
            last_pct[0] = pct
            print(json.dumps({"type": "ep_progress", "ep": ep, "pct": pct, "bytes": bytes_done}), flush=True)

    try:
        success = download_single_ep(templates, ep, title, on_progress)
        if success:
            print(json.dumps({"type": "ep_done", "ep": ep}), flush=True)
        else:
            print(json.dumps({"type": "ep_error", "ep": ep, "msg": "All sources failed"}), flush=True)
    except Exception as e:
        print(json.dumps({"type": "ep_error", "ep": ep, "msg": str(e)}), flush=True)

    print(json.dumps({"type": "all_done"}), flush=True)


def cmd_download(title: str, start_ep: int, end_ep: int, templates: list, eps=None) -> None:
    """逐集下载，向 stdout 输出 JSON 进度行供 Electron 读取。
    eps 若提供（列表），则只下载指定集数而非 start_ep~end_ep 范围。"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from xifan_crawler import download_mp4_series  # type: ignore
    episode_list = eps if eps is not None else list(range(start_ep, end_ep + 1))
    for ep in episode_list:
        print(json.dumps({"type": "ep_start", "ep": ep}), flush=True)
        try:
            download_mp4_series(templates, ep, ep, title)
            print(json.dumps({"type": "ep_done", "ep": ep}), flush=True)
        except Exception as e:
            print(json.dumps({"type": "ep_error", "ep": ep, "msg": str(e)}), flush=True)
    print(json.dumps({"type": "all_done"}), flush=True)


# ── entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: xifan_api.py <captcha|verify|search|watch|download> [args...]", file=sys.stderr)
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
            title = sys.argv[2]
            ep = int(sys.argv[3])
            templates = sys.argv[4:]
            cmd_download_single(title, ep, templates)
        elif cmd == "download":
            title = sys.argv[2]
            start_ep = int(sys.argv[3])
            end_ep = int(sys.argv[4])
            rest = sys.argv[5:]
            eps = None
            if '--eps' in rest:
                idx = rest.index('--eps')
                templates = rest[:idx]
                eps = [int(e) for e in rest[idx + 1:]]
            else:
                templates = rest
            cmd_download(title, start_ep, end_ep, templates, eps)
        else:
            print(f"Unknown command: {cmd}", file=sys.stderr)
            sys.exit(1)
    except IndexError:
        print(json.dumps({"error": f"Missing argument for command '{cmd}'"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()

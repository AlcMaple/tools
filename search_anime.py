import requests
from bs4 import BeautifulSoup
import re
from datetime import datetime
import urllib.parse
import os
import time

# ===================== 配置区域 =====================
BASE_URL = "https://bgm.tv/subject_search/{keyword}?cat=2&page={page}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}
CACHE_FOLDER = "bgm_cache"
PAGE_DELAY = 1
# ====================================================


def init_cache():
    if not os.path.exists(CACHE_FOLDER):
        os.makedirs(CACHE_FOLDER)


def get_cache_file_path(keyword, page):
    safe_keyword = re.sub(r'[\\/:*?"<>|]', "_", keyword)
    return os.path.join(CACHE_FOLDER, f"{safe_keyword}_{page}.html")


def save_page_to_cache(html, keyword, page):
    with open(get_cache_file_path(keyword, page), "w", encoding="utf-8") as f:
        f.write(html)


def read_page_from_cache(keyword, page):
    path = get_cache_file_path(keyword, page)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return None


def parse_total_page(html):
    soup = BeautifulSoup(html, "html.parser")
    multipage = soup.find("div", id="multipage")
    if not multipage:
        return 1
    page_nums = []
    for a in multipage.find_all("a", class_="p"):
        m = re.search(r"page=(\d+)", a.get("href", ""))
        if m:
            page_nums.append(int(m.group(1)))
    return max(page_nums) if page_nums else 1


def parse_date(text):
    if not text:
        return datetime.min, "未知日期"
    m = re.search(r"(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?", text)
    if m:
        y, m, d = int(m.group(1)), int(m.group(2)), int(m.group(3)) if m.group(3) else 1
        return datetime(y, m, d), f"{y}-{m:02d}-{d:02d}"
    m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)
    if m:
        y, m, d = map(int, m.groups())
        return datetime(y, m, d), f"{y}-{m:02d}-{d:02d}"
    m = re.search(r"(\d{4})", text)
    if m:
        return datetime(int(m.group(1)), 1, 1), f"{m.group(1)}-01-01"
    return datetime.min, "未知日期"


def request_page(keyword, page, update):
    if not update:
        cache = read_page_from_cache(keyword, page)
        if cache:
            return cache
    url = BASE_URL.format(keyword=urllib.parse.quote(keyword), page=page)
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        r.raise_for_status()
        r.encoding = "utf-8"
        save_page_to_cache(r.text, keyword, page)
        time.sleep(PAGE_DELAY)
        return r.text
    except:
        return None


# ===================== 核心修复 =====================
def parse_single_page(html, keyword):
    soup = BeautifulSoup(html, "html.parser")
    ul = soup.find("ul", id="browserItemList")
    if not ul:
        return []

    items = ul.select("li.item")
    res = []
    for item in items:
        a = item.select_one("h3 > a.l")
        if not a:
            continue
        title = a.get_text(strip=True)

        # =====================
        # 就是你要的：简单模糊包含！
        # =====================
        if keyword not in title:
            continue

        info = item.select_one("p.info.tip")
        info_text = info.get_text(strip=True) if info else ""
        d_obj, d_str = parse_date(info_text)
        rate = item.select_one("p.rateInfo small.fade")
        rate_str = rate.get_text(strip=True) if rate else "N/A"

        res.append(
            {
                "title": title,
                "date_str": d_str,
                "date_obj": d_obj,
                "rate": rate_str,
                "link": "https://bgm.tv" + a["href"] if a.has_attr("href") else "",
            }
        )
    return res


def deduplicate(items):
    seen = set()
    out = []
    for x in items:
        if x["title"] not in seen:
            seen.add(x["title"])
            out.append(x)
    return out


# ===================== 真正你要的停止逻辑 =====================
def search_bgm(keyword, update=False):
    init_cache()
    all_items = []

    html = request_page(keyword, 1, update)
    if not html:
        return []

    total_page = parse_total_page(html)
    page1 = parse_single_page(html, keyword)
    if not page1:
        return []
    all_items.extend(page1)

    # 从第2页开始爬
    for page in range(2, total_page + 1):
        print(f"正在爬取第 {page} 页...")
        html = request_page(keyword, page, update)
        if not html:
            continue

        current = parse_single_page(html, keyword)

        # =====================
        # 这一页 一条匹配都没有 → 直接结束！
        # =====================
        if len(current) == 0:
            print(f"第 {page} 页没有匹配「{keyword}」的动漫，停止爬取")
            break

        all_items.extend(current)

    all_items = sorted(all_items, key=lambda x: x["date_obj"], reverse=True)
    return deduplicate(all_items)


# ===================== 主程序 =====================
if __name__ == "__main__":
    import sys
    import json as _json

    # 支持 --json 标志：输出 JSON 供 IPC 调用
    #   用法: python search_anime.py <keyword> [y|n] [--json]
    args = [a for a in sys.argv[1:] if a != "--json"]
    json_mode = "--json" in sys.argv

    if len(args) >= 2:
        keyword = args[0]
        update = args[1].lower() == "y"
    elif len(args) == 1:
        keyword = args[0]
        update = False
    else:
        keyword = input("关键词：").strip()
        update = input("更新缓存？y/n：").lower() == "y"

    final = search_bgm(keyword, update)

    if json_mode:
        # 去掉不可序列化的 date_obj 字段
        output = [
            {"title": x["title"], "date": x["date_str"], "rate": x["rate"], "link": x["link"]}
            for x in final
        ]
        print(_json.dumps(output, ensure_ascii=False))
    else:
        print("\n" + "=" * 60)
        if not final:
            print("没有找到结果")
        else:
            for item in final:
                print(f"{item['date_str']}   | {item['title']}")

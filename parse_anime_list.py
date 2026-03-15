import os
import sys
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://dm.xifanacg.com"
CACHE_DIR = "html_cache"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": BASE_URL + "/",
}


def parse_anime_list(html_path):
    with open(html_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    container = soup.find("div", class_="row mask2")
    if not container:
        print("未找到 .row.mask2 容器")
        return []

    results = []
    for item in container.select("div.vod-detail.search-list"):
        # 标题 & 详情页链接
        title_tag = item.select_one("h3.slide-info-title")
        link_tag = title_tag.find_parent("a") if title_tag else None
        title = title_tag.get_text(strip=True) if title_tag else ""
        detail_url = BASE_URL + link_tag["href"] if link_tag else ""

        # 播放页链接
        play_tag = item.select_one("div.vod-detail-bnt a.button")
        watch_url = BASE_URL + play_tag["href"] if play_tag else ""

        # 封面图（懒加载，真实地址在 data-src）
        img_tag = item.select_one("div.detail-pic img")
        cover = img_tag.get("data-src", "") if img_tag else ""

        # 集数/播放量、年份、地区（前三个 .slide-info-remarks）
        remarks = [s.get_text(strip=True) for s in item.select("span.slide-info-remarks")]
        episode = remarks[0] if len(remarks) > 0 else ""
        year    = remarks[1] if len(remarks) > 1 else ""
        area    = remarks[2] if len(remarks) > 2 else ""

        results.append({
            "title":      title,
            "detail_url": detail_url,
            "watch_url":  watch_url,
            "cover":      cover,
            "episode":    episode,
            "year":       year,
            "area":       area,
        })

    return results


def fetch_watch_page(anime):
    """抓取播放页并保存到 html_cache/"""
    url = anime["watch_url"]
    title = anime["title"]
    save_path = os.path.join(CACHE_DIR, f"{title}_watch.html")

    print(f"正在抓取播放页: {url}")
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.encoding = "utf-8"

    with open(save_path, "w", encoding="utf-8") as f:
        f.write(resp.text)
    print(f"已保存到: {save_path}（共 {len(resp.text)} 字符）")
    return save_path


def main():
    if len(sys.argv) >= 2:
        keyword = sys.argv[1]
    else:
        keyword = input("请输入缓存关键词（对应 html_cache/ 下的文件名）: ").strip()

    html_path = os.path.join(CACHE_DIR, f"{keyword}.html")
    if not os.path.exists(html_path):
        print(f"文件不存在: {html_path}")
        return

    anime_list = parse_anime_list(html_path)
    if not anime_list:
        print("解析结果为空，可能是页面结构已变化，请尝试更新缓存重新抓取")
        return

    print(f"\n共找到 {len(anime_list)} 部动漫:\n")
    for i, a in enumerate(anime_list, 1):
        print(f"{i:>2}. {a['title']}")
        print(f"     {a['episode']}  {a['year']}  {a['area']}")
        print(f"     播放页: {a['watch_url']}")
        print()

    choice = input("请输入序号选择动漫（直接回车退出）: ").strip()
    if not choice:
        return
    if not choice.isdigit() or not (1 <= int(choice) <= len(anime_list)):
        print("无效序号")
        return

    selected = anime_list[int(choice) - 1]
    print(f"\n已选择: {selected['title']}")
    save_path = fetch_watch_page(selected)
    with open(".last_watch", "w", encoding="utf-8") as f:
        f.write(save_path)


if __name__ == "__main__":
    main()

import re
import json
import os
import time
import requests
from urllib.parse import unquote
from bs4 import BeautifulSoup

BASE_URL = "https://dm.xifanacg.com"
CACHE_DIR = "html_cache"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": BASE_URL + "/",
}


def _parse_player_data(html):
    # 格式1：单行合法 JSON（新抓取的页面）
    m = re.search(r"var player_aaaa\s*=\s*(\{.*?\})</script>", html)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass

    # 格式2：IDE 格式化后的多行 JS 对象字面量（键无引号）
    block_m = re.search(r"var player_aaaa\s*=\s*\{(.*?)\};", html, re.DOTALL)
    if not block_m:
        return None

    block = block_m.group(1)

    def get_str(key):
        """提取 key: "value"，允许 key 和 value 之间有换行"""
        pat = r'\b' + re.escape(key) + r'\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"'
        m2 = re.search(pat, block, re.DOTALL)
        if not m2:
            return ""
        try:
            return json.loads('"' + m2.group(1) + '"')  # 解码 \uXXXX 和 \/
        except Exception:
            return m2.group(1).replace('\\/', '/')

    # vod_data 子对象
    vod_m = re.search(r'vod_data\s*:\s*\{(.*?)\}', block, re.DOTALL)
    vod_data = {}
    if vod_m:
        vd = vod_m.group(1)
        for field in ["vod_name", "vod_actor", "vod_director", "vod_class"]:
            fm = re.search(
                r'\b' + re.escape(field) + r'\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"',
                vd, re.DOTALL
            )
            if fm:
                try:
                    vod_data[field] = json.loads('"' + fm.group(1) + '"')
                except Exception:
                    vod_data[field] = fm.group(1)

    return {
        "url":      get_str("url"),
        "url_next": get_str("url_next"),
        "from":     get_str("from"),
        "id":       get_str("id"),
        "link":     get_str("link"),
        "link_next":get_str("link_next"),
        "vod_data": vod_data,
    }


def _build_template(ep1_url):
    """把第一集 URL 里的两位集号替换为 {:02d} 占位符"""
    return re.sub(r"(\d{2})(\.[^./]+$)", lambda m: "{:02d}" + m.group(2), ep1_url)


def fetch_source_template(anime_id, source_idx):
    """请求指定源的第一集 watch 页，返回 (template, ep1_url)；失败返回 (None, None)"""
    url = f"{BASE_URL}/watch/{anime_id}/{source_idx}/1.html"
    print(f"    正在拉取源{source_idx}: {url}")
    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.encoding = "utf-8"
        data = _parse_player_data(resp.text)
        if not data:
            return None, None
        ep1_url = unquote(data.get("url", ""))
        if not ep1_url:
            return None, None
        return _build_template(ep1_url), ep1_url
    except Exception as e:
        print(f"    获取失败: {e}")
        return None, None


def parse_anime_info(html_path):
    """
    解析 watch HTML，返回：
    {
        "title": str,
        "id": str,
        "total": int,          # 总集数
        "sources": [           # 按源序号排列
            {"idx": 1, "name": "稀饭新番主线-1", "template": "...{:02d}.mp4", "ep1": "...01.mp4"},
            ...
        ]
    }
    源1的模板直接从 HTML 中读取（无需额外请求），源2+ 自动请求对应 watch 页。
    """
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()

    soup = BeautifulSoup(html, "html.parser")
    data = _parse_player_data(html)
    if not data:
        return None

    anime_id = data.get("id", "")
    title    = data.get("vod_data", {}).get("vod_name", "")
    ep1_url  = unquote(data.get("url", ""))
    current_from = data.get("from", "")

    # 总集数（从当前激活源的 badge 读取）
    total = 1
    active_tag = soup.find("a", attrs={"data-form": current_from})
    if active_tag:
        badge = active_tag.find("span", class_="badge")
        if badge and badge.text.isdigit():
            total = int(badge.text)

    # 所有源标签（anthology-tab nav-swiper）
    tab_div = soup.find("div", class_="anthology-tab nav-swiper")
    source_tags = tab_div.select("a.vod-playerUrl") if tab_div else []

    sources = []
    for idx, tag in enumerate(source_tags, 1):
        badge = tag.find("span", class_="badge")
        badge_text = badge.get_text() if badge else ""
        name = tag.get_text(strip=True).replace(badge_text, "").strip()

        if idx == 1:
            # 源1直接从已有数据读取，无需额外请求
            template = _build_template(ep1_url) if ep1_url else None
            sources.append({"idx": 1, "name": name, "template": template, "ep1": ep1_url})
        else:
            template, ep1 = fetch_source_template(anime_id, idx)
            sources.append({"idx": idx, "name": name, "template": template, "ep1": ep1})

    return {"title": title, "id": anime_id, "total": total, "sources": sources}


def safe_remove_file(file_path, max_retries=3, delay=1):
    """
    安全删除文件，处理文件占用问题
    :param file_path: 文件路径
    :param max_retries: 最大重试次数
    :param delay: 重试间隔（秒）
    :return: 是否删除成功
    """
    if not os.path.exists(file_path):
        print(f"[提示] 文件 {file_path} 不存在，无需删除")
        return True
    
    for attempt in range(max_retries):
        try:
            os.remove(file_path)
            print(f"[成功] 删除文件: {file_path}")
            return True
        except PermissionError:
            if attempt < max_retries - 1:
                print(f"[警告] 第{attempt+1}次删除 {file_path} 失败（文件被占用），{delay}秒后重试...")
                time.sleep(delay)
            else:
                print(f"[错误] 多次尝试删除 {file_path} 失败（文件被占用），跳过删除")
                # 标记文件为待删除，下次脚本运行时再尝试
                try:
                    # 重命名为临时文件，避免后续冲突
                    os.rename(file_path, f"{file_path}.tmp")
                    print(f"[提示] 已将 {file_path} 重命名为 {file_path}.tmp，避免后续冲突")
                except:
                    pass
                return False
        except Exception as e:
            print(f"[错误] 删除 {file_path} 时发生未知错误: {e}")
            return False


def main():
    # 若上一步（parse_anime_list.py）写入了 .last_watch，自动使用
    last_watch_file = ".last_watch"
    html_path = None
    if os.path.exists(last_watch_file):
        with open(last_watch_file, "r", encoding="utf-8") as f:
            candidate = f.read().strip()
        # 替换原有的 os.remove 为安全删除函数
        safe_remove_file(last_watch_file)
        if os.path.exists(candidate):
            html_path = candidate
            print(f"自动使用播放页: {html_path}\n")

    if not html_path:
        watch_files = sorted(
            f for f in os.listdir(CACHE_DIR) if f.endswith("_watch.html")
        )
        if not watch_files:
            print(f"{CACHE_DIR}/ 下没有 _watch.html 文件")
            return

        print("可用的播放页缓存:\n")
        for i, f in enumerate(watch_files, 1):
            print(f"  {i}. {f}")

        choice = input("\n请输入序号: ").strip()
        if not choice.isdigit() or not (1 <= int(choice) <= len(watch_files)):
            print("无效序号")
            return

        html_path = os.path.join(CACHE_DIR, watch_files[int(choice) - 1])

    print("\n正在解析源信息...\n")
    info = parse_anime_info(html_path)
    if not info:
        print("解析失败")
        return

    print(f"动漫:   {info['title']}")
    print(f"总集数: {info['total']}")
    print(f"源数量: {len(info['sources'])}\n")

    for s in info["sources"]:
        status = s["template"] if s["template"] else "❌ 获取失败"
        print(f"  源{s['idx']} [{s['name']}]")
        print(f"    第一集: {s['ep1'] or '—'}")
        print(f"    模板:   {status}")

    if info["total"] > 1 and info["sources"] and info["sources"][0]["template"]:
        t = info["sources"][0]["template"]
        print(f"\n全部集数（源1）:")
        for ep in range(1, info["total"] + 1):
            print(f"  第{ep:02d}集: {t.format(ep)}")

    # ── 下载入口 ──────────────────────────────────────────
    valid_templates = [s["template"] for s in info["sources"] if s["template"]]
    if not valid_templates:
        print("\n没有可用的下载源")
        return

    print()
    ans = input("是否开始下载？(y/N): ").strip().lower()
    if ans != "y":
        return

    while True:
        s_input = input(f"起始集数（直接回车从第1集开始）: ").strip()
        if not s_input:
            start_ep = 1
            break
        if s_input.isdigit() and int(s_input) >= 1:
            start_ep = int(s_input)
            break
        print("请输入有效数字")

    while True:
        e_input = input(f"结束集数（直接回车到第{info['total']}集）: ").strip()
        if not e_input:
            end_ep = info["total"]
            break
        if e_input.isdigit() and int(e_input) >= start_ep:
            end_ep = int(e_input)
            break
        print(f"请输入 >= {start_ep} 的有效数字")

    try:
        from xifan_crawler import download_mp4_series
        download_mp4_series(valid_templates, start_ep, end_ep, info["title"])
    except ImportError:
        print("[错误] 未找到 xifan_crawler 模块，请确认该模块存在")
    except Exception as e:
        print(f"[错误] 下载过程中发生错误: {e}")


if __name__ == "__main__":
    main()
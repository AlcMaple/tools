import requests
import os
import sys
import subprocess
import time
from urllib.parse import quote, urlencode, urljoin
from bs4 import BeautifulSoup

# ===================== 网站配置 =====================
# girigiri 搜索基础 URL
BASE_SEARCH_URL = "https://bgm.girigirilove.com/search/-------------"
BASE_DOMAIN = "https://bgm.girigirilove.com"
# 验证码相关配置（适配 girigiri）
VERIFY_IMG_URL = "https://bgm.girigirilove.com/verify/index.html"
VERIFY_CHECK_URL = "https://bgm.girigirilove.com/index.php/ajax/verify_check"
CAPTCHA_PATH = "captcha_girigiri.jpg"  # 独立文件名避免冲突
# 缓存目录（与原脚本保持一致）
CACHE_DIR = "html_cache"
# 最后选择的播放页文件（兼容下载流程）
LAST_WATCH_FILE = ".last_watch"

# 请求头（模拟浏览器，完全匹配网页环境）
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://bgm.girigirilove.com/",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "max-age=0",
}


def open_captcha():
    """用系统默认查看器打开验证码图片"""
    if not os.path.exists(CAPTCHA_PATH):
        print("验证码图片不存在，无法打开")
        return
    if sys.platform == "win32":
        os.startfile(CAPTCHA_PATH)
    else:
        subprocess.Popen(["open", CAPTCHA_PATH])
        time.sleep(0.5)  # 等图片窗口弹出


def close_captcha():
    """关闭验证码图片窗口并删除临时文件（适配 Windows）"""
    if not os.path.exists(CAPTCHA_PATH):
        return

    try:
        # Windows 系统：简化进程关闭逻辑（避免参数冲突）
        if sys.platform == "win32":
            # 仅尝试关闭常见图片查看器，不捕获输出（避免参数冲突）
            for proc in ["Microsoft.Photos.exe", "mspaint.exe"]:
                # 使用 >nul 2>&1 重定向输出，替代 capture_output
                subprocess.run(f"taskkill /IM {proc} /F >nul 2>&1", shell=True)
        # macOS 系统保持原有逻辑
        elif sys.platform == "darwin":
            subprocess.run(
                ["osascript", "-e", 'tell application "Preview" to close every window'],
                capture_output=True,
            )

        # 删除验证码文件（核心操作，进程关闭失败也强制删除）
        os.remove(CAPTCHA_PATH)

    except PermissionError:
        # 文件仍被占用时，延迟1秒重试删除
        time.sleep(1)
        try:
            os.remove(CAPTCHA_PATH)
        except:
            # 最终删除失败则重命名，避免后续冲突
            try:
                bak_path = f"{CAPTCHA_PATH}.bak"
                os.rename(CAPTCHA_PATH, bak_path)
                print(f"[提示] 验证码文件被占用，已重命名为: {bak_path}")
            except:
                pass
    except Exception as e:
        # 仅记录错误，不影响主流程
        pass


def build_search_url(keyword):
    """构建 girigiri 的完整搜索 URL"""
    return f"{BASE_SEARCH_URL}/?{urlencode({'wd': keyword})}"


def verify_captcha(session):
    """独立的验证码验证函数，验证成功返回 True，失败返回 False"""
    print("\n【强制验证】检测到系统要求验证码验证！")
    while True:
        print("-" * 40)
        # 获取验证码图片（带时间戳避免缓存）
        try:
            img_resp = session.get(
                f"{VERIFY_IMG_URL}?t={int(time.time() * 1000)}",
                headers=HEADERS,
                timeout=15,
            )
            img_resp.raise_for_status()
        except Exception as e:
            print(f"获取验证码图片失败: {e}")
            return False

        # 保存验证码图片
        with open(CAPTCHA_PATH, "wb") as f:
            f.write(img_resp.content)

        # 打开图片并等待用户输入
        open_captcha()
        user_input = input("请输入验证码 (看不清直接按【回车键】刷新): ").strip()

        # 空输入则刷新验证码
        if not user_input:
            close_captcha()
            print("准备获取新的验证码图片...\n")
            continue

        # 提交验证码验证
        print(f"\n正在验证验证码: [{user_input}]...")
        try:
            ajax_headers = {
                **HEADERS,
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            }
            check_resp = session.get(
                VERIFY_CHECK_URL,
                params={"type": "search", "verify": user_input},
                headers=ajax_headers,
                timeout=15,
            )
            check_resp.raise_for_status()
            result = check_resp.text
            print(f"服务器验证返回: {result}")

            # 验证成功判断（覆盖所有可能的成功标识）
            success_flags = ['"code":1', "成功", '"msg":"ok"', "验证通过", "验证成功"]
            if any(flag in result for flag in success_flags):
                close_captcha()
                print(">>> 验证码验证成功！<<<\n")
                return True
            else:
                close_captcha()
                print(">>> 验证码错误，请重新输入！<<<\n")
        except Exception as e:
            close_captcha()
            print(f"提交验证码失败: {e}")
            return False


def fetch_search_page(session, keyword):
    """
    核心抓取逻辑：
    1. 首次请求触发验证码验证
    2. 验证成功后重新请求搜索结果
    3. 返回最终的搜索结果 HTML
    """
    # 第一步：首次请求（触发验证码检测）
    search_url = build_search_url(keyword)
    try:
        first_resp = session.get(search_url, headers=HEADERS, timeout=15)
        first_resp.encoding = "utf-8"
    except Exception as e:
        print(f"首次请求失败: {e}")
        return None

    # 第二步：强制验证验证码（girigiri 100%需要）
    if not verify_captcha(session):
        print("验证码验证失败，终止抓取")
        return None

    # 第三步：验证成功后，重新请求搜索结果
    print(f"\n验证通过，正在获取「{keyword}」的搜索结果...")
    try:
        final_resp = session.get(search_url, headers=HEADERS, timeout=15)
        final_resp.encoding = "utf-8"
        return final_resp.text
    except Exception as e:
        print(f"获取搜索结果失败: {e}")
        return None


def parse_anime_list(html_content):
    """
    解析 girigiri 搜索结果，提取动漫信息列表（去重版）
    返回格式：
    [
        {
            "title": "动漫标题",
            "play_count": "播放量",
            "year": "年份",
            "region": "地区",
            "play_url": "播放页URL"
        },
        ...
    ]
    """
    soup = BeautifulSoup(html_content, "html.parser")
    anime_list = []
    # 用于去重的集合（存储已处理的播放页URL）
    processed_urls = set()

    # 优化：更精准的 DOM 选择器，只匹配完整的动漫项容器
    result_items = soup.select(
        # 优先匹配独立的动漫项容器（避免匹配子元素）
        "div[class*='vod-item'][class*='col'], "
        "div[class^='g-movie-item'], "
        "li[class*='vod-list-item']"
    )

    # 兜底：如果上面的选择器没匹配到，再用通用选择器（但限制层级）
    if not result_items:
        result_items = soup.select(
            "div[class*='mask2'] > div[class*='vod-detail']:first-child"
        )

    for item in result_items:
        anime_info = {}

        # 1. 提取播放页 URL（核心去重依据）
        play_link = item.find("a", href=True, recursive=False) or item.find(
            "a", href=True
        )
        if not play_link or not play_link["href"]:
            continue
        play_url = urljoin(BASE_DOMAIN, play_link["href"])

        # 去重：如果该URL已处理过，直接跳过
        if play_url in processed_urls:
            continue
        processed_urls.add(play_url)
        anime_info["play_url"] = play_url

        # 2. 提取标题（优先从最外层a标签提取）
        title_tag = (
            play_link.find("h3")
            or play_link.find("span", class_=lambda c: c and "name" in c)
            or play_link
        )
        if title_tag:
            anime_info["title"] = title_tag.get_text(strip=True)
        else:
            # 尝试从item的其他位置提取标题
            title_tag = item.find("h3") or item.find(
                "div", class_=lambda c: c and "title" in c
            )
            anime_info["title"] = (
                title_tag.get_text(strip=True) if title_tag else "未知标题"
            )

        # 过滤无效标题
        if anime_info["title"] in ["", "未知标题"]:
            continue

        # 3. 提取播放量、年份、地区（适配 girigiri 页面的信息展示）
        info_tags = item.select(
            "div[class*='info'], span[class*='desc'], div[class*='meta'], p[class*='detail']"
        )
        info_text = " ".join([tag.get_text(strip=True) for tag in info_tags])

        # 提取播放量
        play_count_match = re.search(r"(\d+(?:\.\d+)?万?)\s*播放", info_text)
        anime_info["play_count"] = (
            play_count_match.group(1) + "播放" if play_count_match else "未知播放量"
        )

        # 提取年份
        year_match = re.search(r"(\d{4})", info_text)
        anime_info["year"] = year_match.group(1) if year_match else "未知年份"

        # 提取地区
        region_match = re.search(r"(日本|中国|美国|韩国|国产|日漫|大陆)", info_text)
        anime_info["region"] = region_match.group(1) if region_match else "未知地区"

        anime_list.append(anime_info)

    # 最终兜底：如果解析结果为空，尝试从页面中提取所有唯一的播放URL
    if not anime_list:
        all_links = soup.find_all("a", href=True)
        unique_links = {}
        for link in all_links:
            href = link["href"]
            if "/watch/" in href or "/GV" in href:  # 匹配播放页特征
                full_url = urljoin(BASE_DOMAIN, href)
                title = link.get_text(strip=True) or "未知标题"
                if full_url not in unique_links:
                    unique_links[full_url] = title
        # 转换为列表
        for url, title in unique_links.items():
            anime_list.append(
                {
                    "title": title,
                    "play_count": "未知播放量",
                    "year": "未知年份",
                    "region": "未知地区",
                    "play_url": url,
                }
            )

    return anime_list


def show_anime_list(anime_list, keyword):
    """展示动漫列表并让用户选择，返回选中的播放页URL"""
    if not anime_list:
        print(f"\n❌ 搜索「{keyword}」未找到任何可解析的动漫！")
        return None

    print(f"\n┌─────────────────────────────────────────┐")
    print(f"│            共找到 {len(anime_list)} 部动漫            │")
    print(f"└─────────────────────────────────────────┘")
    print()

    # 展示列表（和稀饭脚本格式一致）
    for idx, anime in enumerate(anime_list, 1):
        print(f" {idx}. {anime['title']}")
        print(f"     {anime['play_count']}  {anime['year']}  {anime['region']}")
        print(f"     播放页: {anime['play_url']}")
        print()

    # 用户选择
    while True:
        choice = input("请输入序号选择动漫（直接回车退出）: ").strip()
        if not choice:
            print("已退出选择")
            return None
        try:
            choice_idx = int(choice) - 1
            if 0 <= choice_idx < len(anime_list):
                selected = anime_list[choice_idx]
                print(f"\n✅ 已选择: {selected['title']}")
                return selected["play_url"]
            else:
                print(f"❌ 请输入 1-{len(anime_list)} 之间的序号！")
        except ValueError:
            print("❌ 请输入有效的数字序号！")


def save_last_watch(play_url):
    """将选中的播放页URL写入.last_watch文件（兼容下载流程）"""
    try:
        with open(LAST_WATCH_FILE, "w", encoding="utf-8") as f:
            f.write(play_url)
        print(f"\n📝 已将播放页URL写入: {LAST_WATCH_FILE}")
        return True
    except Exception as e:
        print(f"❌ 写入 {LAST_WATCH_FILE} 失败: {e}")
        return False


def fetch_and_save():
    """主函数：处理缓存 + 验证 + 抓取 + 解析 + 列表展示 + 选择"""
    # 创建缓存目录
    os.makedirs(CACHE_DIR, exist_ok=True)

    # 解析命令行参数（兼容原脚本逻辑）
    if len(sys.argv) >= 2:
        keyword = sys.argv[1]
        update = sys.argv[2].lower() == "y" if len(sys.argv) >= 3 else False
    else:
        keyword = input("请输入搜索关键词: ").strip()
        update = False

    # 校验关键词
    if not keyword:
        print("错误：关键词不能为空！")
        close_captcha()
        return

    # 缓存文件路径（独立后缀）
    cache_filename = f"{keyword}_girigiri.html"
    cache_path = os.path.join(CACHE_DIR, cache_filename)

    # 缓存逻辑（与原脚本一致）
    use_cache = False
    if os.path.exists(cache_path) and not update:
        answer = (
            input(f"\n已有「{keyword}」的缓存文件，是否更新？(y/N): ").strip().lower()
        )
        if answer != "y":
            print(f"使用缓存文件: {cache_path}")
            use_cache = True

    # 读取缓存或抓取新页面
    html_content = None
    if use_cache:
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                html_content = f.read()
        except Exception as e:
            print(f"读取缓存文件失败: {e}")
            close_captcha()
            return
    else:
        # 创建会话（保持 cookies，验证码验证后有效）
        session = requests.Session()
        session.headers.update(HEADERS)

        # 核心：抓取带验证的搜索页面
        html_content = fetch_search_page(session, keyword)
        if not html_content:
            close_captcha()
            return

        # 保存到缓存
        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                f.write(html_content)
            print(f"\n✅ 搜索结果已保存到: {cache_path}")
            print(f"📄 文件大小: {len(html_content)} 字符")
        except Exception as e:
            print(f"保存缓存文件失败: {e}")
            close_captcha()
            return

    # 解析动漫列表
    print("\n🔍 正在解析搜索结果...")
    anime_list = parse_anime_list(html_content)

    # 展示列表并让用户选择
    selected_play_url = show_anime_list(anime_list, keyword)
    if selected_play_url:
        # 保存到.last_watch文件
        save_last_watch(selected_play_url)

        # 额外：下载播放页HTML（和稀饭脚本一致）
        watch_html_filename = f"{keyword}_girigiri_watch.html"
        watch_html_path = os.path.join(CACHE_DIR, watch_html_filename)
        try:
            session = requests.Session()
            watch_resp = session.get(selected_play_url, headers=HEADERS, timeout=15)
            watch_resp.encoding = "utf-8"
            with open(watch_html_path, "w", encoding="utf-8") as f:
                f.write(watch_resp.text)
            print(
                f"📄 播放页已保存到: {watch_html_path}（共 {len(watch_resp.text)} 字符）"
            )
        except Exception as e:
            print(f"❌ 抓取播放页失败: {e}")

    # 最终清理
    close_captcha()
    print("\n[步骤完成] 按任意键继续（Ctrl+C 可取消）...")
    try:
        input()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    # 修复：添加正则表达式导入
    import re

    try:
        fetch_and_save()
    except KeyboardInterrupt:
        print("\n\n⚠️  用户中断操作！")
        close_captcha()
    except Exception as e:
        print(f"\n❌ 程序异常终止: {e}")
        close_captcha()
    finally:
        # 确保验证码文件被清理
        close_captcha()

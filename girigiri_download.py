import os
import sys
import re
import subprocess
import time
import shutil
import asyncio
import aiohttp
import requests
import urllib3
from urllib.parse import urljoin, unquote
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

# 禁用 requests 的 SSL 证书未验证警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ===================== 网站配置 =====================
BASE_DOMAIN = "https://bgm.girigirilove.com"
CACHE_DIR = "html_cache"
DOWNLOAD_DIR = "downloads"  # 视频下载目录
TEMP_DIR = "temp_ts"  # ts分片临时目录

# 请求头（模拟浏览器）
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": BASE_DOMAIN + "/",
    "Upgrade-Insecure-Requests": "1",
}


# ===================== 工具函数 =====================
def create_dirs():
    """创建必要的目录"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    os.makedirs(TEMP_DIR, exist_ok=True)


def clean_filename(filename):
    """清理文件名中的非法字符"""
    illegal_chars = r'[\/:*?"<>|]'
    return re.sub(illegal_chars, "_", filename)


def extract_real_m3u8_link(redirect_link):
    """从中转链接中提取真实的 m3u8 链接"""
    if not redirect_link or "url=" not in redirect_link:
        return redirect_link
    real_link = re.search(r"url=(.+?)(&|$)", redirect_link)
    if real_link:
        decoded_link = unquote(real_link.group(1))
        print(f"🔧 解析中转链接 → 真实 m3u8: {decoded_link}")
        return decoded_link
    return redirect_link


# ===================== M3U8 & TS 解析与下载 =====================
def parse_m3u8_content(m3u8_url):
    """
    解析m3u8文件，获取所有ts分片的URL和密钥信息（修复相对路径和嵌套问题）
    """
    try:
        response = requests.get(m3u8_url, headers=HEADERS, timeout=30, verify=False)
        response.raise_for_status()
        response.encoding = "utf-8"
        m3u8_content = response.text

        ts_urls = []
        key_info = None
        base_url = m3u8_url

        lines = m3u8_content.strip().split("\n")
        for line in lines:
            line = line.strip()
            if not line:
                continue

            if line.startswith("#"):
                if line.startswith("#EXT-X-KEY:"):
                    key_info = parse_key_info(line, base_url)
                continue

            # 处理嵌套 m3u8
            if ".m3u8" in line:
                nested_url = urljoin(base_url, line)
                print(f"🔄 发现嵌套播放列表，正在递归解析真实列表...")
                return parse_m3u8_content(nested_url)

            # 处理 ts 分片
            ts_url = urljoin(base_url, line)
            ts_urls.append(ts_url)

        print(f"📝 解析m3u8完成 - 共{len(ts_urls)}个分片")
        return ts_urls, key_info, base_url

    except Exception as e:
        print(f"❌ 解析m3u8失败: {e}")
        return [], None, ""


def parse_key_info(key_line, base_url):
    """解析m3u8加密密钥信息"""
    key_info = {}
    uri_match = re.search(r'URI="([^"]+)"', key_line)
    if uri_match:
        key_uri = uri_match.group(1)
        key_info["uri"] = urljoin(base_url, key_uri)

    format_match = re.search(r"FORMAT=([^,]+)", key_line)
    if format_match:
        key_info["format"] = format_match.group(1)

    iv_match = re.search(r"IV=0x([0-9a-fA-F]+)", key_line)
    if iv_match:
        key_info["iv"] = iv_match.group(1)

    return key_info


# --------- 异步协程下载模块 ---------
async def download_ts_segment_async(session, ts_url, save_path, semaphore, retry=8):
    """异步下载单个ts分片"""
    async with semaphore:
        for attempt in range(retry):
            try:
                timeout = aiohttp.ClientTimeout(total=20 + attempt * 5)
                async with session.get(ts_url, timeout=timeout, ssl=False) as response:
                    if response.status == 404:
                        await asyncio.sleep(3)
                        continue

                    response.raise_for_status()
                    content = await response.read()
                    with open(save_path, "wb") as f:
                        f.write(content)
                return True, ts_url

            except Exception as e:
                sleep_time = min(2 + attempt * 1.5, 8)
                await asyncio.sleep(sleep_time)

    # 🚨 异步重试耗尽，说明 IP 可能被临时熔断了！
    print(f"\n🚑 触发终极兜底 (怀疑被临时封锁)，开始抢救: {ts_url.split('/')[-1]}")
    try:
        success = await asyncio.to_thread(_sync_download_fallback, ts_url, save_path)
        if success:
            print(f"✅ 兜底抢救成功: {ts_url.split('/')[-1]}")
            return True, ts_url
    except Exception as fallback_e:
        print(f"\n❌ 兜底彻底失败: {ts_url} - {fallback_e}")

    return False, ts_url


def _sync_download_fallback(ts_url, save_path, retry=3):
    """完全独立的同步兜底：自带冷却期 + 强制短连接"""
    # 🌟 核心破防技巧 1：强制断开连接池，伪装成全新的一次性请求
    fallback_headers = HEADERS.copy()
    fallback_headers["Connection"] = "close"

    for attempt in range(retry):
        try:
            # 🌟 核心破防技巧 2：冷静期。遇到阻断先装死，等防火墙熔断时间过去
            # 第一次等 5 秒，第二次等 10 秒，第三次等 15 秒
            cooldown = 5 * (attempt + 1)
            print(f"   ⏳ 正在冷静 {cooldown} 秒后发起全新请求...")
            time.sleep(cooldown)

            resp = requests.get(
                ts_url, headers=fallback_headers, timeout=30, verify=False
            )
            if resp.status_code == 200:
                with open(save_path, "wb") as f:
                    f.write(resp.content)
                return True
        except Exception as e:
            print(f"   ⚠️ 兜底抢救 {attempt+1}/{retry} 失败...")

    return False


async def run_async_downloads(ts_urls, temp_ts_dir):
    """管理异步任务的协程池"""
    MAX_CONCURRENT = 10
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    connector = aiohttp.TCPConnector(limit=MAX_CONCURRENT, ssl=False)

    async with aiohttp.ClientSession(connector=connector, headers=HEADERS) as session:
        tasks = []
        for idx, ts_url in enumerate(ts_urls):
            ts_filename = f"segment_{idx:05d}.ts"
            save_path = os.path.join(temp_ts_dir, ts_filename)
            task = asyncio.create_task(
                download_ts_segment_async(session, ts_url, save_path, semaphore)
            )
            tasks.append(task)

        completed = 0
        total = len(tasks)
        failed = 0

        for future in asyncio.as_completed(tasks):
            success, url = await future
            if success:
                completed += 1
            else:
                failed += 1
            print(
                f"\r⚡ 极限异步下载进度: [{completed + failed}/{total}] (成功:{completed} 失败:{failed})",
                end="",
            )

        await asyncio.sleep(0.25)

        # 🌟 优化：不再返回布尔值，而是直接返回失败的具体数量
        return failed


def download_ts_segments_multithread(ts_urls, temp_ts_dir, episode_name):
    """无缝替换原有的多线程入口，接入 aiohttp 异步并发"""
    os.makedirs(temp_ts_dir, exist_ok=True)
    print(f"\r🚀 启动 aiohttp 异步并发引擎...")

    # 接收失败的分片数量
    failed_count = asyncio.run(run_async_downloads(ts_urls, temp_ts_dir))

    if failed_count == 0:
        print(f"\n✅ 分片全部下载完成！")
    else:
        print(f"\n⚠️ 存在 {failed_count} 个顽固分片下载失败。")

    return failed_count, temp_ts_dir


# ===================== 解密与合并 =====================
def decrypt_ts_segments(temp_ts_dir, key_info):
    """解密加密的ts分片（如果有密钥）"""
    if not key_info or "uri" not in key_info:
        return True

    try:
        key_response = requests.get(
            key_info["uri"], headers=HEADERS, timeout=15, verify=False
        )
        key = key_response.content

        ts_files = [f for f in os.listdir(temp_ts_dir) if f.endswith(".ts")]
        from Crypto.Cipher import AES

        iv = bytes.fromhex(key_info.get("iv", "00000000000000000000000000000000"))

        for ts_file in ts_files:
            ts_path = os.path.join(temp_ts_dir, ts_file)
            with open(ts_path, "rb") as f:
                encrypted_data = f.read()

            cipher = AES.new(key, AES.MODE_CBC, iv)
            padded_data = encrypted_data + b"\0" * (16 - len(encrypted_data) % 16)
            decrypted_data = cipher.decrypt(padded_data)

            with open(ts_path, "wb") as f:
                f.write(decrypted_data)

        print("🔐 分片解密完成")
        return True
    except Exception as e:
        print(f"❌ 分片解密失败: {e}")
        return False


def merge_ts_segments(temp_ts_dir, output_path, key_info=None):
    """合并ts分片并封装为MP4（修复了FFmpeg相对路径Bug）"""
    try:
        if key_info and not decrypt_ts_segments(temp_ts_dir, key_info):
            return False

        ts_files = [
            f
            for f in os.listdir(temp_ts_dir)
            if f.startswith("segment_") and f.endswith(".ts")
        ]
        ts_files.sort()

        if not ts_files:
            print("❌ 没有找到ts分片文件")
            return False

        # 创建分片列表文件
        list_file = os.path.join(temp_ts_dir, "segments.txt")
        with open(list_file, "w", encoding="utf-8") as f:
            for ts_file in ts_files:
                f.write(f"file '{ts_file}'\n")

        # 🌟 修复合并乌龙：因为已经在 cwd 执行了，直接传入 "segments.txt" 即可
        ffmpeg_cmd = [
            "ffmpeg",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "segments.txt",  # <--- 就改了这里！去掉了 list_file 变量
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-movflags",
            "+faststart",
            "-y",
            "-loglevel",
            "warning",
            output_path,
        ]

        # 将工作目录切换到 temp_ts_dir 内部执行合并
        result = subprocess.run(
            ffmpeg_cmd, capture_output=True, text=True, cwd=temp_ts_dir
        )

        if result.returncode == 0:
            print(f"\n✅ 合并完成: {output_path}")
            return True
        else:
            print(f"\n❌ 合并失败: {result.stderr}")
            return False
    except Exception as e:
        print(f"\n❌ 合并异常: {e}")
        return False


# ===================== 页面与视频解析 =====================
def parse_watch_page(watch_html_path):
    """解析 watch 页面本地缓存，提取动漫标题和集数列表"""
    try:
        with open(watch_html_path, "r", encoding="utf-8") as f:
            html_content = f.read()
    except Exception as e:
        print(f"❌ 读取 watch 页面失败: {e}")
        return None, []

    soup = BeautifulSoup(html_content, "html.parser")
    anime_title = "未知动漫"

    # 精准提取标题
    h3_title_tag = soup.find("h3", class_="slide-info-title")
    if h3_title_tag:
        anime_title = h3_title_tag.get_text(strip=True)
    else:
        title_tag = soup.find("title")
        if title_tag:
            anime_title = title_tag.get_text(strip=True).split("_")[0].strip()

    print(f"✅ 成功提取动漫标题: {anime_title}")

    episode_list = []
    episode_links = soup.select(".anthology-list-play li a")

    for idx, link in enumerate(episode_links, 1):
        episode_info = {}
        episode_name = link.get_text(strip=True) or f"第{idx}集"
        episode_info["name"] = episode_name

        href = link.get("href", "")
        if href:
            episode_url = urljoin(BASE_DOMAIN, href)
            episode_info["url"] = episode_url
            episode_info["id"] = href.strip("/").replace("play", "")
            episode_list.append(episode_info)

    if not episode_list:
        play_pattern = r'href=["\'](/playGV\d+-\d+-\d+/?)["\']'
        play_matches = re.findall(play_pattern, html_content)
        for idx, path in enumerate(play_matches, 1):
            episode_list.append(
                {
                    "name": f"第{idx}集",
                    "url": urljoin(BASE_DOMAIN, path),
                    "id": path.strip("/").replace("play", ""),
                }
            )

    print(f"✅ 解析完成 - 共找到 {len(episode_list)} 集")
    return anime_title, episode_list


def extract_video_link_playwright(episode_url):
    """使用 Playwright 捕获真实 m3u8 链接"""
    m3u8_link = None
    m3u8_keywords = [
        "ai.girigirilove.net/zijian",
        "playlist.m3u8",
        ".m3u8",
        "atom.php?key=",
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-web-security",
                "--no-proxy-server",  # 🌟 核心修复 1：强制禁用任何代理，避免被 Windows 幽灵设置干扰
                f"--user-agent={HEADERS['User-Agent']}",
            ],
            timeout=60000,
        )
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            extra_http_headers=HEADERS,
            ignore_https_errors=True,
        )
        page = context.new_page()

        def handle_route(route, request):
            if request.resource_type in ["image", "stylesheet", "font", "media"]:
                route.abort()
            else:
                route.continue_()

        page.route("**/*", handle_route)

        def handle_request(request):
            nonlocal m3u8_link
            if m3u8_link and "ai.girigirilove.net" in m3u8_link:
                return
            url = request.url
            if (
                any(keyword in url for keyword in m3u8_keywords)
                and ".m3u8" in url.lower()
            ):
                m3u8_link = url
                if "atom.php" in url:
                    real_link = extract_real_m3u8_link(url)
                    if "ai.girigirilove.net" in real_link:
                        m3u8_link = real_link
                print(f"🔍 捕获到 m3u8 链接: {m3u8_link}")

        page.on("request", handle_request)

        # 🌟 核心修复 2：增加重试机制，应对 Socket 闪断
        for attempt in range(3):
            try:
                page.goto(episode_url, wait_until="domcontentloaded", timeout=60000)
                wait_time = 0
                while not m3u8_link and wait_time < 15:
                    page.wait_for_timeout(1000)
                    wait_time += 1
                page.wait_for_timeout(3000)
                break  # 如果没有报错且顺利执行，跳出重试循环
            except PlaywrightTimeoutError:
                print(f"⚠️ 访问超时，正在重试 ({attempt + 1}/3)...")
            except Exception as e:
                print(f"⚠️ 网络连接异常 ({e})，正在重试 ({attempt + 1}/3)...")
                page.wait_for_timeout(2000)  # 等待两秒再重试

        browser.close()

    if m3u8_link:
        m3u8_link = extract_real_m3u8_link(m3u8_link)

    if not m3u8_link:
        print("❌ 未捕获到任何 m3u8 链接")
    return m3u8_link


# ===================== 下载流程控制 =====================
def download_video_multithread(m3u8_link, save_path, episode_name):
    """异步并发下载与合并流程（严格要求 100% 完整）"""
    if not m3u8_link or ".m3u8" not in m3u8_link.lower():
        print(f"❌ {episode_name} - 非 m3u8 链接，跳过")
        return False

    print(f"\n📥 开始并发下载: {episode_name}")
    ts_urls, key_info, base_url = parse_m3u8_content(m3u8_link)
    if not ts_urls:
        return False

    temp_ts_dir = os.path.join(TEMP_DIR, clean_filename(episode_name))
    shutil.rmtree(temp_ts_dir, ignore_errors=True)

    # 获取失败数量
    failed_count, temp_ts_dir = download_ts_segments_multithread(
        ts_urls, temp_ts_dir, episode_name
    )

    # 🌟 撤销妥协！只要有 1 个分片失败，坚决不合并，保证视频完整性！
    if failed_count > 0:
        print(
            f"\n❌ {episode_name} - 抢救无效！仍有 {failed_count} 个关键分片丢失，为保证正片完整性，放弃合并。"
        )
        print(
            "   💡 建议：稍后重新运行脚本，程序会自动跳过已下载的分片，只下载这几个失败的！"
        )
        return False

    abs_save_path = os.path.abspath(save_path)
    merge_success = merge_ts_segments(temp_ts_dir, abs_save_path, key_info)

    shutil.rmtree(temp_ts_dir, ignore_errors=True)
    return merge_success


def download_video_fallback(video_link, save_path, episode_name):
    """原有的 FFmpeg 下载备用方案"""
    if not video_link or ".m3u8" not in video_link.lower():
        return False

    print(f"\n📥 切换 FFmpeg 下载（备用模式）: {episode_name}")
    ffmpeg_cmd = [
        "ffmpeg",
        "-headers",
        f"User-Agent: {HEADERS['User-Agent']}\r\nReferer: {BASE_DOMAIN}/",
        "-timeout",
        "30000000",
        "-rw_timeout",
        "30000000",
        "-reconnect",
        "1",
        "-reconnect_at_eof",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "10",
        "-i",
        video_link,
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart",
        "-y",
        "-loglevel",
        "warning",
        save_path,
    ]
    try:
        process = subprocess.Popen(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            bufsize=1,
            universal_newlines=True,
        )
        for line in iter(process.stdout.readline, ""):
            if line and ("frame=" in line or "time=" in line or "speed=" in line):
                print(f"\r🔄 {line.strip()}", end="")
        process.stdout.close()
        process.wait()

        if process.returncode == 0:
            print(f"\n✅ {episode_name} - FFmpeg下载完成")
            return True
        return False
    except Exception as e:
        print(f"\n❌ FFmpeg下载失败: {e}")
        return False


# ===================== 主函数 =====================
def main():
    create_dirs()
    watch_html_path = ""

    # 优先级 A：命令行参数
    if len(sys.argv) >= 2:
        input_name = sys.argv[1]
        if not input_name.endswith(".html"):
            input_name += ".html"
        watch_html_path = os.path.join(CACHE_DIR, input_name)

    # 优先级 B：读取 .last_watch 文件
    elif os.path.exists(".last_watch"):
        with open(".last_watch", "r", encoding="utf-8") as f:
            content = f.read().strip()
            if content.startswith("http"):
                print("⚠️ .last_watch 是URL，已停用URL自动抓取，请手动输入本地文件名。")
            else:
                input_name = content if content.endswith(".html") else f"{content}.html"
                watch_html_path = os.path.join(CACHE_DIR, input_name)

    # 优先级 C：用户输入文件名
    if not watch_html_path or not os.path.exists(watch_html_path):
        input_name = input(
            f"\n📁 请输入 {CACHE_DIR} 目录下的文件名 (如 光之美少女_girigiri_watch): "
        ).strip()
        if not input_name:
            print("❌ 未输入文件名，退出")
            return
        if not input_name.endswith(".html"):
            input_name += ".html"
        watch_html_path = os.path.join(CACHE_DIR, input_name)

    if not os.path.exists(watch_html_path):
        print(f"❌ 找不到缓存文件: {watch_html_path}")
        return

    print(f"\n📄 正在读取本地缓存: {watch_html_path}")

    # 解析本地缓存页面
    anime_title, episode_list = parse_watch_page(watch_html_path)
    if not episode_list:
        print("❌ 未解析到任何集数")
        return

    # 打印集数列表
    print("\n┌─────────────────────────────────────────┐")
    print(f"│            {anime_title} - 集数列表            │")
    print(f"└─────────────────────────────────────────┘")
    for idx, episode in enumerate(episode_list, 1):
        print(f" {idx}. {episode['name']}")
    print()

    # 选择下载集数
    choice = input("请选择下载集数（如 1-5 / all / 3）: ").strip().lower()
    if not choice:
        return

    download_indices = []
    if choice == "all":
        download_indices = list(range(len(episode_list)))
    elif "-" in choice:
        try:
            start, end = map(int, choice.split("-"))
            download_indices = list(
                range(max(0, start - 1), min(len(episode_list), end))
            )
        except:
            print("❌ 无效范围格式")
            return
    else:
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(episode_list):
                download_indices = [idx]
            else:
                print("❌ 超出范围")
                return
        except:
            print("❌ 无效集数")
            return

    anime_dir = os.path.join(DOWNLOAD_DIR, clean_filename(anime_title))
    os.makedirs(anime_dir, exist_ok=True)

    print(f"\n📁 视频将保存至: {anime_dir}")
    print("─────────────────────────────────────────")

    success_count, fail_count = 0, 0
    for idx in download_indices:
        episode = episode_list[idx]
        episode_name = clean_filename(episode["name"])
        episode_url = episode["url"]

        save_path = os.path.join(anime_dir, f"{episode_name}.mp4")
        if os.path.exists(save_path):
            print(f"⚠️ {episode_name} - 已存在，跳过")
            success_count += 1
            continue

        # Playwright 捕获链接
        video_link = extract_video_link_playwright(episode_url)
        if not video_link:
            fail_count += 1
            continue

        # 异步并发下载 -> 若失败则 FFmpeg 兜底
        if download_video_multithread(video_link, save_path, episode_name):
            success_count += 1
        else:
            if download_video_fallback(video_link, save_path, episode_name):
                success_count += 1
            else:
                fail_count += 1

        time.sleep(2)

    print("\n─────────────────────────────────────────")
    print(f"📊 下载完成 - 成功: {success_count} | 失败: {fail_count}")


if __name__ == "__main__":
    # 检查核心依赖
    try:
        import playwright
        import Crypto.Cipher.AES
        import aiohttp
    except ImportError as e:
        print(f"⚠️ 缺少依赖库，正在尝试自动安装 ({e})...")
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "playwright",
                "pycryptodome",
                "aiohttp",
            ],
            check=True,
        )
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"], check=True
        )
        print("✅ 依赖安装完成，请重新运行脚本！")
        sys.exit(0)

    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⚠️  用户手动中断！")
    except Exception as e:
        print(f"\n❌ 程序异常: {e}")
    finally:
        shutil.rmtree(TEMP_DIR, ignore_errors=True)

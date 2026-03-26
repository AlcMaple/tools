import os
import re
import sys
import asyncio
import aiohttp
from tqdm import tqdm
from urllib.parse import urlparse
import warnings

# 忽略asyncio的无害警告
warnings.filterwarnings("ignore", category=RuntimeWarning)

# 配置
THREADS_PER_EP = 16        # 保留供旧接口兼容，流式下载不再使用
CHUNK_SIZE = 1024 * 1024   # 流式读取块大小（1MB）
TIMEOUT_CONNECT = 30       # 连接超时（秒）
TIMEOUT_READ = 60          # 单次读取超时（秒），不限制整体下载时长
MAX_RETRIES = 5            # 网络抖动时自动断点续传重试次数

# Windows 事件循环修复（仅 Windows 需要）
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


class MultiThreadDownloader:
    def __init__(self, url, save_path, threads=THREADS_PER_EP, progress_callback=None):
        self.url = url
        self.save_path = save_path
        self.threads = threads
        self.file_size = 0
        self.progress_callback = progress_callback
        self._bytes_done = 0
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": f"https://{urlparse(url).hostname}",
            "Accept": "*/*",
            "Accept-Encoding": "identity",  # 禁用压缩，避免分片错误
            "Connection": "keep-alive",
        }

    async def get_file_size(self):
        """获取文件真实大小，验证是否是完整视频"""
        try:
            timeout = aiohttp.ClientTimeout(connect=TIMEOUT_CONNECT, sock_read=TIMEOUT_READ)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.head(self.url, headers=self.headers) as resp:
                    if resp.status == 200:
                        self.file_size = int(resp.headers.get("Content-Length", 0))
                        print(f"📌 文件大小: {self.file_size/1024/1024:.2f} MB")
                        if self.file_size < 10 * 1024 * 1024:  # 小于10MB大概率是低清/防盗链
                            print(f"⚠️  文件小于10MB，可能是低清片段或防盗链，放弃此源！")
                            self.file_size = 0  # 标记为无效，触发 return False
                    else:
                        print(f"❌ 获取文件大小失败，状态码: {resp.status}")
        except Exception as e:
            print(f"❌ 获取文件大小异常: {e}")

    async def download(self):
        """流式下载，支持断点续传 + 网络抖动自动重试。"""
        # 1. 获取服务端文件大小
        await self.get_file_size()
        if self.file_size == 0:
            return False

        # 2. 初始化进度条（整个下载过程只创建一次）
        existing = os.path.getsize(self.save_path) if os.path.exists(self.save_path) else 0
        if existing >= self.file_size:
            print(f"✅ {os.path.basename(self.save_path)} 已完整，跳过\n")
            return True

        self._bytes_done = existing
        progress_bar = tqdm(
            total=self.file_size,
            initial=existing,
            unit="iB",
            unit_scale=True,
            desc=os.path.basename(self.save_path),
        )

        # 3. 带自动重试的流式下载（超时/断线从当前文件末尾续传）
        timeout = aiohttp.ClientTimeout(connect=TIMEOUT_CONNECT, sock_read=TIMEOUT_READ)
        for attempt in range(1, MAX_RETRIES + 1):
            existing = os.path.getsize(self.save_path) if os.path.exists(self.save_path) else 0
            if existing >= self.file_size:
                break  # 已完整，退出重试循环

            req_headers = self.headers.copy()
            if existing > 0:
                req_headers["Range"] = f"bytes={existing}-"
                if attempt == 1:
                    print(f"🔄 断点续传，从 {existing/1024/1024:.2f} MB 继续...")
                else:
                    print(f"🔄 网络抖动，第{attempt}次重试，从 {existing/1024/1024:.2f} MB 续传...")

            mode = "ab" if existing > 0 else "wb"
            try:
                async with aiohttp.ClientSession(
                    connector=aiohttp.TCPConnector()
                ) as session:
                    async with session.get(
                        self.url, headers=req_headers, timeout=timeout, verify_ssl=False
                    ) as resp:
                        if resp.status not in (200, 206):
                            print(f"❌ 请求失败，状态码: {resp.status}")
                            progress_bar.close()
                            return False
                        with open(self.save_path, mode) as f:
                            async for chunk in resp.content.iter_chunked(CHUNK_SIZE):
                                f.write(chunk)
                                n = len(chunk)
                                self._bytes_done += n
                                progress_bar.update(n)
                                if self.progress_callback and self.file_size > 0:
                                    pct = min(99, int(self._bytes_done * 100 / self.file_size))
                                    self.progress_callback(self._bytes_done, self.file_size, pct)
                break  # 正常读完，退出重试循环
            except Exception as e:
                if attempt < MAX_RETRIES:
                    print(f"⚠️  连接中断（{e}），准备续传...")
                    await asyncio.sleep(1)
                else:
                    print(f"❌ 下载失败，已重试 {MAX_RETRIES} 次: {e}")
                    progress_bar.close()
                    return False

        progress_bar.close()

        # 4. 验证文件完整性
        actual = os.path.getsize(self.save_path) if os.path.exists(self.save_path) else 0
        if actual == self.file_size:
            print(f"✅ {os.path.basename(self.save_path)} 下载完成（完整）\n")
            return True
        else:
            print(f"❌ {os.path.basename(self.save_path)} 不完整（{actual}/{self.file_size} 字节），已删除\n")
            if os.path.exists(self.save_path):
                os.remove(self.save_path)
            return False


def _ep1_to_template(ep1_url):
    """把第一集 URL 转为带 {:02d} 占位符的模板"""
    filename = os.path.basename(urlparse(ep1_url).path)
    match = re.search(r"(\d{2})\.[^.]+$", filename)
    if not match:
        return None
    num_part = match.group(1)
    base_filename = filename.replace(num_part, "{:02d}")
    return ep1_url.replace(filename, base_filename)


def download_mp4_series(template_urls, start_episode, end_episode, anime_title):
    """
    批量下载：支持多源自动回退 + 自定义起始/结束集数。

    template_urls: list[str]，每个元素是带 {:02d} 占位符的模板，按优先级排列。
                  下载某集时按序尝试，成功即停止；全部失败则跳过该集。
    start_episode: 起始集数（含）
    end_episode:   结束集数（含）
    """
    save_dir = os.path.join(os.getcwd(), anime_title)
    os.makedirs(save_dir, exist_ok=True)
    print(f"📂 保存目录: {save_dir}")
    print(f"📡 可用源数: {len(template_urls)}")
    print(f"🔄 下载范围: 第{start_episode:02d}集 ~ 第{end_episode:02d}集\n")

    for ep in range(start_episode, end_episode + 1):
        ep_str = f"{ep:02d}"
        save_path = os.path.join(save_dir, f"{anime_title} - {ep_str}.mp4")

        if os.path.exists(save_path):
            print(f"⏭️  第{ep_str}集已存在，跳过\n")
            continue

        success = False
        for src_idx, template in enumerate(template_urls, 1):
            if not template:
                continue
            url = template.format(ep)
            print(f"🔽 第{ep_str}集 [源{src_idx}]: {url}")
            downloader = MultiThreadDownloader(url, save_path, threads=THREADS_PER_EP)
            try:
                ok = asyncio.run(downloader.download())
            except KeyboardInterrupt:
                print(f"\n⚠️  用户中断下载，清理临时文件...")
                if os.path.exists(save_path):
                    os.remove(save_path)
                return
            except Exception as e:
                print(f"❌ 第{ep_str}集 [源{src_idx}] 下载异常: {e}")
                if os.path.exists(save_path):
                    os.remove(save_path)
                ok = False

            if ok:
                success = True
                break
            print(f"⚠️  源{src_idx}失效，尝试下一个源...\n")

        if not success:
            print(f"❌ 第{ep_str}集所有源均失效，跳过\n")

    print("🎉 指定范围的集数下载完成！")


def download_single_ep(template_urls, ep, anime_title, progress_callback=None):
    """下载单集（供 xifan_api.py 的 download-single 命令调用）。
    返回 True 表示成功，False 表示失败。"""
    save_dir = os.path.join(os.getcwd(), anime_title)
    os.makedirs(save_dir, exist_ok=True)
    ep_str = f"{ep:02d}"
    save_path = os.path.join(save_dir, f"{anime_title} - {ep_str}.mp4")

    for template in template_urls:
        if not template:
            continue
        url = template.format(ep)
        downloader = MultiThreadDownloader(
            url, save_path, threads=THREADS_PER_EP, progress_callback=progress_callback
        )
        try:
            ok = asyncio.run(downloader.download())
        except Exception:
            if os.path.exists(save_path):
                os.remove(save_path)
            ok = False
        if ok:
            return True
    return False


if __name__ == "__main__":
    try:
        ep1_url = input("请输入第1集MP4链接: ").strip()
        template = _ep1_to_template(ep1_url)
        if not template:
            print("❌ 链接格式错误（需包含两位数字集数，如01.mp4）")
        else:
            while True:
                start_ep_input = input("请输入起始集数（比如5，表示从第5集开始）: ").strip()
                if start_ep_input.isdigit() and int(start_ep_input) >= 1:
                    start_episode = int(start_ep_input)
                    break
                else:
                    print("❌ 起始集数必须是大于等于1的数字！")

            while True:
                end_ep_input = input("请输入结束集数（总集数，比如12）: ").strip()
                if end_ep_input.isdigit():
                    end_episode = int(end_ep_input)
                    if end_episode >= start_episode:
                        break
                    else:
                        print(f"❌ 结束集数必须大于等于起始集数（{start_episode}）！")
                else:
                    print("❌ 结束集数必须是数字！")

            anime_title = input("请输入动漫标题: ").strip()
            download_mp4_series([template], start_episode, end_episode, anime_title)
    except KeyboardInterrupt:
        print("\n⚠️  程序已被用户中断")
    except Exception as e:
        print(f"❌ 程序异常: {e}")

import requests
import os
import sys
import subprocess
import time
from urllib.parse import quote
from bs4 import BeautifulSoup

# 验证码图片 URL
VERIFY_IMG_URL = "https://dm.xifanacg.com/verify/index.html"
# 验证码提交校验的 AJAX 接口
VERIFY_CHECK_URL = "https://dm.xifanacg.com/index.php/ajax/verify_check"

CACHE_DIR = "html_cache"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://dm.xifanacg.com/",
}


BASE_SEARCH_URL = "https://dm.xifanacg.com/search.html"


CAPTCHA_PATH = "captcha.jpg"


def open_captcha():
    """用系统默认查看器打开验证码图片"""
    if sys.platform == "win32":
        os.startfile(CAPTCHA_PATH)
    else:
        subprocess.Popen(["open", CAPTCHA_PATH])
        time.sleep(0.5)  # 等图片窗口弹出


def close_captcha():
    """关闭验证码图片窗口"""
    if sys.platform == "darwin":
        subprocess.run(
            ["osascript", "-e", 'tell application "Preview" to close every window'],
            capture_output=True,
        )
    elif sys.platform == "win32":
        # 尝试关闭 Windows 常见图片查看器
        for proc in ["Microsoft.Photos.exe", "mspaint.exe", "dllhost.exe"]:
            subprocess.run(["taskkill", "/IM", proc, "/F"], capture_output=True)


def build_url(keyword):
    return f"{BASE_SEARCH_URL}?wd={quote(keyword)}"


def fetch_page(session, url):
    """带验证码处理的页面抓取，返回 HTML 文本"""
    print("正在请求目标页面探测状态...")
    resp = session.get(url, timeout=15)
    resp.encoding = "utf-8"

    if 'name="verify"' in resp.text or "ds-verify-img" in resp.text:
        print("\n【拦截】服务器要求输入验证码！")
        while True:
            print("-" * 30)
            print("正在获取验证码图片...")
            img_resp = session.get(VERIFY_IMG_URL, timeout=15)
            with open(CAPTCHA_PATH, "wb") as f:
                f.write(img_resp.content)
            open_captcha()

            user_input = input(
                "请输入验证码 (看不清直接按【回车键】刷新): "
            ).strip()
            if not user_input:
                close_captcha()
                print("准备获取新的验证码图片...\n")
                continue

            print(f"正在提交验证码: [{user_input}]...")
            ajax_headers = {
                **HEADERS,
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/javascript, */*; q=0.01",
            }
            check_resp = session.get(
                VERIFY_CHECK_URL,
                params={"type": "search", "verify": user_input},
                headers=ajax_headers,
                timeout=15,
            )
            result = check_resp.text
            print(f"服务器返回: {result}")
            if (
                '"code":1' in result
                or "成功" in result
                or '"msg":"ok"' in result.lower()
            ):
                close_captcha()
                print(">>> 验证成功！会话已解锁。 <<<\n")
                break
            else:
                print(">>> 验证失败，请重试！ <<<\n")
    else:
        print("未检测到验证码，直接放行。")

    print("正在获取目标页面数据...")
    final_resp = session.get(url, timeout=15)
    final_resp.encoding = "utf-8"
    return final_resp.text


def fetch_and_save():
    os.makedirs(CACHE_DIR, exist_ok=True)

    if len(sys.argv) >= 2:
        keyword = sys.argv[1]
        update = sys.argv[2].lower() == "y" if len(sys.argv) >= 3 else False
    else:
        keyword = input("请输入搜索关键词: ").strip()
        update = False

    if not keyword:
        print("关键词不能为空")
        return

    cache_path = os.path.join(CACHE_DIR, f"{keyword}.html")

    # 命中缓存时询问是否更新
    if os.path.exists(cache_path):
        if not update:
            answer = input(f"已有「{keyword}」的缓存，是否更新？(y/N): ").strip().lower()
            update = answer == "y"
        if not update:
            print(f"使用缓存: {cache_path}")
            return

    url = build_url(keyword)
    session = requests.Session()
    session.headers.update(HEADERS)

    html = fetch_page(session, url)

    with open(cache_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"已保存到: {cache_path}（共 {len(html)} 字符）")

    # 预检：统计搜索结果数量，关键词输错时立刻警告
    soup = BeautifulSoup(html, "html.parser")
    count = len(soup.select("div.row.mask2 div.vod-detail.search-list"))
    if count == 0:
        print(f"\n⚠️  警告：搜索「{keyword}」没有找到任何结果，请确认关键词后重试")
    else:
        print(f"预检通过：共找到 {count} 条结果")

    if os.path.exists(CAPTCHA_PATH):
        os.remove(CAPTCHA_PATH)


if __name__ == "__main__":
    fetch_and_save()

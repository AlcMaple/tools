# 测试指南

## 环境准备

```bash
pip install requests beautifulsoup4 aiohttp tqdm
```

---

## 步骤 1：测试 fetch_page.py（搜索并缓存页面）

```bash
python fetch_page.py
```

输入关键词 `夜樱家的大作战`，选择是否更新缓存。

**期望结果：**
- 若无缓存：成功抓取并打印 `已保存到: html_cache/夜樱家的大作战.html`
- 若有缓存：询问是否更新，选 n 则打印 `使用缓存: html_cache/夜樱家的大作战.html`

---

## 步骤 2：诊断 parse_anime_list.py（这是上次失败的地方）

```bash
python parse_anime_list.py
```

输入关键词 `夜樱家的大作战`。

**期望结果：** 打印找到的番剧列表
**如果出现 `解析结果为空`：** 说明页面 HTML 结构已变化，执行下面的诊断命令：

```python
# 在 Python 交互环境中运行
from bs4 import BeautifulSoup

with open("html_cache/夜樱家的大作战.html", "r", encoding="utf-8") as f:
    soup = BeautifulSoup(f, "html.parser")

# 检查容器是否存在
container = soup.find("div", class_="row mask2")
print("容器:", container is not None)

# 如果容器不存在，找一下实际的结构
if not container:
    # 找所有可能包含结果的 div
    for div in soup.find_all("div", class_=True)[:20]:
        print(div.get("class"))
else:
    # 检查子元素
    items = container.select("div.vod-detail.search-list")
    print("找到条目数:", len(items))
    if items:
        print("第一条 class:", items[0].get("class"))
    else:
        # 打印容器下第一层子元素的 class
        for child in list(container.children)[:5]:
            if hasattr(child, "get"):
                print("子元素 class:", child.get("class"))
```

根据输出的实际 class 名，更新 `parse_anime_list.py` 第 20、26 行的选择器。

---

## 步骤 3：测试完整串联流程

步骤 2 成功后，选择一部番剧，确认：

- 打印 `已保存到: html_cache/<标题>_watch.html`
- 当前目录出现 `.last_watch` 文件（内容为上述路径）

```bash
cat .last_watch   # macOS/Linux
type .last_watch  # Windows
```

然后立即运行步骤 3：

```bash
python parse_watch_page.py
```

**期望结果：** 打印 `自动使用播放页: html_cache/xxx_watch.html`，然后列出各视频源和模板 URL。
**如果仍然弹出文件列表手动选择：** 说明 `.last_watch` 路径有误或文件未生成。

---

## 步骤 4：验证 bat 串联（Windows 专用）

双击 `tools.bat`，选择 `1`，观察：

1. 只问一次名称和是否更新缓存
2. 步骤 1 结束后自动把名称传给步骤 2（不再手动输入关键词）
3. 步骤 2 选完番剧后，步骤 3 自动使用对应播放页

---

## 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| `解析结果为空` | 页面 CSS class 变了 | 用步骤 2 的诊断脚本确认实际 class |
| `文件不存在` | 步骤 1 未成功保存 | 重新运行 fetch_page.py 并确认 html_cache/ 下有文件 |
| 步骤 3 弹出文件列表 | `.last_watch` 未生成 | 确认步骤 2 有选择番剧并成功抓取播放页 |
| 下载文件小于 10MB | 防盗链/低清源 | 程序会自动跳过，尝试其他源 |

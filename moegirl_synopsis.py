#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
moegirl_synopsis.py
-------------------
从萌娘百科（https://mzh.moegirl.org.cn）抓取动漫条目的剧情简介。

关键点：
1. 萌娘百科的 "Moe Skin" 把真正的 wiki 内容放在
   `<template id="MOE_SKIN_TEMPLATE_BODYCONTENT">…</template>` 里，
   由客户端 Vue 应用渲染到 `<div id="app">`。抓页面源码时必须先把这个
   template 里的 HTML 取出来，再用它作为解析根。
2. 其 MediaWiki API（/api.php）默认会返回 "Unauthorized API call"，
   因此不走 API，直接抓页面 HTML 解析。
3. 页面小节标题的结构是：
       <div class="mw-heading mw-heading3">
           <h3 id="剧情简介"><span>…anchor…</span>剧情简介</h3>
       </div>
   heading 的 `id` 直接写中文（或 MediaWiki 百分号转义形式），
   外面还套了一层 `<div class="mw-heading">`，同级/越级判断时要连带
   这层 wrapper 一起比较。

用法：
    python moegirl_synopsis.py                    # 跑内置 3 个测试条目
    python moegirl_synopsis.py 杀手青春 葬送的芙莉莲 ...
"""

from __future__ import annotations

import re
import sys
import time
from typing import Optional

import requests
from bs4 import BeautifulSoup, Tag

BASE_URL = "https://mzh.moegirl.org.cn/"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# 按优先级排列的 "简介类" 小节标题名
CANDIDATE_SECTIONS = [
    "剧情简介",
    "故事简介",
    "剧情概要",
    "故事概要",
    "故事梗概",
    "内容简介",
    "作品简介",
    "剧情介绍",
    "简介",
]

TEMPLATE_ID = "MOE_SKIN_TEMPLATE_BODYCONTENT"

# 清洗时剔除的杂项
DROP_SELECTORS = [
    "table", "style", "script",
    ".reference", ".mw-editsection",
    ".navbox", ".infobox", ".toc",
    ".thumb", ".gallery", ".hatnote",
]


class MoegirlClient:
    def __init__(self, base_url: str = BASE_URL, timeout: int = 30) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9",
        })

    # ------------------------------------------------------------------
    # 入口
    # ------------------------------------------------------------------
    def get_synopsis(self, title: str) -> Optional[str]:
        html = self._fetch_page(title)
        if html is None:
            return None

        body_root = self._extract_template_root(html)
        if body_root is None:
            return None

        synopsis = self._extract_from_section(body_root)
        if synopsis:
            return synopsis

        # 兜底：抓正文开头几段
        return self._extract_lead(body_root)

    # ------------------------------------------------------------------
    # 网络
    # ------------------------------------------------------------------
    def _fetch_page(self, title: str) -> Optional[str]:
        url = self.base_url + requests.utils.quote(title, safe="")
        resp = self.session.get(url, timeout=self.timeout)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.content.decode("utf-8", errors="replace")

    # ------------------------------------------------------------------
    # HTML 解析
    # ------------------------------------------------------------------
    @staticmethod
    def _extract_template_root(html: str) -> Optional[Tag]:
        """从页面 HTML 里提取 MOE_SKIN template 内的 .mw-parser-output 根节点。

        做法：
        1) 用正则先抓出 <template id="MOE_SKIN_TEMPLATE_BODYCONTENT">…</template>
           里的 HTML 字符串（避免不同 parser 对 template 的处理差异）。
        2) 用 BeautifulSoup 再解析这段字符串，找 .mw-parser-output。
        3) 如果页面没有这个 template（老版皮肤或其他站），回退到整页 parse。
        """
        m = re.search(
            r'<template[^>]*id=["\']' + re.escape(TEMPLATE_ID) + r'["\'][^>]*>'
            r'(.*?)</template>',
            html, flags=re.DOTALL,
        )
        if m:
            inner = m.group(1)
            inner_soup = BeautifulSoup(inner, "html.parser")
            root = inner_soup.find(class_="mw-parser-output")
            return root or inner_soup

        # 回退：整页解析
        soup = BeautifulSoup(html, "html.parser")
        return soup.find(class_="mw-parser-output")

    def _extract_from_section(self, root: Tag) -> Optional[str]:
        heading = self._find_synopsis_heading(root)
        if heading is None:
            return None

        start_node = heading.find_parent("div", class_="mw-heading") or heading
        start_level = int(heading.name[1])

        parts: list[str] = []
        for sib in start_node.find_next_siblings():
            if self._is_heading_at_or_above(sib, start_level):
                break
            if sib.name in {"p", "ul", "ol", "blockquote"}:
                txt = sib.get_text("\n", strip=True)
                if txt:
                    parts.append(txt)
            elif sib.name == "div":
                # 某些 wiki 里用 <div> 排版的整段说明也应该收
                if any(cls in (sib.get("class") or [])
                       for cls in ("poem", "quote", "mw-collapsible")):
                    txt = sib.get_text("\n", strip=True)
                    if txt:
                        parts.append(txt)

        return self._tidy("\n\n".join(parts)) or None

    def _extract_lead(self, root: Tag) -> Optional[str]:
        self._strip_noise(root)
        paragraphs: list[str] = []
        for p in root.find_all("p", recursive=True):
            txt = p.get_text(" ", strip=True)
            if len(txt) < 10:
                continue
            paragraphs.append(txt)
            if len(paragraphs) >= 3:
                break
        return self._tidy("\n\n".join(paragraphs)) or None

    # ------------------------------------------------------------------
    # 工具
    # ------------------------------------------------------------------
    @staticmethod
    def _find_synopsis_heading(root: Tag) -> Optional[Tag]:
        headings = root.find_all(re.compile(r"^h[1-6]$"))
        # 1) 按候选关键词精确匹配
        for keyword in CANDIDATE_SECTIONS:
            for h in headings:
                if h.get("id") == keyword or h.get_text(strip=True) == keyword:
                    return h
        # 2) 模糊匹配
        for h in headings:
            text = h.get_text(strip=True)
            if re.search(r"(简介|概要|梗概)", text):
                return h
        return None

    @staticmethod
    def _is_heading_at_or_above(tag: Tag, level: int) -> bool:
        """判断 tag 是否是一个 <= level 的标题（或裹着 heading 的 mw-heading div）。"""
        if not isinstance(tag, Tag):
            return False
        if re.fullmatch(r"h[1-6]", tag.name or ""):
            return int(tag.name[1]) <= level
        if tag.name == "div" and "mw-heading" in (tag.get("class") or []):
            inner = tag.find(re.compile(r"^h[1-6]$"))
            if inner:
                return int(inner.name[1]) <= level
        return False

    @staticmethod
    def _strip_noise(root: Tag) -> None:
        for sel in DROP_SELECTORS:
            for tag in root.select(sel):
                tag.decompose()

    @staticmethod
    def _tidy(text: str) -> str:
        text = re.sub(r"\[\s*\d+\s*\]", "", text)          # 引用脚注 [1]
        text = re.sub(r"\[\s*编辑\s*\]", "", text)          # 编辑按钮
        text = re.sub(r"[ \t\u3000]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------
def main(argv: list[str]) -> int:
    titles = argv[1:] or ["杀手青春", "冰之城墙", "ATRI -My Dear Moments-"]
    client = MoegirlClient()

    hit = 0
    for idx, title in enumerate(titles, 1):
        print("=" * 72)
        print(f"[{idx}/{len(titles)}] 《{title}》")
        print("=" * 72)

        try:
            synopsis = client.get_synopsis(title)
        except requests.RequestException as exc:
            print(f"[网络错误] {exc}")
            synopsis = None

        if synopsis:
            hit += 1
            print(synopsis)
        else:
            print("[未找到简介]")

        print()
        time.sleep(0.4)          # 温和限速

    print(f"共 {len(titles)} 个条目，成功抓到简介 {hit} 个。")
    return 0 if hit == len(titles) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
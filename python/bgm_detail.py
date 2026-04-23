"""
bgm_detail.py — 通过 bgm.tv 公开 API (v0) 获取单部动漫详情，无需登录。

用法:
    python bgm_detail.py <subject_id 或 bgm.tv 链接>
    python bgm_detail.py 404887
    python bgm_detail.py https://bgm.tv/subject/404887

API 文档: https://bangumi.github.io/api/
"""

import json
import re
import sys

import requests

# ===================== 配置 =====================
BASE_API = "https://api.bgm.tv/v0"
HEADERS = {
    # bgm.tv API 要求标注客户端信息，否则可能被限速
    "User-Agent": "tools/1.0 (github.com/user/tools)",
    "Accept": "application/json",
}
TIMEOUT = 10

# 从 /persons 端点筛选的 Staff 职位关键词（relation 字段包含即匹配）
STAFF_ROLES_FROM_PERSONS = ["导演", "监督", "音乐", "系列构成", "脚本", "人物原案", "总作画监督"]
# 直接从 infobox 提取的关键字段，作为补充（优先级更高）
INFOBOX_STAFF_KEYS = ["导演", "监督", "音乐", "系列构成", "人物设定", "原作"]
# ================================================


def extract_subject_id(raw: str) -> int | None:
    """从 URL 或纯数字字符串中提取 subject ID。"""
    m = re.search(r"/subject/(\d+)", raw)
    if m:
        return int(m.group(1))
    if raw.strip().isdigit():
        return int(raw.strip())
    return None


def _get(path: str) -> dict | list:
    url = f"{BASE_API}{path}"
    r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def _parse_infobox(infobox: list) -> dict:
    """
    将 API 返回的 infobox 数组转为 {key: value_str} 字典。
    value 可能是字符串，也可能是 [{v: ..., k: ...}] 形式的列表。
    """
    result = {}
    for item in infobox:
        key = item.get("key", "")
        value = item.get("value", "")
        if isinstance(value, list):
            value = "、".join(v.get("v", "") for v in value if v.get("v"))
        result[key] = str(value).strip()
    return result


def _pick_staff_from_persons(persons: list) -> list:
    """
    从 /persons 端点结果中筛选关键 Staff。
    返回 [{"role": ..., "name": ..., "name_cn": ...}, ...]
    """
    picked = []
    seen_roles = set()
    for p in persons:
        relation = p.get("relation", "")
        if not any(role in relation for role in STAFF_ROLES_FROM_PERSONS):
            continue
        if relation in seen_roles:
            continue
        seen_roles.add(relation)
        picked.append(
            {
                "role": relation,
                "name": p.get("name", ""),
                "name_cn": p.get("name_cn", "") or p.get("name", ""),
            }
        )
        if len(picked) >= 6:
            break
    return picked


def _pick_staff_from_infobox(infobox: dict) -> list:
    """
    从 infobox 中提取关键 Staff 信息作为补充。
    infobox value 可能是逗号/顿号分隔的多人，只取第一位。
    """
    result = []
    for key in INFOBOX_STAFF_KEYS:
        value = infobox.get(key, "").strip()
        if not value:
            continue
        # 取第一位（部分字段多人用「、」或「,」分隔）
        first = re.split(r"[,，、]", value)[0].strip()
        if first:
            result.append({"role": key, "name": first, "name_cn": first})
    return result


def _merge_staff(from_infobox: list, from_persons: list) -> list:
    """
    合并两个来源的 Staff：infobox 优先，persons 补充不重复的职位。
    """
    merged = list(from_infobox)
    seen_roles = {s["role"] for s in merged}
    for s in from_persons:
        # persons 的 role 可能是「总作画监督」，infobox 里没有，直接追加
        if not any(existing in s["role"] for existing in seen_roles):
            merged.append(s)
            seen_roles.add(s["role"])
        if len(merged) >= 6:
            break
    return merged


def get_anime_detail(subject_id: int) -> dict:
    """
    主函数：拉取并整合动漫详情。
    返回结构见下方 return 语句注释。
    """
    subject = _get(f"/subjects/{subject_id}")

    infobox = _parse_infobox(subject.get("infobox", []))
    rating = subject.get("rating", {})
    images = subject.get("images", {})

    # 封面图：优先 large，依次降级
    cover = (
        images.get("large")
        or images.get("common")
        or images.get("medium")
        or ""
    )

    # 标签：取前 8 个高频 tag
    tags = [t["name"] for t in subject.get("tags", [])[:8]]

    # Studio：优先从 infobox 取，再从 /persons type=3 (公司) 里找动画制作公司
    studio = (
        infobox.get("动画制作")
        or infobox.get("制作公司")
        or ""
    )

    # 放送状态：bgm.tv 没有直接的状态字段，用 date 推断
    air_date_str = subject.get("date", "") or infobox.get("放送开始", "")

    # Staff：合并 infobox + /persons 端点两路来源
    staff_infobox = _pick_staff_from_infobox(infobox)
    try:
        persons = _get(f"/subjects/{subject_id}/persons")
        # 顺便从公司类型（type=3）里补全 Studio
        if not studio:
            for p in persons:
                if p.get("type") == 3 and "动画制作" in p.get("relation", ""):
                    studio = p.get("name_cn") or p.get("name", "")
                    break
        staff_persons = _pick_staff_from_persons(persons)
    except Exception:
        staff_persons = []
    staff = _merge_staff(staff_infobox, staff_persons)

    return {
        # 基础信息
        "id": subject.get("id"),
        "title": subject.get("name", ""),          # 原文标题
        "title_cn": subject.get("name_cn", ""),    # 中文标题
        "summary": subject.get("summary", ""),
        "cover": cover,
        "link": f"https://bgm.tv/subject/{subject_id}",
        # 评分
        "score": rating.get("score", 0),           # float, e.g. 8.2
        "rank": rating.get("rank", 0),
        "votes": rating.get("total", 0),
        # 播出信息
        "date": air_date_str,                       # e.g. "2024-10-05"
        "platform": subject.get("platform", ""),    # e.g. "TV"
        "episodes": subject.get("eps", 0),          # 总集数
        # 分类
        "tags": tags,
        "studio": studio,
        # Staff 列表
        "staff": staff,
        # 完整 infobox（供调试或扩展）
        "infobox": infobox,
    }


# ===================== CLI 入口 =====================
if __name__ == "__main__":
    raw = sys.argv[1] if len(sys.argv) >= 2 else input("输入 subject ID 或 bgm.tv 链接：").strip()

    sid = extract_subject_id(raw)
    if not sid:
        print("错误：无法解析 subject ID", file=sys.stderr)
        sys.exit(1)

    try:
        detail = get_anime_detail(sid)
    except requests.HTTPError as e:
        print(f"HTTP 错误：{e}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(detail, ensure_ascii=False, indent=2))

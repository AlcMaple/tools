#!/usr/bin/env bash
#
# filter-portrait-2x3.sh —— 递归扫描一个文件夹下所有图片，挑出"接近 2:3 竖图"
# 的复制到目标文件夹。用来从一堆图里快速捞出适合当封面 / 海报的竖版图
# （番剧封面、漫画单行本封面都是 2:3）。
#
# 依赖：macOS 自带的 `sips`（读图片像素尺寸，零额外安装）。
#
# 用法：
#   ./filter-portrait-2x3.sh <源文件夹> <目标文件夹> [容差百分比]
#
#   <源文件夹>     递归扫描的根目录（含子文件夹）
#   <目标文件夹>   匹配的图片复制到这里（不存在会自动创建）
#   [容差百分比]   可选，默认 8。2:3 = 0.6667，±8% → 比例落在 0.613~0.72 之间
#                  都算。放宽到 15 能多捞些"差不多竖版"的图，收紧到 3 只要正版
#
# 输出：复制时给文件名加 4 位序号前缀（0001_原名.jpg），避免不同子文件夹里
#       的同名文件互相覆盖。结尾打印扫描总数 / 匹配数。
#
# 例：
#   ./filter-portrait-2x3.sh ~/Downloads/图片 ~/Downloads/竖图 8
#
set -euo pipefail

SRC="${1:-}"
DST="${2:-}"
TOL_PCT="${3:-8}"

if [ -z "$SRC" ] || [ -z "$DST" ]; then
  echo "用法: $0 <源文件夹> <目标文件夹> [容差百分比，默认 8]" >&2
  exit 1
fi
if [ ! -d "$SRC" ]; then
  echo "源文件夹不存在: $SRC" >&2
  exit 1
fi

# 2:3 = 0.66667。容差把上下界算出来：lo = 0.66667*(1-tol)，hi = 0.66667*(1+tol)。
RATIO=$(awk 'BEGIN{print 2/3}')
LO=$(awk -v r="$RATIO" -v t="$TOL_PCT" 'BEGIN{print r*(1-t/100)}')
HI=$(awk -v r="$RATIO" -v t="$TOL_PCT" 'BEGIN{print r*(1+t/100)}')

mkdir -p "$DST"
echo "源: $SRC"
echo "目标: $DST"
echo "目标比例 2:3 (${RATIO})，容差 ±${TOL_PCT}% → 接受比例区间 [${LO}, ${HI}]"
echo "扫描中…"

count=0
matched=0
while IFS= read -r -d '' f; do
  count=$((count + 1))
  dims=$(sips -g pixelWidth -g pixelHeight "$f" 2>/dev/null || true)
  w=$(echo "$dims" | awk '/pixelWidth/{print $2}')
  h=$(echo "$dims" | awk '/pixelHeight/{print $2}')
  # 读不出尺寸 / 高度为 0 的跳过
  { [ -z "$w" ] || [ -z "$h" ] || [ "$h" -eq 0 ]; } 2>/dev/null && continue
  keep=$(awk -v w="$w" -v h="$h" -v lo="$LO" -v hi="$HI" \
    'BEGIN{r=w/h; print (r>=lo && r<=hi)?"1":"0"}')
  if [ "$keep" = "1" ]; then
    matched=$((matched + 1))
    base=$(basename "$f")
    cp "$f" "$DST/$(printf '%04d' "$matched")_${base}"
  fi
done < <(find "$SRC" -type f \( \
  -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \
  -o -iname '*.gif' -o -iname '*.bmp' -o -iname '*.heic' -o -iname '*.tiff' \
  \) -print0)

echo "----"
echo "扫描总数: $count"
echo "符合 2:3 (±${TOL_PCT}%): $matched"
echo "已复制到: $DST"

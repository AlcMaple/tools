#!/bin/bash
# 服务器每天 04:00 的备份，以 root 跑（备份目录保持 root-only，应用被攻破也删不掉备份）。
# 线上位置：/usr/local/bin/mapletools-backup.sh；它调用同目录的 mapletools-backup-collect.sh
# （就是仓库里的 web/scripts/backup-collect.sh）。两个文件都要**复制到 root 名下**再用，
# 不要直接从 /opt/mapletools 里执行：那个目录归 mapletools 用户，应用被攻破时能改脚本，再借 root 执行。
#
# 备什么由 backup-collect.sh 决定：数据目录默认全备，新增的数据不用在这里补。
# 恢复：解开 tar.gz，见 docs/web/唐人云部署.md「备份」。
set -euo pipefail

DIR=/opt/mapletools-backup
COLLECT=/usr/local/bin/mapletools-backup-collect.sh
LOG=/var/log/mapletools-backup.log
SRC=/opt/mapletools-data/web.db
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/mapletools-$STAMP.tar.gz"

exec >> "$LOG" 2>&1
echo "== $(date -Is) 开始"

# 无论成败都执行：root 打开库时若 WAL/SHM 不存在会新建成 root 所有，应用（mapletools）就再也写不了自己的库，
# 会在某个凌晨 4 点之后毫无征兆地 500。
finish() {
  code=$?
  rm -f "$OUT.part"
  chown mapletools:mapletools "$SRC" "${SRC}-wal" "${SRC}-shm" 2>/dev/null || true
  if [ "$code" -ne 0 ]; then echo "✗ 失败（退出码 $code）：今天没有产出新备份"; fi
  exit "$code"
}
trap finish EXIT

"$COLLECT" > "$OUT.part"
gzip -t "$OUT.part"
mv "$OUT.part" "$OUT"

# 保留 14 天。每份都是完整快照，删老的只是丢掉回滚到当时的能力，不丢当前数据。
# 后面几个旧文件名是改成默认全备之前的格式，让它们自然过期，过期后可以删掉这几行。
find "$DIR" -maxdepth 1 \( -name 'mapletools-*.tar.gz' -o -name 'web-*.db.gz' -o -name 'covers-*.tar.gz' \
  -o -name 'calendar-seasons-*.tar.gz' -o -name 'order-judge-*.tar.gz' -o -name 'catalog-covers-*.tar.gz' \) -mtime +14 -delete

# 本机整机备份脚本读这个文件判断每日备份是否还活着
date +%s > "$DIR/LAST_OK.tmp" && mv "$DIR/LAST_OK.tmp" "$DIR/LAST_OK"
echo "✓ $OUT（$(du -h "$OUT" | cut -f1)）"

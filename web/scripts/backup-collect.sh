#!/usr/bin/env bash
# 在服务器上运行：把数据目录整理成一份快照，打成 tar 流写到 stdout（进度和警告走 stderr）。
# 由 web/scripts/backup-server.sh 通过 ssh 喂进来；不要手工改服务器上的拷贝，改仓库里这份。
#
# 分类规则：**默认全备**。数据目录顶层的每一项都会被扫到，没出现在下面「已知」表里的新东西
# 不会被漏掉，而是自动纳入快照，并在报告里标成「未分类」，提醒人补一条说明。
#   db        web.db：用 sqlite .backup 取一致性快照（开着 WAL，cp 会拷到撕裂的文件）
#   sqlite    其他顶层 SQLite 文件（按文件头识别，不靠扩展名）：同样 .backup
#   live      进快照，每次都重新拿：用户上传文件、小型状态文件、密钥配置
#   static    不进快照，由本机增量补：写入后不再改的大目录，或周更的单文件
#   oversize  未分类且超过 SNAP_MAX_KB 的条目：不进快照（防止快照膨胀），由本机按更新增量补，不会丢
#   skip      故意不备：可再生的缓存、热传临时文件、SQLite 的 wal/shm（库本身已由 .backup 覆盖）
# live 目录里如果混着 SQLite 文件（*.db / *.sqlite*），拷贝后会再用 .backup 覆盖一遍，避免撕裂。
set -euo pipefail
umask 077

D="${DATA_DIR:-/opt/mapletools-data}"
SNAP_MAX_KB="${SNAP_MAX_KB:-204800}"   # 未分类条目超过 200MB 就不塞进快照
S="$(mktemp -d /tmp/mt-snap.XXXXXX)"
trap 'rm -rf "$S"' EXIT
mkdir -p "$S/data" "$S/system"

# ── 已知条目：新增数据落盘位置时在这里补一行，没补也不会漏（见上方「默认全备」），只是报告里会标未分类 ──
KNOWN_LIVE=" covers catalog-covers order-judge calendar-seasons holidays calendar-cache.json line-speed.json ecosystem.config.cjs .env.ai .env.sentry "
KNOWN_STATIC=" bgm_index.db bgm-cover-cache "   # bgm_index.db 每周四才变；bgm-cover-cache 文件名是内容哈希、写入后不再改
is_skip() {   # 可再生 / 临时：hls、prefetch 是转码和预抓缓存，丢了会自己重新生成
  case "$1" in
    # umami-tracking-backups：2026-08-26 接统计脚本时留下的旧 dist 副本，一次性、可由 git 重建
    web.db-wal|web.db-shm|hls|prefetch|hotfix-*|*.bak|*.bak-*|*.part|*.tmp|*.lock|MAINTENANCE|umami-tracking-backups) return 0 ;;
  esac
  return 1
}
is_sqlite() { [ -f "$1" ] && [ "$(head -c 15 "$1" 2>/dev/null | tr -d '\000')" = 'SQLite format 3' ]; }

INV="$S/inventory.tsv"; : > "$INV"      # 名称 类别 大小KB 文件数 最近写入(epoch) 是否已知
OVERSIZE="$S/oversize.txt"; : > "$OVERSIZE"
UNCLASSIFIED=""

while IFS= read -r -d '' n; do
  p="$D/$n"
  kb="$(du -sk "$p" | cut -f1)"
  files="$(find "$p" -type f | wc -l | tr -d ' ')"
  newest="$(find "$p" -type f -printf '%T@\n' | sort -n | tail -1 | cut -d. -f1 || true)"
  known=yes
  if [ "$n" = web.db ]; then cls=db
  elif is_skip "$n"; then cls=skip
  elif [[ "$KNOWN_STATIC" == *" $n "* ]]; then cls=static
  elif [[ "$KNOWN_LIVE" == *" $n "* ]]; then cls=live
  elif is_sqlite "$p"; then cls=sqlite; known=no
  elif [ "$kb" -gt "$SNAP_MAX_KB" ]; then cls=oversize; known=no
  else cls=live; known=no
  fi
  [ "$known" = no ] && UNCLASSIFIED="$UNCLASSIFIED $n"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$cls" "$kb" "$files" "${newest:-0}" "$known" >> "$INV"

  case "$cls" in
    db|sqlite)
      sqlite3 "$p" ".backup '$S/data/$n'"
      [ "$(sqlite3 "$S/data/$n" 'PRAGMA integrity_check')" = ok ] || { echo "$n 完整性检查失败" >&2; exit 1; } ;;
    live)
      cp -a "$p" "$S/data/"
      # live 目录里混着的 SQLite 文件：cp 可能拷到撕裂的文件，用 .backup 的结果覆盖
      if [ -d "$p" ]; then
        while IFS= read -r -d '' f; do
          if is_sqlite "$f"; then
            rel="${f#"$D"/}"; rm -f "$S/data/$rel"; sqlite3 "$f" ".backup '$S/data/$rel'"
            echo "（$rel 是目录里的 SQLite 文件，已改用 .backup）" >&2
          fi
        done < <(find "$p" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0)
      fi ;;
    oversize) echo "$n" >> "$OVERSIZE" ;;
  esac
done < <(find "$D" -mindepth 1 -maxdepth 1 -printf '%f\0' | sort -z)

# 表结构清单：每个 SQLite 文件的表、行数、列名；本机拿它和上一份快照对比，自动发现新表和新列
SCHEMA="$S/schema.tsv"; : > "$SCHEMA"
dump_schema() {   # $1 库文件  $2 显示名
  local t
  for t in $(sqlite3 -readonly "$1" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"); do
    printf '%s\t%s\t%s\t%s\n' "$2" "$t" \
      "$(sqlite3 -readonly "$1" "select count(*) from \"$t\"")" \
      "$(sqlite3 -readonly "$1" "select group_concat(name, ',') from pragma_table_info('$t')")" >> "$SCHEMA"
  done
}
for f in "$S"/data/*; do [ -f "$f" ] && is_sqlite "$f" && dump_schema "$f" "$(basename "$f")"; done
while IFS=$'\t' read -r n cls _; do   # static 里的库（bgm_index.db）直接读服务器上的原文件
  if [ "$cls" = static ] && is_sqlite "$D/$n"; then dump_schema "$D/$n" "$n"; fi
done < "$INV"

# 换机器要重做的系统配置；用通配符，新增的 mapletools 相关配置会自动带上
for f in /etc/nginx/nginx.conf /etc/nginx/sites-available/* /usr/local/bin/mtweb /usr/local/bin/mapletools-*.sh \
         /etc/logrotate.d/mapletools* /etc/cron.d/*mapletools* /etc/systemd/system/pm2-mapletools.service \
         /etc/sysctl.d/90-bbr.conf /etc/modules-load.d/bbr.conf; do
  if [ -e "$f" ]; then cp -a --parents "$f" "$S/system/"; fi
done
crontab -l > "$S/system/crontab-root.txt" 2>/dev/null || true

{
  echo "taken_at=$(date -Is)"
  echo "now_epoch=$(date +%s)"
  echo "host=$(hostname)"
  echo "code_commit=$(git -C /opt/mapletools rev-parse HEAD)"
  echo "code_dirty_files=$(git -C /opt/mapletools status --short | wc -l)"
  echo "unclassified=${UNCLASSIFIED# }"
  sqlite3 "$S/data/web.db" "select 'rows_users='||count(*) from users; select 'rows_tracks='||count(*) from tracks;"
} > "$S/INFO.txt"
( cd "$S" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256 )

tar -czf - -C "$S" .

#!/usr/bin/env bash
# 把线上服务器的全部数据拉回本机，用于服务器瘫痪时紧急恢复或换机器时整机复原。
# 每次更新服务器代码之前先跑一遍（见 AGENTS.md「服务端 / 部署」）。
#
# 用法：web/scripts/backup-server.sh [--live-only]
#   默认：快照 + 静态区；--live-only 只做快照（跳过静态区同步）
#   BACKUP_DIR 可改存放位置，默认 <仓库>/server-backups（已在 .gitignore，里面有用户数据和密钥，不许进 git）
#
# 存放结构：
#   snapshots/mapletools-<时间戳>.tar.gz   每次都重新拿，一份文件，含库 + 用户上传文件 + 服务器配置
#   static/bgm_index.db                    番剧索引：每周四才变，源站没变就不重复拉
#   static/bgm-cover-cache/                封面缓存：文件名是内容哈希、写入后不再改，只增量补新文件
# 旧快照不会自动删，由人决定；脚本只在最后列出来。
set -euo pipefail
umask 077

HOST="${BACKUP_HOST:-root@103.250.172.17}"
SSH_PORT="${BACKUP_SSH_PORT:-31789}"
SSH_KEY="${BACKUP_SSH_KEY:-$HOME/.ssh/tryidc_web}"
DATA=/opt/mapletools-data
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${BACKUP_DIR:-$ROOT/server-backups}"
LIVE_ONLY=0
[ "${1:-}" = "--live-only" ] && LIVE_ONLY=1

SSH=(ssh -p "$SSH_PORT" -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15)
RSH="ssh -p $SSH_PORT -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=15"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"   # 本机时间；同一天多次备份按时分秒就能分先后
say() { printf '%s\n' "$*" >&2; }
die() { say "✗ $*"; exit 1; }

# 备份目录在仓库里时必须被 git 忽略，否则用户数据和密钥有被提交的风险
mkdir -p "$OUT/snapshots" "$OUT/static"   # 目录要先存在：.gitignore 里的 `xxx/` 只匹配已存在的目录
if [ "${OUT#"$ROOT"/}" != "$OUT" ] && ! git -C "$ROOT" check-ignore -q "$OUT"; then
  die "$OUT 没有被 .gitignore 忽略，拒绝写入（里面有用户数据和密钥）"
fi
chmod 700 "$OUT" "$OUT/snapshots" "$OUT/static"
FREE_KB="$(df -k "$OUT" | awk 'NR==2{print $4}')"
[ "$FREE_KB" -gt 5242880 ] || die "本机剩余空间不足 5GB，先清理再备份"

"${SSH[@]}" "$HOST" true || die "连不上服务器 $HOST（端口 $SSH_PORT）"

# ── 1. 快照：服务器上暂存 → 流式拉回 → 本机校验 → 才改成正式文件名 ──────────────
say "== 快照：库、用户上传文件、服务器配置"
PART="$OUT/snapshots/.mapletools-$STAMP.tar.gz.part"
trap 'rm -f "$PART"; rm -rf "${VERIFY:-}"' EXIT

# 远端脚本走 stdin、tar 流走 stdout，进度走 stderr；暂存目录退出时自动清掉
"${SSH[@]}" "$HOST" 'bash -s' > "$PART" <<'REMOTE'
set -euo pipefail
umask 077
D=/opt/mapletools-data
S="$(mktemp -d /tmp/mt-snap.XXXXXX)"
trap 'rm -rf "$S"' EXIT
mkdir -p "$S/data" "$S/system"

# 库必须用 .backup：开着 WAL，cp 会拷到写入中途撕裂的文件
sqlite3 "$D/web.db" ".backup '$S/data/web.db'"
[ "$(sqlite3 "$S/data/web.db" 'PRAGMA integrity_check')" = ok ] || { echo "web.db 完整性检查失败" >&2; exit 1; }

# 与库配套的磁盘文件、小型状态文件、密钥配置
for p in covers catalog-covers order-judge calendar-seasons holidays \
         calendar-cache.json line-speed.json ecosystem.config.cjs .env.ai .env.sentry; do
  if [ -e "$D/$p" ]; then cp -a "$D/$p" "$S/data/"; else echo "（服务器上没有 $p，跳过）" >&2; fi
done

# 换机器要重做的系统配置：nginx、mtweb 包装器、备份脚本、日志轮转、BBR、定时任务
for f in /etc/nginx/nginx.conf /etc/nginx/sites-available/mapletools-web /usr/local/bin/mtweb \
         /usr/local/bin/mapletools-backup.sh /etc/logrotate.d/mapletools-pm2 \
         /etc/sysctl.d/90-bbr.conf /etc/modules-load.d/bbr.conf; do
  if [ -e "$f" ]; then cp -a --parents "$f" "$S/system/"; else echo "（服务器上没有 $f，跳过）" >&2; fi
done
crontab -l > "$S/system/crontab-root.txt" 2>/dev/null || true

{
  echo "taken_at=$(date -Is)"
  echo "host=$(hostname)"
  echo "code_commit=$(git -C /opt/mapletools rev-parse HEAD)"
  echo "code_dirty_files=$(git -C /opt/mapletools status --short | wc -l)"
  sqlite3 "$S/data/web.db" "select 'rows_users='||count(*) from users; select 'rows_tracks='||count(*) from tracks;"
} > "$S/INFO.txt"
( cd "$S" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256 )

tar -czf - -C "$S" .
REMOTE

# 本机再验一遍：压缩包完整、清单哈希对得上、库能打开且行数与服务器记录的一致
gzip -t "$PART"
VERIFY="$(mktemp -d "${TMPDIR:-/tmp}/mt-verify.XXXXXX")"
tar -xzf "$PART" -C "$VERIFY"
( cd "$VERIFY" && shasum -a 256 -c MANIFEST.sha256 > /dev/null ) || die "快照里的文件哈希对不上，已丢弃"
[ "$(sqlite3 "$VERIFY/data/web.db" 'PRAGMA integrity_check')" = ok ] || die "快照里的库损坏，已丢弃"
LOCAL_USERS="$(sqlite3 "$VERIFY/data/web.db" 'select count(*) from users')"
grep -qx "rows_users=$LOCAL_USERS" "$VERIFY/INFO.txt" || die "用户数和服务器记录的不一致，已丢弃"
FINAL="$OUT/snapshots/mapletools-$STAMP.tar.gz"
mv "$PART" "$FINAL"
say "✓ $FINAL  ($(du -h "$FINAL" | cut -f1))"
sed 's/^/    /' "$VERIFY/INFO.txt" >&2

# ── 2. 静态区：基本不变的数据，只补新的 ──────────────────────────────────────────
if [ "$LIVE_ONLY" = 0 ]; then
  say "== 静态区（已有的不重复拉）"
  BEFORE="$(stat -f %m "$OUT/static/bgm_index.db" 2>/dev/null || echo 0)"
  rsync -rlt --partial -e "$RSH" "$HOST:$DATA/bgm_index.db" "$OUT/static/"
  AFTER="$(stat -f %m "$OUT/static/bgm_index.db")"
  if [ "$BEFORE" = "$AFTER" ]; then say "  bgm_index.db 没变，跳过"; else say "  bgm_index.db 已更新"; fi
  mkdir -p "$OUT/static/bgm-cover-cache"
  N0="$(ls "$OUT/static/bgm-cover-cache" | wc -l | tr -d ' ')"
  # 不加 --delete：服务器上清掉的封面缓存，本机这份仍然留着
  rsync -rlt --ignore-existing --partial -e "$RSH" "$HOST:$DATA/bgm-cover-cache/" "$OUT/static/bgm-cover-cache/"
  N1="$(ls "$OUT/static/bgm-cover-cache" | wc -l | tr -d ' ')"
  say "  bgm-cover-cache：原有 $N0 个，新补 $((N1 - N0)) 个，现共 $N1 个"
fi

# ── 3. 旧快照清单：是否删除由人决定 ──────────────────────────────────────────────
say "== 本机现有快照（脚本不会自动删，需要的话自己删旧的）"
ls -1t "$OUT/snapshots"/mapletools-*.tar.gz | while read -r f; do printf '    %s  %s\n' "$(du -h "$f" | cut -f1)" "$f" >&2; done
say "  总占用：$(du -sh "$OUT" | cut -f1)"

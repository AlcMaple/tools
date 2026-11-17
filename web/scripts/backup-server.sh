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
#
# 怎么分类、备什么都不靠人记：服务器端的 backup-collect.sh 扫描数据目录的每一项，默认全部纳入；
# 没登记过的新条目自动备份并在报告里标「未分类」。每次跑完还会和上一份快照对比，
# 报告新增 / 消失的条目、新表、列变化、行数变化，同时存成 snapshots/mapletools-<时间戳>.report.txt。
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

# ── 0. 服务器每日备份还活着吗、服务器上的脚本是不是落后于仓库 ───────────────────────
# 只警告不拦截：这里要拿的是一份新快照，每日备份出问题不该让你拿不到它
SRV="$("${SSH[@]}" -n "$HOST" 'echo "last_ok=$(cat /opt/mapletools-backup/LAST_OK 2>/dev/null)"
  echo "collect=$(sha256sum /usr/local/bin/mapletools-backup-collect.sh 2>/dev/null | cut -d" " -f1)"
  echo "daily=$(sha256sum /usr/local/bin/mapletools-backup.sh 2>/dev/null | cut -d" " -f1)"')"
srv_field() { printf '%s\n' "$SRV" | sed -n "s/^$1=//p"; }
LAST_OK="$(srv_field last_ok)"
if [ -z "$LAST_OK" ]; then
  say "⚠ 服务器每日备份没有成功记录（/opt/mapletools-backup/LAST_OK 不存在）：新版每日备份还没装，或一直没跑成功"
elif [ $(( $(date +%s) - LAST_OK )) -gt 93600 ]; then
  say "⚠ 服务器每日备份已超过 26 小时没成功过（上次 $(date -r "$LAST_OK" '+%F %T')），看 /var/log/mapletools-backup.log"
fi
for pair in "collect:backup-collect.sh" "daily:backup-daily.sh"; do
  want="$(shasum -a 256 "$(dirname "$0")/${pair#*:}" | cut -d' ' -f1)"
  [ "$(srv_field "${pair%%:*}")" = "$want" ] || say "⚠ 服务器上的 ${pair#*:} 和仓库不一致（没装或已落后），需要重新复制到 /usr/local/bin/"
done

# ── 1. 快照：服务器上暂存 → 流式拉回 → 本机校验 → 才改成正式文件名 ──────────────
say "== 快照：库、用户上传文件、服务器配置"
PART="$OUT/snapshots/.mapletools-$STAMP.tar.gz.part"
trap 'rm -f "$PART"; rm -rf "${VERIFY:-}"' EXIT

# 收集脚本在 backup-collect.sh：默认全备、自动分类，tar 流走 stdout，进度和警告走 stderr
"${SSH[@]}" "$HOST" 'bash -s' > "$PART" < "$(dirname "$0")/backup-collect.sh"

# 本机再验一遍：压缩包完整、清单哈希对得上、库能打开且行数与服务器记录的一致
gzip -t "$PART"
VERIFY="$(mktemp -d "${TMPDIR:-/tmp}/mt-verify.XXXXXX")"
tar -xzf "$PART" -C "$VERIFY"
( cd "$VERIFY" && shasum -a 256 -c MANIFEST.sha256 > /dev/null ) || die "快照里的文件哈希对不上，已丢弃"
[ "$(sqlite3 "$VERIFY/data/web.db" 'PRAGMA integrity_check')" = ok ] || die "快照里的库损坏，已丢弃"
LOCAL_USERS="$(sqlite3 "$VERIFY/data/web.db" 'select count(*) from users')"
grep -qx "rows_users=$LOCAL_USERS" "$VERIFY/INFO.txt" || die "用户数和服务器记录的不一致，已丢弃"
PREV="${BACKUP_PREV:-$(ls -1t "$OUT/snapshots"/mapletools-*.tar.gz 2>/dev/null | head -1 || true)}"   # 对比用：上一份快照（BACKUP_PREV 可指定，测试用）
FINAL="$OUT/snapshots/mapletools-$STAMP.tar.gz"
mv "$PART" "$FINAL"
INV_NOW="$VERIFY/inventory.tsv"
say "✓ $FINAL  ($(du -h "$FINAL" | cut -f1))"
sed 's/^/    /' "$VERIFY/INFO.txt" >&2

# ── 变化报告：和上一份快照对比，不用人记得「这次动了什么数据」 ─────────────────────
REPORT="$OUT/snapshots/mapletools-$STAMP.report.txt"
NOW="$(sed -n 's/^now_epoch=//p' "$VERIFY/INFO.txt")"
{
  UNCL="$(sed -n 's/^unclassified=//p' "$VERIFY/INFO.txt")"
  if [ -n "$UNCL" ]; then
    echo "⚠ 未分类的新条目（已自动纳入备份，不会漏）：$UNCL"
    echo "  → 判断它属于哪一类，补进 backup-collect.sh 顶部的已知表，并在部署文档里记一行"
    echo
  fi
  PREV_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mt-prev.XXXXXX")"
  if [ -n "$PREV" ] && tar -xzf "$PREV" -C "$PREV_DIR" ./inventory.tsv ./schema.tsv 2>/dev/null; then
    echo "对比基准：$(basename "$PREV")"
    echo "── 数据条目（live 每次备 / static 增量补 / sqlite、db 用 .backup / skip 故意不备）"
    awk -F'\t' -v now="$NOW" '
      function age(t,  d) { if (t <= 0) return "无文件"; d = now - t
        if (d < 3600) return int(d/60) "分钟前"; if (d < 86400) return int(d/3600) "小时前"; return int(d/86400) "天前" }
      NR==FNR { pk[$1]=$3; pf[$1]=$4; next }
      { seen[$1]=1
        if ($2 == "skip") { skip = skip " " $1; next }
        if (!($1 in pk)) mark = "新增"
        else if ($3 != pk[$1] || $4 != pf[$1]) mark = sprintf("%+d KB / %+d 个文件", $3-pk[$1], $4-pf[$1])
        else { same = same " " $1; next }
        printf "  %-26s %-9s %8d KB  %-22s 最近写入 %s\n", $1, $2, $3, mark, age($5) }
      END { for (k in pk) if (!(k in seen)) printf "  %-26s 已从服务器消失（本机旧快照里仍有）\n", k
            if (same != "") print "  没变化：" same
            if (skip != "") print "  故意不备：" skip }
    ' "$PREV_DIR/inventory.tsv" "$VERIFY/inventory.tsv"
    echo "── 数据表（新增 / 消失 / 列变化 / 行数变化）"
    awk -F'\t' '
      NR==FNR { r[$1"\t"$2]=$3; c[$1"\t"$2]=$4; next }
      { k=$1"\t"$2; seen[k]=1
        if (!(k in r)) printf "  + 新表  %s.%s（%s 行，列：%s）\n", $1, $2, $3, $4
        else { if (c[k] != $4) printf "  ~ 列变了  %s.%s：%s → %s\n", $1, $2, c[k], $4
               if (r[k] != $3) { n++; line[n]=sprintf("  行数  %s.%s：%d → %d（%+d）", $1, $2, r[k], $3, $3-r[k]) } } }
      END { for (k in r) if (!(k in seen)) { split(k, a, "\t"); printf "  - 表消失  %s.%s\n", a[1], a[2] }
            for (i=1;i<=n;i++) print line[i] }
    ' "$PREV_DIR/schema.tsv" "$VERIFY/schema.tsv"
  else
    echo "（没有上一份可对比的快照，本次只做基线）"
  fi
  rm -rf "$PREV_DIR"
} | tee "$REPORT" >&2

# ── 2. 静态区：按快照里的清单同步，不再写死名字 ─────────────────────────────────
# static = 写入后不再改（已有的不重复拉）；oversize = 未分类的大条目（按更新增量补）。都不加 --delete
if [ "$LIVE_ONLY" = 0 ]; then
  say "== 静态区（已有的不重复拉）"
  while IFS=$'\t' read -r name cls _; do
    [ "$cls" = static ] || [ "$cls" = oversize ] || continue
    kind="$("${SSH[@]}" -n "$HOST" "[ -d '$DATA/$name' ] && echo dir || echo file")"
    if [ "$kind" = file ]; then
      BEFORE="$(stat -f %m "$OUT/static/$name" 2>/dev/null || echo 0)"
      rsync -rlt --partial -e "$RSH" "$HOST:$DATA/$name" "$OUT/static/"
      AFTER="$(stat -f %m "$OUT/static/$name")"
      if [ "$BEFORE" = "$AFTER" ]; then say "  $name 没变，跳过"; else say "  $name 已更新"; fi
    else
      mkdir -p "$OUT/static/$name"
      N0="$(find "$OUT/static/$name" -type f | wc -l | tr -d ' ')"
      OPT=--ignore-existing; [ "$cls" = oversize ] && OPT=--update
      rsync -rlt $OPT --partial -e "$RSH" "$HOST:$DATA/$name/" "$OUT/static/$name/"
      N1="$(find "$OUT/static/$name" -type f | wc -l | tr -d ' ')"
      say "  $name：原有 $N0 个，新补 $((N1 - N0)) 个，现共 $N1 个"
    fi
  done < "$INV_NOW"
fi

# ── 3. 旧快照清单：是否删除由人决定 ──────────────────────────────────────────────
say "== 本机现有快照（脚本不会自动删，需要的话自己删旧的）"
ls -1t "$OUT/snapshots"/mapletools-*.tar.gz | while read -r f; do printf '    %s  %s\n' "$(du -h "$f" | cut -f1)" "$f" >&2; done
say "  总占用：$(du -sh "$OUT" | cut -f1)"

#!/usr/bin/env bash
# 不开播 / 卡顿复查：列出最近的卡顿记录，以及同一时段 nginx 实际发给该 IP 的速度。
# 用法：web/scripts/check-playback.sh [最近几小时，默认 24]
set -euo pipefail
HOURS="${1:-24}"
ssh -p 31789 -i ~/.ssh/tryidc_web root@103.250.172.17 HOURS="$HOURS" 'bash -s' <<'EOF'
since=$(date -u -d "-$HOURS hours" +%Y-%m-%dT%H:%M)
echo "== 播放器：卡顿 / 推一把 / 有问题的 qos（$since UTC 之后）"
cat /home/mapletools/.pm2/logs/mapletools-web-out.log* 2>/dev/null \
  | grep -aE '^\[player:client\] [0-9T:.-]+Z' \
  | awk -v s="$since" '$2 >= s' \
  | grep -aE 'stall|kick|qos stalls=[1-9]|startup=[0-9]{2,}|media error' | cut -c1-400 | tail -40
echo
echo "== nginx：/api/player/stream 大请求的实际到手速度（>1MB）"
zcat -f /var/log/nginx/access.log /var/log/nginx/access.log.1 2>/dev/null \
  | grep -a 'player/stream' | grep -a ' rt=' \
  | awk '{ rt=0; b=0; for (i=2;i<=NF;i++) if ($i ~ /^rt=/) { rt=substr($i,4); b=$(i-1); break }
           if (b+0 > 1048576 && rt > 0) printf "%s %s %6.1fMB %6.1fs %5.2fMbps\n", $1, $2, b/1048576, rt, b*8/rt/1e6 }' \
  | tail -40
EOF

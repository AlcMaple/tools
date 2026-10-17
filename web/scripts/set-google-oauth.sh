#!/usr/bin/env bash
# 换 Google 登录凭据：本地交互输入（不回显、不进 shell 历史），只改 VPS 上 ecosystem 里那两行，改前留备份。
set -euo pipefail
read -rp 'GOOGLE_CLIENT_ID: ' id
read -rsp 'GOOGLE_CLIENT_SECRET: ' secret; echo
[[ $id == *.apps.googleusercontent.com && $secret == GOCSPX-* ]] || { echo '格式不对：ID 应以 .apps.googleusercontent.com 结尾，密钥以 GOCSPX- 开头' >&2; exit 1; }
printf '%s\n%s\n' "$id" "$secret" | ssh -p 31789 -i ~/.ssh/tryidc_web root@103.250.172.17 'bash -c '"'"'
set -euo pipefail
read -r id; read -r secret
f=/opt/mapletools-data/ecosystem.config.cjs
cp -p "$f" "$f.bak-$(date +%F-%H%M)"
ID="$id" SECRET="$secret" perl -i -pe "s/(GOOGLE_CLIENT_ID:\s*)([\"\x27]).*?\2/\$1\x27\$ENV{ID}\x27/; s/(GOOGLE_CLIENT_SECRET:\s*)([\"\x27]).*?\2/\$1\x27\$ENV{SECRET}\x27/" "$f"
grep -cE "GOOGLE_CLIENT_(ID|SECRET): \x27" "$f" | grep -qx 2 && echo "已更新（备份在 $f.bak-*）"
'"'"''

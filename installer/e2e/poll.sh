#!/bin/sh
# 在 e2e 容器内读安装器 /api/status，打印十步进度（POSIX sh，容器里没 python3）
# 用法： sh /repo/dist/e2e/poll.sh [base-url]
BASE="${1:-http://127.0.0.1:18080}"

RAW="$(curl -s -m 15 "${BASE}/api/status")" || { echo "curl 失败：安装器还在吗？"; exit 1; }

printf '%s' "$RAW" | sed -n 's/.*"nextStep":"\([^"]*\)".*/nextStep: \1/p'
printf '%s' "$RAW" | sed 's/},{/}\
{/g' | grep -o '"id":"[^"]*","title":"[^"]*","status":"[^"]*"' \
  | sed 's/"id":"\([^"]*\)","title":"\([^"]*\)","status":"\([^"]*\)"/  \1  \3  \2/'
printf '%s' "$RAW" | sed -n 's/.*"lastError":"\([^"]\{1,\}\)".*/lastError: \1/p' | cut -c1-500
printf '%s' "$RAW" | sed -n 's/.*"dockerVersion":"\([^"]*\)".*/dockerVersion: \1/p'
printf '%s' "$RAW" | sed -n 's/.*"imageCount":\([0-9]*\).*/imageCount: \1/p'

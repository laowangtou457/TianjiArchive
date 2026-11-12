#!/usr/bin/env bash
# 收集引导：stagec 已 disable docker.service/socket，docker0 不存在，slirp SSH 可用。
# 只打串口标记 + 等宿主来取文件；10 分钟无人来就保底关机（防 VM 空转）。
# 宿主 e2e-ubuntu.sh collect 阶段：scp 取证 -> ssh poweroff。
SER=/dev/ttyS0
echo "=== CX ubuntu COLLECT-READY $(date -u '+%FT%TZ') ===" > "$SER"
sleep 600
echo "=== CX ubuntu COLLECT-TIMEOUT ===" > "$SER"
sync
systemctl poweroff

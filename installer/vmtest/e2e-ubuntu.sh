#!/usr/bin/env bash
# 变体 A 真机 e2e 驱动（Ubuntu Server 22.04，guest = tianji-vm-ubuntu QEMU）
# 复用变体 B 的三阶段骨架（README §7），差异：
#   * SSH 用户 tianji + sudo（autoinstall 非 root），密钥与变体 B 相同
#   * guest 无 curl，全部取证经 ssh + python3，文件回传走 tar over ssh
#   * stagec 单元跑完链路后 disable docker + reboot（-no-reboot 顶掉 QEMU），
#     宿主再起一次收集引导 scp 取证（docker0 不在，SSH 可用）
#
# 用法：
#   bash installer/vmtest/e2e-ubuntu.sh prep     # 起 VM -> 推脚本/unit -> enable -> arm -> poweroff
#   bash installer/vmtest/e2e-ubuntu.sh chain    # 放 .run 进 httpd -> 带只读 tar 引导 -> 等 stagec 跑完（阻塞）
#   bash installer/vmtest/e2e-ubuntu.sh collect  # 收集引导 -> scp 取证 -> poweroff -> 归档
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
VT="$REPO/installer/vmtest"
LOGD="$VT/logs"
GADIR="$VT/e2e/ubuntu"
VM_DIR="${TIANJI_VM_DIR:-E:/tmp-vm}"
KS_SERVE="$VM_DIR/ks-serve"
KEY="${TIANJI_VM_KEY:-E:/tmp-vm/vmtest_ed25519}"
RUN_FILE="$REPO/dist/installer/tianji-server-setup-ubuntu-debian-amd64-1.0.0.run"
RUN_SHA="5fab54c9dabeb29f943efee070f25d0123eb81b5306a8729c57b0f4365f0dc88"
TAR="$REPO/offline/tianji-offline-images.tar"
SSH_BASE=(-i "$KEY" -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o ConnectTimeout=5 -o LogLevel=ERROR)
SSHC="ssh ${SSH_BASE[*]} tianji@127.0.0.1"

die() { echo "[e2e-ubuntu] $*" >&2; exit 1; }

ssh_ready() { $SSHC 'echo ok' >/dev/null 2>&1; }
wait_ssh()  { for i in $(seq 1 120); do sleep 2; ssh_ready && return 0; done; return 1; }

# 起 VM（后台），等 SSH，执行传进来的远程命令块，干净关机，等容器退出
run_vm_bg() { bash "$VT/run-vm.sh" --os ubuntu --mem "${E2E_MEM:-10240}" --smp 4 "$@" & VMPID=$!; }
vm_down()   { wait "$VMPID"; local rc=$?; echo "[e2e-ubuntu] VM 进程退出 rc=$rc"; return $rc; }

push_file() { # push_file <本地文件> <guest 绝对路径> <mode>
  tr -d '\r' < "$1" | $SSHC "sudo tee '$2' >/dev/null" || die "push $1 失败"
  $SSHC "sudo chmod $3 '$2'" || die "chmod $2 失败"
}

phase_prep() {
  [ -f "$KEY" ] || die "缺 SSH 密钥 $KEY"
  ssh_ready && die "2222 已有 SSH 在监听（先确认没有别的 VM 在跑）"
  echo "[prep] 起 VM（等 SSH 就绪）"
  run_vm_bg
  wait_ssh || { kill "$VMPID" 2>/dev/null; die "SSH 一直不可达"; }
  echo "[prep] 核对 python3 / 磁盘"
  $SSHC 'python3 --version && df -h / | tail -1' || die "python3 或根分区异常"

  echo "[prep] 推送 stagec.sh / collect.sh / unit 文件"
  push_file "$GADIR/stagec.sh"  /root/stagec.sh  755
  push_file "$GADIR/collect.sh" /root/collect.sh 755
  push_file "$GADIR/tianji-e2e-stagec.service"  /etc/systemd/system/tianji-e2e-stagec.service  644
  push_file "$GADIR/tianji-e2e-collect.service" /etc/systemd/system/tianji-e2e-collect.service 644
  $SSHC 'sudo systemctl daemon-reload && sudo systemctl enable tianji-e2e-stagec.service' \
    || die "enable stagec 失败"

  echo "[prep] arm（/root/stagec-armed）+ 干净关机"
  # 注意：poweroff 会掐断 SSH 连接（"Connection closed by remote host"），ssh rc 非 0 属预期，
  # 不能用 rc 判成败——以「容器随后退出」为准（run_vm_bg 的 vm_down 会等它）。
  $SSHC 'sudo touch /root/stagec-armed && sync && (sudo poweroff &) ; sleep 2' || true
  vm_down
  echo "[prep] 完成。下一步： bash $0 chain"
}

phase_chain() {
  [ -f "$RUN_FILE" ] || die "缺 .run: $RUN_FILE"
  [ -f "$TAR" ] || die "缺镜像 tar: $TAR"
  echo "[chain] 放 .run 进 httpd 根（固定别名 server-setup.run）"
  mkdir -p "$KS_SERVE"
  cp "$RUN_FILE" "$KS_SERVE/server-setup.run"
  echo "[chain] $(sha256sum "$KS_SERVE/server-setup.run")"
  sha256sum "$KS_SERVE/server-setup.run" | grep -q "$RUN_SHA" || die ".run sha 不符"

  echo "[chain] 引导（阻塞至 stagec 跑完 reboot -> -no-reboot 顶掉 QEMU）"
  bash "$VT/run-vm.sh" --os ubuntu --mem "${E2E_MEM:-10240}" --smp 4 \
       --attach-ro "$TAR" || die "run-vm.sh 退出非 0（看串口日志）"

  echo "[chain] 归档串口日志（幂等：每次覆盖，最新一轮为准）"
  cp "$LOGD/ubuntu-boot.log" "$LOGD/ubuntu-e2e-stagec-boot.log"
  cp "$LOGD/ubuntu-boot-stages.log" "$LOGD/ubuntu-e2e-stagec-boot-stages.log" 2>/dev/null || true
  grep -E '=== CX ubuntu' "$LOGD/ubuntu-e2e-stagec-boot.log" | tail -30
  echo "[chain] 完成。下一步： bash $0 collect"
}

phase_collect() {
  ssh_ready && die "2222 已有 SSH 在监听（先确认没有别的 VM 在跑）"
  echo "[collect] 起收集引导 VM（后台），轮询串口 COLLECT-READY"
  run_vm_bg
  local i
  for i in $(seq 1 180); do
    sleep 5
    grep -q 'COLLECT-READY' "$LOGD/ubuntu-boot.log" 2>/dev/null && break
    kill -0 "$VMPID" 2>/dev/null || die "QEMU 已退出但没等到 COLLECT-READY（看 $LOGD/ubuntu-boot.log）"
  done
  grep -q 'COLLECT-READY' "$LOGD/ubuntu-boot.log" 2>/dev/null || die "等 COLLECT-READY 超时"
  echo "[collect] SSH 可用性确认 + 取证（tar over ssh）"
  wait_ssh || die "收集引导 SSH 不可达"
  local out="$LOGD/ubuntu-e2e-collect-files.tgz"
  # --ignore-failed-read：S3 若已 FAIL 则 S4..S10 的响应文件不存在，tar 不应因此失败
  $SSHC "sudo tar czf - --ignore-failed-read -C / root/stagec-ubuntu.log root/setup-web-C.log root/c-tarreg.json \
         root/c-env.json root/c-confirm.json root/c-resp-S1.json root/c-resp-S2_VERIFY.json \
         root/c-resp-S3_DOCKER.json root/c-resp-S4_IMAGES.json root/c-resp-S5_ENV.json \
         root/c-resp-S6_UP.json root/c-resp-S7_MIGRATE.json root/c-resp-S8_SEED.json \
         root/c-resp-S9_SMOKE.json root/c-resp-S10_DONE.json \
         var/lib/tianji-install/state.json 2>/dev/null" > "$out" \
    || die "取证 tar 失败"
  echo "[collect] $(ls -la "$out")"
  $SSHC 'sync; sudo poweroff' || true
  vm_down
  cp "$LOGD/ubuntu-boot.log" "$LOGD/ubuntu-e2e-collect-boot.log"
  echo "[collect] 完成。证据： $LOGD/ubuntu-e2e-stagec-boot.log / ubuntu-e2e-collect-files.tgz / ubuntu-e2e-collect-boot.log"
}

case "${1:-}" in
  prep)    phase_prep ;;
  chain)   phase_chain ;;
  collect) phase_collect ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac

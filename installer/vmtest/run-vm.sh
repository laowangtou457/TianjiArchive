#!/usr/bin/env bash
# 天玑档案 变体 B：在容器化 QEMU/KVM 上无人值守安装 麒麟 V10 SP3 / 统信 UOS 20
#
# 用法（在宿主仓库根目录跑，脚本会自己进容器）：
#   bash installer/vmtest/run-vm.sh --os kylin --fresh    # 清盘、无人值守安装、装完自行退出
#   bash installer/vmtest/run-vm.sh --os uos   --fresh
#   bash installer/vmtest/run-vm.sh --os kylin            # 只引导已装好的盘（做二次探测用）
#
# 产物：
#   E:/tmp-vm/<os>.qcow2                    30G 稀疏虚拟盘（不入库）
#   installer/vmtest/logs/<os>-install.log  串口全文（入库）
#   installer/vmtest/logs/<os>-qemu.cmd     实际 qemu 命令行（入库）
#
# 关键设计：
#   * guest 走 QEMU user 网络（10.0.2.0/24），从 10.0.2.2:8000 取 kickstart。
#   * 引导用 ISO 内的 vmlinuz/initrd + inst.stage2=hd:LABEL=<卷标>，不依赖 ISO 的 isolinux。
#   * -no-reboot：anaconda 装完重启时 QEMU 自行退出，作为「装完」的硬信号。
#   * hostfwd 2222 -> guest 22，宿主 `ssh -i E:/tmp-vm/vmtest_ed25519 -p 2222 root@127.0.0.1` 探测。
set -uo pipefail

OS=""; FRESH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --os) OS="${2:-}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    -h|--help) sed -n '3,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ "$OS" = kylin ] || [ "$OS" = uos ] || { echo "必须指定 --os kylin|uos" >&2; exit 2; }

case "$OS" in
  kylin) ISO_FILE="Kylin-Server-V10-SP3-2403-Release-20240426-X86_64.iso"; LABEL="Kylin-Server-10" ;;
  uos)   ISO_FILE="uniontechos-server-20-1020e-amd64.iso";               LABEL="UnionTechOS" ;;
esac

# ---------------------------------------------------------------- 宿主模式：进容器
# 用 `docker run -d` 分离运行：安装要十几分钟，不能把容器生命周期绑在客户端上
# （第一版用 -i 前台跑，客户端被信号打断 -> 容器一起死，"error waiting for container: unexpected EOF"）。
if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
  REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
  ISO_DIR="${TIANJI_ISO_DIR:-E:/国产OS镜像}"
  VM_DIR="${TIANJI_VM_DIR:-E:/tmp-vm}"
  NAME="tianji-vm-$OS"
  mkdir -p "$VM_DIR"
  docker rm -f "$NAME" >/dev/null 2>&1
  echo "[host] 分离启动容器 $NAME（ISO=$ISO_DIR VM=$VM_DIR）"
  run_detached() {
    MSYS_NO_PATHCONV=1 docker run -d --name "$NAME" --privileged "$@" \
      -v "$ISO_DIR":/iso:ro \
      -v "$VM_DIR":/vm \
      -v "$REPO_DIR/installer/vmtest":/vmtest \
      -p 2222:2222 \
      tianji-qemu:1 bash /vmtest/run-vm.sh --os "$OS" $([ "$FRESH" = 1 ] && echo --fresh)
  }
  if ! run_detached --device /dev/kvm >/dev/null 2>&1; then
    echo "[host] --device /dev/kvm 不可用（WSL2 未暴露 KVM），退回 TCG 重试"
    docker rm -f "$NAME" >/dev/null 2>&1
    run_detached >/dev/null 2>&1 || { echo "[host] 容器启动失败" >&2; exit 3; }
  fi
  echo "[host] 容器已起。串口日志: $REPO_DIR/installer/vmtest/logs/$OS-install.log"
  echo "[host] 另开终端可 tail -f 该文件；本进程会阻塞到 qemu 退出（docker wait）"
  RC="$(docker wait "$NAME" 2>/dev/null)"; RC="${RC:-1}"
  echo "[host] 容器退出 rc=$RC（0 = anaconda 装完自行重启，被 -no-reboot 拦下）"
  docker logs --tail 20 "$NAME" 2>&1 | sed 's/\r//g'
  exit $RC
fi

# ---------------------------------------------------------------- 容器内模式
ISO="/iso/$ISO_FILE"
DISK="/vm/$OS.qcow2"
LOG_DIR="/vmtest/logs"
mkdir -p "$LOG_DIR"
[ -f "$ISO" ] || { echo "找不到 ISO: $ISO" >&2; exit 3; }
# --- 加速器选择：**必须真的起一次 QEMU 才算数**
# 只看 /dev/kvm 是否存在不够：WSL2/Docker Desktop 上节点可能在、但 kvm 初始化会失败
# （本次实测就是这么翻车的——file 存在，`-accel kvm` 却起不来；后来又整个消失，
#  宿主 /sys/module/kvm* 都没了）。所以这里做一次最小启动探测：
#   timeout 强杀 => 说明 QEMU 成功跑起来了（rc=124/137）；秒退 => 初始化失败。
kvm_probe() {
  [ -e /dev/kvm ] || return 1
  timeout 8 qemu-system-x86_64 -machine q35,accel=kvm -cpu host -m 128 \
      -display none -nodefaults -S -monitor none >/dev/null 2>&1
  case $? in 124|137) return 0 ;; *) return 1 ;; esac
}
if kvm_probe; then
  ACCEL="accel=kvm"; CPU="host"; ACCEL_DESC="KVM（/dev/kvm 可用且 kvm 加速初始化成功）"
else
  ACCEL="accel=tcg"; CPU="max";  ACCEL_DESC="TCG（无 KVM 或 kvm 初始化失败 → 纯软件模拟，约慢 5-10 倍，但可用）"
  [ -e /dev/kvm ] && ACCEL_DESC="TCG（/dev/kvm 节点存在但 -accel kvm 初始化失败 → 降级软件模拟）"
fi
echo "[c] 加速器: $ACCEL_DESC"

if [ "$FRESH" = 1 ]; then rm -f "$DISK"; fi
if [ ! -f "$DISK" ]; then
  qemu-img create -f qcow2 "$DISK" 30G >/dev/null || exit 3
  FRESH=1
fi
# 装盘与「引导已装盘」落两份不同日志，否则第二次启动会把安装证据冲掉
if [ "$FRESH" = 1 ]; then MODE=install; else MODE=boot; fi
LOG="$LOG_DIR/$OS-$MODE.log"
CMDLOG="$LOG_DIR/$OS-$MODE-qemu.cmd"

# --- kickstart：注入公钥
PUBKEY_FILE="${VM_PUBKEY:-/vm/vmtest_ed25519.pub}"
[ -f "$PUBKEY_FILE" ] || { echo "缺公钥 $PUBKEY_FILE" >&2; exit 3; }
mkdir -p /vm/ks-serve
sed "s|@SSH_PUBKEY@|$(cat "$PUBKEY_FILE")|" "/vmtest/ks/$OS-min.ks" > /vm/ks-serve/ks.cfg
echo "[c] kickstart /vm/ks-serve/ks.cfg  ($(wc -c < /vm/ks-serve/ks.cfg) B)"

# --- 起 perl HTTP 服务
if ! (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null; then
  nohup perl /vmtest/ks-httpd.pl 8000 /vm/ks-serve > /vm/ks-serve/httpd.log 2>&1 &
  for i in $(seq 1 30); do sleep 0.2; (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null && break; done
  (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null || { echo "ks-httpd 未就绪" >&2; cat /vm/ks-serve/httpd.log; exit 4; }
  echo "[c] ks-httpd :8000 就绪（guest 侧 10.0.2.2:8000）"
fi

COMMON=( -machine "q35,$ACCEL" -cpu "$CPU" -m 4096 -smp 4 -display none
         -drive file="$DISK",if=virtio,format=qcow2,cache=unsafe
         -cdrom "$ISO" -boot order=c
         -netdev "user,id=n0,hostfwd=tcp::2222-:22" -device virtio-net-pci,netdev=n0
         -monitor none -no-reboot -name "tianji-$OS" )

if [ "$FRESH" = 1 ]; then
  EXDIR="/vm/boot-$OS"; rm -rf "$EXDIR"; mkdir -p "$EXDIR"
  for f in vmlinuz initrd.img; do
    isoinfo -R -i "$ISO" -x "/images/pxeboot/$f" > "$EXDIR/$f" 2>/dev/null
    [ -s "$EXDIR/$f" ] || { echo "从 ISO 抽 /images/pxeboot/$f 失败" >&2; exit 5; }
  done
  echo "[c] 内核: $(ls -l "$EXDIR" | tail -2 | awk '{print $5, $9}' | tr '\n' ' ')"
  APPEND="inst.ks=http://10.0.2.2:8000/ks.cfg inst.stage2=hd:LABEL=$LABEL inst.repo=hd:LABEL=$LABEL ip=dhcp inst.text inst.cmdline console=ttyS0,115200n8"
  ARGS=( "${COMMON[@]}" -kernel "$EXDIR/vmlinuz" -initrd "$EXDIR/initrd.img" -append "$APPEND" )
else
  ARGS=( "${COMMON[@]}" )
fi

printf 'qemu-system-x86_64 ' > "$CMDLOG"
printf '%q ' "${ARGS[@]}" >> "$CMDLOG"; echo >> "$CMDLOG"
echo "[c] 启动 qemu，串口 -> $LOG"
qemu-system-x86_64 "${ARGS[@]}" -serial "file:$LOG" >> "$LOG_DIR/$OS-$MODE-qemu.out" 2>&1
RC=$?

# 串口日志开头补一行「本次到底用什么加速器跑的」——事后看日志才不会把 TCG 的慢误判成系统卡死。
if [ -s "$LOG" ]; then
  TMP="$LOG.hdr"
  {
    echo "# ===== tianji vmtest ====="
    echo "# os=$OS  mode=$([ "$FRESH" = 1 ] && echo install || echo boot-installed)"
    echo "# accel=$ACCEL cpu=$CPU  ($ACCEL_DESC)"
    echo "# qemu rc=$RC  finished=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# cmd: $(head -1 "$CMDLOG")"
    echo "# ========================="
    cat "$LOG"
  } > "$TMP" && mv "$TMP" "$LOG"
fi
echo "[c] qemu 退出 rc=$RC"; tail -15 "$LOG" 2>/dev/null
exit $RC

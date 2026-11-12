#!/usr/bin/env bash
# 天玑档案 vmtest：在容器化 QEMU/KVM 上无人值守安装
#   --os kylin   麒麟 V10 SP3（变体 B，anaconda kickstart）
#   --os uos     统信 UOS 20（变体 B，anaconda kickstart）
#   --os ubuntu  Ubuntu Server 22.04（变体 A，casper + subiquity autoinstall）
#
# 用法（在宿主仓库根目录跑，脚本会自己进容器）：
#   bash installer/vmtest/run-vm.sh --os kylin --fresh    # 清盘、无人值守安装、装完自行退出
#   bash installer/vmtest/run-vm.sh --os uos   --fresh
#   bash installer/vmtest/run-vm.sh --os ubuntu --fresh
#   bash installer/vmtest/run-vm.sh --os kylin            # 只引导已装好的盘（做二次探测用）
#
# 端到端验收（变体 B 安装包）推荐参数 + 只读挂载镜像 tar：
#   bash installer/vmtest/run-vm.sh --os kylin --disk 60G --mem 8192 --smp 4 \
#        --attach-ro E:/TianjiArchive/offline/tianji-offline-images.tar
#
# 产物：
#   E:/tmp-vm/<os>.qcow2                         稀疏虚拟盘（默认 30G，--disk 可改；不入库）
#   installer/vmtest/logs/<os>-install.log        装盘串口全文
#   installer/vmtest/logs/<os>-boot.log           引导串口全文
#   installer/vmtest/logs/<os>-<mode>-stages.log  阶段打点（起止时刻 + 耗时）
#   installer/vmtest/logs/<os>-<mode>-qemu.cmd    实际 qemu 命令行
#
# 关键设计：
#   * guest 走 QEMU user 网络（10.0.2.0/24），从 10.0.2.2:8000 取 kickstart（kylin/uos）
#     或 autoinstall user-data（ubuntu）；同一个 httpd 也能发 .run 安装包（固定别名，见 README §7）。
#   * 引导用 ISO 内的 vmlinuz/initrd + inst.stage2=hd:LABEL=<卷标>（kylin/uos）；
#     ubuntu 用 casper 引导（boot=casper，ISO 自带 squashfs），autoinstall 走 nocloud。
#   * -no-reboot：kylin/uos anaconda 装完重启时 QEMU 自行退出；ubuntu 靠 user-data 的
#     shutdown: poweroff 直接关机退出 —— 两者都以「容器退出」作装完硬信号。
#   * hostfwd 2222 -> guest 22，宿主 `ssh -i E:/tmp-vm/vmtest_ed25519 -p 2222 root@127.0.0.1` 探测。
#
# 参数：
#   --os kylin|uos|ubuntu 必填
#   --fresh              清盘重装
#   --disk 30G           虚拟盘大小（默认 30G 不变；端到端验收建议 60G）
#   --mem 4096           guest 内存 MiB（默认 4096；跑完整栈建议 8192）
#   --smp 4              vCPU 数（默认 4）
#   --attach-ro <file>   以只读 virtio 盘挂进 guest（**仅 boot 模式**；用于镜像 tar，
#                        对应现场「用户已把 tar 拷到机器上」，比走 slirp 传输更忠实）
set -uo pipefail

OS=""; FRESH=0; DISK_SIZE="30G"; MEM_MB=4096; SMP=4; ATTACH_RO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --os) OS="${2:-}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --disk) DISK_SIZE="${2:-}"; shift 2 ;;
    --mem) MEM_MB="${2:-}"; shift 2 ;;
    --smp) SMP="${2:-}"; shift 2 ;;
    --attach-ro) ATTACH_RO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,30p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
case "$OS" in
  kylin|uos)   ;;
  ubuntu)      ;;
  *) echo "必须指定 --os kylin|uos|ubuntu" >&2; exit 2 ;;
esac
case "$DISK_SIZE" in ''|*[!0-9GgMmTt]*) echo "--disk 形如 30G/60G" >&2; exit 2 ;; esac
case "$MEM_MB" in ''|*[!0-9]*) echo "--mem 必须是整数 MiB" >&2; exit 2 ;; esac
case "$SMP" in ''|*[!0-9]*) echo "--smp 必须是整数" >&2; exit 2 ;; esac

case "$OS" in
  kylin)  ISO_FILE="Kylin-Server-V10-SP3-2403-Release-20240426-X86_64.iso"; LABEL="Kylin-Server-10" ;;
  uos)    ISO_FILE="uniontechos-server-20-1020e-amd64.iso";                 LABEL="UnionTechOS" ;;
  ubuntu) ISO_FILE="ubuntu-22.04.5-live-server-amd64.iso";                  LABEL="Ubuntu-Server 22.04" ;;  # LABEL 仅记录用，casper 不走 stage2
esac

# ---------------------------------------------------------------- 宿主模式：进容器
# 用 `docker run -d` 分离运行：安装要十几分钟，不能把容器生命周期绑在客户端上
# （第一版用 -i 前台跑，客户端被信号打断 -> 容器一起死，"error waiting for container: unexpected EOF"）。
if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
  REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
  # ubuntu 镜像不在国产OS镜像目录，单独给默认值（TIANJI_ISO_DIR 仍可整体覆盖）
  DEF_ISO_DIR="E:/国产OS镜像"; [ "$OS" = ubuntu ] && DEF_ISO_DIR="E:/iso"
  ISO_DIR="${TIANJI_ISO_DIR:-$DEF_ISO_DIR}"
  VM_DIR="${TIANJI_VM_DIR:-E:/tmp-vm}"
  NAME="tianji-vm-$OS"
  mkdir -p "$VM_DIR"

  # 参数原样透传给容器内实例（默认值也要传，日志里才看得到"这次到底用什么跑的"）
  PASS=( --os "$OS" --disk "$DISK_SIZE" --mem "$MEM_MB" --smp "$SMP" )
  [ "$FRESH" = 1 ] && PASS+=( --fresh )
  MOUNTS=()
  if [ -n "$ATTACH_RO" ]; then
    [ -f "$ATTACH_RO" ] || { echo "找不到 --attach-ro 文件: $ATTACH_RO" >&2; exit 2; }
    AR_DIR="$(cd "$(dirname "$ATTACH_RO")" && pwd)"
    MOUNTS=( -v "$AR_DIR":/extra:ro )
    PASS+=( --attach-ro "/extra/$(basename "$ATTACH_RO")" )
  fi

  docker rm -f "$NAME" >/dev/null 2>&1
  echo "[host] 分离启动容器 $NAME（ISO=$ISO_DIR VM=$VM_DIR disk=$DISK_SIZE mem=${MEM_MB}MiB smp=$SMP）"
  run_detached() {
    MSYS_NO_PATHCONV=1 docker run -d --name "$NAME" --privileged "$@" \
      -v "$ISO_DIR":/iso:ro \
      -v "$VM_DIR":/vm \
      -v "$REPO_DIR/installer/vmtest":/vmtest \
      ${MOUNTS[@]+"${MOUNTS[@]}"} \
      -p 2222:2222 \
      ${TIANJI_SERIAL_TELNET:+-e TIANJI_SERIAL_TELNET=1 -p 2301:2301} \
      tianji-qemu:1 bash /vmtest/run-vm.sh ${PASS[@]+"${PASS[@]}"}
  }
  if ! run_detached --device /dev/kvm >/dev/null 2>&1; then
    echo "[host] --device /dev/kvm 不可用（WSL2 未暴露 KVM），退回 TCG 重试"
    docker rm -f "$NAME" >/dev/null 2>&1
    run_detached >/dev/null 2>&1 || { echo "[host] 容器启动失败" >&2; exit 3; }
  fi
  echo "[host] 容器已起。日志目录: $REPO_DIR/installer/vmtest/logs/"
  echo "[host] 另开终端可 tail -f；本进程会阻塞到 qemu 退出（docker wait）"
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

# 先定模式/日志：盘不存在一律按装盘处理，stage 打点才能从第一步就落同一份文件
if [ "$FRESH" = 1 ]; then rm -f "$DISK"; fi
[ -f "$DISK" ] || FRESH=1
if [ "$FRESH" = 1 ]; then MODE=install; else MODE=boot; fi
LOG="$LOG_DIR/$OS-$MODE.log"
CMDLOG="$LOG_DIR/$OS-$MODE-qemu.cmd"
STAGELOG="$LOG_DIR/$OS-$MODE-stages.log"
: > "$STAGELOG"

# 阶段打点：同时落盘（事后对日志看耗时）与打屏（现场看进度）
STAGE_NAME=""; STAGE_T0=0; STAGE_START=""
stage_begin() { STAGE_NAME="$1"; STAGE_T0=$(date +%s); STAGE_START=$(date -u '+%H:%M:%S'); printf '[c] >>> %s\n' "$STAGE_NAME"; }
stage_end() {
  local t1 d; t1=$(date +%s); d=$((t1 - STAGE_T0))
  printf '# [阶段] %-14s start=%s end=%s 耗时=%ss\n' \
    "$STAGE_NAME" "$STAGE_START" "$(date -u '+%H:%M:%S')" "$d" >> "$STAGELOG"
  printf '[c] <<< %s 耗时 %ss\n' "$STAGE_NAME" "$d"
}

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
stage_begin "加速器探测"
if kvm_probe; then
  ACCEL="accel=kvm"; CPU="host"; ACCEL_DESC="KVM（/dev/kvm 可用且 kvm 加速初始化成功）"
else
  ACCEL="accel=tcg"; CPU="max";  ACCEL_DESC="TCG（无 KVM 或 kvm 初始化失败 → 纯软件模拟，约慢 5-10 倍，但可用）"
  [ -e /dev/kvm ] && ACCEL_DESC="TCG（/dev/kvm 节点存在但 -accel kvm 初始化失败 → 降级软件模拟）"
fi
echo "[c] 加速器: $ACCEL_DESC"
stage_end
{
  echo "# os=$OS  mode=$MODE"
  echo "# params: disk=$DISK_SIZE mem=${MEM_MB}MiB smp=$SMP attach_ro=${ATTACH_RO:-none}"
  echo "# accel=$ACCEL cpu=$CPU"
} >> "$STAGELOG"

# --- 虚拟盘
stage_begin "准备虚拟盘"
if [ ! -f "$DISK" ]; then
  qemu-img create -f qcow2 "$DISK" "$DISK_SIZE" >/dev/null || { stage_end; echo "建盘失败" >&2; exit 3; }
  echo "[c] 新建 $DISK ($DISK_SIZE)"
else
  echo "[c] 复用已有 $DISK（--disk 仅对新建生效）"
fi
echo "[c] $(qemu-img info "$DISK" 2>/dev/null | grep -i 'virtual size' | head -1)"
stage_end

# --- kickstart / autoinstall：注入公钥
stage_begin "准备 kickstart"
PUBKEY_FILE="${VM_PUBKEY:-/vm/vmtest_ed25519.pub}"
[ -f "$PUBKEY_FILE" ] || { stage_end; echo "缺公钥 $PUBKEY_FILE" >&2; exit 3; }
mkdir -p /vm/ks-serve
PUB="$(cat "$PUBKEY_FILE")"
if [ "$OS" = ubuntu ]; then
  # subiquity nocloud 数据源从 seedfrom 取 /user-data 与 /meta-data
  sed "s|@SSH_PUBKEY@|$PUB|" /vmtest/ks/ubuntu-user-data.yml > /vm/ks-serve/user-data
  cp /vmtest/ks/ubuntu-meta-data.yml /vm/ks-serve/meta-data
  echo "[c] autoinstall /vm/ks-serve/{user-data,meta-data}  ($(wc -c < /vm/ks-serve/user-data) B)"
else
  sed "s|@SSH_PUBKEY@|$PUB|" "/vmtest/ks/$OS-min.ks" > /vm/ks-serve/ks.cfg
  echo "[c] kickstart /vm/ks-serve/ks.cfg  ($(wc -c < /vm/ks-serve/ks.cfg) B)"
fi
stage_end

# --- 起 perl HTTP 服务（流式 + Range，见 ks-httpd.pl 头注释）
stage_begin "启动 ks-httpd"
if ! (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null; then
  nohup perl /vmtest/ks-httpd.pl 8000 /vm/ks-serve > /vm/ks-serve/httpd.log 2>&1 &
  for i in $(seq 1 30); do sleep 0.2; (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null && break; done
  (exec 3<>/dev/tcp/127.0.0.1/8000) 2>/dev/null || { stage_end; echo "ks-httpd 未就绪" >&2; cat /vm/ks-serve/httpd.log; exit 4; }
  echo "[c] ks-httpd :8000 就绪（guest 侧 10.0.2.2:8000）"
else
  echo "[c] ks-httpd 已在监听 :8000（复用）"
fi
stage_end

# --- ubuntu 装机期：把 ISO 服务成本地 apt 镜像（:8001）
# 背景（2026-11-12 五轮装机实测）：subiquity 对 target 内 apt-get update 失败一律致命，
# 而宿主 clash TUN 对 archive.ubuntu.com 502/200 摇摆，外网镜像不能作确定性依赖；
# 断网（ip link down）也拦不住 subiquity 自己重放 netplan。终解：ISO 里 dists/jammy
# 恰好只含 main+restricted（pool 含 openssh-server），配合 autoinstall 的
# disable_suites/disable_components 后 primary 源全部命中本地 httpd —— 零外网依赖。
stage_begin "挂载 ISO 为 apt 镜像"
if [ "$OS" = ubuntu ] && [ "$MODE" = install ]; then
  mkdir -p /iso-mnt
  if mount -o loop,ro "/iso/$ISO_FILE" /iso-mnt 2>/dev/null; then
    nohup perl /vmtest/ks-httpd.pl 8001 /iso-mnt > /vm/ks-serve/apt-httpd.log 2>&1 &
    for i in $(seq 1 30); do sleep 0.2; (exec 3<>/dev/tcp/127.0.0.1/8001) 2>/dev/null && break; done
    (exec 3<>/dev/tcp/127.0.0.1/8001) 2>/dev/null || { stage_end; echo "apt 镜像 httpd 未就绪" >&2; cat /vm/ks-serve/apt-httpd.log; exit 4; }
    echo "[c] apt 镜像 httpd :8001 就绪（guest 侧 http://10.0.2.2:8001/，loop mount /iso-mnt）"
  else
    stage_end; echo "ISO loop mount 失败（--privileged 容器内应有 /dev/loop-control）" >&2; exit 4
  fi
else
  echo "[c] 非 ubuntu 装机模式，跳过 apt 镜像"
fi
stage_end

COMMON=( -machine "q35,$ACCEL" -cpu "$CPU" -m "$MEM_MB" -smp "$SMP" -display none
         -drive file="$DISK",if=virtio,format=qcow2,cache=unsafe
         -cdrom "$ISO" -boot order=c
         -netdev "user,id=n0,hostfwd=tcp::2222-:22" -device virtio-net-pci,netdev=n0
         -monitor none -no-reboot -name "tianji-$OS" )

# 串口形态：默认纯落盘；TIANJI_SERIAL_TELNET=1 时改 telnet(2301)+logfile 双路 ——
# 装机失败停在 error shell 时，宿主可直连串口现场取证（挂盘/chroot/看 target 配置）。
# 宿主侧容器需 -p 2301:2301（host 模式恒定发布）。telnet 接入工具：宿主 python socket。
if [ -n "${TIANJI_SERIAL_TELNET:-}" ]; then
  SERIAL=( -chardev "socket,id=s0,host=0.0.0.0,port=2301,server=on,wait=off,logfile=$LOG"
           -serial chardev:s0 )
  echo "[c] 串口 = telnet 2301（容器内）+ logfile=$LOG"
else
  SERIAL=( -serial "file:$LOG" )
fi

# --- 只读挂载镜像 tar（仅 boot 模式：装盘时挂第三块盘会被 clearpart 波及）
EXTRA=( )
if [ -n "$ATTACH_RO" ]; then
  if [ "$MODE" = install ]; then
    echo "[c] 注意: --attach-ro 只在 boot 模式挂载（装盘阶段挂载会被 clearpart 波及），本次忽略"
  else
    [ -f "$ATTACH_RO" ] || { echo "找不到 --attach-ro 文件: $ATTACH_RO" >&2; exit 3; }
    EXTRA=( -drive "file=$ATTACH_RO,if=virtio,format=raw,readonly=on" )
    echo "[c] 只读挂入: $ATTACH_RO（guest 内用 lsblk/blkid 确认设备名，通常是 /dev/vdb）"
  fi
fi

stage_begin "组装启动参数"
if [ "$FRESH" = 1 ]; then
  EXDIR="/vm/boot-$OS"; rm -rf "$EXDIR"; mkdir -p "$EXDIR"
  if [ "$OS" = ubuntu ]; then
    SRC=(casper/vmlinuz casper/initrd)     # casper 引导：内核与 initrd 在 /casper/
  else
    SRC=(images/pxeboot/vmlinuz images/pxeboot/initrd.img)
  fi
  DST=(vmlinuz initrd.img)                 # 本地统一命名，后面 -kernel/-initrd 不用分叉
  for i in 0 1; do
    isoinfo -R -i "$ISO" -x "/${SRC[$i]}" > "$EXDIR/${DST[$i]}" 2>/dev/null
    [ -s "$EXDIR/${DST[$i]}" ] || { stage_end; echo "从 ISO 抽 /${SRC[$i]} 失败" >&2; exit 5; }
  done
  echo "[c] 内核: $(ls -l "$EXDIR" | tail -2 | awk '{print $5, $9}' | tr '\n' ' ')"
  if [ "$OS" = ubuntu ]; then
    # subiquity autoinstall：nocloud 数据源 + 串口控制台；boot=casper 让 casper initramfs 生效
    APPEND="boot=casper autoinstall ds=nocloud;s=http://10.0.2.2:8000/ ip=dhcp console=ttyS0,115200n8"
  else
    APPEND="inst.ks=http://10.0.2.2:8000/ks.cfg inst.stage2=hd:LABEL=$LABEL inst.repo=hd:LABEL=$LABEL ip=dhcp inst.text inst.cmdline console=ttyS0,115200n8"
  fi
  ARGS=( "${COMMON[@]}" ${EXTRA[@]+"${EXTRA[@]}"} ${SERIAL[@]+"${SERIAL[@]}"} -kernel "$EXDIR/vmlinuz" -initrd "$EXDIR/initrd.img" -append "$APPEND" )
else
  ARGS=( "${COMMON[@]}" ${EXTRA[@]+"${EXTRA[@]}"} ${SERIAL[@]+"${SERIAL[@]}"} )
fi
stage_end

printf 'qemu-system-x86_64 ' > "$CMDLOG"
printf '%q ' "${ARGS[@]}" >> "$CMDLOG"; echo >> "$CMDLOG"

stage_begin "qemu 运行($MODE)"
echo "[c] 启动 qemu，串口 -> $LOG"
qemu-system-x86_64 "${ARGS[@]}" >> "$LOG_DIR/$OS-$MODE-qemu.out" 2>&1
RC=$?
stage_end

# 串口日志开头补头部：加速器 + 参数 + 阶段耗时。事后看日志才不会把 TCG 的慢误判成系统卡死，
# 也不会出现「到底卡在哪一段」只能靠猜。
if [ -s "$LOG" ]; then
  TMP="$LOG.hdr"
  {
    echo "# ===== tianji vmtest ====="
    echo "# os=$OS  mode=$([ "$FRESH" = 1 ] && echo install || echo boot-installed)"
    echo "# accel=$ACCEL cpu=$CPU"
    echo "# params: disk=$DISK_SIZE mem=${MEM_MB}MiB smp=$SMP attach_ro=${ATTACH_RO:-none}"
    echo "# qemu rc=$RC  finished=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# cmd: $(head -1 "$CMDLOG")"
    echo "# stages（明细见 logs/$OS-$MODE-stages.log）："
    sed 's/^/  /' "$STAGELOG"
    echo "# ========================="
    cat "$LOG"
  } > "$TMP" && mv "$TMP" "$LOG"
fi
echo "[c] qemu 退出 rc=$RC；阶段打点 -> $STAGELOG"
sed 's/^/  /' "$STAGELOG" 2>/dev/null
tail -15 "$LOG" 2>/dev/null
exit $RC

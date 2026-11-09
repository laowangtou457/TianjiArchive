#!/usr/bin/env bash
# 天玑档案 变体 B：对已装好的麒麟 / 统信 guest 做 OS 基线探测（六项 + 附加）
#
# 用法（宿主仓库根目录）：
#   bash installer/vmtest/probe.sh --os kylin
#   bash installer/vmtest/probe.sh --os uos --port 2222
#
# 前置：run-vm.sh 启动的 qemu 仍在跑（hostfwd 2222 -> guest 22）。
# 产物：installer/vmtest/logs/<os>-probe.txt（原文，入库；退出码随 ssh 返回）
#
# 注意：探测脚本**只读**，唯二例外是末尾的临时 modprobe（不改任何配置文件）。
set -uo pipefail

OS=""; PORT=2222
while [ $# -gt 0 ]; do
  case "$1" in
    --os) OS="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ "$OS" = kylin ] || [ "$OS" = uos ] || { echo "必须指定 --os kylin|uos" >&2; exit 2; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
KEY="${TIANJI_VM_KEY:-E:/tmp-vm/vmtest_ed25519}"
OUT="$REPO_DIR/installer/vmtest/logs/$OS-probe.txt"
mkdir -p "$(dirname "$OUT")"

[ -f "$KEY" ] || { echo "缺私钥 $KEY" >&2; exit 3; }
chmod 600 "$KEY" 2>/dev/null
SSH=( ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
      -o IdentitiesOnly=yes -o ConnectTimeout=6 -o LogLevel=ERROR root@127.0.0.1 )

echo "[probe] 等 sshd 起来（最多 300s；TCG 无 KVM 时开机到 sshd 要 1-3 分钟）…"
for i in $(seq 1 150); do
  if "${SSH[@]}" true 2>/dev/null; then echo "[probe] ssh 通了（第 $i 次尝试，约 $((i*2))s）"; break; fi
  [ "$i" = 150 ] && { echo "[probe] ssh 连不上，放弃" >&2; exit 4; }
  sleep 2
done

{
  echo "##############################################################################"
  echo "# 天玑档案 变体 B —— OS 基线探测原文"
  echo "# 目标系统: $OS"
  echo "# 采集时间(宿主): $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 采集方式: bash installer/vmtest/probe.sh --os $OS  (ssh root@127.0.0.1:$PORT)"
  echo "##############################################################################"
} | tee "$OUT"

"${SSH[@]}" 'bash -s' 2>&1 <<'REMOTE' | tee -a "$OUT"
set -u
sec() { echo; echo "===== [$1] $2 ====="; }
run() { echo "\$ $*"; eval "$@" 2>&1; echo "[rc=$?]"; }

sec 0 "系统标识"
run 'cat /etc/os-release'
run 'uname -a'
run 'hostnamectl 2>/dev/null | head -8'

sec 1 "SELinux 默认状态"
run 'command -v getenforce || echo "(无 getenforce，说明未装 selinux 用户态工具)"'
run 'getenforce 2>&1 || true'
run 'cat /sys/fs/selinux/enforce 2>&1 || echo "(无 /sys/fs/selinux/enforce → 内核侧未启用 SELinux)"'
run 'grep -E "^SELINUX=" /etc/selinux/config 2>&1 || echo "(无 /etc/selinux/config)"'
run 'sestatus 2>&1 | head -8 || echo "(无 sestatus)"'
run 'ls /sys/fs/selinux 2>&1 | head -5'
run 'rpm -q selinux-policy-targeted container-selinux 2>&1'

sec 2 "麒麟 kysec（统信应为全无，这本身就是结论）"
run 'command -v getstatus || echo "(无 getstatus)"'
run 'command -v kysec_get; command -v setstatus'
run 'getstatus 2>&1 || true'
run 'getstatus -m kysec 2>&1 || true'
run 'getstatus -m exectl 2>&1 || true'
run 'systemctl is-active kysec-daemon 2>&1; systemctl is-enabled kysec-daemon 2>&1'
run 'ps -ef | grep -i kysec | grep -v grep || echo "(无 kysec 进程)"'
run 'ls -la /etc/kysec/db/ 2>&1 | head -10'
run 'rpm -qa | grep -i kysec || echo "(未安装任何 kysec 包)"'

sec 3 "cgroup 版本"
run 'stat -fc %T /sys/fs/cgroup'
run 'cat /proc/self/cgroup'
run 'mount | grep cgroup | head -5'

sec 4 "iptables 后端"
run 'iptables --version'
run 'command -v iptables-nft iptables-legacy 2>&1'
run 'iptables -t nat -L -n 2>&1 | head -3'
run 'nft list tables 2>&1 | head -3'

sec 5 "xfs ftype（overlay2 前提）"
run 'findmnt -no FSTYPE,SOURCE /'
run 'xfs_info / 2>&1 | tr "," "\n" | grep -i ftype || echo "(根不是 xfs 或 xfs_info 不可用)"'
run 'xfs_info /boot 2>&1 | tr "," "\n" | grep -i ftype || true'

sec 6 "内核 / glibc / systemd"
run 'systemctl --version | head -1'
run 'uname -r'
run 'rpm -q glibc systemd kernel kernel-core 2>&1'
run 'rpm -q xfsprogs iptables nftables libseccomp 2>&1'

sec 7 "firewalld"
run 'systemctl is-active firewalld 2>&1; systemctl is-enabled firewalld 2>&1'
run 'firewall-cmd --state 2>&1 || true'
run 'firewall-cmd --get-default-zone 2>&1 || true'

sec 8 "附加：overlay / br_netfilter 能否加载（决定 docker 可行性）"
run 'ls /usr/lib/modules/$(uname -r)/kernel/fs/overlayfs/ 2>&1 || ls /lib/modules/$(uname -r)/kernel/fs/overlayfs/ 2>&1'
run 'lsmod | grep -E "overlay|br_netfilter" || echo "(均未加载)"'
run 'modprobe overlay 2>&1; modprobe br_netfilter 2>&1; lsmod | grep -E "overlay|br_netfilter" || echo "(加载失败)"'
run 'sysctl net.bridge.bridge-nf-call-iptables 2>&1'

sec 9 "附加：docker 相关前置（发行版自带版本、磁盘、内核模块）"
run 'dpkg -l 2>/dev/null | head -1; rpm -qa | grep -iE "^docker|^podman|container-selinux" || echo "(无容器包)"'
run 'df -hT / | tail -2'
run 'free -m | head -2; nproc'

echo; echo "===== [done] 探测结束 $(date -u '+%Y-%m-%dT%H:%M:%SZ') ====="
REMOTE

echo "[probe] 已保存: $OUT ($(wc -l < "$OUT") 行)"

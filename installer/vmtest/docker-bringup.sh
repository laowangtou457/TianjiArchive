#!/usr/bin/env bash
# 天玑档案 变体 B 附加实测：把 docker 27.5.1 静态载荷真的搬进国产 OS 里跑起来
#
# 对应 docs/VARIANT-B-OS-BASELINE.md §7 的第 4、6 项：
#   4. cgroup v1 上 dockerd 27.5.1 的实际启动行为（能不能起、选了什么 driver/cgroup）
#   6. firewalld reload / restart 后 docker 写的 iptables 链还在不在（端口会不会全不通）
#
# 用法（宿主仓库根目录，qemu 在跑、能 ssh 进 guest）：
#   bash installer/vmtest/docker-bringup.sh --os kylin
#
# 产物：
#   installer/vmtest/logs/<os>-dockerd.txt   本次会话看到的全部输出
#   guest:/root/tianji-diag.txt              同一份诊断，**落盘在 guest 里**
#
# 为什么要落盘到 guest：guest 内一旦出现网桥接口（dockerd 默认建 docker0 就算），QEMU user
# 网络下的 SSH 就会失联（根因见下方「读数须知」），宿主 ssh 会话直接断、输出全丢。落盘后可以
# 重启 guest（清掉运行时 iptables 状态）再 `cat /root/tianji-diag.txt` 把现场取回来。
# 重启后重新拿回输出的方法：
#   bash installer/vmtest/run-vm.sh --os kylin            # 重新引导
#   ssh -i E:/tmp-vm/vmtest_ed25519 -p 2222 root@127.0.0.1 cat /root/tianji-diag.txt
#
# ⚠ 读数须知（2026-11-09 二分实验结论）：
#   失联的触发条件不是 firewalld，而是 **guest 内出现了网桥接口**。QEMU user 网络(slirp) 在
#   guest 多一个接口后就投递不进 guest（所以 iptables 命中计数全是 0）。手工 `ip link add
#   docker0 type bridge` 可立刻复现；`--bridge=none --iptables=false` 则完全不发生。
#   → 本脚本第 [5]/[6] 段（firewalld reload/restart 之后的观测）**受此限制**，
#     只能用来取「reload 是否清 DOCKER 链」这类在失联前就能拿到的值；
#     不能用它判断「OS 把管理面弄挂了」。真正的 OS 级冲突见 docs/VARIANT-B-VM-RESULT.md §2.6(A)
#     —— 统信的 `ZONE_CONFLICT: 'docker0' already bound to a zone`。
set -uo pipefail

OS=""; PORT=2222
while [ $# -gt 0 ]; do
  case "$1" in
    --os) OS="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ "$OS" = kylin ] || [ "$OS" = uos ] || { echo "必须指定 --os kylin|uos" >&2; exit 2; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
KEY="${TIANJI_VM_KEY:-E:/tmp-vm/vmtest_ed25519}"
[ -f "$KEY" ] || KEY="E:/tmp-vm/vmtest_ed25519"
PAYLOAD="$REPO_DIR/installer/build/payload/kylin-uos/docker-static"
OUT="$REPO_DIR/installer/vmtest/logs/$OS-dockerd.txt"
mkdir -p "$(dirname "$OUT")"
chmod 600 "$KEY" 2>/dev/null
[ -f "$PAYLOAD/docker-27.5.1.tgz" ] || { echo "缺载荷 $PAYLOAD/docker-27.5.1.tgz" >&2; exit 3; }

SSH=( ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
      -o IdentitiesOnly=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=3
      -o LogLevel=ERROR root@127.0.0.1 )
SCP=( scp -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
      -o IdentitiesOnly=yes -o LogLevel=ERROR )

{
  echo "##############################################################################"
  echo "# 附加实测：docker 27.5.1 静态载荷在 $OS 上的启动行为 + firewalld 冲突"
  echo "# 时间(宿主): $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "##############################################################################"
} | tee "$OUT"

"${SSH[@]}" 'mkdir -p /usr/local/lib/tianji/docker-static /usr/local/lib/docker/cli-plugins' || exit 4

# 载荷已存在就跳过（重跑时省 140MB 传输）
NEED_TGZ=$("${SSH[@]}" 'test -s /usr/local/lib/tianji/docker-static/docker-27.5.1.tgz && echo no || echo yes')
if [ "$NEED_TGZ" = yes ]; then
  echo "[dockerd] 传载荷（76M + 64M，走 ssh）…" | tee -a "$OUT"
  "${SCP[@]}" "$PAYLOAD/docker-27.5.1.tgz" root@127.0.0.1:/usr/local/lib/tianji/docker-static/ 2>&1 | tee -a "$OUT"
  "${SCP[@]}" "$PAYLOAD/docker-compose-linux-x86_64" root@127.0.0.1:/usr/local/lib/docker/cli-plugins/docker-compose 2>&1 | tee -a "$OUT"
else
  echo "[dockerd] 载荷已在 guest，跳过传输" | tee -a "$OUT"
fi

# 远程脚本：所有输出 tee 到 /root/tianji-diag.txt，SSH 断了也能事后取
"${SSH[@]}" 'bash -s' 2>&1 <<'REMOTE' | tee -a "$OUT"
set -u
D=/usr/local/lib/tianji/docker-static
DIAG=/root/tianji-diag.txt
: > "$DIAG"
lrun() { echo "\$ $*" >>"$DIAG"; eval "$@" >>"$DIAG" 2>&1; echo "[rc=$?]" >>"$DIAG"; }
sec()  { echo >>"$DIAG"; echo "===== [$1] $2 =====" >>"$DIAG"; }
say()  { echo "$*" >>"$DIAG"; echo "$*"; }

sec 0 "基线（dockerd 启动前）"
lrun 'iptables -S 2>&1 | head -12'
lrun 'ss -ltn 2>&1 | head -6'
lrun 'systemctl is-active firewalld; firewall-cmd --get-default-zone 2>&1'

sec 1 "解包"
if [ ! -x "$D/docker/dockerd" ]; then
  lrun "cd $D && tar -xzf docker-27.5.1.tgz && ls -l docker/ | head -10"
fi
lrun 'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose'
lrun 'ln -sf /usr/local/lib/tianji/docker-static/docker/* /usr/local/bin/'
lrun '/usr/local/lib/tianji/docker-static/docker/dockerd --version'
lrun '/usr/local/bin/docker --version'

sec 2 "起 dockerd（默认参数，含 --iptables=true）"
lrun 'pkill -f dockerd || true'
lrun 'sleep 1'
say "--- 下面这步之后 SSH 可能失联，现场已落盘 $DIAG ---"
lrun 'nohup /usr/local/lib/tianji/docker-static/docker/dockerd --data-root /var/lib/docker \
        --exec-root /var/run/docker --pidfile /var/run/docker.pid \
        --host unix:///var/run/docker.sock --storage-driver overlay2 > /root/dockerd.log 2>&1 &'
lrun 'for i in $(seq 1 40); do sleep 1; docker info >/dev/null 2>&1 && break; done; echo waited'
lrun 'docker info 2>&1 | grep -iE "Server Version|Storage Driver|Cgroup Version|Cgroup Driver|Kernel Version|Security Options|Docker Root Dir"'
lrun 'tail -20 /root/dockerd.log'

sec 3 "storage driver 实选结果"
lrun 'docker info 2>&1 | grep -i "Storage Driver"'
lrun 'ls -d /var/lib/docker/overlay2 2>&1; mount | grep -c overlay'

sec 4 "iptables 链（docker 是否写下）"
lrun 'iptables -t nat -S 2>&1 | grep -E "DOCKER|MASQUERADE" | head -10'
lrun 'iptables -S FORWARD 2>&1 | head -8'
lrun 'iptables -t nat -S 2>&1 | grep -c DOCKER'

sec 5 "SSH 是否还活着（dockerd 起来以后）"
lrun 'ss -ltnp 2>&1 | grep -E ":22\b"'
lrun 'systemctl is-active sshd'

sec 6 "firewalld 冲突：reload / restart 后 docker 链还在不在"
lrun 'firewall-cmd --permanent --zone=trusted --add-interface=docker0'
lrun 'iptables -t nat -S 2>&1 | grep -c DOCKER'
say "--- firewall-cmd --reload"
lrun 'firewall-cmd --reload'
lrun 'sleep 2'
lrun 'iptables -t nat -S 2>&1 | grep -c DOCKER'
lrun 'iptables -t nat -S 2>&1 | grep DOCKER | head -5'
say "--- systemctl restart firewalld"
lrun 'systemctl restart firewalld'
lrun 'sleep 3'
lrun 'iptables -t nat -S 2>&1 | grep -c DOCKER'
lrun 'firewall-cmd --zone=trusted --list-all 2>&1 | head -8'
lrun 'ss -ltnp 2>&1 | grep -E ":22\b"'

sec 7 "dockerd 重启后链是否重建"
lrun 'pkill -f dockerd; sleep 2'
lrun 'nohup /usr/local/lib/tianji/docker-static/docker/dockerd --data-root /var/lib/docker --storage-driver overlay2 > /root/dockerd2.log 2>&1 &'
lrun 'for i in $(seq 1 30); do sleep 1; docker info >/dev/null 2>&1 && break; done; echo waited'
lrun 'iptables -t nat -S 2>&1 | grep -c DOCKER'
lrun 'docker info 2>&1 | grep -iE "Storage Driver|Cgroup Version"'

sec 8 "收尾"
say "===== [done] $(date -u '+%Y-%m-%dT%H:%M:%SZ') ====="
echo "===== [diag 全文] ====="
cat "$DIAG"
REMOTE

RC=$?
echo "[dockerd] ssh 退出码 $RC"
if [ "$RC" -ne 0 ]; then
  cat <<'TIP' | tee -a "$OUT"

[!] ssh 中途断了（多半是 dockerd 起来后管理通道被打断，这本身就是 §4.4 要验证的现象）。
    诊断已落盘在 guest 的 /root/tianji-diag.txt，重启 guest 后取回：
      docker rm -f tianji-vm-<os>; bash installer/vmtest/run-vm.sh --os <os>
      ssh -i E:/tmp-vm/vmtest_ed25519 -p 2222 root@127.0.0.1 cat /root/tianji-diag.txt
TIP
fi
echo "[dockerd] 已保存: $OUT"

# installer/e2e/ · 特权 systemd 容器内的十步端到端（降级验证途径）

**这是降级方案，不是真机验证。** 目的只有一个：在没有虚拟化工具的构建机上，尽量把
`S1_PREFLIGHT → S10_DONE` 这条真实路径跑一遍，把「哪一步在什么条件下会坏」找出来。
它能证明的东西和不能证明的东西在文末写清楚了，**不要拿它冒充真机验收**。

设计依据：`docs/INSTALLER-DESIGN.md` §4/§6；结论与未验证项登记在 `../README.md`。

## 为什么需要额外做一个 base 镜像

`ubuntu:22.04` 官方镜像里**没有** `/lib/systemd/systemd`（只带 `libsystemd0`），
直接 `docker run ubuntu:22.04 /lib/systemd/systemd` 会报：

```text
exec: "/lib/systemd/systemd": stat /lib/systemd/systemd: no such file or directory
```

所以先构建 `Dockerfile` 里的派生镜像（装上 `systemd systemd-sysv dbus`），再把它当 init 起。

## 跑法（构建机，Git Bash）

```bash
cd installer/e2e
docker build -t tianji-e2e-base:22.04 .

# 关键三件：--privileged、--cgroupns=host、把 /sys/fs/cgroup 挂进去；
# --tmpfs /run /run/lock 是 systemd 要写的运行目录。
docker run -d --name tj-e2e --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock \
  -v "//e/TianjiArchive:/repo" \
  tianji-e2e-base:22.04 /lib/systemd/systemd

docker exec tj-e2e sh -c 'cat /proc/1/comm; systemctl is-system-running'   # 期望 systemd / running|degraded

# 容器内只能 vfs（外层是 overlayfs），且不能碰 iptables —— 这是容器适配，真机不需要
docker exec tj-e2e sh -c 'mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<EOF
{"storage-driver":"vfs","iptables":false,"ip6tables":false}
EOF'

# 把镜像 tar 拷进容器本地盘（跨 bind mount 读 1.5GB 会让 docker load 慢很多）
docker cp ../../offline/tianji-offline-images.tar tj-e2e:/root/tianji-offline-images.tar

# 深度校验（root 会把 L-a 逐文件 + 镜像 tar 溯源都做完）
docker exec tj-e2e sh -c 'sh /repo/dist/installer/tianji-server-setup-*-amd64-*.run \
  --verify-only --images-tar /root/tianji-offline-images.tar'

# 起 Web 向导 → 填表单 → 一键执行（走真实前端路径，不绕过 UI）
docker exec -d tj-e2e bash -c 'nohup sh /repo/dist/installer/tianji-server-setup-*-amd64-*.run \
  --web --images-tar /root/tianji-offline-images.tar > /root/web.log 2>&1'
docker exec tj-e2e sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://127.0.0.1:18080/api/env -H "Content-Type: application/json" -d "{...8 项表单...}"'
docker exec -d tj-e2e bash -c 'curl -s -m 3000 -X POST http://127.0.0.1:18080/api/run-all > /root/runall.json'
docker exec tj-e2e sh /repo/installer/e2e/poll.sh        # 十步进度
```

`poll.sh` 用 POSIX sh 解析 `/api/status`（容器里没有 `python3`），只读、不改状态。

## ⚠️ 磁盘陷阱（本轮真踩，代价是整个构建机的 Docker 都停了）

**不要在「外层 Docker Desktop」的机器上用 vfs 跑嵌套 dockerd 加载 GB 级镜像。**
vfs 对每个镜像的每一层做**完整复制**（无硬链接），1.5GB 的 tar 展开后放大倍数在 10 倍量级；
它会先把 Docker Desktop 的 ext4 虚拟盘写满，再把你宿主的系统盘写满，然后：

1. daemon 报 `write /var/lib/desktop-containerd/.../meta.db: read-only file system`；
2. 容器 fs 变只读（`df` 直接 `Input/output error`）；
3. 最后 `Docker Desktop is unable to start`，**所有容器一起消失**（别人的也一起）。

本轮实测：`docker_data.vhdx` 45.3GB、宿主 C 盘总共 199GB → C 盘剩 ~700MB 时全线崩。
恢复要人工：退出 Docker Desktop → 腾 10–20GB → Settings → Troubleshoot → Clean/Purge data
→ 重启（`isAdmin=False` 且 `wsl.exe` / `com.docker.service` 在安全策略黑名单里时，命令行救不了）。

### vfs 放大倍数实测区间（留盘按这个算，别信「1.5G 的 tar 大概占 2G」）

| 轮次 | 载入情况 | 占盘 | 倍数 |
| --- | --- | --- | --- |
| 第一次（中断） | 7/8 镜像 | 22GB | **14.6 倍** |
| 第二次（8/8 全部载完） | 8 个镜像 | 40GB | **约 26 倍** |

镜像 tar 本体 1.51GB。倍数不是常数：vfs 对**每个镜像的每一层**做完整复制（无硬链接、
共享层也不去重），所以镜像越多、层越碎，倍数越高。**按 30 倍留盘**，即「1.5GB tar → 留 45GB 以上」。

**限额必须用 loop + ext4，`--storage-opt size=` 是假的**（本轮实测）：

```sh
docker run --rm --storage-opt size=1G alpine:3.20 df -h /     # 仍显示整盘 1006.9G，参数被静默忽略
```

Docker Desktop 的 overlayfs 驱动接受该参数但不实现配额。可用的硬限额是
「特权容器里给 dockerd 的数据根挂一个固定大小的 ext4」：

```sh
# 容器内（先自证：hostname / [ -f /.dockerenv ] / readlink -f /var/lib/docker 三样都打出来！）
systemctl stop docker docker.socket
rm -rf /var/lib/docker                      # ← 宿主 daemon 的数据根也叫这个路径，务必先自证在容器里
truncate -s 80G /root/nested-docker.img
mkfs.ext4 -q -F -m 1 -L tj-nested /root/nested-docker.img
mount -o loop /root/nested-docker.img /var/lib/docker
df -hT /var/lib/docker                      # 必须显示 79G ext4 /dev/loopX，不是 overlay 1006.9G
systemctl start docker
```

限额「是真的」要能证明，两步都留档：

```sh
dumpe2fs -h /dev/loop2 | grep -Ei 'block count|block size'   # 20971520 × 4096 = 80GiB
fallocate -l 200G /var/lib/docker/.probe                      # 期望 No space left on device
rm -f /var/lib/docker/.probe
```

`fallocate` 是秒级且不落数据（只做超额分配），比 `dd` 写 35GB 安全得多——**在宿主机磁盘
刚被写爆过一次的机器上，不要用 dd 做这个验证**。

**其余可选**：把 Docker Desktop 的磁盘镜像挪到有大余量的盘（Settings → Resources →
Disk image location），或干脆换真机/真 VM。详见 `../../offline/README.md` §8.3。

## 它证明了什么 / 没证明什么

**已证明**（本轮实测，见 `../README.md` §4）：

- 十步**全部 DONE**：`S1_PREFLIGHT`（`osMatch.level=exact`）→ `S2_VERIFY`（真 1.5GB tar
  `IS_PASS: YES`）→ `S3_DOCKER`（真 85 个 deb + `systemctl enable --now docker`，
  `client=29.9.3 server=29.9.3`）→ `S4_IMAGES`（**8/8** 镜像，1m30s）→ `S5_ENV`
  → `S6_UP`（**8/8 容器 running，6 个带 healthcheck 的全 healthy**，21.2s）
  → `S7_MIGRATE`（2.7s）→ `S8_SEED`（1.8s）→ `S9_SMOKE`（**4/4 PASS**，6.9s）
  → `S10_DONE`（`99-summary.txt`）；
- 这条路**真的抓到过两个单测抓不到的缺陷**：S3 的 `dpkg -i` Pre-Depends 参数顺序、
  S6 的 `volumes/esdata` 属主（ES 以 uid=1000 跑，报错完全不提属主）。修完各重跑一遍才通过。

**没证明**（所以不能算验收）：

- **这不是真机**：内核是构建机的（`6.18.54.1-microsoft-standard-WSL2`，不是 Ubuntu 22.04
  自带的 5.15）、**cgroup v2**（真机 Ubuntu 22.04 默认 v1 hybrid）、AppArmor 基本不生效、
  `dockerd` 跑在 **vfs** 而不是 overlay2（磁盘表现、inode 消耗、并发写性能全不一样）；
- 真机的 systemd 行为（unit 依赖顺序、`TimeoutStartSec`、restart 语义）只能靠真机验；
- 变体 B（麒麟/UOS 的 static 方案）完全不在这条路径上；
- 它证明了「安装器的十步逻辑在 Linux + 真 docker + 真镜像上能走通」，**不能**证明
  「在某台国产化服务器上能装好」。

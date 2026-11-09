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

**下次要做这步的话**：给容器加 `--storage-opt size=`/`--memory` 限额，或把 Docker Desktop 的
磁盘镜像挪到有大余量的盘（Settings → Resources → Disk image location），或干脆换真机/真 VM。

## 它证明了什么 / 没证明什么

**已证明**（本轮实测，见 `../README.md` §4）：

- `S1_PREFLIGHT`：OS 识别为 `Ubuntu 22.04.5 LTS` → `osMatch.level=exact`，K 值实测
  （`vm.max_map_count=262144`、磁盘 1007GB、内存充足）；
- `S2_VERIFY`：真 1.5GB 镜像 tar 的深度校验 `IS_PASS: YES`，12.8s；
- `S3_DOCKER`：真 85 个 deb 的 `dpkg -i` + `systemctl enable --now docker` 成功，
  `client=29.9.3 server=29.9.3`、`systemctl is-active docker=active`。
  （这一步先暴露了 Pre-Depends 顺序缺陷，修完才通过——这就是做这层的价值。）

**没证明**（所以不能算验收）：

- `S4_IMAGES` 之后（`docker load` 全量、`compose up --wait`、`migrate`、`seed`、四项冒烟）
  **一次都没跑完**；
- 容器不是真机：内核是构建机的（本轮 `6.18.54.1-microsoft-standard-WSL2`，不是
  Ubuntu 22.04 自带的 5.15）、**cgroup v2**（真机 Ubuntu 22.04 默认 v1 hybrid）、
  AppArmor 基本不生效、`dockerd` 跑在 `vfs` 而不是 `overlay2`；
- 真机的 systemd 行为（unit 依赖顺序、`TimeoutStartSec`、restart 语义）只能靠真机验。

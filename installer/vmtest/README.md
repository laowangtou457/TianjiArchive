# 变体 B 真机验证：容器化 QEMU 装 麒麟 V10 SP3 / 统信 UOS 20

目的：把 `docs/VARIANT-B-OS-BASELINE.md` §7 里六项「未验证」变成**有命令有输出**的实测结论。
不是读包列表，是真的装进虚拟盘、开机、跑 `getenforce` / `getstatus` / `xfs_info`。

结论汇总见 **`docs/VARIANT-B-VM-RESULT.md`**；本文件只讲怎么复现。

---

## 1. 前置

| 依赖 | 要求 | 说明 |
|---|---|---|
| 宿主 | Windows + Docker Desktop（WSL2 后端） | 不需要装 VirtualBox/VMware/Hyper-V |
| 镜像 | `tianji-qemu:1` | ubuntu 22.04 + qemu 6.2 + isoinfo(genisoimage) + perl + socat，无 python3/curl |
| 磁盘 | 空闲 ≥ 40G | 虚拟盘 30G 稀疏 + 日志；**不要在 C 盘上跑**（见坑 5） |
| KVM | **可选** | 没有 `/dev/kvm` 就走 TCG，实测可用（麒麟最小化装机 ~14 分钟到 499/499 包）。脚本会先真起一次 `-accel kvm` 探测，失败才降级，并把最终选择写进日志首行 |
| ISO | `E:\国产OS镜像\Kylin-Server-V10-SP3-2403-Release-20240426-X86_64.iso`（卷标 `Kylin-Server-10`）<br>`E:\国产OS镜像\uniontechos-server-20-1020e-amd64.iso`（卷标 `UnionTechOS`） | 只读挂载，不入库 |
| SSH 密钥 | `E:/tmp-vm/vmtest_ed25519`（+ `.pub`） | 缺了自己生成：`ssh-keygen -t ed25519 -N "" -f E:/tmp-vm/vmtest_ed25519` |

> **TCG 是正式路径，不是降级方案。** 这台机器上 Docker Desktop 的 WSL2 实例并没有稳定的 KVM
> （`/dev/kvm` 时有时无，宿主侧 `/sys/module/kvm*` 甚至会整个消失），任何「必须 KVM」的
> 设计都会在这里跑不通。`run-vm.sh` 的做法是：`kvm_probe()` 真起一次最小 QEMU，
> 被 `timeout` 强杀（rc=124/137）才算 kvm 可用，否则 `accel=tcg`。

镜像与宿主路径可用环境变量覆盖：`TIANJI_ISO_DIR`、`TIANJI_VM_DIR`、`TIANJI_VM_KEY`。

## 2. 一键复现

```bash
# 装麒麟（清盘 -> 无人值守安装 -> anaconda 结束时 qemu 自行退出）
bash installer/vmtest/run-vm.sh --os kylin --fresh

# 装完立刻探测（qemu 需仍在跑，hostfwd 2222 -> guest 22）
bash installer/vmtest/probe.sh --os kylin

# 换统信
bash installer/vmtest/run-vm.sh --os uos --fresh
bash installer/vmtest/probe.sh --os uos
```

`run-vm.sh` 在宿主上跑时自己进容器（`docker run -d` **分离**模式，见坑 1），
串口日志实时落 `installer/vmtest/logs/<os>-install.log`，可以另开终端 `tail -f`。

### 目录

```
installer/vmtest/
├── run-vm.sh          # 建盘 + 起 http + 引导 anaconda（宿主/容器双模式）
├── probe.sh           # ssh 进 guest 采集六项 + 附加
├── ks-httpd.pl        # 喂 kickstart 的极简 HTTP（镜像里没 python3/curl）
├── ks/kylin-min.ks    # 麒麟无人值守 kickstart
├── ks/uos-min.ks      # 统信（仅 hostname/注释差异）
└── logs/              # 串口全文 + 探测原文（文本，入库）
```

## 3. 安装器是怎么被引导的

```
qemu-system-x86_64 -machine q35,accel=<kvm|tcg> \
  -kernel <ISO>/images/pxeboot/vmlinuz -initrd <ISO>/images/pxeboot/initrd.img \
  -append "inst.ks=http://10.0.2.2:8000/ks.cfg
           inst.stage2=hd:LABEL=<卷标> inst.repo=hd:LABEL=<卷标>
           ip=dhcp inst.text inst.cmdline console=ttyS0,115200n8" \
  -cdrom <ISO> -drive file=<os>.qcow2,if=virtio \
  -netdev user,id=n0,hostfwd=tcp::2222-:22 -device virtio-net-pci,netdev=n0 \
  -display none -serial file:logs/<os>-install.log -no-reboot
```

要点：
- `ip=dhcp` 是必须的——dracut 阶段就要能拉 `inst.ks`，否则 kickstart 拿不到，安装变交互式卡死。
- `inst.stage2=hd:LABEL=` 让 dracut 用卷标找 ISO 上的 stage2，不需要 isolinux，也不需要把 ISO 解压。
- `-no-reboot` 让 anaconda 装完那次重启直接把 QEMU 顶掉，**退出码 0 就是「装完」的硬信号**。
- kickstart 里**故意不写 `selinux` 指令**，否则测不出发行版默认态。

## 4. 已知坑（都是这次踩出来的，按踩到顺序）

1. **`docker run -i` 会把安装绑死在客户端上**。客户端一被信号打断，容器立刻死，
   日志停在一半、报 `error waiting for container: unexpected EOF`。
   → 改为 `docker run -d --name tianji-vm-<os>` + `docker wait`。
2. **`isoinfo -x` 必须带 `-R`**。不带的话抽出来的 `vmlinuz` 是 0 字节（ISO 用的是 Rock Ridge 路径），
   qemu 会直接报内核格式错。`-J`（Joliet）也行。
3. **`tianji-qemu:1` 里没有 python3 / curl / busybox**，只有 perl 5.34。
   `python3 -m http.server` 那套跑不起来 → 用 `ks-httpd.pl`（IO::Socket::INET，核心模块，零依赖）。
4. **`/dev/kvm` 在 Docker Desktop（WSL2）上不可信**。同一次会话里前面还能用，后面
   `/sys/module/kvm*` 直接消失（宿主 `/dev` 里也没有 kvm 节点了）。脚本自动降级到 TCG，
   并把实际加速器写进日志首行——否则「慢」会被误判成「系统卡死」。
5. **C 盘写满会让 Docker daemon 存储变只读，然后整体起不来**。真实报错原文（按出现顺序）：
   ```
   docker run   → write /var/lib/desktop-containerd/daemon/io.containerd.metadata.v1.bolt/meta.db:
                  read-only file system
   docker logs  → open /var/lib/docker/containers/<id>/local-logs/container.log: read-only file system
   docker info  → Error response from daemon: Docker Desktop is unable to start
   docker version → failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
   ```
   触发条件：Docker 的数据盘 `AppData\Local\Docker\wsl\disk\docker_data.vhdx`（45.3GB）
   所在的 C 盘只剩几 MB，vhdx 无法增长 → VM 内 ext4 报错转只读 → engine 挂掉。
   **这不是脚本问题，但会伪装成脚本失败**，装之前先 `df -h /c`，且虚拟盘/日志一律放 E 盘。
   注意：`E:\tmp-vm\*.qcow2` 与 `installer/vmtest/logs/` 都是宿主文件，Docker 数据被清也不影响。
6. **Windows/Docker 的路径转换**：Git Bash 会把 `-v E:/x:/y` 里的路径改写，必须
   `MSYS_NO_PATHCONV=1`，脚本里已处理。
7. **往 guest 写完文件要 `sync` 再杀 QEMU**。qemu 被强杀时 guest 的 ext4 页缓存会丢，
   本次就丢过一整份实验脚本（`/root/exp3.sh` 写完 3 分钟后消失，白跑一轮）。
8. **SSH 一断，ssh 会话里的远程脚本会被 SIGHUP 带走**。要在 guest 里做「可能断网」的实验，
   必须用 systemd 单元（`systemctl start --no-block`）或 `setsid` 启动 + 每步写盘 + `sync`，
   否则断网那一刻证据全丢。本仓库的取证脚本就是这么做的（见 `docs/VARIANT-B-VM-RESULT.md` §2.6）。
9. **QEMU user 网络（slirp）不能验证「guest 内跑 docker 之后的管理面可达性」**。
   guest 一旦建出网桥接口（dockerd 默认行为，或手工 `ip link add docker0 type bridge`），
   宿主经 `hostfwd` 的 SSH 就再也连不进去：sshd 还在监听、loopback:22 可连、
   **iptables 命中计数全 0**（SYN 没到 guest 协议栈）；重启 guest 即恢复；`--bridge=none` 不发生。
   我第一次把这个现象误判成「firewalld 重启打断管理面」，做了二分才改过来（见 §2.6）。
   → 要测 docker 之后的端口可达性，请改用 tap/bridge 网络，或在 guest 内部自测，别用 hostfwd+ssh。
10. **麒麟/统信上 dockerd 二次启动可能直接失败**：`Failed to program NAT chain:
   ZONE_CONFLICT: 'docker0' already bound to a zone`（统信实测）。firewalld 已经把 docker0
   绑进 zone，dockerd 再绑一次就冲突。处置：`systemctl disable --now firewalld` 或
   `--iptables=false`。**这一条才是真·OS 级冲突**，与坑 9 是两回事。

## 5. 时间成本（实测）

| 阶段 | KVM | TCG（无 /dev/kvm） |
|---|---|---|
| 麒麟最小化安装（499 包） | **4 分钟** | 约 16 分钟 |
| 首次开机到 SSH 可用 | 约 30 秒 | 约 2 分钟 |
| 探测（`probe.sh` 六项） | < 1 分钟 | < 1 分钟 |
| dockerd 实测（含 140MB 载荷走 ssh） | 3-5 分钟 | 8-12 分钟 |

有 KVM 时 4 分钟装完；没有 KVM 的 TCG 也能接受，不需要为此去装 VirtualBox。
加速器由 `kvm_probe()` 每次运行时实测（不缓存结论），结果写进串口日志首行。

## 6. 装完之后的实测结果

六项基线值、证据原文、与 `docs/VARIANT-B-OS-BASELINE.md` 的冲突点，全部在
**`docs/VARIANT-B-VM-RESULT.md`**。这里只留一条最要紧的：

> **`systemctl restart firewalld` 在 dockerd 运行时会打断外部访问（连带 SSH 管理面），且不自愈。**
> 实测 `--reload` 不会清 DOCKER 链，但 `restart` 会让外部 SYN 根本到不了 guest 的 INPUT
> （iptables 计数全 0）。处置：安装时直接 `systemctl disable --now firewalld`，把 docker0 加 trusted 无效。

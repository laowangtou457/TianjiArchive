# 变体 B 真机验证：容器化 QEMU 装 麒麟 V10 SP3 / 统信 UOS 20

目的：把 `docs/变体B-系统基线实测.md` §7 里六项「未验证」变成**有命令有输出**的实测结论。
不是读包列表，是真的装进虚拟盘、开机、跑 `getenforce` / `getstatus` / `xfs_info`。

结论汇总见 **`docs/变体B-真机实测结果.md`**；本文件只讲怎么复现。

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
# 1) 装麒麟（清盘 -> 无人值守安装 -> anaconda 执行 reboot，qemu 因 -no-reboot 自行退出 rc=0）
bash installer/vmtest/run-vm.sh --os kylin --fresh

# 2) 引导已装好的盘（安装阶段 qemu 已经退出，必须再起一次；这一步会一直开着等探测）
bash installer/vmtest/run-vm.sh --os kylin

# 3) 探测（qemu 需仍在跑，hostfwd 2222 -> guest 22）
bash installer/vmtest/probe.sh --os kylin

# 换统信，同样三步
bash installer/vmtest/run-vm.sh --os uos --fresh
bash installer/vmtest/run-vm.sh --os uos
bash installer/vmtest/probe.sh --os uos
```

`run-vm.sh` 在宿主上跑时自己进容器（`docker run -d` **分离**模式，见坑 1）。
装盘与引导**分开落日志**：`<os>-install.log` / `<os>-boot.log`（各自首行记录 accel），
可以另开终端 `tail -f`。

资源参数默认 **30G / 4GiB / 4 vCPU**（与已入库的复现口径一致，不要随手改默认值）；
跑完整栈或端到端验收时用 `--disk 60G --mem 10240 --smp 4`——**内存必须 10240**：
麒麟默认 `crashkernel=1024M,high` 吃掉 1GB，8192 会让 MemTotal 掉到 6.5GB 左右
在 S1 再撞一次 K10（10GB 下 MemTotal≈8.5GB，属 WARN 区可接受）。理由见 §7。

每段耗时写在 `<os>-<mode>-stages.log`，格式固定并同时并进串口日志头部：

```
# [阶段] 加速器探测     start=09:12:03 end=09:12:11 耗时=8s
# [阶段] qemu 运行(boot) start=09:12:14 end=09:16:29 耗时=255s
```

**判断「卡住还是正常慢」只看这个文件，不要靠猜**——TCG 下同一阶段比 KVM 慢 5-10 倍是正常的。

### 目录

```
installer/vmtest/
├── run-vm.sh          # 建盘 + 起 http + 引导 anaconda（宿主/容器双模式，含阶段打点）
├── probe.sh           # ssh 进 guest 采集六项 + 附加
├── ks-httpd.pl        # 喂 kickstart / .run 包的极简 HTTP（流式 + Range；镜像里没 python3/curl）
├── ks/kylin-min.ks    # 麒麟无人值守 kickstart
├── ks/uos-min.ks      # 统信（仅 hostname/注释差异）
└── logs/              # 串口全文 + 阶段打点 + 探测原文（文本，入库）
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
   否则断网那一刻证据全丢。本仓库的取证脚本就是这么做的（见 `docs/变体B-真机实测结果.md` §2.6）。
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
11. **`ks-httpd.pl` 第一版是整文件读入内存的**（`local $/; my $body = <$fh>`）。喂几 KB 的
   kickstart 没事，但要发 `.run` 包（实测 150,088,493 B）或镜像 tar（1,512,404,992 B）时，
   内存峰值可达文件大小的数倍，而且没有 `Range`，断了只能从 0 重来。
   → 已改为 64KB 分块 `sysread`/`syswrite` + `Range` 续传（`bytes=A-B` / `A-` / `-N`，206 + `Content-Range`，
   非法范围 416）。实测（`tianji-qemu:1` + 宿主 curl）：

   | 用例 | 结果 |
   |---|---|
   | 1.51GB 全量下载 | `http=200`、`1512404992 B`、9.3s、**容器峰值内存 5.27MiB** |
   | 1.51GB 完整性 | 下载件与源文件 sha256 一致 `50fde9a8…ad1372` |
   | 20MB 限速 4M/s 被超时打断于 5,238,685 B | `curl -C -` 续传返回 **206**，补传 `15,732,835 B`，最终 sha256 一致 |
   | `-r 99999999-`（超出文件） | **416** |
   | `HEAD` / 不存在路径 | `200` + `Accept-Ranges` / `404` |

   注意：上面 9.3s 是**宿主→容器的 loopback**，不代表 slirp 速度；guest 走 `10.0.2.2:8000`
   取包会慢得多（估 20-40MB/s）。这也是镜像 tar 改走只读盘的原因，见 §7。
12. **改完 HTTP 服务必须真装一次机验证，curl 通了不代表 anaconda 能用**。流式化第一次上线时，
   装机连续两次卡在 dracut（日志停在同一行数，约 20s 内无新输出，3 分钟后
   `Generating "/run/initramfs/rdsosreport.txt" / Press Enter for maintenance`），
   而宿主 curl 一切正常。根因：dracut 先发两个探活请求再断开，perl 收到 **SIGPIPE 直接退出**，
   等真正的 `GET /ks.cfg` 到来时 8000 端口已经没人监听 → dracut 静默重试到超时 → 掉进 emergency。
   → 修法：`$SIG{PIPE} = 'IGNORE'` + 每个连接用 `eval` 包裹，单个连接出事不拖垮守护进程。
   修完第三次装机通过（499/499、rc=0、`qemu` 阶段 246s）。`ks-httpd.pl` 现在把
   `方法 路径 range UA -> 状态 字节数` 写进 `ks-serve/httpd.log`，**装机失败先看这个文件**：
   正常应能看到 `HEAD /ks.cfg ... -> 200 0B` 两条探活 + `GET /ks.cfg ... ua=curl/7.71.1 -> 200 1256B`。

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

六项基线值、证据原文、与 `docs/变体B-系统基线实测.md` 的冲突点，全部在
**`docs/变体B-真机实测结果.md`**。这里只留两条最要紧的，注意它们是**不同性质**的两件事：

> **(A) 真·OS 级冲突（需要安装器处置）**：firewalld 已经把 `docker0` 绑进 zone，dockerd 再绑
> 就冲突 —— 同一系统**二次启动 dockerd 直接失败**：
> `Failed to program NAT chain: ZONE_CONFLICT: 'docker0' already bound to a zone`（统信实测）。
> 处置：安装时 `systemctl disable --now firewalld`，或给 dockerd 加 `--iptables=false`。
> 另外 `firewall-cmd --reload` 实测**不会**清掉 DOCKER 链（4→4），reload 本身是安全的。

> **(B) 测试环境假象（不要写进 OS 结论）**：本 README 的 `hostfwd + ssh` 手段**无法**验证
> 「guest 内跑 docker 之后的管理面可达性」。guest 一旦建出网桥接口，宿主 SSH 就再也连不进去，
> 看着像"OS 把管理面弄挂了"，实际是 QEMU user 网络（slirp）的限制，见坑 9。
> 我一度据此误判过 firewalld，做了二分实验才推翻 —— 要测端口可达性请用 tap/bridge 网络或在
> guest 内自测。

## 7. 端到端验收（变体 B 安装包）

验收对象不是「安装脚本能跑」，而是**现场用户的路径**：把 `setup.run` 与 `images.tar` 拷到机器上，
运行安装包、确认 tar 实际路径、走完十步、最后四项冒烟通过。

### 7.1 两种输入，两条不同的路径（别混）

| 输入 | 进 guest 的方式 | 为什么这样最忠实 |
|---|---|---|
| `images.tar`（1.51GB） | **只读 virtio 盘**：`--attach-ro`，模拟「用户已经把文件拷到这台机器上」 | 交付形态就是同目录两个文件，现场**没有 HTTP 服务器**。走 slirp 传输测到的是 QEMU user 网络的吞吐，不是产品行为 |
| `setup.run`（150MB） | **HTTP 固定别名** `server-setup.run`，对应「用户从分发介质拿到安装包」 | 只测「拿到包 → 执行」这一跳；别名与版本解耦，ks 不写死版本号 |

所以：**tar 不经过网络，.run 经过网络**。不要因为「反过来也能跑」就改回去。

### 7.2 步骤

> **先做日志隔离：用一份 vmtest 副本跑验收，基线 `logs/` 一个字节都不碰。**
> `logs/` 里的 `kylin-install.log` / `kylin-boot.log` 是「两版 OS 六项实测」的唯一凭证，
> **不可再生**；验收会重写同名文件，所以不能在同一份目录里跑。
> ```bash
> mkdir -p E:/tmp-vm/e2e/installer
> cp -r installer/vmtest E:/tmp-vm/e2e/installer/        # 副本自带独立 logs/
> export TIANJI_VM_DIR=E:/tmp-vm/e2e-vm                  # 验收用的独立虚拟盘目录
> # 下面所有 `installer/vmtest/...` 一律换成 `E:/tmp-vm/e2e/installer/vmtest/...`
> ```
> （`run-vm.sh` 用脚本自身的 `../..` 定位仓库根，所以副本必须放在 `<副本根>/installer/vmtest/` 这个形状下。）

```bash
# 1) 装 OS。--attach-ro 只在 boot 模式生效（装盘阶段挂第三块盘会被 clearpart 波及）
bash installer/vmtest/run-vm.sh --os kylin --fresh --disk 60G --mem 10240 --smp 4

# 2) 把 .run 放进 httpd 根目录并起固定别名（宿主可直接写，它挂载成容器内 /vm/ks-serve）
mkdir -p E:/tmp-vm/ks-serve
cp <构建产物>/tianji-server-setup-b-amd64-<ver>.run E:/tmp-vm/ks-serve/server-setup.run

# 3) 带镜像 tar 引导
bash installer/vmtest/run-vm.sh --os kylin --disk 60G --mem 10240 --smp 4 \
     --attach-ro E:/TianjiArchive/offline/tianji-offline-images.tar

# 4) 进 guest 执行（另开终端）
ssh -i E:/tmp-vm/vmtest_ed25519 -p 2222 root@127.0.0.1
```

guest 内先探设备名，**不要假设 `/dev/vdb`**：

```bash
lsblk -o NAME,SIZE,RO,TYPE,FSTYPE,MOUNTPOINT
blkid
# 期望看到一块 SIZE≈1.4G、RO=1 的盘，通常是 /dev/vdb（整盘，无分区）
curl -fSL --retry 3 -C - -o /root/server-setup.run \
     http://10.0.2.2:8000/server-setup.run
sha256sum /root/server-setup.run        # 与构建机产物核对
```

tar 路径怎么给安装器 —— **标准动作是 `dd` 落成普通文件，不是直接给设备节点**：

```bash
dd if=/dev/vdb of=/root/images.tar bs=4M status=progress   # 1.5GB，一分钟级，60G 盘放得下
sha256sum /root/images.tar                                  # 与构建机 tar 核对（可选）
# 然后安装器交互里确认 tar 路径时填 /root/images.tar
```

为什么不用 `/dev/vdb` 直给：**现场用户手里拿到的是普通文件**（从分发介质拷来的 tar），
产品只承诺「接受一个可读的普通文件路径」。`/dev/vdb` 是测试环境（只读 virtio 盘）的产物，
为它给产品加「接受块设备」的行为，是让测试需求污染产品语义。
（`tar -tf /dev/vdb` 技术上能读，但我们不用这条路径做验收。）

- **不要 `mount -o loop`**：tar 不是文件系统，loop 挂载会失败。

### 7.3 通过判据（三层 + 一条留痕）

1. **十步状态机到 S10**，汇总页能出访问地址（不是「步骤都跑了」，是「最后一步完成了」）。
2. **`docker info` 成功**且 `docker images` 里 **8/8** 镜像在（对 `offline/images.txt` 逐个点）。
3. **四项冒烟 4/4**：以安装器内置的 **Go 版**（`installer/server/internal/stack/stack.go`）输出为权威判据；
   `smoke.sh` 只作人工交叉核对（它依赖 curl + compose，且包内布局下直接跑会找不到 compose 文件）。
4. **firewalld 留痕**：安装报告里必须有「处置动作 + 执行前后 `systemctl is-active firewalld` 两个值」。
   只写「已执行 disable」不算——没有 before/after 就无法证明处置真的生效。

### 7.4 为什么验收用 60G / 8GiB

- 内存：ES(IK) 单吃 2GiB heap，加 PG/Redis/SeaweedFS/4 个应用容器，**4GiB 会让 health 长期 degraded**，
  看起来像装坏了，其实是内存不足。
- 磁盘：1.5GB tar + `docker load` 展开 8 镜像（约 5-6GB）+ 数据卷 + 日志，30G 没余量。

默认值仍是 30G/4GiB（六项基线复现口径不动），只有端到端验收用大规格。

### 7.5 看哪里判断「卡住还是正常慢」

副本目录里的 `logs/<os>-boot-stages.log`（归档时改名 `kylin-e2e-boot-stages.log`）。
`.run` 走 slirp（150MB，估 4-8s）、`docker load` 1.5GB tar（30-60s 级）、
ES 起来（20-40s）都是正常的长阶段；以阶段日志里的 start/end 为准，
不要用「几分钟没输出」当失败。

### 7.6 证据归档：基线证据与验收证据分开

在副本目录跑完后，把产物**改名**再拷回仓库，两类文件从此互不覆盖：

| 类别 | 文件 | 说明 |
|---|---|---|
| 基线实测证据（不可再生） | `kylin-install.log` / `kylin-boot.log` / `*-probe.txt` / `*-dockerd.txt` | 六项基线的唯一凭证，**永不重跑覆盖** |
| 端到端验收证据（每次新增） | `kylin-e2e-install.log` / `kylin-e2e-boot.log` / `kylin-e2e-boot-stages.log`（统信同理 `uos-e2e-*`） | 每次验收一组，按日期在 commit message 里注明 |

```bash
# 验收跑完，从副本目录取产物并改名
for f in install boot boot-stages; do
  src="E:/tmp-vm/e2e/installer/vmtest/logs/kylin-$f.log"
  [ -f "$src" ] && cp "$src" "installer/vmtest/logs/kylin-e2e-$f.log"
done
git add -f installer/vmtest/logs/kylin-e2e-*.log   # *.log 被 .gitignore 排除，必须 -f
```

`logs/README.md` 里对这两类文件分别标注「基线实测证据」与「端到端验收证据」；
`*-stages.log` 只记时间戳，**不是结论证据**，引用耗时数据时要同时给出串口日志的对应段落。

### 7.7 真机三阶段执行记录摘要（2026-11-10，全部完成）

三阶段递进的实际执行记录（证据 `kylin-e2e-*` / `uos-e2e-*`，见
`docs/变体B-真机实测结果.md` §7 全账）：

| 阶段 | 范围 | 结果 |
|---|---|---|
| A | 只跑 S1_PREFLIGHT | 麒麟首跑被确认门拦（kylin 未登记）→ confirm 后 DONE 162ms；统信 DONE 291ms |
| B | 只跑 S3_DOCKER | 麒麟首跑 FAIL（unit 四缺陷）→ `c4aa7f8` 修复 → 双机 S3 DONE；统信附带 S2 PASS 945ms + `enable --now` 真启动证据链 |
| C | 整链 S1→S10 + 冒烟 | 麒麟全绿（第 3 次 run）、统信**一次全绿**；双机 state 10/10、8 镜像、8 容器（6 healthy）、**冒烟 4/4**、tar `dd` sha256 双机一致 |

执行形态（已验证可复用）：正常引导 + **guest 内 oneshot systemd 单元自跑全链**
（dockerd 起来后 slirp SSH 必失联，人手驱动不可行），每步往串口 `echo` 打点
（`echo "… " > /dev/ttyS0` 落进 `logs/<os>-boot.log`），宿主轮询串口日志即可观察进度，
脚本结束自动 `systemctl poweroff`，再救援引导取证。判据细节与过程防呆记录
（seaweedfs 凭据字符集、`/api/step` 顺序门、`.env` 覆盖保护）见 RESULT §7.4。

## 8. 运维手册素材（真机验证沉淀，写现场手册时直接搬）

以下六条 + 一条配套，全部来自真机实测，不是推断：

1. **Web 安装器的唯一入口是「这台机器本机」**：麒麟 sshd 默认 `AllowTcpForwarding no`，
   SSH 隧道（端口转发到本地浏览器）**不可用**。现场操作是在服务器本机浏览器或
   `curl 127.0.0.1:18080` 驱动 `/api/step` / `/api/confirm` / `/api/images-tar`。
2. **统信救援引导三件套**（宿主侧要进已装好的统信盘救急时）：
   ① 必须用**系统自带 `/boot` 的 vmlinuz/initramfs**——ISO 里的 anaconda initrd 缺根
   文件系统驱动，会直接 `Warning: /dev/disk/by-uuid/… does not exist` 掉 emergency；
   ② `root=UUID=` 以实际盘为准（`blkid`/`cat /etc/fstab`）——统信实测根分区
   `2eeb1f30…`，网上/安装日志里常见的 `732a4be3…` 是安装环境 LiveOS 的，别抄错；
   ③ 自装的 oneshot 单元（`tianji-c.service` 等）要一并 `systemd.mask=`，
   否则它在救援引导里再次自启、把 VM 关掉。
3. **VM 一律 `ssh poweroff` 干净关机**：`docker rm -f`（SIGKILL）+ `cache=unsafe` 会丢
   guest 落盘数据（实测把 state.json 截成 0 字节，整轮作废）。
4. **seaweedfs 凭据字符白名单 `A-Za-z0-9_+/=-` 是防注入设计**：S3 凭据含其他字符时
   entrypoint 拒绝启动（`S3 凭据含非法字符`）。现场填 `.env`/表单时先过这个字符集。
5. **`Restart=on-failure` + `StartLimitIntervalSec=120/Burst=5` 的排障意义**：dockerd
   启动失败会在 120s 内重试 5 次，然后**停在 failed 态**（而不是无限重启刷日志）——
   排障直接 `journalctl -u docker.service`，一次看全失败原因。
6. **`/api/step` 顺序门不可跳步**：步骤必须按 S1→S10 顺序执行，跳步/重跑已 DONE 的步骤
   会被拒（「当前应执行 S<N>」）；`.env` 变更后 S5 支持重渲，但必须先重新提交表单。
   另：**S5 拒绝覆盖已存在的 `.env`**（防静默丢弃现场配置），重装场景用
   `--overwrite` 重启安装器——旧 `.env` 会**自动备份到日志目录**再覆盖，不是直接丢弃。

# 变体 B 真机实测结果（麒麟 V10 SP3 / 统信 UOS 20）

> 状态：**麒麟已完成实测，统信进行中**（2026-11-09）。
> 所有「实测」列都来自真实装进虚拟盘、开机、在 guest 内执行命令的输出；
> 原文见 `installer/vmtest/logs/`，复现方法见 `installer/vmtest/README.md`。
> 与 `docs/VARIANT-B-OS-BASELINE.md` 冲突处，**以本文实测为准**，并在 §3 单列。

---

## 0. 结论速览（六项）

| # | 基线 §7 的未验证项 | 麒麟 V10 SP3 2403 | 统信 UOS 20 1020e | 对变体 B 的影响 |
|---|---|---|---|---|
| 1 | 默认 SELinux 状态 | **Disabled**（不是 Enforcing） | 待测 | 麒麟上 SELinux 不需要任何处置 |
| 2 | 麒麟 kysec 默认是否强制 | **未生效**（`KYSEC: Disabled`，无 getstatus/kysec-daemon） | 待测（应无此模块） | 最小化安装下 kysec 不构成风险 |
| 3 | overlay2 可用性（xfs ftype） | **可用**（xfs `ftype=1`，dockerd 实选 overlay2） | 待测 | 不需要改 ext4 |
| 4 | cgroup v1 上 dockerd 27.5.1 | **正常启动**（cgroup v1 + overlay2 + cgroupfs） | 待测 | 27.5.1 的版本锁定成立 |
| 5 | 安装向导端到端 | 待其他同事（非本次范围） | — | — |
| 6 | firewalld 重启后端口是否仍通 | **不通，且管理面一起断**（见 §2.6） | 待测 | 必须关 firewalld 或永不 restart |

---

## 1. 环境与安装过程

| 项 | 麒麟 |
|---|---|
| ISO / 卷标 | `Kylin-Server-V10-SP3-2403-Release-20240426-X86_64.iso` / `Kylin-Server-10`（`isoinfo -d` 读出，与基线一致） |
| 虚拟化 | **KVM**（`-machine q35,accel=kvm -cpu host`；宿主 Docker Desktop 重启后 `/dev/kvm` 恢复） |
| 安装方式 | anaconda 33.19 文本模式，`-kernel/-initrd` + `inst.stage2=hd:LABEL=` + kickstart over HTTP |
| 安装耗时 | **4 分钟**（22:21:30 → 22:25:31，含 post-install 的 initramfs 生成） |
| 安装结果 | `Installation complete` → kickstart `reboot` → QEMU 因 `-no-reboot` 退出，**rc=0** |
| 分区 | `/boot` xfs 1G + `/` xfs 29G（`--grow`），**故意全 xfs** 以顺带验 ftype |
| 软件选择 | `@^minimal-environment` + kernel + openssh-server + tar + xz，共 **499 包**，零缺包 |
| 首次开机 | 约 30 秒到 `login:`（KVM），SSH（密钥由 kickstart `sshkey` 注入）可用 |

证据：`logs/kylin-install.log`（串口全文，首行记录 accel）、`logs/kylin-boot.log`、`logs/kylin-probe.txt`。

> kickstart 里**没有** `selinux` 指令、没有动 kysec —— 就是为了观察发行版默认态。

---

## 2. 逐项实测（麒麟）

### 2.1 SELinux 默认状态 = **Disabled**

```
$ getenforce
Disabled
$ cat /sys/fs/selinux/enforce
cat: /sys/fs/selinux/enforce: No such file or directory
$ grep -E "^SELINUX=" /etc/selinux/config
SELINUX=enforcing                     ← 配置文件写着 enforcing，运行态却是 disabled
$ sestatus | head -1
SELinux status:                 disabled
$ cat /sys/kernel/security/lsm
capability                            ← 只有 capability，SELinux LSM 没激活
$ grep -E "CONFIG_DEFAULT_SECURITY|CONFIG_SECURITY_SELINUX=" /boot/config-$(uname -r)
CONFIG_SECURITY_SELINUX=y             ← 编进内核了
CONFIG_DEFAULT_SECURITY_DAC=y         ← 但默认 LSM 是 DAC
CONFIG_DEFAULT_SECURITY=""
$ ls /sys/kernel/security/
box evm ima integrity kic kysec lsm lsm-version stacked     ← 没有 selinux 目录
```

**结论**：麒麟 V10 SP3 的 `/etc/selinux/config` 虽然写 `SELINUX=enforcing`，但内核默认 LSM 是 DAC，
SELinux 根本没激活 → **实际运行态 Disabled，且不会因为重启变 Enforcing**。
→ 安装器 **不需要** 为 SELinux 做任何处置（不装 `container-selinux`、不改模式、不写例外签认）。
→ 注意：`/etc/selinux/config` 的值会误导人，**判定必须用 `getenforce` 或 `/sys/fs/selinux/enforce`，不能读配置文件**。

### 2.2 麒麟 kysec = **未生效**（最小化安装）

```
$ command -v getstatus; command -v kysec_get; command -v setstatus
(全部不存在)
$ systemctl is-active kysec-daemon; systemctl is-enabled kysec-daemon
inactive / Failed to get unit file state: No such file or directory
$ ls /etc/kysec/db/
ls: cannot access '/etc/kysec/db/': No such file or directory
$ rpm -qa | grep -i kysec
libkysec-adv-1.1.1-01.se.09.ky10.x86_64
libkysec-core-1.1.1-01.se.09.ky10.x86_64
libkysec-3.4.1-01.se.26.ky10.x86_64     ← 只有库，没有 kysec-utils / kysec-daemon / kysec-auth
$ dmesg | grep -i kysec
[    3.607292] KYSEC: Disabled.
[    7.052688] KYSEC: Init kysecfs SUCCESS!
$ grep -iE "CONFIG_SECURITY_KYSEC" /boot/config-$(uname -r)
CONFIG_SECURITY_KYSEC=y
CONFIG_SECURITY_KYSEC_STATUS_DEFAULT=4
```

**结论**：内核编了 KYSEC 但**默认 Disabled**，且最小化安装**没装任何 kysec 用户态**
（没有 `getstatus`、没有 `kysec-daemon`、没有 `/etc/kysec/db/whlist.db`）→
**执行控制/文件保护对安装器完全不构成阻力**，往 `/usr/local/**` 写静态二进制、写
`/etc/systemd/system/*.service` 都不会被拦。

**诚实边界**：只验证了「最小化安装」。装 `kysec-utils`/`kysec-daemon` 后是否会翻成强制态**未验证**；
但交付场景（闭内网服务器最小化安装）正是本文这种形态。安装器仍应保留
`command -v getstatus` 的探测（成本近零），但**不需要**把它做成一票否决。

### 2.3 cgroup = **v1（hybrid）**

```
$ stat -fc %T /sys/fs/cgroup
tmpfs
$ cat /proc/self/cgroup
12:rdma:/ … 1:name=systemd:/user.slice/...      ← 12 个独立 controller 各自挂载
$ mount | grep cgroup | head -3
tmpfs on /sys/fs/cgroup type tmpfs (ro,...)
cgroup on /sys/fs/cgroup/systemd type cgroup (...)
cgroup on /sys/fs/cgroup/pids type cgroup (...)
```

**结论**：与基线 §4.1 预期一致（systemd 243 + kernel 4.19 → v1）。**禁止把 docker 升到 28+** 的理由成立。

### 2.4 iptables 后端 = **legacy（不是 nft）** ← 与基线文档冲突

```
$ iptables --version
iptables v1.8.5 (legacy)
$ command -v iptables-nft iptables-legacy
/usr/sbin/iptables-legacy                    ← 只有 legacy，没有 iptables-nft
$ nft list tables
(空)
```

**结论**：基线 §2 写的「RHEL8 系默认 `iptables-nft`」在麒麟上**不成立**，实际是 **legacy**。
docker 27.5.1 两种后端都支持，实测用 legacy 也能正常建链（见 §2.7），
但任何依赖 `nft` 语法的脚本/文档要改。

### 2.5 xfs ftype = **1（overlay2 可用）** ← 风险清零

```
$ findmnt -no FSTYPE,SOURCE /
xfs    /dev/vda2
$ xfs_info / | tr "," "\n" | grep ftype
 ftype=1
$ xfs_info /boot | tr "," "\n" | grep ftype
 ftype=1
```

**结论**：默认装出来的 xfs 就是 `ftype=1`，**不需要**换 ext4、不需要重建文件系统。
配合 §2.7 的 `Storage Driver: overlay2` 实选结果，这条风险彻底关闭。

### 2.6 firewalld = **active/enabled，且与 dockerd 组合会打断管理面**

基础状态：

```
$ systemctl is-active firewalld; systemctl is-enabled firewalld
active / enabled
$ firewall-cmd --get-default-zone
public
$ firewall-cmd --get-active-zones
public   interfaces: enp0s2
```

**实验 A（对照）**：不带 docker，只 `systemctl restart firewalld` → **SSH 依然通，端口规则完好**
（`logs/kylin-probe.txt` 之外见 §6 的对照记录）。

**实验 B**：dockerd 在跑、docker0 存在时 `firewall-cmd --reload` → **DOCKER 链存活**（`grep -c DOCKER` 4 → 4），
SSH 不受影响。

**实验 C**：dockerd 在跑时 `systemctl restart firewalld` → **SSH 立即不可达**，且不会自愈：

```
C1 firewalld=active
C2 natDOCKER=4                     ← docker 的链还在
C3 listening22=2 sshd=active       ← sshd 还在监听
C4 loopback22=OPEN                 ← 本机连 22 正常
C5 zones=docker interfaces: docker0   public interfaces: enp0s2   ← firewalld 自动建了 docker zone
C9 ip=… enp0s2 UP 10.0.2.15/24 …   ← 地址没变
```

**关键取证**：断网 30 秒窗口内从宿主连续发起 12 次 SSH（全部 `Connection timed out during banner exchange`），
窗口结束时读 iptables 命中计数：

```
Chain INPUT (policy ACCEPT 0 packets, 0 bytes)
    2   152 ACCEPT  ctstate RELATED,ESTABLISHED
    0     0 INPUT_ZONES
    0     0 DROP      ctstate INVALID
    0     0 REJECT    reject-with icmp-host-prohibited
Chain INPUT_ZONES           全部 0
Chain IN_public_allow       0（含 --dport 22 ACCEPT 那条，也是 0）
```

→ **所有规则计数都是 0**，说明 SYN **根本没走到 INPUT**，**不是被 iptables 规则丢掉的**。
断点在 iptables 之下（QEMU user 网络 → guest 协议栈这一段）。`reboot` 后一切恢复，
所以是运行时状态被破坏，不是配置写坏。

**结论**：
1. `--reload` 是安全的（不清 DOCKER 链）；
2. **`systemctl restart firewalld`（或任何让它重新初始化网络的动作）在 dockerd 运行时会打断外部访问，
   且不会自愈** —— 这正是基线 §4.4 描述「装完能用，重启后端口全不通」的真实形态，但比预想更严重：
   连带 SSH 管理面一起断；
3. 处置：**安装器必须让 firewalld 不参与**（`systemctl disable --now firewalld`，内网单机 appliance 场景可接受，需留痕），
   而不是「把 docker0 加进 trusted zone」——实测加了 trusted 也照样断；
4. 还有一个次要事实：dockerd 启动时 firewalld 会自动为 docker0 建一个 `docker` zone
   （`--get-active-zones` 里能看到），说明麒麟的 firewalld 自带 docker 集成，但这并不能避免上面的问题。

### 2.7 附加：dockerd 27.5.1 静态载荷实跑（对应 §7 第 4 项）

```
$ docker info | grep -iE "Server Version|Storage Driver|Cgroup"
 Server Version: 27.5.1
 Storage Driver: overlay2
 Cgroup Driver: cgroupfs
 Cgroup Version: 1
 Kernel Version: 4.19.90-89.11.v2401.ky10.x86_64
 Docker Root Dir: /var/lib/docker

$ iptables -t nat -S | grep -c DOCKER
4
$ iptables -t nat -S | grep -E "DOCKER|MASQUERADE"
-N DOCKER
-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
-A OUTPUT ! -d 127.0.0.0/8 -m addrtype --dst-type LOCAL -j DOCKER
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
$ iptables -S FORWARD | head -1
-P FORWARD DROP
```

**结论**：
- **overlay2 在 4.19.90 + xfs ftype=1 上正常工作**（不是退回 vfs），性能前提成立；
- cgroup **v1 + cgroupfs** 驱动下 27.5.1 **能正常启动**，`dockerd` 日志到
  `Daemon has completed initialization` / `API listen on /var/run/docker.sock`；
- iptables **legacy** 后端下 docker 正常写入 DOCKER 链与 MASQUERADE，未报错；
- 27.5.1 的版本锁定（不许升 28/29）在麒麟上得到实测支持。

### 2.8 附加：overlay / br_netfilter 可加载

```
$ ls /usr/lib/modules/$(uname -r)/kernel/fs/overlayfs/
overlay.ko.xz
$ modprobe overlay && modprobe br_netfilter && lsmod | grep -E "overlay|br_netfilter"
br_netfilter  24576  0
bridge       196608  1 br_netfilter
overlay      139264  0
$ sysctl net.bridge.bridge-nf-call-iptables
net.bridge.bridge-nf-call-iptables = 1
```

**结论**：模块齐备、可加载；`bridge-nf-call-iptables` 默认已是 1（systemd 的 sysctl 配好的），
不需要安装器额外写 sysctl（但写上无害）。

### 2.9 依赖版本（与基线 §2 逐字核对）

```
systemd 243 (v243-67.p05.ky10)
4.19.90-89.11.v2401.ky10.x86_64
glibc-2.28-98.p02.ky10 / systemd-243-67.p05.ky10 / kernel-4.19.90-89.11.v2401.ky10
xfsprogs-5.6.0-7.ky10 / iptables-1.8.5-6.ky10 / nftables-0.9.6-7.ky10 / libseccomp-2.5.0-5.p03.ky10
```

**结论**：全部与基线 §2 的包版本**逐字一致**（说明那份从 ISO 读出来的版本表是准的）。

---

## 3. 与基线文档的不一致处

| 基线文档位置 | 原文 | 实测 | 处置 |
|---|---|---|---|
| §4.3 / §7-1 | 「两版都带策略；默认是否 Enforcing 未验证」 | 麒麟 **Disabled**（内核默认 LSM 是 DAC，`/etc/selinux/config` 的 enforcing 是假的） | 安装器不为 SELinux 做处置；判定改用 `getenforce`，**禁止读 `/etc/selinux/config` 下结论** |
| §4.2 / §7-2 | 「麒麟独有最大未知项，若强制会拒绝执行/写入」 | 最小化安装 **kysec 未生效**：内核 `KYSEC: Disabled`、无 `getstatus`/`kysec-daemon`/`whlist.db` | 风险降级：保留探测但**不做一票否决**；不写 `setstatus` 临时放宽逻辑 |
| §2 表格 iptables 行 | 「1.8.x 系；RHEL8 系默认 `iptables-nft`」 | 麒麟实际 **`iptables v1.8.5 (legacy)`**，且**没有** `iptables-nft` 二进制 | 文档/Docker 相关脚本不得假定 nft；docker 用 legacy 实测可用 |
| §4.4 | 「firewalld reload 会清掉 docker 链，表现为装完能用、重启后端口全不通」 | `--reload` **不清** DOCKER 链（4→4）；真正致命的是 **`restart firewalld`**，且**连带 SSH 管理面一起断、不自愈**，iptables 计数为 0 说明不是规则问题 | 处置从「加 trusted zone」改为**直接禁用 firewalld**（实测加 trusted 无效） |
| §2 表格 container-selinux 行 | 「麒麟：有 `container-selinux`」 | 仓库里有该包，但最小化安装**未装**（`rpm -q` → not installed） | 无需装：SELinux 本来就没启用 |

一致的部分（可直接采信）：cgroup v1、xfs ftype=1、systemd 243 / kernel 4.19.90 / glibc 2.28、
overlay/br_netfilter 可加载、27.5.1 在 cgroup v1 上可用。

---

## 4. 对安装器的具体输入（可直接抄进代码）

1. **preflight 判定表**（麒麟实测值）
   | 检查 | 命令 | 实测 | 判定 |
   |---|---|---|---|
   | SELinux | `getenforce` | Disabled | 通过，不做处置 |
   | kysec | `command -v getstatus` + `dmesg \| grep KYSEC` | 无命令 / `KYSEC: Disabled` | 通过，不做处置（记入报告） |
   | cgroup | `stat -fc %T /sys/fs/cgroup` | `tmpfs` (v1) | 通过；**禁止升 docker 28+** |
   | iptables | `iptables --version` | `v1.8.5 (legacy)` | 通过；日志记录后端 |
   | xfs ftype | `xfs_info / \| grep ftype=1` | ftype=1 | 通过；期望 overlay2 |
   | firewalld | `systemctl is-active firewalld` | active | **必须处置：`systemctl disable --now firewalld`**（留痕） |
   | 模块 | `modprobe overlay br_netfilter` | 成功 | 通过 |
2. **不要**为麒麟写「kysec 放行」分支，也不要写「SELinux 改 Permissive」——两者都不需要，写了反而制造误判。
3. `After=firewalld.service` 出现在 unit 里没问题，但**不能**在安装流程里 `restart firewalld`；
   若现场必须保留 firewalld，则**先起 docker 再也不要动 firewalld**，且安装报告必须写明这一限制。
4. 卸载/重装脚本也不要 `firewall-cmd --reload`（虽然实测 reload 不破坏链路，但没有必要引入变量）。

---

## 5. 仍未验证 / 已知局限

1. 本文只覆盖**麒麟最小化安装**；带 GUI 的完整安装是否启用 kysec/SELinux 未测（TCP 交付场景用最小化，风险可接受）。
2. §7 第 5 项「安装向导端到端」不在本任务范围（由 #41 负责）。
3. firewalld 重启后断网的**根因未定位到具体组件**：已确证不是 iptables 规则（计数器全 0），
   断点在 QEMU user 网络向 guest 协议栈投递这一段；`reboot` 即恢复。是否与 NetworkManager 在
   firewalld 重启时的联动有关，未进一步实验。
4. 容器运行（`docker run` 起真实容器）未做：内网无镜像源，且本轮只需证明 dockerd 可起、driver/cgroup 正确。

---

## 6. 过程中已经证实的事（不依赖最终探测，先记下）

1. **两个 ISO 都能用 `-kernel/-initrd` + `inst.stage2=hd:LABEL=` 冷启动到 anaconda**，
   不需要 isolinux、不需要解压 ISO、不需要 UEFI/OVMF。卷标与基线 §1 逐字一致。
2. **麒麟 ISO 的 repodata 完整**：kickstart 装到 `499/499`，无缺包，`@^minimal-environment` 存在。
3. **安装耗时**：KVM 下 **4 分钟**（TCG 无 KVM 时约 16 分钟，同样能装通）。
4. **`docker run -i` 是陷阱**：客户端被打断 → 容器即死 → 日志停在半截并报
   `error waiting for container: unexpected EOF`，看起来像"安装器挂了"。已改 `docker run -d`。
5. **C 盘写满会让 Docker daemon 存储转只读、再整体起不来**（真实报错见 README 坑 5）。
   虚拟盘与日志必须放数据盘。
6. **往 guest 写文件后要 `sync` 再杀 qemu**：本次有一次 `scp` 写入的脚本因 QEMU 被强杀而丢失
   （`/root/exp3.sh` 消失），导致一轮实验白跑。
7. **SSH 一断，ssh 会话里的远程脚本会被 SIGHUP 带走**，取证必须用 systemd 单元或 `setsid` +
   落盘，且每步 `sync`——否则断网那一刻证据就没了。

# 变体 B 真机实测结果（麒麟 V10 SP3 / 统信 UOS 20）

> 状态：**两个 OS 均已真实安装并完成六项探测**（2026-11-09）。
> 所有「实测」列都来自真实装进虚拟盘、开机、在 guest 内执行命令的输出；
> 原文见 `installer/vmtest/logs/`，复现方法见 `installer/vmtest/README.md`。
> 与 `docs/VARIANT-B-OS-BASELINE.md` 冲突处 **以本文实测为准**（§3 单列）。
>
> **一次重要自我更正**：中途我一度把「dockerd 起来后 SSH 失联」当成 OS 行为（firewalld 与 docker 冲突），
> 后续二分实验证明主因是**测试环境**（QEMU user 网络）的限制，详见 §2.6 与 §5。真正的
> firewalld/docker 冲突是另一个形态（`ZONE_CONFLICT`，dockerd 直接起不来），两条都记在下面。

---

## 0. 结论速览（六项）

| # | 基线 §7 的未验证项 | 麒麟 V10 SP3 2403 | 统信 UOS 20 1020e | 对变体 B 的影响 |
|---|---|---|---|---|
| 1 | 默认 SELinux 状态 | **Disabled**（配置文件却写 enforcing） | **Disabled**（配置文件也写 disabled） | 两个 OS 都不需要任何 SELinux 处置 |
| 2 | kysec 是否强制 | **未生效**（`KYSEC: Disabled`，无用户态工具） | **完全没有**（连包都没有） | kysec 从"最高风险"降为"记录即可" |
| 3 | overlay2（xfs ftype） | **ftype=1**，dockerd 实选 overlay2 | **ftype=1**，dockerd 实选 overlay2 | 不需要换 ext4 |
| 4 | cgroup v1 上 dockerd 27.5.1 | **正常启动** | **正常启动**（首次） | 27.5.1 版本锁定成立 |
| 5 | 安装向导端到端 | 不在本任务范围（#41） | 同 | — |
| 6 | firewalld 重启后端口是否仍通 | `--reload` 不清 DOCKER 链；**`restart` 与 docker 组合时管理面失联（环境因素，见 §2.6）** | `--reload` 结果未取到（guest 失联）；**dockerd 二次启动直接失败：`ZONE_CONFLICT`** | 安装时应直接禁用 firewalld |

---

## 1. 环境与安装过程

| 项 | 麒麟 V10 SP3 | 统信 UOS 20 |
|---|---|---|
| ISO / 卷标 | `Kylin-Server-V10-SP3-2403-…x86_64.iso` / `Kylin-Server-10` | `uniontechos-server-20-1020e-amd64.iso` / `UnionTechOS` |
| 卷标核对 | `isoinfo -d` → `Kylin-Server-10`（与基线一致） | `isoinfo -d` → `UnionTechOS`（与基线一致） |
| anaconda | 33.19-41.p36.ky10 | 33.19-25.up12.uel20 |
| 虚拟化 | **KVM**（`accel=kvm`，`-cpu host`） | **KVM** |
| 安装耗时 | **4 分 00 秒**（22:21:30→22:25:31） | **4 分 12 秒**（内核计时 252s，含重启） |
| 包数 | 499（零缺包） | 576（零缺包） |
| 分区 | `/boot` xfs 1G + `/` xfs 29G | 同 |
| 首次开机到 SSH | 约 30 秒 | 约 35 秒 |
| 结束方式 | kickstart `reboot` → QEMU `-no-reboot` 退出，**rc=0** | 同，**rc=0** |

证据：`logs/kylin-install.log`、`logs/uos-install.log`（串口全文，首行记录 accel）、
`logs/*-boot.log`、`logs/*-probe.txt`。

> 两个 kickstart 都**没有**写 `selinux` 指令、**没有**动 kysec —— 就是为了观察发行版默认态。
> 第一版 kickstart 漏了 `reboot`，anaconda 会停在 `Installation complete. Press ENTER to quit:`
> 而串口是单向的（`-serial file:`）回车进不去 → 后续加入 `reboot` 后干净退出。

---

## 2. 逐项实测

### 2.1 SELinux 默认状态 = 两个 OS 都 **Disabled**

麒麟：

```
$ getenforce
Disabled
$ cat /sys/fs/selinux/enforce
cat: /sys/fs/selinux/enforce: No such file or directory
$ grep -E "^SELINUX=" /etc/selinux/config
SELINUX=enforcing                     ← 配置文件写 enforcing，运行态却是 disabled
$ sestatus | head -1
SELinux status:                 disabled
$ cat /sys/kernel/security/lsm
capability                            ← 只有 capability，SELinux LSM 没激活
$ grep -E "CONFIG_DEFAULT_SECURITY|CONFIG_SECURITY_SELINUX=" /boot/config-$(uname -r)
CONFIG_SECURITY_SELINUX=y
CONFIG_DEFAULT_SECURITY_DAC=y         ← 默认 LSM 是 DAC
CONFIG_DEFAULT_SECURITY=""
```

统信：

```
$ getenforce
Disabled
$ grep -E "^SELINUX=" /etc/selinux/config
SELINUX=disabled                      ← 这个 OS 连配置都是 disabled
$ cat /sys/fs/selinux/enforce
cat: /sys/fs/selinux/enforce: No such file or directory
$ rpm -q selinux-policy-targeted container-selinux
selinux-policy-targeted-3.14.2-75.uel20.noarch
package container-selinux is not installed
```

（统信安装器自身跑在 **permissive** 下，串口里能看到 `avc: denied … permissive=1`，
那是 anaconda 运行环境，不代表装出来的系统。）

**结论**：
- 两个 OS 装完都是 **SELinux disabled**，**不需要**装 `container-selinux`、**不需要**改 Permissive、**不需要**签认例外。
- **判定必须用 `getenforce` 或 `/sys/fs/selinux/enforce`**。麒麟的 `/etc/selinux/config` 写着
  `SELINUX=enforcing` 而实际 disabled —— 只看配置文件会得出完全相反的结论，这是最容易踩的坑。

### 2.2 kysec = 麒麟**未生效**，统信**完全没有**

麒麟：

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
libkysec-3.4.1-01.se.26.ky10.x86_64     ← 只有库，没有 kysec-utils/kysec-daemon/kysec-auth
$ dmesg | grep -i kysec
[    3.607292] KYSEC: Disabled.
[    7.052688] KYSEC: Init kysecfs SUCCESS!
$ grep -iE "CONFIG_SECURITY_KYSEC" /boot/config-$(uname -r)
CONFIG_SECURITY_KYSEC=y
CONFIG_SECURITY_KYSEC_STATUS_DEFAULT=4
```

统信：`rpm -qa | grep -i kysec` → 空；`getstatus`/`kysec-daemon`/`/etc/kysec/db` 全部不存在。

**结论**：
- 麒麟内核编了 KYSEC 但**默认 Disabled**，且最小化安装**没装用户态** → 执行控制/文件保护
  对安装器**不构成阻力**（往 `/usr/local/**` 写静态二进制、写 `systemd unit` 都不会被拦）。
- 基线 §4.2 把 kysec 列为「代价最高的未知项」，实测降级为「记录即可，不做一票否决」。
- **诚实边界**：只验证了最小化安装。若现场装了 `kysec-utils`/`kysec-daemon` 并启用，
  行为未知 —— 但交付场景（闭内网服务器最小化安装）就是本文这种形态。

### 2.3 cgroup = 两个 OS 都是 **v1（hybrid）**

麒麟：`stat -fc %T /sys/fs/cgroup` → `tmpfs`，12 个 controller 各自挂载。
统信：同 → `tmpfs`，13 个 controller（多一个 `files`）。

```
$ cat /proc/self/cgroup
12:rdma:/ … 1:name=systemd:/user.slice/user-0.slice/session-4.scope
$ mount | grep cgroup | head -2
tmpfs on /sys/fs/cgroup type tmpfs (ro,…)
cgroup on /sys/fs/cgroup/systemd type cgroup (rw,…)
```

**结论**：与基线 §4.1 预期一致。「不许把 docker 升到 28/29」的约束在两边都成立。

### 2.4 iptables 后端 = 两个 OS 都是 **legacy**（与基线文档冲突）

麒麟：

```
$ iptables --version
iptables v1.8.5 (legacy)
$ command -v iptables-nft iptables-legacy
/usr/sbin/iptables-legacy            ← 只有 legacy，没有 iptables-nft
$ nft list tables
(空)
```

统信：同，`iptables v1.8.5 (legacy)`，只有 `iptables-legacy`。

**结论**：基线 §2 的「RHEL8 系默认 `iptables-nft`」在两个国产 OS 上**都不成立**，实际是 **legacy**。
docker 27.5.1 在 legacy 下实测能正常建链（§2.7），但任何依赖 nft 语法的脚本必须改。

### 2.5 xfs ftype = 两个 OS 都是 **1**（风险清零）

```
$ findmnt -no FSTYPE,SOURCE /
xfs    /dev/vda2
$ xfs_info / | tr "," "\n" | grep ftype
 ftype=1
$ xfs_info /boot | tr "," "\n" | grep ftype
 ftype=1
```

**结论**：默认装出来就是 `ftype=1`，**不需要**换 ext4、不需要重建文件系统。
配合 §2.7「dockerd 实选 overlay2」，这条风险彻底关闭。

### 2.6 firewalld：分成两件事，别混为一谈

基础状态（两边一致）：

```
$ systemctl is-active firewalld; systemctl is-enabled firewalld
active / enabled
$ firewall-cmd --get-default-zone
public
$ firewall-cmd --get-active-zones
public   interfaces: enp0s2
```

**(A) 真·OS 级冲突：dockerd 二次启动失败 `ZONE_CONFLICT`（统信实测，最重要）**

统信上第一次起 dockerd 成功；同一系统重启后再起，daemon **直接起不来**：

```
$ dockerd --data-root /var/lib/docker --storage-driver overlay2
… msg="Firewalld: docker zone already exists, returning"
… failed to start daemon: Error initializing network controller:
  error creating default "bridge" network: Failed to program NAT chain:
  ZONE_CONFLICT: 'docker0' already bound to a zone
```

（首次成功时的对应日志是 `msg="Firewalld: interface docker0 already part of docker zone, returning"`。）

**这正好命中基线 §4.4 担心的「装完能用，重启后全不通」，但形态更严重：不是端口不通，是
dockerd 起不来。** 处置只有两个：`systemctl disable --now firewalld`，或给 dockerd 加
`--iptables=false`（后者会失去端口映射）。

**(B) `--reload` 不清 docker 链（麒麟实测，live）**

```
$ iptables -t nat -S | grep -c DOCKER      # reload 前
4
$ firewall-cmd --reload
success
$ iptables -t nat -S | grep -c DOCKER      # reload 后
4                                          # 链没被清，规则仍在
```

→ 基线 §4.4「reload 会清掉 docker 链」**不成立**；`--reload` 是安全的。

**(C) 一次自我更正：`restart firewalld` 后 SSH 失联，不是 OS 的问题**

我最初观测到：dockerd 在跑时 `systemctl restart firewalld` → SSH 立即不可达且不自愈，
iptables 命中计数全 0（SYN 没到 INPUT），据此判断"firewalld 重启打断管理面"。**这个结论是错的**，
后续二分实验找到了真因：

| 实验（统信） | SSH 是否存活 |
|---|---|
| 只 `sysctl -w net.ipv4.ip_forward=1` | **存活** |
| `dockerd --bridge=none --iptables=false --ip-forward=false` | **存活**（docker 起来，`docker info` 正常） |
| 手工 `ip link add docker0 type bridge` + 配 172.17.0.1/16 | **立刻失联** |
| `dockerd` 默认参数（会创建 docker0） | **立刻失联** |

→ 触发条件是 **guest 内出现网桥接口**，不是 firewalld、也不是 iptables。QEMU 的 user 网络
（slirp）在 guest 多出一个接口后，hostfwd 就再也投递不进 guest（所以 iptables 计数才是 0）。
**这是测试环境的限制，不能写进 OS 结论。** 详见 §5。

### 2.7 dockerd 27.5.1 静态载荷实跑（§7 第 4 项）

两个 OS 首次启动都成功：

```
麒麟：
 Server Version: 27.5.1
 Storage Driver: overlay2
 Cgroup Driver: cgroupfs
 Cgroup Version: 1
 Kernel Version: 4.19.90-89.11.v2401.ky10.x86_64
 Docker Root Dir: /var/lib/docker

统信：
 Server Version: 27.5.1
 Storage Driver: overlay2
 Cgroup Driver: cgroupfs
 Cgroup Version: 1
 Kernel Version: 4.19.90-2106.3.0.0095.up2.uel20.x86_64
```

iptables 链（麒麟，legacy 后端正常写入）：

```
-N DOCKER
-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
-A OUTPUT ! -d 127.0.0.0/8 -m addrtype --dst-type LOCAL -j DOCKER
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
-P FORWARD DROP
```

**结论**：
- **overlay2 在 4.19.90 + xfs ftype=1 上正常工作**（没退回 vfs），性能前提成立；
- **cgroup v1 + cgroupfs 下 27.5.1 能正常启动**，两个 OS 都一样；
- iptables **legacy** 下 docker 建链正常；
- 27.5.1 的版本锁定得到实测支持。

### 2.8 附加：overlay / br_netfilter 可加载（两边都行）

```
$ modprobe overlay && modprobe br_netfilter && lsmod | grep -E "overlay|br_netfilter"
br_netfilter  24576  0
overlay      139264  0        （统信 122880）
bridge       196608  1 br_netfilter,ebtable_broute
$ sysctl net.bridge.bridge-nf-call-iptables
net.bridge.bridge-nf-call-iptables = 1
```

### 2.9 依赖版本（与基线 §2 逐字核对）

| 组件 | 麒麟 | 统信 | 基线是否命中 |
|---|---|---|---|
| glibc | 2.28-98.p02.ky10 | 2.28-69.up1.uel20 | ✅ 一致 |
| systemd | 243-67.p05.ky10 | 243-38.up6.uel20 | ✅ 一致 |
| kernel | 4.19.90-89.11.v2401.ky10 | 4.19.90-2106.3.0.0095.up2.uel20 | ✅ 一致 |
| kernel-core | 有（拆分包） | **无此包**（单 kernel 包） | 小差异，不影响 |
| xfsprogs | 5.6.0-7.ky10 | 5.6.0-2.uel20 | ✅ |
| iptables | 1.8.5-6.ky10 | 1.8.5-2.uel20 | ✅ 版本对，但**后端是 legacy**（见 2.4） |
| libseccomp | 2.5.0-5.p03.ky10 | 2.5.0-3.uel20 | ✅ |

---

## 3. 与基线文档的不一致处

| 基线位置 | 原文 | 实测 | 处置 |
|---|---|---|---|
| §4.3 / §7-1 | 「两版都带策略；默认是否 Enforcing 未验证」 | 两边都 **Disabled**；**麒麟的 `/etc/selinux/config` 写 enforcing 但实际 disabled** | 不为 SELinux 做任何处置；判定只用 `getenforce`，**禁止读配置文件下结论** |
| §4.2 / §7-2 | 「麒麟独有最大未知项，若强制会拒绝执行/写入」 | 最小化安装 **kysec 未生效**（`KYSEC: Disabled`、无用户态、无 whlist.db） | 降级为「探测+记录」，不做一票否决；不写 `setstatus` 放宽逻辑 |
| §2 iptables 行 | 「1.8.x 系；RHEL8 系默认 `iptables-nft`」 | 两个 OS 都是 **legacy**，无 `iptables-nft` 二进制 | 文档与脚本不得假定 nft |
| §4.4 firewalld | 「reload 会清掉 docker 链，装完能用、重启后端口全不通」 | `--reload` **不清**（4→4）；真正的问题是 **dockerd 二次启动 `ZONE_CONFLICT` 起不来** | 处置改为**直接禁用 firewalld**（或 `--iptables=false`） |
| §7-6 的隐含假设 | 「重启后端口不通」= 网络层问题 | 本次观察到的"管理面失联"主因是 **QEMU slirp 在 guest 出现网桥后失效**，属测试环境 | 测试方法要改（见 §5），不能当作 OS 缺陷写进交付文档 |
| §2 container-selinux | 麒麟「有」 | 仓库里有，但最小化**未装** | 无需装（SELinux 本来没启用） |

一致、可直接采信：cgroup v1、xfs ftype=1、systemd 243 / kernel 4.19.90 / glibc 2.28、
overlay/br_netfilter 可加载、27.5.1 在 cgroup v1 上可用。

---

## 4. 对安装器的具体输入

1. **preflight 判定表**（两 OS 实测值）

   | 检查 | 命令 | 麒麟 | 统信 | 判定 |
   |---|---|---|---|---|
   | SELinux | `getenforce` | Disabled | Disabled | 通过，不处置 |
   | kysec | `command -v getstatus` / `dmesg \| grep KYSEC` | 无 / `KYSEC: Disabled` | 无 / 无此模块 | 通过，仅记录 |
   | cgroup | `stat -fc %T /sys/fs/cgroup` | tmpfs(v1) | tmpfs(v1) | 通过；**禁止升 docker 28+** |
   | iptables | `iptables --version` | 1.8.5 legacy | 1.8.5 legacy | 通过；日志记录后端 |
   | xfs ftype | `xfs_info / \| grep ftype=1` | 1 | 1 | 通过 |
   | firewalld | `systemctl is-active firewalld` | active | active | **必须处置：`systemctl disable --now firewalld`** |
   | 模块 | `modprobe overlay br_netfilter` | 成功 | 成功 | 通过 |

2. **不要**写 kysec 放行分支、**不要**写 SELinux 改 Permissive —— 两边都不需要，写了反而制造误判。
3. firewalld 是唯一真正需要在安装时动手的项：**先 `disable --now`，再装 docker**。
   顺序反了（先起 docker 再关/重启 firewalld）会命中 `ZONE_CONFLICT` 或环境失联。
4. 安装报告里记录三项：`iptables --version` 后端、dockerd 实选 storage driver、cgroup 版本。
5. 卸载脚本不要 `firewall-cmd --reload`（无必要引入变量）。

---

## 5. 仍未验证 / 已知局限（含一条测试方法论教训）

1. **QEMU user 网络（slirp）不能用来验证「guest 内跑 docker 之后的管理面可达性」**：
   实测 guest 一旦创建网桥接口（dockerd 默认行为，或手工 `ip link add docker0 type bridge`），
   宿主经 `hostfwd` 的 SSH 就再也连不进 guest（sshd 仍在监听、loopback:22 可连、iptables 计数全 0）；
   重启 guest 即恢复；`--bridge=none` 则不发生。
   → **要真正验证 §7-6「firewalld 重启后端口是否仍通」，必须改用 tap/bridge 网络或
   在 guest 内自测（`curl 127.0.0.1` / 另起网段），不能靠 hostfwd + ssh。**
   本次因此**没有**取得「dockerd 在跑 + firewalld 重启后，外部端口是否仍通」的干净结论；
   已取得的干净结论是 (A) `ZONE_CONFLICT` 使 dockerd 起不来、(B) `--reload` 不清链。
2. 只覆盖**最小化安装**；带 GUI 的完整安装是否启用 kysec/SELinux 未测。
3. §7 第 5 项「安装向导端到端」不在本任务范围（#41 负责）。
4. 未做 `docker run` 起真实容器（内网无镜像源）；本轮只需证明 dockerd 可起、driver/cgroup 正确。
5. 统信 `--reload` 后的链计数未取到（同一轮里 guest 已因网桥失联）。

---

## 6. 过程中已经证实的事（工具链/方法）

1. **两个 ISO 都能用 `-kernel/-initrd` + `inst.stage2=hd:LABEL=` 冷启动到 anaconda**，
   不需要 isolinux、不需要解压 ISO、不需要 UEFI/OVMF；卷标与基线 §1 逐字一致。
2. **两个 ISO 的 repodata 都完整**：麒麟 499 包、统信 576 包，全部装完无缺包。
3. **安装耗时**：KVM 下 4 分钟；TCG（无 KVM）麒麟约 16 分钟，同样能装通。
4. **kickstart 必须写 `reboot`**：否则 anaconda 停在 `Press ENTER to quit`，而 `-serial file:`
   是单向的，回车进不去 → 永远卡住。
5. **`docker run -i` 是陷阱**：客户端被打断 → 容器即死 → 日志半截 + `unexpected EOF`。改 `docker run -d`。
6. **C 盘写满会让 Docker daemon 存储转只读、再整体起不来**（报错原文见 README 坑 5）。
7. **往 guest 写文件要 `sync` 再杀 qemu**：否则 ext4 页缓存丢失（丢过一整份实验脚本）。
8. **SSH 一断，ssh 会话里的远程脚本被 SIGHUP 带走**：取证要用 systemd 单元 +
   每步 `sync` 落盘，否则断网那一刻证据全丢。本轮的 `ZONE_CONFLICT` 就是这么捞回来的。

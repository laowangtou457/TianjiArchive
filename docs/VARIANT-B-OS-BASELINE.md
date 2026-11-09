# 变体 B（麒麟 / 统信）系统基线实测

> 状态：**已从 ISO 离线取证**（2026-11-09）。本文所有版本号均直接读自用户提供的两个
> 安装镜像的 `Packages/` 与 repodata 元数据，不是凭经验推测；凡未验证的一律标注
> 「未验证」，不做默认假设。
>
> 关联文档：`docs/INSTALLER-DESIGN.md` §4.3（变体 B 载荷策略）、§9（交付物清单）。

---

## 1. 取证对象与取证方法

| 项 | 麒麟 | 统信 |
|---|---|---|
| ISO 文件 | `Kylin-Server-V10-SP3-2403-Release-20240426-X86_64.iso` | `uniontechos-server-20-1020e-amd64.iso` |
| 文件大小 | 4,696,293,376 B (4.37 GiB) | 5,240,782,848 B (4.88 GiB) |
| sha256 | `039681842fc354789ed4471f9debdf0204a4e64607db59a9d8fecb37c4ed77a3` | `87453df118d773e5a0c876a700c1280202e4e29bcbd35c661ad2a1c1fa975656` |
| 卷标 | `Kylin-Server-10` | `UnionTechOS` |
| 镜像标识 | `.productinfo`：Kylin Linux Advanced Server release V10 SP3 2403/(Halberd)-x86_64-Build20.01/20240426 | `.treeinfo`：family=UnionTech version=20 name=UnionTechOS20 |
| 构建时间戳 | 2025-08-09（`.treeinfo`/文件时间） | 2021-07-20（`.discinfo`/文件时间） |
| 包管理形态 | RPM + `repodata`（yum 仓库） | RPM + `repodata`（yum 仓库） |
| `Packages/` 包数 | **2921** | **2313** |
| 服务期线索 | `.kyinfo` `term = 2026-12-03` | 无（ISO 内无对应字段） |

**取证方法**（可复现，不装系统、不联网）：

```powershell
Mount-DiskImage -ImagePath 'E:\国产OS镜像\<iso>' -PassThru | Get-Volume
# 然后 ls <盘符>/Packages 读包名；cat <盘符>/.treeinfo /.discinfo /.productinfo /.kyinfo
```

两个镜像都是合法 ISO9660（卷标与 `CD001` 魔数均已核对），`Packages/` 为平铺 RPM，
因此**包版本可以逐字读出**。这一步把此前「国产 OS 版本未知，只能猜」的前提彻底消掉了。

---

## 2. 实测基线对照表

| 组件 | 麒麟 V10 SP3 2403 (x86_64) | 统信 UOS 20 1020e (uel20) | 对变体 B 的意义 |
|---|---|---|---|
| glibc | `2.28-98.p02.ky10` | `2.28-69.up1.uel20` | **两者同为 2.28**。静态二进制本来不依赖它，但意味着「按 glibc 2.28 编的动态包」在两边都够用 |
| systemd | `243-67.p05.ky10` | `243-38.up6.uel20` | **两者同为 243** → 默认 **cgroup v1（hybrid）**，这是选 Docker 版本的决定性约束 |
| kernel | `4.19.90-89.11.v2401.ky10`（含 `kernel-core`/`-modules`/`-modules-extra`） | `4.19.90-2106.3.0.0095.up2.uel20` | 同代 4.19.90 → satisfies Docker ≥3.10、overlay2 需 ≥4.0 |
| iptables | `1.8.5-6.ky10`（含 `iptables-libs`） | `1.8.5-2.uel20` | 1.8.x 系；RHEL8 系默认 `iptables-nft`，Docker 27 支持 nft backend |
| nftables | `0.9.6-7.ky10` + `libnftnl 1.1.7` | `0.9.6-2.uel20` + `libnftnl 1.1.7` | nft 后端具备 |
| conntrack | `libnetfilter_conntrack 1.0.8-3` | `libnetfilter_conntrack 1.0.8-1` + `conntrack-tools 1.4.6` | 端口映射/会话跟踪所需模块齐备 |
| libseccomp | `2.5.0-5.p03.ky10` | `2.5.0-3.uel20` | 满足 Docker 27 的 seccomp 需求（≥2.4） |
| SELinux 策略 | `selinux-policy-targeted 3.14.2-81.se.29.08` | `selinux-policy-targeted 3.14.2-75` | 两版都带策略；**默认是否 Enforcing 未验证** |
| container-selinux | **有**：`container-selinux-2.138.0-1.p01.ky10` | **无**（全库检索无此包） | UOS 若 Enforcing，容器挂载会被拒 → 见 §4.3 |
| 麒麟安全模块 | **有**：`kysec-auth` / `kysec-daemon` / `kysec-utils 3.4.1` / `kysec-sync-daemon` | 无 | **麒麟独有的最大未知项** → 见 §4.2 |
| firewalld | `0.6.6-5.p04.ky10` | `0.6.6-4.uel20` | 与 docker 写 iptables 共存是历史坑 → 见 §4.4 |
| 存储工具 | `xfsprogs 5.6.0-7`、`lvm2 2.03.09-15`、`device-mapper 1.02.171`、`btrfs-progs 5.7` | `xfsprogs 5.6.0-2`、`lvm2 2.03.09-5`、`device-mapper 1.02.171` | overlay2 的 xfs `ftype=1` 需现场核对 → 见 §4.5 |
| 网络工具 | `iproute 5.5.0`、`bridge-utils 1.7`、`ipset 7.6` | `iproute 5.5.0`、`ipset 7.6`、**无 bridge-utils** | `brctl` 不得出现在任何交付脚本里 |
| 证书 | `openssl-libs 1.1.1f`、`ca-certificates 2023.2.60` | `openssl-libs 1.1.1f`、`ca-certificates **2020.2.46**` | UOS 根证书较旧 → 自签 CA 必须显式装入信任库 |
| 发行版自带容器栈 | `docker-engine 18.09.0-261.p02.ky10` + `docker-runc 1.0.0.rc3`、`podman 0.10.1` | `docker-engine 18.09.0-203.uel20` | **不采用**，理由见 §3.2 |

---

## 3. 对变体 B 载荷策略的判定

### 3.1 结论：继续走「docker 静态二进制」，版本锁定 27.5.1

三条互相独立的理由，均为本次实测/实测比对得出：

1. **glibc 不是障碍，但也不是保障**。两个 OS 都是 glibc 2.28 + systemd 243 + kernel 4.19.90，
   同一代基线；静态二进制连这层依赖都不需要（实测见 §5.1），因此「两个国产 OS 用同一份
   二进制」成立，不必为麒麟/UOS 各出一个包。
2. **cgroup 版本决定了 Docker 主版本上限**。systemd 243 + kernel 4.19 的默认是 cgroup v1
   （hybrid），国产 OS 短期内不会跳到支持 unified 的 systemd 249+。Docker **28 起 cgroup v1
   进入移除轨道、29 明确标记 deprecated**，而 27.x 仍在 cgroup v1 上正常工作。
   → **27.5.1 是这批 OS 上风险最低的可选点，不许随手升到 28/29**；升级必须单独回归。
3. **发行版仓库里的 docker-engine 18.09.0 不能用**（见 §3.2）。

### 3.2 为什么不用 ISO 仓库里现成的 `docker-engine`

| 维度 | 仓库自带 18.09.0 | 静态 27.5.1 |
|---|---|---|
| 年代 | 2018 年 11 月 | 2025 年 1 月 |
| Docker API | 1.39 | 1.47 |
| compose v2 插件 | 不匹配（插件机制是 19.03 之后的事） | 原生匹配（实测见 §5.2） |
| 依赖闭包 | 要解 RPM 闭包，麒麟/UOS 两份各不相同 | 零外部依赖（静态） |
| 升级可控性 | 由发行版仓库决定，我们无权改 | 我们自己钉版本 + 摘要 |
| 交付面 | 两套 OS 两套闭包，各有各的坑 | 一份载荷，两边同一二进制 |

结论：仓库里那个包只证明「这发行版生态里有 docker」，不构成可选方案。

---

## 4. 风险清单与现场预检要求（按概率×代价排序）

以下 6 项必须做进安装器 `preflight`，**检出即给出可执行处置**，不能只警告。

### 4.1 cgroup 版本（高概率，中代价）
- 探测：`stat -fc %T /sys/fs/cgroup` → `tmpfs`=v1 / `cgroup2fs`=v2。
- 期望 v1。若是 v2 也接受（27.5.1 两者都支持），但要记录到安装报告。
- 处置：无需动作，仅记录；**同时禁止把 docker 升到 28+**。

### 4.2 麒麟 kysec 执行控制（概率未知，代价最高）
- 现象：`kysec-*` 在麒麟上是一个独立的安全模块，其「执行控制（exectl）」可拒绝运行未授权
  的可执行文件，「文件保护（fpro）」可拒绝对受保护路径的写入。若为强制态，我们解包到
  `/usr/local/**` 的静态二进制、写 `/etc/systemd/system/*.service`、写 `/etc/docker/`、
  挂载 `/var/lib/docker` 都可能被拒。
- **本次已从 ISO 内的二进制解出确切命令**（`kysec-utils-3.4.1-01.se.26.ky10`，读取
  `getstatus` / `setstatus` / `kysec_get` 的 usage 字符串，非猜测）：

  ```
  getstatus [-m | --module <module>] [-h | --help]
  setstatus <module> [-s,--status <enforcing|permissive|on|off>]
                     [-f,--func <func>] [-c,--control <on|off>] [-t,--temporary] [-h,--help]
  kysec_get <module> [-R] [-l] [-f|-P|-p|-n] <path|pkgname|pid>
  ```

  模块名：`kysec`（总开关）、`exectl`（执行控制）、`fpro`（文件保护）、`ppro`（进程保护）、
  `netctl`（网络控制）、`kmod`（内核模块）；另有 `selinux` / `apparmor` / `box` 三个并列
  状态可查可设。实际用法示例（来自二进制内字符串）：
  `setstatus kysec -s enforcing`、`setstatus kysec -f netctl -c on -t`、
  `kysec_get exectl -f /usr/bin/`、`kysec_get fpro -f /usr/bin/ls`。
  `-t` 为**临时**设置（不持久化，重启失效）——正好可用作「安装窗口内临时放宽」。
  白名单库是 sqlite：`/etc/kysec/db/whlist.db`。
- 探测（写进 `preflight`）：
  1. `command -v getstatus` 存在性；
  2. `getstatus` 输出里取 `KySec status:` 与 `exectl: on/off`；
  3. 对我们将要落地的路径做定点查询：`kysec_get exectl -f /usr/local/lib/tianji/docker-static/dockerd`。
  4. 注意 `getstatus` 走 D-Bus 查 `kysec-daemon`，**守护进程没起时查询会失败**，要把
     「查不到」与「查到 off」区分开，不能把失败当放行。
- 处置（分档，留给现场，均需留痕）：
  1. 首选：把二进制路径加入白名单（`/etc/kysec/db/whlist.db` 有配套工具，具体写入口待真机确认）；
  2. 次选：`setstatus kysec -s permissive -t` 做**临时**放宽，安装完 `setstatus kysec -s enforcing`
     恢复，并复验 dockerd 仍能启动；
  3. 最后：前置条件不满足 → 中止，给出明确话术，不允许「带病安装」。
- 仍未验证：麒麟**默认**是否 Enforcing、`-t` 的确切生效范围。`kysec-init.service` 是
  systemd 单元，意味着最小化安装若未启用该服务，执行控制很可能根本不生效——但这只是
  推断，不作为交付依据。

> 顺带修正一个常见误解：kysec 与 SELinux 在麒麟上是**并存的两套**（`getstatus` 会分别打印
> `KySec status:` 与 `selinux status:`），处置时必须分别判断，不能只查一个。

### 4.3 SELinux（麒麟 Enforcing 时概率中，UOS 无 container-selinux 时代价高）
- 探测：`getenforce`（`Enforcing`/`Permissive`/`Disabled`）。
- 麒麟：仓库自带 `container-selinux 2.138.0` → Enforcing 时可用 ISO 作为本地仓库
  `rpm -i` 装该包（离线可行）。
- 统信：**仓库内无 container-selinux**。若 Enforcing，容器启动会因 `mounton` 被拒。
  处置：改 `Permissive` 并在安装报告里显式记录为交付例外（需现场签认），不要静默改。
- 未验证：两版 OS 的**默认** SELinux 状态（要装系统才知道）。

### 4.4 firewalld 与 docker 的 iptables 共存（高概率，低-中代价）
- 两版都带 `firewalld 0.6.6`。docker 直接写 iptables，firewalld reload 会清掉 docker 链，
  表现为「装完能用，重启或 reload 后端口全不通」。
- 处置：安装时把 `docker0` 与 `br-*` 接口加入 `trusted` zone（`firewall-cmd --permanent`），
  或明确关闭 firewalld（内网单机 appliance 场景可接受，需留痕）。

### 4.5 overlay2 的 xfs `ftype=1`（低概率，中代价）
- kernel 4.19 支持 overlay2，但若 `/var/lib/docker` 落在 `ftype=0` 的 xfs 上，docker 会
  拒绝启动 overlay2 并退到 `vfs`（性能差一个量级）。
- 探测：`xfs_info <挂载点> | grep -E 'ftype=1'`；不存在则改 ext4 目录或重建文件系统。
- 记录实际选中的 storage driver 到安装报告。

### 4.6 自签 CA 信任链（UOS 上概率高，低代价）
- UOS 的 `ca-certificates` 停留在 2020.2.46。我们全内网 + 自签 CA，
  必须在安装步骤里 `cp 证书 /etc/pki/ca-trust/source/anchors/ && update-ca-trust extract`
  （RPM 系的路径与 Ubuntu 的 `update-ca-certificates` 不同，**不能复用变体 A 的脚本**）。

---

## 5. 已经做过的实测（2026-11-09）

### 5.1 静态载荷完整性 + 静态性
`installer/build/fetch-docker-static.sh` 跑通，产出：

```
docker-27.5.1.tgz              76,186,310 B  sha256 4f798b3e…45d640
docker-compose-linux-x86_64    63,785,037 B  sha256 383ce669…12baf0
```

摘要**双源比对一致**：`download.docker.com` 与 `mirrors.ustc.edu.cn/docker-ce` 下载的
`docker-27.5.1.tgz` sha256 完全相同；compose 摘要与 GitHub Release 发布的 `.sha256` 文件一致。

容器内逐个检查链接方式：

```
dockerd                not a dynamic executable
docker                 not a dynamic executable
containerd             not a dynamic executable
runc                   statically linked
ctr                    not a dynamic executable
docker-proxy           not a dynamic executable
compose                not a dynamic executable
```

→ 零 glibc 依赖成立，两版 OS 共用一份载荷的判断有据。

### 5.2 二进制可实际运行
在同一容器内起嵌套 dockerd 并驱动 compose：

```
Docker version 27.5.1, build 4c9b3b0        # dockerd
Docker version 27.5.1, build 9f9e405        # cli
Docker Compose version v2.29.7
ServerVersion=27.5.1 Driver=vfs CgroupVersion=2 CgroupDriver=cgroupfs
COMPOSE_CONFIG_OK
插件发现：/usr/local/lib/docker/cli-plugins/docker-compose 被 CLI 正常识别
```

**诚实边界**：这台构建机是 Docker Desktop（WSL2，kernel `6.18.54.1-microsoft-standard-WSL2`，
**cgroup v2**），因此上面的运行只证明「二进制本身可用、compose 插件目录约定正确」，
**不证明**在 kernel 4.19 + cgroup v1 上也一样。§4.1/§4.3/§4.5 三条必须真机才能结案。

### 5.3 本轮在 `fetch-docker-static.sh` 上修掉的三个缺陷

| # | 缺陷 | 现象 | 处置 |
|---|---|---|---|
| 1 | 假设存在 `<tgz>.sha256` | `download.docker.com/.../docker-27.5.1.tgz.sha256` → **404**（官方该目录只有 tgz） | 改为**内置摘要**（双源比对后固化）+ 未内置摘要的版本 fail-closed 拒绝，可用 `--docker-sha256` 显式传入 |
| 2 | 无源失败兜底 | 官方源握手抖动即整体失败 | 官方源三次重试 → 自动切 USTC 镜像；换源不降低安全性（摘要是离线可信锚点） |
| 3 | `tar -tzf … \| grep -qx` 在 `set -o pipefail` 下误判 | 报「包内缺少 docker/dockerd」，实际包是好的（grep 命中即退出 → tar 收 SIGPIPE → 管道 141） | 先把清单落成变量再 `grep <<<"$LIST"`，并顺带补齐 `containerd`/`runc`/`containerd-shim-runc-v2` 三项检查 |

缺陷 3 是**静默误判型**：不修就会让人以为下载坏了，从而反复重下；这类 `pipefail + grep -q`
组合要全仓排查一遍（`build-server-package.sh`、`make-manifest.sh` 都在此列）。

---

## 6. 变体 B 安装逻辑的实现要求（给 #41 的输入）

1. **落点**：二进制解到 `/usr/local/lib/tianji/docker-static/`，**不要**放 `/usr/local/bin`
   或 `/usr/bin`——前者会与未来可能安装的发行版 docker 抢 PATH，后者在麒麟上正处在
   kysec 文件保护的高危区。
2. **compose 插件**：放 `/usr/local/lib/docker/cli-plugins/docker-compose`（已实测被
   CLI 识别）；不要指望 `/usr/libexec/docker/cli-plugins`（RPM 系自带的 docker 会争抢）。
3. **systemd unit**：`ExecStart=` 写绝对路径，`After=network-online.target firewalld.service`，
   并加 `ExecStartPost=` 做一次就绪等待；unit 文件写入前先判断 kysec 是否需要放行。
4. **不碰发行版包管理**：不执行 `rpm -e`/`dnf install`（除 SELinux 可选装 container-selinux 外）；
   卸载脚本必须只删我们自己写下的文件清单。
5. **preflight 六项**：§4.1–§4.6，全部落到安装报告，缺一即为未完成。
6. **禁止**在任何脚本里使用 `brctl`（UOS 无 `bridge-utils`）、`apt`/`dpkg`、
   Ubuntu 的 `update-ca-certificates`。

---

## 7. 未验证项（不做假设，等真机）

| # | 未验证内容 | 卡在哪 |
|---|---|---|
| 1 | 两个 OS 默认 SELinux 状态 | 需装系统 |
| 2 | 麒麟 kysec 默认是否强制（命令语法已解出，见 §4.2） | 需装系统 |
| 3 | kernel 4.19.90 上 overlay2 是否可用（xfs ftype） | 需装系统 |
| 4 | cgroup v1 上 dockerd 27.5.1 的实际启动行为 | 需装系统 |
| 5 | 安装向导在 4.19 内核 + cgroup v1 下的端到端一次通过 | 需装系统 |
| 6 | firewalld 重启后端口是否仍通 | 需装系统 |

**本机无法启动 ISO 做真 VM 测试**（`wsl.exe` 被沙箱黑名单拦截、无 VirtualBox/VMware、
PowerShell 非提升态无法启用 Hyper-V、`qemu.weilnetz.de` 不可达），此项待用户裁定：
装 VirtualBox / 提权放行 Hyper-V / 授权算力机 `117.157.77.4`（当前 SSH `Permission denied`）。

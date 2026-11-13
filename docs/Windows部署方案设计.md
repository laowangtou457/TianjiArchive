# 天玑档案管理系统 · Windows 部署方案设计（变体 C）

> 版本：v1.0（2026-11-10）
> 状态：设计定稿 + 编排器实现 + 组包链路落地；**S2 之后各阶段真机（Windows Server 2022）验证待做**（见 §9 诚实边界）。
> 上游文档：`安装器总体设计.md`（变体 A/B 已闭环）；本文只写 Windows 变体的增量，不重复 A/B 内容。

---

## 1. 目标与结论

**目标**：让服务端 8 容器栈（api / extractor / web / backup / elasticsearch-ik / redis / postgres / seaweedfs）可以部署到 Windows 服务器，交付物形态与变体 A/B 对齐：

| 项 | 变体 A | 变体 B | **变体 C（本文）** |
|---|---|---|---|
| 目标 OS | Ubuntu 22.04/24.04, Debian 12 | 麒麟 V10 / 统信 UOS | **Windows Server 2022；Windows 10 21H2+ / Windows 11** |
| 产物 | `tianji-server-setup-ubuntu-debian-amd64-1.0.0.run` | `tianji-server-setup-kylin-uos-…run` | **`tianji-server-setup-windows-amd64-1.0.0.zip`** |
| 编排器 | Go 安装器（TUI/Web 向导） | Go 安装器 | **PowerShell 编排器 `tianji-windows-setup.ps1`** |
| Docker 来源 | dpkg 闭包 | 静态 tar + 自写 unit | **dpkg 闭包（在 WSL 内跑变体 A 路径）** |

**核心裁定（一句话）**：Linux 栈一行不改。变体 C = Windows 宿主上的 PowerShell 编排器，把 WSL2 + Ubuntu 22.04 准备好后，**将变体 A 的 .run 原样放进 WSL 发行版内执行**——S1→S10 全套闸门（预检 / dpkg 闭包 / 迁移 / 镜像装载 / 冒烟）零改动继承。

### 1.1 为什么是 WSL2，而不是别的

| 备选 | 裁定 | 理由 |
|---|---|---|
| **WSL2 + Ubuntu + 复用变体 A** | ✅ 采用 | 栈内全部组件（ES/PG/SeaweedFS/Go 安装器）都是 Linux 优先；复用 .run 意味着 A/B 已真机闭环的安装/迁移/冒烟逻辑原样生效，Windows 侧只新增"宿主编排"一层 |
| Docker Desktop | ❌ 排除 | 企业付费授权（员工 >250 或年营收 >$10M 的单位须付费订阅），档案客户（政企）大概率命中；且 DDE 自身同样依赖 WSL2/ Hyper-V，架构上没有省任何事 |
| 原生 Windows 服务（PG/ES Windows 版 + 各组件直装） | ❌ 排除 | Redis 官方无 Windows 版、SeaweedFS/compose 需逐个适配、Go 安装器是 GOOS=linux——等于把已闭环的交付重写一遍，且四性检测/备份链路全部要重新验证 |

### 1.2 零 Go 代码改动的边界

变体 A .run 在 WSL 内执行的**兼容性前提**（S3_DOCKER 阶段前由编排器保证）：

1. `/etc/wsl.conf` 写入 `[boot] systemd=true`——变体 A 的 docker deb 装 unit 走 `systemctl enable`，WSL 无 systemd 时会失败；
2. WSL 版本 ≥ 0.67.65（systemd 支持）——由随包 WSL MSI 保证（§4）；
3. WSL 发行版内时区/中文 locale 不影响安装器（Go 安装器界面是宿主浏览器 Web 向导，不依赖发行版 locale）。

---

## 2. 交付包结构与落盘

```
tianji-server-setup-windows-amd64-1.0.0.zip
└── tianji-windows-setup/
    ├── tianji-windows-setup.ps1            # PowerShell 编排器（本变体唯一新代码）
    ├── 说明.txt                             # 面向现场运维的中文说明
    ├── payload/
    │   ├── wsl.2.x.x64.msi                 # 微软官方 WSL MSI（含内核 + wsl.exe，离线安装 Store 版 WSL）
    │   ├── ubuntu-jammy-wsl-rootfs.tar.gz  # Ubuntu 22.04 WSL rootfs（与变体 A 构建机同 codename）
    │   ├── tianji-server-setup-ubuntu-debian-amd64-1.0.0.run   # 原样复用，不做任何改写
    │   └── SHA256SUMS.txt                  # 全部载荷 sha256（编排器逐项校验后才执行）
    └── （镜像 tar 不打进包，分发口径与 §7.1 分离分发一致——用离线交付整合包或单独镜像 tar）
```

- 现场落盘：编排器与 payload 解压到任意目录（如 `D:\tianji-setup\`）；WSL 发行版 vhdx 固定落 `C:\tianji\wsl\`；状态与日志落 `C:\tianji\`。
- 包体估算：≈ 440 MB（.run ≈130MB + rootfs ≈300MB + MSI ≈10MB + 编排器 <1MB）。

---

## 3. 目标 OS 矩阵（只认实测过的，不猜）

| OS | 支持 | 依据 / 边界 |
|---|---|---|
| Windows Server 2022 Standard/Datacenter | ✅ 目标平台 | 支持 VirtualMachinePlatform + WSL MSI；真机验证见 §9 |
| Windows Server 2025 | 🟡 预期可用，未实测 | 同 2022 机制；列入待验证 |
| Windows Server 2019 / 2016 | ❌ 不支持 | 无 WSL2 能力，不做降级 |
| Windows 10 21H2+（build 19044+） | ✅ 支持 | 须启用虚拟化（BIOS VT-x/AMD-V） |
| Windows 11（全版本） | ✅ 支持 | 22H2+ 可选 mirrored 网络模式（§5.3） |
| 域控/AD 环境 | 🟡 未验证 | 计划任务与防火墙策略可能受组策略约束，登记待验证 |

预检硬闸（S1，fail-closed）：管理员身份、OS 版本在矩阵内、HypervisorPresent（或虚拟化未禁用）、内存 ≥ 8GB（建议 16）、安装盘剩余 ≥ 60GB（镜像 tar + 数据卷增长）、8080/8333/3000/18080 端口空闲。

---

## 4. 离线资产（难点 1：内网拿不到微软商店）

WSL2 官方推荐路径是 `wsl --install`（联网 + 商店）。内网离线替代：

1. **WSL MSI**（`wsl.2.x.x64.msi`）：微软 GitHub Releases 提供的离线安装器，一次装齐「Store 版 wsl.exe + WSL2 内核」，替代 inbox WSL，带 systemd 支持。构建机用 `fetch-wsl-assets.sh` 抓取并登记 sha256；若微软直连失败，按脚本内提示手工下载后放入 `installer/build/assets/wsl/`。
2. **Ubuntu 22.04 WSL rootfs**（`ubuntu-jammy-wsl-rootfs.tar.gz`）：与变体 A 构建机同 codename（jammy），保证 dpkg 闭包兼容承诺不变（变体 A 只承诺与构建机同 codename）。主源清华 TUNA、备源官方 cloud-images，脚本内固定版本号不追 latest。
3. **变体 A .run**：由 `build-server-package.sh --variant ubuntu-debian --codename jammy` 产出后原样放进 Windows 包，**不做任何改写**（改写会破坏 G1 载荷一致性口径与 sha 登记）。

三份资产在出包时全部进 `SHA256SUMS.txt`；编排器 S0 装载阶段逐项重算校验，不一致即停（fail-closed，与变体 B 的 G1-static 同哲学：装上去的东西没有归属校验，只能在出包侧钉死）。

---

## 5. 网络（难点 2：WSL2 NAT 与局域网访问）

### 5.1 端口口径

| 端口 | 用途 | 暴露面 |
|---|---|---|
| 8080 | web（用户界面 + /healthz） | LAN（portproxy + 防火墙放行） |
| 8333 | SeaweedFS S3（浏览器直传/预览） | LAN（portproxy + 防火墙放行） |
| 18080 | Go 安装器 Web 向导 | 仅 localhost（WSL localhostForwarding 自动） |
| 3000 | api 直连（调试用） | 仅 localhost |
| 9200 / 5432 / 6379 | ES / PG / Redis | **不暴露**（与 Linux 变体同口径） |

### 5.2 默认：NAT + portproxy

WSL2 默认 NAT 网络：宿主本机访问容器栈靠 `localhostForwarding`（默认开启，免配置）；**局域网其他机器**访问 8080/8333 需要：

1. `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8080 connectaddress=<WSL IP> connectport=8080`（8333 同理）；
2. `New-NetFirewallRule -DisplayName "TianjiArchive Web" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow`（8333 同理）；
3. WSL IP 是动态的 → 编排器提供 `tianji-windows-setup.ps1 -RefreshPortProxy`，开机自启任务每次也先刷新再起栈。

### 5.3 可选：mirrored 网络模式（Windows 11 22H2+）

`.wslconfig` 写 `networkingMode=mirrored` 后 WSL 直接共享宿主网络栈，**免 portproxy、免 localhost 转发**，防火墙语义与普通 Windows 服务一致。Server 2022 不支持 → 编排器在 OS 支持时**询问**是否启用（默认否，保持与 Server 2022 同路径），非交互模式默认否。

---

## 6. 安装流程（S1→S7，fail-closed，留痕）

| 阶段 | 内容 | 失败语义 |
|---|---|---|
| S0 装载 | 解压目录识别 + SHA256SUMS 逐项校验 | 载荷不一致立即停，不进入任何安装动作 |
| S1 预检 | §3 硬闸全过才放行；输出 PASS/FAIL 明细 | 任一 FAIL 停；`-PreflightOnly` 只跑到这里 |
| S2 虚拟化底座 | 启用 VirtualMachinePlatform（DISM）+ 静默安装 WSL MSI | DISM/MSI 返回码非 0 即停；**需重启时显式停下并写 state.json（stage=S2_REBOOT_PENDING）**，重启后重跑自动从 S2 续 |
| S3 发行版 | `wsl --import TianjiArchive C:\tianji\wsl <rootfs>` + 写 `/etc/wsl.conf`（systemd=true）+ `.wslconfig`（memory/processors 上限） | import 失败即停；.wslconfig 写 `%UserProfile%\.wslconfig`（带 Tianji 标记注释，不覆盖用户已有配置——冲突时显式报错） |
| S4 服务端安装 | .run 拷入 WSL `/opt/tianji-installer/` → 编排器提示在宿主浏览器打开 `http://localhost:18080` 完成 S1→S10（与变体 A 体验一致，含单步通道 /api/step） | 向导内部自fail-closed；编排器轮询 `.run` 退出码 |
| S5 端口暴露 | portproxy ×2 + 防火墙规则 ×2 + 宿主 LAN IP 自测（Invoke-WebRequest 本机 LAN 地址 8080/healthz） | 自测不过 = LAN 侧不可用，FAIL 停（本机 localhost 已通不算过） |
| S6 自启 | 计划任务 `TianjiArchive-Boot`（SYSTEM / ONSTART）→ `C:\tianji\bin\tianji-boot.ps1`：刷新 portproxy → `wsl -d TianjiArchive -u root -- /opt/tianji/bin/boot.sh`（compose up -d + 等 healthy + 冒烟 3 项） | boot 脚本失败写 Windows 事件日志可见的留痕文件，任务不隐藏失败 |
| S7 收尾冒烟 | 复用 client-lite 同口径三项：8080 /healthz、/api/health（objectStorage.ok=true）、8333 TCP | 三项全 PASS 才 IS_PASS: YES，退出码 0 |

**断点重入**：`C:\tianji\state.json` 记 `{stage, variant, startedAtUtc, steps:{...}}`；重跑编排器从首个非 DONE 阶段续（与 Linux 安装器状态机同哲学）。**日志**：`C:\tianji\logs\setup-<时间戳>.log`（Start-Transcript 全程留痕）。

---

## 7. 卸载与数据

`tianji-windows-setup.ps1 -Uninstall`：

1. 停计划任务并删除；删 portproxy ×2 与防火墙规则 ×2；
2. WSL 发行版**默认保留**（数据在 `C:\tianji\wsl\ext4.vhdx` 内，含全部档案数据）；
3. `-PurgeData` 才执行 `wsl --unregister TianjiArchive` + 删 `C:\tianji` —— **显式二次确认**，与 Linux 变体 `--purge-volumes` 同语义：不明确要求数据清除就一定保留。

---

## 8. 与既有交付物的一致性口径

- **自检/冒烟判据**：S7 与 client-lite 自检.ps1、offline/smoke.sh 同口径（8080/healthz + /api/health + 8333 TCP）。
- **部署手册**：`离线部署手册.md` 增加 Windows 变体章节指针；Linux 双变体内容不动。
- **版本绑定**：Windows 包内的 .run 版本与编排器 `-Version` 必须一致，出包脚本强制核对（防"新编排器配旧服务端"的静默漂移）。
- **docker deb 闭包**：rootfs 锁 jammy → 变体 A "只承诺同 codename" 的边界原样成立。

---

## 9. 诚实边界（真机回填版 · 2026-11-13）

> 2026-11-13 在 **Windows Server 2022（21H2 / build 20348，Evaluation）VMware 虚拟机**上完成 V0→V7 真机验证。
> 验证清单与逐条证据见 `installer/windows/真机验证清单.md`。下列各条已按实测结论改写，**未闭环的如实标注**。

### 9.1 已验证通过（真机）

| 项 | 结论 |
|---|---|
| V0 载荷校验 | zip / tar 双 sha256 构建前后一致 |
| V1 十项预检 | 全 PASS（`HypervisorPresent=True`、build 20348、C: 103.4GB、四端口空闲、`C:\tianji` 可写） |
| V2 特性启用 + 重启闸 | S2 返回重启闸 rc=7、`state.json` 写 `S2=REBOOT_PENDING`；重启后续装成功（`VirtualMachinePlatform` 已启用 → wsl.msi 返回 0） |
| V3 发行版导入 | 导入成功、`systemd=true` 生效、`.wslconfig` 生效（`memory=10GB processors=4`） |
| V4 向导 S1→S10 | 全 DONE（S1 0.2s / S2 58.7s / S3 82.6s / S4 166.3s / S5 0.0s / S6 53.1s / S7 7.5s / S8 4.7s / S9 15.9s / S10 0.0s） |
| V4 冒烟 | 4/4 passed：健康检查四依赖全 ok（postgres 12ms / es 6ms / objectStorage 3ms / redis 1ms）；S3 探针 `OPS_TOTAL=13 OPS_PASSED=13`；样品书籍全链路 `IS_PASS: YES` |
| V5 端口暴露 | portproxy（`0.0.0.0` + `127.0.0.1` 各两条）+ 防火墙 8080/8333；**局域网自测 `http://<VM-IP>:8080/healthz` = ok** |
| V6 任务注册 | `TianjiArchive-Boot` 注册成功，`Principal = Administrator / S4U / Highest` |
| V7 完成判定 | `IS_PASS: YES —— 安装完成` |

### 9.2 未闭环（如实登记，不粉饰）

**V6「重启 → 不登录 → 服务自动起来」未通过**，根因已定位为 WSL2 的平台行为，不是安装脚本缺陷：

- **WSL2 的实用 VM 在没有附着会话时会自动关闭**。实测证据：每次 `wsl.exe` 调用查到的
  `PID 1 systemd` 的 `ELAPSED` 只有 12–21 秒 —— 说明每次都是**冷启动一个新 VM**，而非接入已有的。
  8 个 docker 容器属于后台进程，**不算活动会话**，钉不住 VM。
- VM 被关掉后 `docker.sock` 消失、8080 无监听；此时宿主 portproxy 规则再正确
  （`iphlpsvc` Running、目标 IP 对得上）也转发不到东西 → `localhost:8080` 超时。
- 冷启动一遍（systemd 引导 + dockerd + 8 容器 restart）实测 **约 35–60 秒**
  （5 秒轮询第 7 轮后 `healthz=200`）。

对应修复（已落源码，**尚未在真机复验**）：

1. boot 包装末尾起一个常驻 `sleep infinity` WSL 会话钉住 VM；
2. 计划任务 `ExecutionTimeLimit = 0`（原为 `PT1H`，一小时后任务被杀，keep-alive 随之消失）；
3. S4 改为轮询 Linux 侧 `state.json` 的 `S10_DONE`，不再 `WaitForExit`（向导是常驻 Web 服务，永不退出）。

**V8（`-Uninstall`）/ V9（`-Uninstall -PurgeData`）/ V10（重装回归）未执行**，等 V6 闭环后一并做。

### 9.3 嵌套虚拟化对宿主的硬要求（现场部署必须提前确认）

变体 C 要在 VM 内的 WSL2 里跑 docker，因此 **VM 自身需要嵌套虚拟化**（`vhv.enable="TRUE"`），
而嵌套虚拟化要求宿主把原生 VT-x/EPT 让给 VMware：

- 宿主若启用了 Hyper-V（`HypervisorPresent=True`，或 WSL2 / Docker Desktop / 内存完整性在跑），
  VMware 只能走 WHP 模式，**WHP 不支持嵌套虚拟化** → 客户机 `HypervisorPresent` 恒 `False`，VM 内 WSL2 起不来；
- 现场安装前必须确认：`bcdedit /set hypervisorlaunchtype off` + 关闭「内核隔离 → 内存完整性」+ 重启。
  只做 `bcdedit` 而不关内存完整性，重启后 hypervisor 会被重新拉起（实测：重启后 VMware 报
  「此平台不支持虚拟化的 Intel VT-x/EPT」、`模块"HV"启动失败`）；
- 该设置与宿主上的 WSL2 / Docker Desktop **互斥**，验证/部署期间二者不可同时使用。

> 这是平台限制而非本方案的取舍。若现场必须两者共存，替代路线是把 Server 2022 跑在
> Hyper-V 上并用 `Set-VMProcessor -ExposeVirtualizationExtensions $true` 开嵌套（本方案未实现，登记为备选）。

### 9.4 仍未验证（保持开放）

1. **Windows Defender / 企业杀软**：对 `ext4.vhdx` 与 docker 的干扰未验证。
2. **域控 / 组策略**：计划任务注册与防火墙规则可能被 GPO 覆盖，未验证。
3. **Windows 11 / mirrored 网络模式**：仅验证了 Server 2022 + NAT + portproxy 路径。
4. **磁盘清理与磁盘占用**：`.wslconfig` 的 `memory` 上限需扣除内核开销（8GB 上限实测 `MemTotal` 仅 ~7.4GB），
   预检判据要求 ≥8GB 时须给到 10GB 以上；该梯度已按物理内存分档实现，但仅在 12GB 物理机上验证过。

---

## 10. 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.0 | 2026-11-10 | 设计定稿；编排器 `tianji-windows-setup.ps1` + `fetch-wsl-assets.sh` + `build-windows-package.sh` 落地；本机静态验证与组包双跑通过；S2→S7 真机验证登记待做 |
| v1.1 | 2026-11-13 | **真机回填**：Server 2022 VM 上跑通 V0→V5、V7（S1→S10 全 DONE + 冒烟 4/4 + LAN 自测）；§9 按实测重写。修复 13 处真机缺陷：S2 补启用 `Microsoft-Windows-Subsystem-Linux`、`wsl.conf` 反引号换行、`WslPathOf` 盘符小写、`.wslconfig` 补段头与内存梯度、`Get-WslIp` 双编码解码、`Content` 的 `Byte[]` 归一化、`$PSCommandPath`、`localhost→127.0.0.1` 与 portproxy 回环规则、`/api/health` 断言结构、boot.sh base64 前归一 LF、S6 改 S4U、**S4 改轮询 state.json 不再 `WaitForExit`**、boot 加 keep-alive + `ExecutionTimeLimit=0`。V6 重启自启未闭环（WSL2 VM 无会话自动关闭），根因与修复已登记 §9.2 |

# logs/ 说明：每个文件是什么、能不能当证据

所有日志都是**原始输出**，未做修饰；结论见 `docs/变体B-真机实测结果.md`。

| 文件 | 内容 | 可信度 |
|---|---|---|
| `kylin-install.log` | 麒麟安装串口全文（首行是 `# accel=…` 头，由 run-vm.sh 在 qemu 退出后补写） | 原文，可直接引用 |
| `kylin-boot.log` | 麒麟首次开机串口 | 原文；注意它每次重启会被截断重写，且头行只在 qemu 正常退出时补写 |
| `kylin-probe.txt` | 麒麟六项探测 + 补证（`[10]` 段为 SELinux 关闭原因） | 原文，**核心证据** |
| `kylin-dockerd.txt` | 麒麟 dockerd 27.5.1 启动、overlay2、iptables 链、firewalld reload 实验 | 原文拼接，**核心证据** |
| `kylin-firewalld-exp3.log` | 麒麟「dockerd 在跑 + restart firewalld」实验 | ⚠ **环境相关**，见下 |
| `kylin-firewalld-exp4-counters.log` | 同一场景下 iptables 命中计数（全 0） | ⚠ **环境相关**，见下 |
| `uos-install.log` / `uos-boot.log` | 统信安装/开机串口 | 原文 |
| `uos-probe.txt` | 统信六项探测 | 原文，**核心证据** |
| `uos-dockerd.txt` | 统信 dockerd 首次启动成功 + 二次启动 `ZONE_CONFLICT` 失败 | 原文拼接，**核心证据** |
| `*-install-qemu.cmd` / `*-boot-qemu.cmd` | 实际 qemu 命令行（含 `accel`） | 原文 |
| `*-install-qemu.out` / `*-boot-qemu.out` | qemu 自身 stderr | 原文（通常为空） |

## 变体 A（ubuntu/debian）证据（2026-11-12）

| 文件 | 内容 | 可信度 |
|---|---|---|
| `ubuntu-install.log` | Ubuntu 22.04.5 无人值守装机串口全文（第 6 轮，ISO 本地 apt 镜像方案，零 `install_fail`） | 原文，**核心证据** |
| `ubuntu-e2e-stagec-boot.log` | guest 内 oneshot 自跑 S1→S10 全链串口全文，末段 `=== CX ubuntu ALL-GREEN ===` | 原文，**核心证据（主判据）** |
| `ubuntu-e2e-collect-boot.log` | collect 阶段（disable docker 后）串口全文 | 原文 |
| `ubuntu-e2e-collect-files.tgz` | guest 内取证包：`state.json` + `S1..S10` 全部 `/api/step` 回执 + `stagec-ubuntu.log` | 原文，**判据数据源** |
| `*-stages.log` | 阶段耗时打点（装机 173s / boot 272s） | 只记时间戳，**不是结论证据** |
| `ubuntu-e2e-evidence.md` | 本次 e2e 的结论汇总（十步 / 8 镜像 sha / 冒烟 4/4 / 串口行号 / 缺陷闭环） | 结论文档，引用数字一律可回溯到上面几份原文 |
| `ubuntu-e2e-docker-inventory.txt` | 采集失败留痕：`docker` 起来后 slirp SSH 失联（同 `kylin-firewalld-exp3` 机理） | ⚠ **不可作证据**，镜像判据改用 `S4_IMAGES` 回执 |

> 与变体 B 的差别：变体 A 走 `docker load`，容器记录的是 **sha 引用**而非 tag，
> 事后按 `Repository:Tag` 数 `docker images` 会误判为 0 个（已在 `e2e/ubuntu/stagec.sh` 修掉
> docker CLI 路径硬编码问题）。「8 镜像」以 installer 自己导入后的 `checks[]` 全 `ok:true` 为准。


## ⚠ 关于 `kylin-firewalld-exp3/exp4`

这两份记录的是「guest 内 dockerd 起来后，宿主经 QEMU `hostfwd` 的 SSH 失联」。
后续二分实验证明：**触发条件是 guest 内出现网桥接口**（手工 `ip link add docker0 type bridge`
也会立刻复现，`--bridge=none` 则不发生），是 **QEMU user 网络（slirp）的限制**，
不是 firewalld、也不是 iptables（exp4 的计数器全 0 正是这个原因）。
→ 这两份可以用来证明「slirp + 网桥 = 宿主侧失联」，**不能**用来证明「麒麟/统信把管理面弄挂了」。

真正属于 OS 的 firewalld 结论在 `uos-dockerd.txt` 第三部分：`ZONE_CONFLICT: 'docker0' already bound to a zone`。

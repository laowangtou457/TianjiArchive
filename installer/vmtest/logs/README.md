# logs/ 说明：每个文件是什么、能不能当证据

所有日志都是**原始输出**，未做修饰；结论见 `docs/VARIANT-B-VM-RESULT.md`。

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

## ⚠ 关于 `kylin-firewalld-exp3/exp4`

这两份记录的是「guest 内 dockerd 起来后，宿主经 QEMU `hostfwd` 的 SSH 失联」。
后续二分实验证明：**触发条件是 guest 内出现网桥接口**（手工 `ip link add docker0 type bridge`
也会立刻复现，`--bridge=none` 则不发生），是 **QEMU user 网络（slirp）的限制**，
不是 firewalld、也不是 iptables（exp4 的计数器全 0 正是这个原因）。
→ 这两份可以用来证明「slirp + 网桥 = 宿主侧失联」，**不能**用来证明「麒麟/统信把管理面弄挂了」。

真正属于 OS 的 firewalld 结论在 `uos-dockerd.txt` 第三部分：`ZONE_CONFLICT: 'docker0' already bound to a zone`。

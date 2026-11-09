// Package preflight 执行设计 §4.5 的 K1~K13 系统前置核对。
//
// 纪律：逐条**实测**，不读文档、不猜。任一 FAIL 即阻断安装；WARN 需要用户显式确认。
// 三条最容易被忽略但一定会炸的（K5/K6/K7 的 ES 门槛）在这里如实暴露，
// 而不是等到 compose up 之后 ES 容器退出再让人猜。
package preflight

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Level 是单项检查的结论。
type Level string

// 检查结论取值。
const (
	LevelPass Level = "PASS"
	LevelWarn Level = "WARN"
	LevelFail Level = "FAIL"
	LevelSkip Level = "SKIP"
)

// Item 是一条检查结果。Detail 是给人看的结论，Raw 是实测原始输出（进 01-preflight.log）。
type Item struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Level  Level  `json:"level"`
	Detail string `json:"detail"`
	Raw    string `json:"raw,omitempty"`
	Hint   string `json:"hint,omitempty"`
}

// Report 是完整的体检报告。
type Report struct {
	Items     []Item            `json:"items"`
	Facts     map[string]string `json:"facts"`
	StartedAt time.Time         `json:"startedAt"`
	EndedAt   time.Time         `json:"endedAt"`
}

// Failed 返回所有 FAIL 项。
func (r *Report) Failed() []Item {
	var out []Item
	for _, it := range r.Items {
		if it.Level == LevelFail {
			out = append(out, it)
		}
	}
	return out
}

// Warnings 返回所有 WARN 项。
func (r *Report) Warnings() []Item {
	var out []Item
	for _, it := range r.Items {
		if it.Level == LevelWarn {
			out = append(out, it)
		}
	}
	return out
}

// OK 表示没有 FAIL 项（WARN 不阻断，但调用方应提示确认）。
func (r *Report) OK() bool { return len(r.Failed()) == 0 }

// Runner 执行外部命令。抽成接口是为了单测能喂假数据而不真跑 dpkg。
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (stdout string, err error)
}

// ExecRunner 是真实实现。
type ExecRunner struct{}

// Run 执行命令并返回合并后的输出。
func (ExecRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, name, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// Options 控制预检范围。
type Options struct {
	// Variant 为 ubuntu-debian 或 kylin-uos，决定是否检查 dpkg 锁（K11 仅变体 A）。
	Variant string
	// RootDir 用于定位 os-release（测试可指向 fixture 目录）。
	RootDir string
	// Runner 为空时用 ExecRunner。
	Runner Runner
}

// Check 执行全部 K1~K13。
func Check(ctx context.Context, opts Options) *Report {
	if opts.Runner == nil {
		opts.Runner = ExecRunner{}
	}
	if opts.RootDir == "" {
		opts.RootDir = "/"
	}
	rep := &Report{Facts: map[string]string{}, StartedAt: time.Now().UTC()}
	add := func(it Item) { rep.Items = append(rep.Items, it) }

	osr, err := ReadOSRelease(filepath.Join(opts.RootDir, "etc/os-release"))
	if err != nil {
		add(Item{ID: "K0", Title: "发行版识别", Level: LevelFail, Detail: err.Error(),
			Hint: "读不到 /etc/os-release，无法判定发行版与版本，拒绝继续"})
	} else {
		rep.Facts["os_id"] = osr["ID"]
		rep.Facts["os_version_id"] = osr["VERSION_ID"]
		rep.Facts["os_codename"] = osr["VERSION_CODENAME"]
		add(Item{ID: "K0", Title: "发行版识别", Level: LevelPass,
			Detail: fmt.Sprintf("%s %s (%s)", osr["ID"], osr["VERSION_ID"], osr["VERSION_CODENAME"]),
			Raw:    fmt.Sprintf("ID=%s VERSION_ID=%s VERSION_CODENAME=%s", osr["ID"], osr["VERSION_ID"], osr["VERSION_CODENAME"])})
	}

	// K1 内核版本
	if out, err := opts.Runner.Run(ctx, "uname", "-r"); err != nil {
		add(Item{ID: "K1", Title: "内核版本", Level: LevelFail, Detail: "uname -r 失败: " + err.Error()})
	} else {
		ver := strings.TrimSpace(out)
		rep.Facts["kernel"] = ver
		major, minor := parseKernel(ver)
		level := LevelPass
		hint := ""
		switch {
		case major < 3 || (major == 3 && minor < 10):
			level = LevelFail
			hint = "内核低于 3.10，overlay2 与 cgroup 均不可用，必须升级内核"
		case major < 4 || (major == 4 && minor < 19):
			level = LevelWarn
			hint = "内核低于 4.19，可运行但不保证 overlay2/cgroup v2 行为，建议升级"
		}
		add(Item{ID: "K1", Title: "内核版本", Level: level, Detail: ver + "（要求 ≥ 4.19，最低 3.10）", Raw: ver, Hint: hint})
	}

	// K2 架构
	if out, err := opts.Runner.Run(ctx, "uname", "-m"); err != nil {
		add(Item{ID: "K2", Title: "架构", Level: LevelFail, Detail: "uname -m 失败: " + err.Error()})
	} else {
		arch := strings.TrimSpace(out)
		rep.Facts["arch"] = arch
		if arch == "x86_64" {
			add(Item{ID: "K2", Title: "架构", Level: LevelPass, Detail: "x86_64", Raw: arch})
		} else {
			add(Item{ID: "K2", Title: "架构", Level: LevelFail, Detail: arch,
				Hint: "首版只承诺 amd64：镜像与二进制都是 x86-64，架构不符必然跑不起来"})
		}
	}

	// K3 overlay2 —— 判定顺序必须是「先 modprobe，再读 /proc/filesystems」。
	//
	// 真机实测（麒麟 V10 SP3，2026-11-10）：全新机器的 overlay 模块默认不加载，
	// /proc/filesystems 只在模块加载**之后**才列 `nodev overlay`。旧写法先读文件再
	// modprobe，于是同一份预检日志自相矛盾——「modprobe overlay: ok」与
	// 「/proc/filesystems 含 overlay: false」并存，且在全新机器上必然误报 FAIL。
	// 统一口径（K3 与变体 B 的 B5 同源）：支持 = modprobe 退出码 0 或 modprobe 后
	// /proc/filesystems 含 overlay。modprobe 的输出/错误要留在 Raw 里，不许静默。
	modOut, modErr := opts.Runner.Run(ctx, "modprobe", "overlay")
	fsOut, fsErr := readFile(filepath.Join(opts.RootDir, "proc/filesystems"))
	hasOverlay := fsErr == nil && strings.Contains(fsOut, "overlay")

	raw := "modprobe overlay: "
	switch {
	case modErr == nil:
		raw += "ok"
	default:
		raw += "失败（" + modErr.Error() + "）"
	}
	if strings.TrimSpace(modOut) != "" {
		raw += "\n  输出: " + strings.TrimSpace(modOut)
	}
	if fsErr != nil {
		raw += "\n/proc/filesystems 读不到: " + fsErr.Error()
	} else {
		raw += "\n/proc/filesystems 含 overlay（modprobe 之后读取）: " + strconv.FormatBool(hasOverlay)
	}

	switch {
	case modErr == nil || hasOverlay:
		how := "modprobe 成功"
		if modErr != nil {
			how = "模块已加载/内建（/proc/filesystems 直接列出）"
		}
		rep.Facts["overlay"] = "supported"
		add(Item{ID: "K3", Title: "overlay2 文件系统", Level: LevelPass,
			Detail: "内核支持 overlay（" + how + "）", Raw: raw})
	case fsErr != nil:
		rep.Facts["overlay"] = "unknown"
		add(Item{ID: "K3", Title: "overlay2 文件系统", Level: LevelWarn,
			Detail: "modprobe 失败且读不到 /proc/filesystems，无法判定 overlay 支持", Raw: raw,
			Hint: "手工跑 `modprobe overlay && grep overlay /proc/filesystems` 后重装"})
	default:
		rep.Facts["overlay"] = "unsupported"
		add(Item{ID: "K3", Title: "overlay2 文件系统", Level: LevelFail,
			Detail: "内核不支持 overlayfs，无法运行 Docker", Raw: raw,
			Hint: "modprobe overlay 失败且 /proc/filesystems 无 overlay：内核没有 overlay 模块。" +
				"只能退回 vfs（磁盘占用与性能不可接受）；请换内核或开启 overlay 模块"})
	}

	// K4 cgroup
	if out, err := opts.Runner.Run(ctx, "stat", "-fc", "%T", "/sys/fs/cgroup"); err == nil {
		fs := strings.TrimSpace(out)
		rep.Facts["cgroup"] = fs
		switch fs {
		case "cgroup2fs", "tmpfs":
			add(Item{ID: "K4", Title: "cgroup", Level: LevelPass, Detail: fs, Raw: fs})
		default:
			add(Item{ID: "K4", Title: "cgroup", Level: LevelFail, Detail: "无法识别的 cgroup 文件系统: " + fs,
				Hint: "dockerd 会启动失败；确认系统挂载了 cgroup v1/v2"})
		}
	} else {
		add(Item{ID: "K4", Title: "cgroup", Level: LevelWarn, Detail: "stat /sys/fs/cgroup 失败: " + err.Error()})
	}

	// K5 vm.max_map_count —— ES 启动的硬门槛。
	//
	// 判级是 WARN 不是 FAIL（真机 e2e 2026-11-10 裁定）：payload 里带
	// /etc/sysctl.d/99-tianji.conf（vm.max_map_count=262144），S3_DOCKER 会落盘并
	// `sysctl --system` 生效、回读核对。S1 把一个会被 S3 自动修复的项判成阻断 FAIL
	// 是自相矛盾——但这只能由 S3 的回读来背书（kernel.EnsureKernelParams 留了
	// before/after，生效值仍 < 262144 会在 S3 阻断），不能在这里静默放行了事。
	if out, err := opts.Runner.Run(ctx, "sysctl", "-n", "vm.max_map_count"); err == nil {
		val := strings.TrimSpace(out)
		rep.Facts["vm.max_map_count"] = val
		if n, convErr := strconv.Atoi(val); convErr == nil && n >= 262144 {
			add(Item{ID: "K5", Title: "vm.max_map_count", Level: LevelPass,
				Detail: fmt.Sprintf("%d（要求 ≥ 262144）", n), Raw: val})
		} else {
			add(Item{ID: "K5", Title: "vm.max_map_count", Level: LevelWarn,
				Detail: fmt.Sprintf("%s（要求 ≥ 262144；S3_DOCKER 将自动修复）", val), Raw: val,
				Hint: "ES 8 会因 mmap 数量不足直接退出（bootstrap.memory_lock: true）。" +
					"S3_DOCKER 将写入 /etc/sysctl.d/99-tianji.conf 并 `sysctl --system` 生效，" +
					"生效后回读核对 ≥ 262144，不满足会在 S3 阻断；想提前修可手工 " +
					"`sysctl -w vm.max_map_count=262144`"})
		}
	} else {
		add(Item{ID: "K5", Title: "vm.max_map_count", Level: LevelWarn, Detail: "sysctl 不可用: " + err.Error(),
			Hint: "现在读不到无法预判，但 S3_DOCKER 会写入 /etc/sysctl.d/99-tianji.conf 并回读核对 ≥ 262144；" +
				"届时仍低于要求会在 S3 阻断（不会静默放行）"})
	}

	// K6/K7 ulimit（用 sh -c 读当前 shell 的软限制）
	if out, err := opts.Runner.Run(ctx, "sh", "-c", "ulimit -l; ulimit -n"); err == nil {
		lines := strings.Fields(strings.TrimSpace(out))
		memlock, nofile := "", ""
		if len(lines) >= 2 {
			memlock, nofile = lines[0], lines[1]
		}
		rep.Facts["ulimit_memlock"] = memlock
		rep.Facts["ulimit_nofile"] = nofile
		if memlock == "unlimited" {
			add(Item{ID: "K6", Title: "memlock ulimit", Level: LevelPass, Detail: "unlimited", Raw: out})
		} else {
			add(Item{ID: "K6", Title: "memlock ulimit", Level: LevelWarn, Detail: memlock + "（期望 unlimited）",
				Hint: "ES 锁内存可能失败；安装器会写入 /etc/security/limits.d/99-tianji-limits.conf"})
		}
		if n, convErr := strconv.Atoi(nofile); convErr == nil && n >= 65535 {
			add(Item{ID: "K7", Title: "nofile ulimit", Level: LevelPass, Detail: nofile + "（要求 ≥ 65535）", Raw: nofile})
		} else {
			add(Item{ID: "K7", Title: "nofile ulimit", Level: LevelWarn, Detail: nofile + "（要求 ≥ 65535）",
				Hint: "ES 可能报 max file descriptors too low"})
		}
	} else {
		add(Item{ID: "K6", Title: "memlock ulimit", Level: LevelWarn, Detail: "读取失败: " + err.Error()})
		add(Item{ID: "K7", Title: "nofile ulimit", Level: LevelWarn, Detail: "读取失败: " + err.Error()})
	}

	// K8 iptables / nft
	iptOK := false
	if _, err := opts.Runner.Run(ctx, "iptables", "-V"); err == nil {
		iptOK = true
	}
	nftOK := false
	if _, err := opts.Runner.Run(ctx, "nft", "list", "ruleset"); err == nil {
		nftOK = true
	}
	if iptOK || nftOK {
		add(Item{ID: "K8", Title: "iptables/nft", Level: LevelPass,
			Detail: fmt.Sprintf("iptables=%v nft=%v", iptOK, nftOK)})
	} else {
		add(Item{ID: "K8", Title: "iptables/nft", Level: LevelWarn, Detail: "两者均不可用",
			Hint: "容器间 NAT 可能建不起来，tianji-net 网络会失败"})
	}

	// K9 磁盘（部署根所在分区）
	if out, err := opts.Runner.Run(ctx, "df", "-B1", "--output=avail", "/var"); err == nil {
		fields := strings.Fields(out)
		if len(fields) >= 2 {
			if avail, convErr := strconv.ParseInt(fields[len(fields)-1], 10, 64); convErr == nil {
				// 用十进制 GB 换算：磁盘是按十进制标注的（标称 30GB 的盘实际就是
				// 300 亿字节），若按 GiB 相除会得到 27，把「刚够」误判成 FAIL。
				gb := avail / (1000 * 1000 * 1000)
				rep.Facts["disk_avail_gb"] = strconv.FormatInt(gb, 10)
				level, hint := LevelPass, ""
				switch {
				case gb < 30:
					level = LevelFail
					hint = "可用空间不足 30GB：解压镜像 tar 后还要 load，会中途失败"
				case gb < 60:
					level = LevelWarn
					hint = "建议 ≥ 60GB：ES 与 PG 会持续增长，30GB 只够跑起来"
				}
				add(Item{ID: "K9", Title: "磁盘可用空间", Level: level,
					Detail: fmt.Sprintf("%d GB（要求 ≥ 30，建议 ≥ 60）", gb), Raw: out, Hint: hint})
			}
		}
	} else {
		add(Item{ID: "K9", Title: "磁盘可用空间", Level: LevelWarn, Detail: "df 失败: " + err.Error()})
	}

	// K10 内存
	if out, err := readFile(filepath.Join(opts.RootDir, "proc/meminfo")); err == nil {
		if m := regexp.MustCompile(`MemTotal:\s+(\d+) kB`).FindStringSubmatch(out); len(m) == 2 {
			if kb, convErr := strconv.ParseInt(m[1], 10, 64); convErr == nil {
				// 同 K9：按十进制 GB 换算。16GB 机器的 MemTotal 通常是 16384000 kB，
				// 按 GiB 相除得 15，会把足量机器误判成 WARN —— 这类假警报会直接
				// 让现场操作员不信任安装器的判定。
				gb := kb / (1000 * 1000)
				rep.Facts["mem_total_gb"] = strconv.FormatInt(gb, 10)
				level, hint := LevelPass, ""
				switch {
				case gb < 8:
					// 判据不动（真机 e2e 2026-11-10 裁定）：内存不足就是不足，S1 不许放行。
					// 只改文案——真麒麟默认 crashkernel=1024M,high 占约 1GB，8GB 物理机
					// MemTotal ≈ 6.5GB，只说「内存不足」会让现场以为唯一出路是换机器。
					level = LevelFail
					hint = "内存不足 8GB：ES 1g heap + PG shared_buffers 512MB + 8 个容器必然 OOM。" +
						"注意麒麟默认 crashkernel=1024M,high 会占约 1GB，MemTotal ≈ 物理内存 − 1GB" +
						"（8GB 物理机的 MemTotal ≈ 6.5GB，按本判据 FAIL 是正确行为）。出路两条：" +
						"① 加内存到 8GB 以上；② 确认不需要 kdump 后，在内核参数中去掉 crashkernel（grub 配置）并重启"
				case gb < 16:
					level = LevelWarn
					hint = "建议 ≥ 16GB：8GB 能跑但无余量"
				}
				add(Item{ID: "K10", Title: "内存", Level: level,
					Detail: fmt.Sprintf("%d GB（要求 ≥ 8，建议 ≥ 16）", gb), Raw: strings.TrimSpace(m[0]), Hint: hint})
			}
		}
	} else {
		add(Item{ID: "K10", Title: "内存", Level: LevelWarn, Detail: "读不到 /proc/meminfo: " + err.Error()})
	}

	// K11 dpkg 锁（仅变体 A）
	if opts.Variant == "ubuntu-debian" {
		locked := false
		var holder string
		for _, lock := range []string{"/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock"} {
			out, err := opts.Runner.Run(ctx, "fuser", lock)
			if err == nil && strings.TrimSpace(out) != "" {
				locked = true
				holder = strings.TrimSpace(out) + " @ " + lock
				break
			}
		}
		if locked {
			add(Item{ID: "K11", Title: "dpkg 锁", Level: LevelFail, Detail: "被占用: " + holder,
				Hint: "通常是 unattended-upgrades 在跑；等待其结束或先 systemctl stop unattended-upgrades，再重跑"})
		} else {
			add(Item{ID: "K11", Title: "dpkg 锁", Level: LevelPass, Detail: "未被占用"})
		}
	} else {
		add(Item{ID: "K11", Title: "dpkg 锁", Level: LevelSkip, Detail: "变体 B 不使用 dpkg，跳过"})
	}

	// K12 已有 Docker
	if out, err := opts.Runner.Run(ctx, "docker", "version", "--format", "{{.Server.Version}}"); err == nil && strings.TrimSpace(out) != "" {
		rep.Facts["docker_existing"] = strings.TrimSpace(out)
		add(Item{ID: "K12", Title: "已有 Docker", Level: LevelPass,
			Detail: "已安装，Server " + strings.TrimSpace(out) + "，将跳过安装并复用", Raw: out})
	} else {
		add(Item{ID: "K12", Title: "已有 Docker", Level: LevelPass, Detail: "未安装（将由安装器安装）"})
	}

	// K13 SELinux / AppArmor（只告警，不阻断）
	selinux := "disabled"
	if out, err := readFile(filepath.Join(opts.RootDir, "sys/fs/selinux/enforce")); err == nil {
		if strings.TrimSpace(out) == "1" {
			selinux = "enforcing"
		} else {
			selinux = "permissive"
		}
	}
	// apparmor 的 enabled 文件内容是 "Y"/"N"（内核未编译 AppArmor 时该文件不存在），
	// 只判存在性会把 "N" 也算成启用，从而对干净主机误报 WARN。
	apparmor := "absent"
	if out, err := readFile(filepath.Join(opts.RootDir, "sys/module/apparmor/parameters/enabled")); err == nil {
		if strings.TrimSpace(out) == "Y" {
			apparmor = "present"
		} else {
			apparmor = "compiled-but-disabled"
		}
	}
	rep.Facts["selinux"] = selinux
	rep.Facts["apparmor"] = apparmor
	level := LevelPass
	hint := ""
	if selinux == "enforcing" || apparmor == "present" {
		level = LevelWarn
		hint = "卷挂载可能被 MAC 策略拒绝（./volumes/*）；必要时为 /opt/tianji 加白名单"
	}
	add(Item{ID: "K13", Title: "SELinux/AppArmor", Level: level,
		Detail: fmt.Sprintf("selinux=%s apparmor=%s", selinux, apparmor), Hint: hint})

	rep.EndedAt = time.Now().UTC()
	return rep
}

// ReadOSRelease 解析 os-release（KEY=VALUE，值可带引号）。
func ReadOSRelease(path string) (map[string]string, error) {
	raw, err := readFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败: %w", path, err)
	}
	out := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.Index(line, "=")
		if idx <= 0 {
			continue
		}
		key := line[:idx]
		val := strings.Trim(line[idx+1:], `"'`)
		out[key] = val
	}
	return out, nil
}

func readFile(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// parseKernel 从 "5.15.0-91-generic" 解析主次版本。
func parseKernel(ver string) (int, int) {
	m := regexp.MustCompile(`^(\d+)\.(\d+)`).FindStringSubmatch(ver)
	if len(m) != 3 {
		return 0, 0
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major, minor
}

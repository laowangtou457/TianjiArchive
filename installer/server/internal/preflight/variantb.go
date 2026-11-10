package preflight

// 变体 B（麒麟 Kylin V10 / 统信 UOS 20）的六项 OS 基线预检。
//
// 依据：docs/变体B-系统基线实测.md §4.1–§4.6（含 2026-11-09 麒麟真机的实测校正）。
// 边界（裁定过，别越线）：
//   - **只探测与报告，不做任何自动处置**。setstatus -t / setenforce 0 / systemctl disable
//     firewalld / 加 trusted zone 一概不写进代码——这些要现场签认，由安装步骤按报告决定，
//     不能由一个探测函数偷偷改系统状态。
//   - 判定口径必须区分「确认关闭」与「探测失败」。**查不到 ≠ 放行**：
//     kysec 守护没起时 getstatus 必然失败，把它当 off 是最危险的假绿。
//   - SELinux 只认 getenforce 与 /sys/fs/selinux/enforce。**绝不读 /etc/selinux/config**
//     下结论：麒麟最小化安装实测 `SELINUX=enforcing` 而实际状态是 Disabled，
//     按配置文件判会把 Disabled 误判成 Enforcing，触发一整套不必要的处置。
//
// 六项产出统一为 Item：Raw 是原始输出（进 01-preflight.log），Level 是归一化判定
// （PASS=OK / WARN / FAIL / N/A），Hint 是一句话处置建议。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// LevelNA 表示「本机不适用」，与 SKIP（该检查被跳过）区分开。
// 例：统信上查 kysec、没装 firewalld 的机器上查 firewalld。
const LevelNA Level = "N/A"

// VariantBOptions 控制变体 B 预检范围。
type VariantBOptions struct {
	// RootDir 用于读 /etc/os-release、/proc/filesystems、/etc/kysec 等（单测指向 fixture）。
	RootDir string
	// DataDir 是要落 docker 数据/安装载荷的目录，用于探测其所在文件系统的类型。
	// 默认 /var/lib（麒麟/UOS 上 /var 与 / 通常同一分区）。
	DataDir string
	// Runner 为空时用 ExecRunner。
	Runner Runner
}

// CheckVariantB 执行 §4.1–§4.6 六项探测，返回复用 audit 报告结构的 Report。
func CheckVariantB(ctx context.Context, opts VariantBOptions) *Report {
	if opts.Runner == nil {
		opts.Runner = ExecRunner{}
	}
	if opts.RootDir == "" {
		opts.RootDir = "/"
	}
	if opts.DataDir == "" {
		opts.DataDir = "/var/lib"
	}
	rep := &Report{Facts: map[string]string{}, StartedAt: time.Now().UTC()}
	add := func(it Item) { rep.Items = append(rep.Items, it) }

	osr, _ := ReadOSRelease(filepath.Join(opts.RootDir, "etc/os-release"))
	osID := strings.ToLower(osr["ID"])
	osName := osr["ID"] + " " + osr["VERSION_ID"]
	rep.Facts["os"] = strings.TrimSpace(osName)
	isKylin := strings.Contains(osID, "kylin")

	add(checkCgroupV1V2(ctx, opts, rep))
	add(checkSELinux(ctx, opts, rep))
	add(checkKysec(ctx, opts, rep, isKylin))
	add(checkIptablesBackend(ctx, opts, rep))
	add(checkOverlay2Prereq(ctx, opts, rep))
	add(checkFirewalld(ctx, opts, rep))

	rep.EndedAt = time.Now().UTC()
	return rep
}

// checkCgroupV1V2 是 §4.1：只记录，不设阈值。
//
// 为什么只记录：变体 B 锁的 docker 27.5.1 在 cgroup v1/v2 上都能跑，
// 真正要守住的是「别升到 28+」（28 起对 v1 标记 deprecated）。那条约束在载荷版本里，
// 不在预检里——预检只负责把现场事实写进报告，将来出问题时有据可查。
func checkCgroupV1V2(ctx context.Context, opts VariantBOptions, rep *Report) Item {
	const id, title = "B1", "cgroup 版本"
	out, err := opts.Runner.Run(ctx, "stat", "-fc", "%T", "/sys/fs/cgroup")
	if err != nil {
		rep.Facts["cgroup"] = "unknown"
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "stat /sys/fs/cgroup 失败：" + describeRunErr(err),
			Raw:    out,
			Hint:   "无法确认 cgroup 版本；docker 27.5.1 两者都支持，但请手工核 `stat -fc %T /sys/fs/cgroup`"}
	}
	fsType := strings.TrimSpace(out)
	var version string
	switch fsType {
	case "tmpfs":
		version = "v1"
	case "cgroup2fs":
		version = "v2"
	default:
		version = "unknown(" + fsType + ")"
	}
	rep.Facts["cgroup"] = version
	switch version {
	case "v1", "v2":
		return Item{ID: id, Title: title, Level: LevelPass,
			Detail: "cgroup " + version + "（" + fsType + "）",
			Raw:    fsType,
			Hint:   "仅记录。**禁止把 docker 升到 28/29**：28 起 cgroup v1 标记 deprecated"}
	default:
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "无法识别的 cgroup 文件系统类型：" + fsType,
			Raw:    fsType,
			Hint:   "确认 /sys/fs/cgroup 是 cgroup v1/v2 的挂载点，不要是普通目录"}
	}
}

// checkSELinux 是 §4.3。
//
// 判定只认 getenforce（以及 /sys/fs/selinux/enforce 作旁证）。
// 麒麟实测的坑：/etc/selinux/config 写着 enforcing，而 getenforce 说 Disabled——
// 配置文件记的是「下次启用时的目标态」，不是当前态。
func checkSELinux(ctx context.Context, opts VariantBOptions, rep *Report) Item {
	const id, title = "B2", "SELinux 状态"
	out, err := opts.Runner.Run(ctx, "getenforce")
	raw := strings.TrimSpace(out)
	if err != nil {
		// getenforce 不存在 / 无法执行：说明本机没有 SELinux 栈，属「不适用」，
		// 但不能据此说「已关闭」——两者在报告里必须能区分。
		if isCommandMissing(err) {
			rep.Facts["selinux"] = "not-applicable"
			return Item{ID: id, Title: title, Level: LevelNA,
				Detail: "本机没有 getenforce（未安装 SELinux 用户态），不适用",
				Raw:    raw,
				Hint:   "无需动作"}
		}
		rep.Facts["selinux"] = "unknown"
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "getenforce 执行失败：" + describeRunErr(err),
			Raw:    raw,
			Hint:   "**不要把探测失败当成已关闭**；手工跑 `getenforce` 与 `cat /sys/fs/selinux/enforce` 确认"}
	}

	state := canonicalSELinux(raw)
	rep.Facts["selinux"] = state
	enforceRaw := readTrimmed(filepath.Join(opts.RootDir, "sys/fs/selinux/enforce"))
	rawCombined := "getenforce=" + raw
	if enforceRaw != "" {
		rawCombined += "; /sys/fs/selinux/enforce=" + enforceRaw
	}

	switch state {
	case "disabled":
		return Item{ID: id, Title: title, Level: LevelPass,
			Detail: "Disabled（无需处置）", Raw: rawCombined,
			Hint: "注意：**不要读 /etc/selinux/config 判断**，它写的是下次启用的目标态，麒麟上会误报 Enforcing"}
	case "permissive":
		return Item{ID: id, Title: title, Level: LevelPass,
			Detail: "Permissive（不会拦容器挂载）", Raw: rawCombined,
			Hint: "无需动作；若后续改成 Enforcing 需先装 container-selinux"}
	case "enforcing":
		pkgOut, pkgErr := opts.Runner.Run(ctx, "rpm", "-q", "container-selinux")
		pkgRaw := strings.TrimSpace(pkgOut)
		if pkgErr != nil || strings.Contains(strings.ToLower(pkgRaw), "not installed") || pkgRaw == "" {
			return Item{ID: id, Title: title, Level: LevelWarn,
				Detail: "Enforcing 且检测不到 container-selinux 包（容器起不来时会因 mounton 被拒）",
				Raw:    rawCombined + "\n--- rpm -q container-selinux ---\n" + pkgRaw,
				Hint: "麒麟：从 ISO 本地仓库 `rpm -i` 装 container-selinux；统信：仓库无此包，" +
					"只能改 Permissive 并在安装报告里登记为交付例外（需现场签认）"}
		}
		return Item{ID: id, Title: title, Level: LevelPass,
			Detail: "Enforcing，但已有 container-selinux（" + pkgRaw + "），容器可正常启动",
			Raw:    rawCombined + "\n--- rpm -q container-selinux ---\n" + pkgRaw,
			Hint:   "无需动作"}
	default:
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "getenforce 输出无法识别：" + raw,
			Raw:    rawCombined,
			Hint:   "手工核 `getenforce`；未知状态不要当作放行"}
	}
}

// checkKysec 是 §4.2。
//
// 关键口径（麒麟最小化安装实测）：kysec-utils 默认**不装**，`/usr/sbin/getstatus` 不存在，
// 也没有 kysec-daemon 与 /etc/kysec/db —— 这种情况下 kysec 根本不在生效，属「确认未启用」。
// 但只要工具在、查询却失败（守护没起、D-Bus 不通），就必须记 WARN：
// 那时我们**无法证明**它是关的，按放行处理等于赌。
func checkKysec(ctx context.Context, opts VariantBOptions, rep *Report, isKylin bool) Item {
	const id, title = "B3", "麒麟 kysec 执行控制"
	if !isKylin {
		rep.Facts["kysec"] = "not-applicable"
		return Item{ID: id, Title: title, Level: LevelNA,
			Detail: "非麒麟系统，不适用", Raw: "",
			Hint: "无需动作"}
	}

	pathOut, pathErr := opts.Runner.Run(ctx, "sh", "-c", "command -v getstatus")
	getstatusPath := strings.TrimSpace(pathOut)
	kysecDir := filepath.Join(opts.RootDir, "etc/kysec")
	_, dirErr := os.Stat(kysecDir)
	hasDir := dirErr == nil

	if pathErr != nil || getstatusPath == "" {
		if !hasDir {
			// 口径（team-lead 裁定）：**工具不存在 → N/A，不是「已关闭」**。
			// 差别不是措辞：说「已关闭」等于我们替这台机器断言了一件没测过的事；
			// 说 N/A 只表示「这一项在本机没有适用对象」。
			rep.Facts["kysec"] = "not-applicable"
			return Item{ID: id, Title: title, Level: LevelNA,
				Detail: "kysec-utils 未安装（麒麟最小化安装的实测形态：无 getstatus、无 /etc/kysec），判 N/A",
				Raw:    "command -v getstatus: (空)\n/etc/kysec: 不存在",
				Hint: "无需动作。**这不是「已确认关闭」**，而是「本机没有 kysec 可判」；" +
					"若现场另装了 kysec-utils，请重跑本项"}
		}
		rep.Facts["kysec"] = "unknown"
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "存在 /etc/kysec 但查不到 getstatus：无法确认 kysec 当前状态",
			Raw:    "command -v getstatus: (空)\n/etc/kysec: 存在",
			Hint:   "**不得当作放行**。装 kysec-utils 后用 `getstatus` 核，或直接 `systemctl status kysec`"}
	}

	statusOut, statusErr := opts.Runner.Run(ctx, "getstatus")
	raw := "getstatus path=" + getstatusPath + "\n--- getstatus ---\n" + strings.TrimSpace(statusOut)
	if statusErr != nil {
		rep.Facts["kysec"] = "probe-failed"
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "getstatus 执行失败：" + describeRunErr(statusErr) + "（守护未起时必然失败）",
			Raw:    raw,
			Hint: "**探测失败不等于已关闭**。先 `systemctl status kysec-daemon`；" +
				"确认关闭需拿到 getstatus 的实际输出，或 `pgrep -af kysec` 证明没有守护进程",
		}
	}

	moduleStatus := parseKysecStatus(statusOut)
	exectl := parseKysecModule(statusOut, "exectl")
	rep.Facts["kysec"] = moduleStatus
	rep.Facts["kysec_exectl"] = exectl

	switch {
	case moduleStatus == "":
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "getstatus 有输出但解析不到 `KySec status:` 行",
			Raw:    raw,
			Hint:   "手工跑 `getstatus` 看实际格式；解析不到时不要当作放行"}
	case moduleStatus == "enforcing" && exectl == "on":
		return Item{ID: id, Title: title, Level: LevelFail,
			Detail: "kysec 强制态且执行控制开启：解包到 /usr/local 的静态二进制可能被拒绝执行",
			Raw:    raw,
			Hint: "三条路，按优先级：①把二进制路径加白名单（/etc/kysec/db/whlist.db）；" +
				"②`setstatus kysec -s permissive -t` 临时放宽，装完恢复并复验 dockerd；" +
				"③前置条件不满足则中止，不允许带病安装。三条都要留痕"}
	case moduleStatus == "enforcing":
		return Item{ID: id, Title: title, Level: LevelPass,
			Detail: "kysec 强制态，但执行控制(exectl) 未开启，不影响运行静态二进制",
			Raw:    raw,
			Hint:   "无需动作；安装后若出现「权限不足」先回来查 fpro（文件保护）"}
	default:
		return Item{ID: id, Title: title, Level: LevelPass,
			Detail: "kysec 非强制态（status=" + moduleStatus + ", exectl=" + orDash(exectl) + "）",
			Raw:    raw,
			Hint:   "无需动作"}
	}
}

// checkIptablesBackend 是 §4.4 的前置事实：只看后端，不判好坏。
//
// 之所以要记录：麒麟/UOS 上都可能同时装 iptables-legacy 与 iptables-nft，
// `iptables` 这个软链指向谁决定了 dockerd 建规则的方式；出现「规则看起来建了但不生效」
// 时，第一件事就是回来核这三行输出。
func checkIptablesBackend(ctx context.Context, opts VariantBOptions, rep *Report) Item {
	const id, title = "B4", "iptables 后端"
	out, err := opts.Runner.Run(ctx, "iptables", "--version")
	verLine := strings.TrimSpace(out)
	if err != nil {
		rep.Facts["iptables"] = "missing"
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "找不到可用的 iptables：" + describeRunErr(err),
			Raw:    verLine,
			Hint: "dockerd 默认要建 DOCKER 链；缺 iptables 只能用 `--iptables=false` 的降级形态，" +
				"端口发布与容器互通都会受影响，需现场裁定"}
	}

	backend := "unknown"
	lower := strings.ToLower(verLine)
	switch {
	case strings.Contains(lower, "nf_tables"):
		backend = "nf_tables"
	case strings.Contains(lower, "legacy"):
		backend = "legacy"
	}
	rep.Facts["iptables"] = backend

	legacy := strings.TrimSpace(runOrEmpty(ctx, opts.Runner, "sh", "-c", "command -v iptables-legacy"))
	nft := strings.TrimSpace(runOrEmpty(ctx, opts.Runner, "sh", "-c", "command -v iptables-nft"))
	raw := verLine
	if legacy != "" {
		raw += "\niptables-legacy: " + legacy
	}
	if nft != "" {
		raw += "\niptables-nft: " + nft
	}

	hint := "仅记录。docker 直接写 iptables，与 firewalld 会交叠（见 B6）"
	if backend == "unknown" {
		hint = "版本行里既没 nf_tables 也没 legacy，请人工确认这个 iptables 是哪来的（自编译？容器内？）"
	}
	return Item{ID: id, Title: title, Level: LevelPass,
		Detail: "后端 " + backend, Raw: raw, Hint: hint}
}

// checkOverlay2Prereq 是 §4.5 的前置部分。
//
// xfs 的 ftype=1 检查**故意不在这里做**：ftype 只在 /var/lib/docker 真正落在 xfs 上时才有意义，
// 而那个目录在安装前可能还不存在。放到安装步骤里、数据目录已创建之后查，才查得准。
// 这里只回答三个问题：内核够不够、overlay 模块能不能载、目标盘是什么文件系统。
func checkOverlay2Prereq(ctx context.Context, opts VariantBOptions, rep *Report) Item {
	const id, title = "B5", "overlay2 前置（内核 / overlay 模块 / 目标盘 fs）"

	kernelOut, kernelErr := opts.Runner.Run(ctx, "uname", "-r")
	kernel := strings.TrimSpace(kernelOut)
	if kernelErr != nil {
		kernel = ""
	}
	major, minor := parseKernel(kernel)

	// 判定顺序必须是「先 modprobe，再读 /proc/filesystems」，与 K3 同一口径。
	//
	// 真机实测（麒麟 V10 SP3，2026-11-10）：全新机器的 overlay 模块默认不加载，
	// /proc/filesystems 只在模块加载**之后**才列 `nodev overlay`。旧写法先读文件再
	// modprobe，且 modprobe 成功后不重读——同一份日志里「modprobe overlay: ok」与
	// 「/proc/filesystems 含 overlay: false」并存，WARN 理由永远错。
	// 支持 = modprobe 退出码 0 或 modprobe 后 /proc/filesystems 含 overlay。
	modOut, modErr := opts.Runner.Run(ctx, "modprobe", "overlay")
	fsList, fsListErr := readFile(filepath.Join(opts.RootDir, "proc/filesystems"))
	hasOverlay := fsListErr == nil && strings.Contains(fsList, "overlay")
	overlayUsable := modErr == nil || hasOverlay

	fsTypeRaw, fsTypeErr := opts.Runner.Run(ctx, "stat", "-f", "-c", "%T", opts.DataDir)
	fsType := strings.TrimSpace(fsTypeRaw)

	if kernel != "" {
		rep.Facts["kernel"] = kernel
	}
	rep.Facts["overlay_in_proc_filesystems"] = strconv.FormatBool(hasOverlay)
	rep.Facts["overlay_usable"] = strconv.FormatBool(overlayUsable)
	if fsTypeErr == nil {
		rep.Facts["data_fs"] = fsType
	}

	var raw strings.Builder
	fmt.Fprintf(&raw, "uname -r: %s\n", orDash(kernel))
	if modErr == nil {
		raw.WriteString("modprobe overlay: ok\n")
	} else {
		fmt.Fprintf(&raw, "modprobe overlay: 失败（%s）\n", describeRunErr(modErr))
	}
	if strings.TrimSpace(modOut) != "" {
		fmt.Fprintf(&raw, "  输出: %s\n", strings.TrimSpace(modOut))
	}
	if fsListErr != nil {
		fmt.Fprintf(&raw, "/proc/filesystems 读不到: %s\n", fsListErr.Error())
	} else {
		// 注明读取时序：这是 modprobe 之后读的，不再是「载入前」的旧状态。
		fmt.Fprintf(&raw, "/proc/filesystems 含 overlay（modprobe 之后读取）: %v\n", hasOverlay)
	}
	fmt.Fprintf(&raw, "stat -f %s: %s\n", opts.DataDir, orDash(fsType))
	switch {
	case kernelErr != nil:
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "读不到内核版本，无法确认 overlay2 前置",
			Raw:    raw.String(),
			Hint:   "手工跑 `uname -r`"}
	case major < 4 || (major == 4 && minor < 19):
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: fmt.Sprintf("内核 %s 低于 4.19，overlay2 行为不保证", kernel),
			Raw:    raw.String(),
			Hint:   "会退回 vfs：镜像展开会放大约 14~26 倍（本轮实测区间），磁盘按 30 倍预留"}
	case !overlayUsable:
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "内核不支持或载不上 overlay 模块，docker 会退回 vfs",
			Raw:    raw.String(),
			Hint: "vfs 对每一层完整复制，1.5GB 镜像 tar 实测放大 14.6~26 倍；" +
				"先确认 `modprobe overlay` 与 `grep overlay /proc/filesystems`，再决定是否继续"}
	default:
		return Item{ID: id, Title: title, Level: LevelPass,
			Detail: "内核 " + kernel + "，overlay 可用，目标盘 " + orDash(fsType),
			Raw:    raw.String(),
			Hint:   "xfs 上还需 `xfs_info " + opts.DataDir + " | grep ftype=1`（安装时在数据目录建好后查）"}
	}
}

// checkFirewalld 是 §4.4。
//
// 判据以「第二版实测校正」为准（docs/变体B-系统基线实测.md §4.4）：
//   - 真正成立的 OS 级证据来自统信：firewalld 会把 docker0 绑进自己的 zone，dockerd 再绑
//     一次就冲突 → 重启系统后再起 dockerd 直接失败
//     `Failed to program NAT chain: ZONE_CONFLICT: 'docker0' already bound to a zone`。
//     这比「端口不通」严重：**是 daemon 起不来**。
//   - 「restart firewalld 后 SSH 失联 / trusted zone 无效」那批结论**已被二分实验证伪**，
//     是 QEMU user 网络（slirp）的环境假象（guest 内出现第二个网桥，hostfwd 投递失效），
//     不是 OS 行为。**绝不能把它写进给现场的话术**——那会让人去试一个从来没被证实的动作。
func checkFirewalld(ctx context.Context, opts VariantBOptions, rep *Report) Item {
	const id, title = "B6", "firewalld 状态"
	out, err := opts.Runner.Run(ctx, "firewall-cmd", "--state")
	stateOut := strings.TrimSpace(out)
	if isCommandMissing(err) {
		rep.Facts["firewalld"] = "not-installed"
		return Item{ID: id, Title: title, Level: LevelNA,
			Detail: "未安装 firewalld，不适用", Raw: stateOut,
			Hint: "无需动作"}
	}
	if err != nil {
		rep.Facts["firewalld"] = "unknown"
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "firewall-cmd --state 失败：" + describeRunErr(err),
			Raw:    stateOut,
			Hint:   "**不要把探测失败当成已停用**；手工跑 `systemctl is-active firewalld`"}
	}

	if strings.Contains(strings.ToLower(stateOut), "running") {
		rep.Facts["firewalld"] = "running"
		return Item{ID: id, Title: title, Level: LevelWarn,
			Detail: "firewalld 正在运行：它会把 docker0 绑进自己的 zone，dockerd 再绑就冲突" +
				"（统信实测：重启后再起 dockerd 直接失败，报 ZONE_CONFLICT）",
			Raw: stateOut,
			Hint: "处置二选一，均需留痕：①安装时 `systemctl disable --now firewalld`（内网单机 appliance 首选）；" +
				"②dockerd 配 `--iptables=false` 并自行接管端口管控。" +
				"**不要用「加 trusted zone」当处置**：那批实验（含 restart 后 SSH 失联）" +
				"已由二分实验证伪为 QEMU slirp 环境假象，不是 OS 行为",
		}
	}
	rep.Facts["firewalld"] = "not-running"
	return Item{ID: id, Title: title, Level: LevelPass,
		Detail: "firewalld 未运行（" + orDash(stateOut) + "）", Raw: stateOut,
		Hint: "无需动作；仍建议在安装报告里记下当前状态，便于重启后复现排查"}
}

// --- 小工具 ---

// describeRunErr 把「命令不存在 / 超时 / 其他失败」三类区分开。
//
// 这个区分不是洁癖：预检的每一条都要回答「是现场真不行，还是我们查不出来」。
// 把超时写成失败会让现场去修一个不存在的问题；把「查不到」写成 OK 则会放走真风险。
func describeRunErr(err error) string {
	switch {
	case err == nil:
		return "ok"
	case isCommandMissing(err):
		return "命令不存在"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "命令超时"
	default:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return fmt.Sprintf("命令失败（退出码 %d）", exitErr.ExitCode())
		}
		return "命令失败：" + err.Error()
	}
}

// isCommandMissing 判断错误是不是「这个命令在本机不存在」。
func isCommandMissing(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return true
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) && errors.Is(pathErr.Err, os.ErrNotExist) {
		return true
	}
	// Windows / 某些 shell 下 exec 会把「找不到可执行文件」报成字符串，兜一层。
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "executable file not found") ||
		strings.Contains(msg, "no such file or directory")
}

var kysecStatusLine = regexp.MustCompile(`(?i)KySec\s+status\s*:\s*([a-z\-]+)`)

// parseKysecStatus 从 getstatus 输出里取 `KySec status:` 的值，归一化成 enforcing/permissive/off。
func parseKysecStatus(out string) string {
	m := kysecStatusLine.FindStringSubmatch(out)
	if m == nil {
		return ""
	}
	v := strings.ToLower(strings.TrimSpace(m[1]))
	switch v {
	case "enforcing", "permissive":
		return v
	case "off", "disabled", "disable", "none":
		return "off"
	default:
		return v
	}
}

// parseKysecModule 取某个模块的 on/off，例如 `exectl: on`。
func parseKysecModule(out, module string) string {
	re := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(module) + `\s*:\s*(on|off|enforcing|permissive)`)
	m := re.FindStringSubmatch(out)
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1])
}

// canonicalSELinux 把 getenforce 的三种输出归一化。
func canonicalSELinux(out string) string {
	v := strings.ToLower(strings.TrimSpace(out))
	switch {
	case strings.Contains(v, "enforcing"):
		return "enforcing"
	case strings.Contains(v, "permissive"):
		return "permissive"
	case strings.Contains(v, "disabled"):
		return "disabled"
	default:
		return ""
	}
}

// runOrEmpty 执行命令并把失败吞成空串（用于「有没有这个命令」这类探测）。
func runOrEmpty(ctx context.Context, r Runner, name string, args ...string) string {
	out, err := r.Run(ctx, name, args...)
	if err != nil {
		return ""
	}
	return out
}

// readTrimmed 读文件并去空白；读不到返回空串（探测用，不区分「不存在」与「读失败」）。
func readTrimmed(path string) string {
	out, err := readFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// orDash 把空串显示成 `-`，避免日志里出现「xxx: 」后面什么都没有。
func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

package dockerinstall

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

// procMaxMapCountPath 是 /proc 直写与直读的路径；抽成变量便于单测注入
// （Windows 开发机上没有 /proc，不注入则回读兜底分支永远测不到）。
var procMaxMapCountPath = "/proc/sys/vm/max_map_count"

// 内核参数文件名，与 installer/build/payload/common/sysctl/ 下的载荷同名。
const (
	SysctlFileName = "99-tianji.conf"
	LimitsFileName = "99-tianji-limits.conf"
)

// ParamMaxMapCount 是 ES 8 的硬门槛（设计 K5）。写进去之后还要回读确认生效——
// 「写了但没生效」是这类操作最常见的失败方式（sysctl --system 被 SELinux 拒绝、
// /etc/sysctl.d 里后加载的文件把值覆盖回去），只写不验等于没做。
const ParamMaxMapCount = 262144

// docker.service 的 drop-in：让 dockerd 自身持有无限 memlock。
//
// 为什么需要：compose 里 elasticsearch 声明了 ulimits.memlock: -1，
// dockerd 要以 CAP_SYS_RESOURCE 为容器放开；同时变体 A 的官方 unit 没设
// LimitMEMLOCK，而 limits.d 只对「登录会话」生效、管不到 systemd 拉起的进程。
const dockerLimitsDropIn = `[Service]
LimitMEMLOCK=infinity
LimitNOFILE=65535
`

// EnsureKernelParams 把预检 K5/K6/K7 要求的内核参数落到宿主并立即生效。
//
// 顺序：先写文件（可审计、可重放），再 sysctl --system，最后回读校验。
// 任何一步失败都 fail-closed——ES 起不来时现场最容易误判成「镜像坏了」。
func EnsureKernelParams(ctx context.Context, opts Options) error {
	// ⓪ 先留 before：K5 在 S1 已改判 WARN（理由「S3 会自动修复」），所以 S3 必须能
	// **证明确实修了**——只报 after 无法回答「这一步到底改没改成」，before/after
	// 都落进 S3 日志，静默失败就无处可藏。
	before := "-"
	if out, err := opts.Runner.Run(ctx, "sysctl", "-n", "vm.max_map_count"); err == nil {
		if v := strings.TrimSpace(out.Stdout); v != "" {
			before = v
		}
	}

	// ① sysctl.d
	srcSysctl := filepath.Join(opts.Layout.SysctlDir(), SysctlFileName)
	if err := copyFile(srcSysctl, filepath.Join(opts.SysctlDir, SysctlFileName), 0o644); err != nil {
		return fmt.Errorf("写入 %s 失败（载荷缺失或权限不足）: %w", filepath.Join(opts.SysctlDir, SysctlFileName), err)
	}
	opts.logf("已写入 %s", filepath.Join(opts.SysctlDir, SysctlFileName))

	// ② limits.d
	srcLimits := filepath.Join(opts.Layout.SysctlDir(), LimitsFileName)
	destLimits := filepath.Join(opts.LimitsDir, LimitsFileName)
	if err := os.MkdirAll(opts.LimitsDir, 0o755); err != nil {
		return fmt.Errorf("创建 %s 失败: %w", opts.LimitsDir, err)
	}
	if err := copyFile(srcLimits, destLimits, 0o644); err != nil {
		return fmt.Errorf("写入 %s 失败: %w", destLimits, err)
	}
	opts.logf("已写入 %s（对新登录会话生效）", destLimits)

	// ③ 应用
	if execxHas("sysctl") {
		out, err := opts.Runner.Run(ctx, "sysctl", "--system")
		if err != nil {
			return fmt.Errorf("sysctl --system 失败: %w\n%s", err, out.Tail(10))
		}
		opts.logf("%s", strings.TrimRight(out.Combined(), "\n"))
	} else {
		// 极简系统可能没有 sysctl 命令；用 /proc 直写兜底（需要 root）。
		if err := writeProcSys(procMaxMapCountPath, strconv.Itoa(ParamMaxMapCount)); err != nil {
			return fmt.Errorf("本机没有 sysctl 命令，且直接写 %s 失败: %w", procMaxMapCountPath, err)
		}
		opts.logf("无 sysctl 命令，已直写 /proc/sys/vm/max_map_count")
	}

	// ④ 回读校验：K5 在 S1 已改判 WARN，这里是唯一能证明「S3 真的修好了」的环节。
	// after 读不到要报错（不能静默放行——sysctl --system 被 SELinux 拒绝时表面
	// 全绿、ES 起来就崩）；生效值仍低要报错并带上改前值；成功则打 before→after，
	// 让安装报告自己回答「这一步到底改没改成」。
	n, readErr := readProcInt(ctx, opts, "vm.max_map_count")
	if readErr != nil {
		return fmt.Errorf("无法回读 vm.max_map_count（sysctl 与 %s 都不可用），不能确认 ES 参数已生效: %w",
			procMaxMapCountPath, readErr)
	}
	if n < ParamMaxMapCount {
		return fmt.Errorf("vm.max_map_count 生效值为 %d（改前 %s），仍低于要求 %d（ES 8 会启动即崩）\n"+
			"处置：检查 /etc/sysctl.d/ 下是否有其他文件把该值改回去了（按文件名排序，后加载的覆盖前面的）",
			n, before, ParamMaxMapCount)
	}
	opts.logf("vm.max_map_count: %s → %d（要求 ≥ %d，已回读确认）", before, n, ParamMaxMapCount)
	return nil
}

// readProcInt 回读内核参数当前生效值：先 `sysctl -n`，读不到（命令不存在/失败）
// 再用 /proc 直读兜底。两个都读不到时返回错误——调用方必须能证明参数真的生效了，
// 「读不到就当成功」是这一步最危险的静默失败。
func readProcInt(ctx context.Context, opts Options, param string) (int, error) {
	if out, err := opts.Runner.Run(ctx, "sysctl", "-n", param); err == nil {
		if n, convErr := strconv.Atoi(strings.TrimSpace(out.Stdout)); convErr == nil {
			return n, nil
		}
	}
	procPath := procMaxMapCountPath
	if param != "vm.max_map_count" {
		procPath = filepath.Join("/proc/sys", strings.ReplaceAll(param, ".", "/"))
	}
	if raw, err := os.ReadFile(procPath); err == nil {
		if n, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil {
			return n, nil
		}
	}
	return 0, errors.New("sysctl -n " + param + " 与 " + procPath + " 均不可用")
}

// ensureDockerUnitLimits 给变体 A 的官方 unit 补一个 drop-in（变体 B 的 unit 已自带）。
func ensureDockerUnitLimits(opts Options) error {
	if opts.NoSystemd {
		return nil
	}
	dropInDir := filepath.Join(filepath.Dir(buildplan.DefaultSystemdUnit), "docker.service.d")
	if err := os.MkdirAll(dropInDir, 0o755); err != nil {
		return fmt.Errorf("创建 %s 失败: %w", dropInDir, err)
	}
	path := filepath.Join(dropInDir, "10-tianji-limits.conf")
	if err := os.WriteFile(path, []byte(dockerLimitsDropIn), 0o644); err != nil {
		return fmt.Errorf("写 %s 失败: %w", path, err)
	}
	opts.logf("已写入 %s（dockerd 自身 memlock 放开）", path)
	return nil
}

func copyFile(src, dest string, perm os.FileMode) error {
	raw, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dest, raw, perm)
}

// writeProcSys 直写 /proc；抽成变量便于单测注入（Windows 开发机上没有 /proc，
// 不注入则「无 sysctl 命令时的兜底」这一分支永远测不到）。
var writeProcSys = func(path, value string) error {
	return os.WriteFile(path, []byte(value+"\n"), 0o644)
}

// execxHas 抽出成变量，便于单测在不改 PATH 的前提下替换命令存在性判断。
var execxHas = execx.Has
